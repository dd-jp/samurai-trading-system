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
 */
import { DEBATE_BAR_TIMEFRAME_MS, floorToBar } from '../../pipeline/debate-engine/index.js';
import type { DecisionBar } from './types.js';

/** The tick loop's seam onto the gate — see `DebateBarDecisionGate`. */
export interface DecisionGate {
  /**
   * Claims the decision for the bar containing `tickTime` if no pass has
   * claimed it yet; returns `undefined` when the bar is already claimed (the
   * common case — this tick runs the tick path only).
   */
  claim(instrument: string, tickTime: Date): DecisionBar | undefined;
  /**
   * Releases a claim after the claimed pass FAILED, so the next tick in the
   * same bar retries the decision. Ownership-aware: a rescind for a bar the
   * instrument no longer holds is a no-op, so a stale release cannot unlock a
   * newer bar's claim.
   */
  rescind(instrument: string, bar: DecisionBar): void;
}

export class DebateBarDecisionGate implements DecisionGate {
  /** Opening boundary (epoch ms) of the last bar each instrument claimed. */
  readonly #claimedBarMs = new Map<string, number>();

  claim(instrument: string, tickTime: Date): DecisionBar | undefined {
    const open_time = floorToBar(tickTime, DEBATE_BAR_TIMEFRAME_MS);
    const barMs = open_time.getTime();
    if (this.#claimedBarMs.get(instrument) === barMs) return undefined;
    this.#claimedBarMs.set(instrument, barMs);
    return {
      id: `${open_time.toISOString()}@${DEBATE_BAR_TIMEFRAME_MS}`,
      open_time,
      timeframe_ms: DEBATE_BAR_TIMEFRAME_MS,
    };
  }

  rescind(instrument: string, bar: DecisionBar): void {
    if (this.#claimedBarMs.get(instrument) === bar.open_time.getTime()) {
      this.#claimedBarMs.delete(instrument);
    }
  }
}
