/**
 * Decision-bar gate (#743) — decides, per instrument per tick, whether this
 * tick opens a new debate bar and therefore runs the DECISION path (Analysts →
 * Debate → Trader → Risk → Verdict → Execution) rather than the tick path's
 * cheap exit check. See docs/specs/orchestrator-spec.md, "The tick/decision
 * split".
 *
 * ## The bar derivation lives here, once
 *
 * `claim` floors the tick time onto the SAME grid `debate_id` is keyed on —
 * `floorToBar(now, DEBATE_BAR_TIMEFRAME_MS)`, the exact function and constant
 * the debate engine owns — and the resulting `DecisionBar` is passed down
 * through `TickContext.decision_bar` to the Debate step and, via
 * `DebateResult.bar_timestamp` (#687), to the Trader. A gate keyed on a SECOND
 * notion of "new bar" (a different timeframe, a bar-close event from market
 * data) could fire twice inside one debate bar, and the #617 short-circuit
 * would then be asked to absorb a duplicate the gate itself created — which is
 * constraint 3 of the split. Deriving from the one shared grid makes that
 * disagreement inexpressible.
 *
 * ## Why claim/rescind rather than a bare "is new bar" predicate
 *
 * A pure predicate re-answers `true` for every tick until something records
 * that the bar was decided, and the recording is the part that carries the
 * failure modes:
 *
 * - Recording at claim time means a decision pass that THROWS (a transient
 *   LLM failure at bar open) silently forfeits the whole bar — no retry until
 *   the next bar, and a quiet hour is indistinguishable from a quiet market
 *   (#625's signature).
 * - Recording at completion time means a permanently-failing pass retries
 *   every tick, which is the 30x-per-bar churn the split exists to remove.
 *
 * So: `claim` records immediately (at most one decision pass per bar can be
 * in flight or completed), and the tick loop calls `rescind` when — and only
 * when — the claimed pass failed, restoring the retry without ever allowing a
 * second concurrent claim. A retried decision re-runs the analysts; if the
 * failed attempt got as far as writing its `debate_log` row, the Debate
 * step's same-bar short-circuit replays it rather than paying twice.
 *
 * ## In-memory, restart-clean — deliberately
 *
 * Per orchestrator-spec.md story 15 the Orchestrator holds no unrecoverable
 * state across a tick. Losing this map on restart costs one decision pass
 * re-entered mid-bar: the analysts re-run once, and the Debate step's
 * persistent `debate_log` short-circuit (#617) — plus its per-bar memo —
 * decides whether that costs an LLM call. That is the same recovery posture
 * `SequentialTickRunner.#lastAdvisory` takes, for the same reason.
 *
 * ## The retry bound (#785)
 *
 * `rescind` is the retry knob claim/rescind was built around, and it was
 * deliberately unbounded at #743: a bounded retry with no failure mode of its
 * own is strictly better than an unbounded one, but #743 was already the
 * fix for a worse problem (silent per-bar forfeiture) and adding a second
 * knob to the same PR would have muddied which one the tests were pinning.
 * The gap #743 left: a PERSISTENTLY failing decision pass rescinds every
 * tick for the rest of the bar — up to `bar_ms / tick_ms` decision-pass
 * retries (30 at the production 2-minute-tick/1-hour-bar cadence), each one
 * a full analyst rebuild. Bounded by `maxRetriesPerBar`: once a bar's rescind
 * count reaches it, `rescind` KEEPS the claim instead of releasing it — the
 * bar is forfeit for the remainder of its life, and the tick loop's caller is
 * told so (via the return value) precisely so it can make that forfeiture
 * LOUD rather than let the bar quietly run out its clock as 30 more retries.
 * The next bar opens with a fresh claim and a fresh retry count regardless of
 * how the previous one ended — `claim` resets the counter, so a forfeit never
 * bleeds into a bar that has not failed yet.
 */
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type { DecisionBar } from './types.js';

/**
 * The default retry budget (#785): generous enough that a couple of
 * transient LLM blips (rate limit, timeout) both retry and succeed inside
 * one bar, small enough that a persistently failing pass forfeits the bar
 * well short of the ~30 retries the production 2-minute-tick/1-hour-bar
 * cadence would otherwise allow
 */
export const DEFAULT_MAX_DECISION_RETRIES_PER_BAR = 5;

/**
 * `rescind`'s outcome, so the tick loop can tell an ordinary retry from a
 * forfeited bar without re-deriving the gate's bookkeeping itself:
 *
 *   'retried'   — the claim was released; the next tick in this bar retries.
 *   'forfeited' — the retry budget for this bar is exhausted; the claim was
 *                 KEPT (no further decision pass retries this bar) and the
 *                 caller must report this loudly (#785's acceptance: a
 *                 forfeit must not read as an ordinary quiet tick).
 *   'stale'     — the instrument's claim had already moved on to a newer bar
 *                 (ownership-aware no-op); nothing changed.
 */
export type RescindResult = 'retried' | 'forfeited' | 'stale';

/** The tick loop's seam onto the gate — see `DebateBarDecisionGate` */
export interface DecisionGate {
  /**
   * Claims the decision for the bar containing `tickTime` if no pass has
   * claimed it yet; returns `undefined` when the bar is already claimed (the
   * common case — this tick runs the tick path only)
   */
  claim(instrument: string, tickTime: Date): DecisionBar | undefined;
  /**
   * Releases a claim after the claimed pass FAILED, so the next tick in the
   * same bar retries the decision — unless the bar's retry budget is
   * exhausted, in which case the claim is KEPT and the bar is forfeit (#785).
   * Ownership-aware: a rescind for a bar the instrument no longer holds is a
   * no-op, so a stale release cannot unlock a newer bar's claim. See
   * `RescindResult`.
   */
  rescind(instrument: string, bar: DecisionBar): RescindResult;
}

export class DebateBarDecisionGate implements DecisionGate {
  /** Opening boundary (epoch ms) of the last bar each instrument claimed */
  readonly #claimedBarMs = new Map<string, number>();
  /** Rescind count for the current bar's retry budget, per instrument (#785) */
  readonly #retries = new Map<string, number>();
  /**
   * The bar `#retries` is counting for, per instrument — tracked SEPARATELY
   * from `#claimedBarMs`, which a 'retried' rescind deletes so the bar can be
   * reclaimed. Without this, reclaiming the same bar after a retry would look
   * like a brand-new bar to `claim` and reset the count it exists to
   * accumulate, and the budget would never bind.
   */
  readonly #retryBarMs = new Map<string, number>();
  readonly #maxRetriesPerBar: number;

  constructor(maxRetriesPerBar: number = DEFAULT_MAX_DECISION_RETRIES_PER_BAR) {
    if (!Number.isFinite(maxRetriesPerBar) || maxRetriesPerBar < 1) {
      throw new Error(
        `DebateBarDecisionGate: maxRetriesPerBar must be a finite number >= 1, got ${maxRetriesPerBar}`,
      );
    }
    this.#maxRetriesPerBar = Math.floor(maxRetriesPerBar);
  }

  claim(instrument: string, tickTime: Date): DecisionBar | undefined {
    const open_time = floorToBar(tickTime, DEBATE_BAR_TIMEFRAME_MS);
    const barMs = open_time.getTime();
    if (this.#claimedBarMs.get(instrument) === barMs) return undefined;
    this.#claimedBarMs.set(instrument, barMs);
    // Only a genuinely NEW bar resets the retry count — reclaiming the SAME
    // bar after a 'retried' rescind must keep accumulating toward the budget
    if (this.#retryBarMs.get(instrument) !== barMs) {
      this.#retries.set(instrument, 0);
      this.#retryBarMs.set(instrument, barMs);
    }
    return {
      id: `${open_time.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`,
      open_time,
      timeframe_ms: DEBATE_BAR_TIMEFRAME_MS,
    };
  }

  rescind(instrument: string, bar: DecisionBar): RescindResult {
    if (this.#claimedBarMs.get(instrument) !== bar.open_time.getTime()) return 'stale';

    const retries = (this.#retries.get(instrument) ?? 0) + 1;
    if (retries >= this.#maxRetriesPerBar) {
      // Retry budget exhausted: the claim stays HELD, so no further pass
      // retries this bar — forfeit, reported to the caller rather than acted
      // on here, since alerting is the tick loop's job, not the gate's
      return 'forfeited';
    }
    this.#retries.set(instrument, retries);
    this.#claimedBarMs.delete(instrument);
    return 'retried';
  }
}
