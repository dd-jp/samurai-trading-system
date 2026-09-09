/**
 * Bounded-repeat write gate for exit-check skip `trader_log` rows (#1128
 * review round 1) — the third instance of this repo's "restart-clean,
 * per-key Map, bounded repeat" throttle shape, alongside
 * `TraderDiagnosticThrottle` (./trader-diagnostic-alert.ts) and
 * `FilledZeroSizeThrottle` (../../../pipeline/execution/filled-zero-size-throttle.ts).
 * Given its own home, unlike a third copy inlined in `direct-bind.ts`, so the
 * write-gate math is unit-tested directly rather than only through
 * `direct-bind.test.ts`'s full-pipeline `exitCheck` tests.
 *
 * A naive "differs from the last OBSERVED tick" change detector cannot bound
 * volume in two real states: `decide.ts`'s own doc on
 * `exit_held_quantity_diverged` says the instrument is "stuck un-exitable"
 * until the fill record is fixed — potentially every tick, for the life of
 * the wedge — and a reason that oscillates between two (or more) values,
 * whatever the dwell length of each run, is "changed" on every switch. An
 * earlier version of this file tracked a single "consecutive tick-over-tick
 * change" streak to catch that second case, but the streak resets to 0
 * whenever a tick repeats the tick immediately before it — which every run
 * of length >= 2 does the tick after each switch — so it only ever caught
 * period-1 (every-single-tick) alternation and silently let any dwell-2+
 * oscillation (e.g. an intermittent `InsufficientBarsError` producing
 * A,A,B,B,A,A,...) write on every switch, unbounded. This version instead
 * tracks a bounded-repeat budget PER REASON (ticks since that specific
 * reason was last written), independent of how many other reasons occurred
 * in between — a reason switching back to something already written inside
 * `ALERT_REPEAT_EVERY_DIAGNOSTICS` ticks is suppressed regardless of dwell
 * length, and a reason never written before (or last written outside the
 * budget) still writes immediately, preserving "a single genuine transition
 * writes right away."
 */
import type { TraderSkipReason } from '../../../pipeline/trader/index.js';
import { ALERT_REPEAT_EVERY_DIAGNOSTICS } from './trader-diagnostic-alert.js';

interface ExitSkipEpisodeState {
  lastObserved: TraderSkipReason;
  written: ReadonlyMap<TraderSkipReason, number>;
}

/**
 * Which exit-check skip reasons repeat on their own cadence even while
 * unchanged, rather than writing only on their onset.
 *
 * `exit_no_filled_size` fires when `totalHeldQuantity(held) <= 0`
 * (decide.ts, `heldQuantitiesFor`'s sum: `filled_size` net of recorded exit
 * fills) — a BROADER condition than it looks, and NOT the same test
 * `FilledZeroSizeThrottle` (`filled-zero-size-throttle.ts`, #1087) runs. That
 * throttle fires when `reconcile()` adopts a lot as `filled`/`partially_filled`
 * whose OWN `filled_size` is still zero — the wedge case, a lot that may
 * never fill. `exit_no_filled_size` also fires on a lot that filled
 * completely and was ALREADY exited completely, netting `held` to zero
 * through exit fills rather than through a stuck `filled_size` — an entirely
 * ordinary post-exit state, not a fault. Only the wedge sub-case is a
 * problem an operator needs repeated visibility into, and that sub-case IS
 * covered: `FilledZeroSizeThrottle` is fed independently from the fill-sync
 * side, on its own poll cadence, not gated by whether `exitCheck` happens to
 * observe this instrument. So `exit_no_filled_size`'s bounded-repeat
 * candidacy would be redundant with a channel that already exists for the
 * one sub-case that matters, and this only needs its onset here, same as any
 * other declined/could-not-decide reason.
 *
 * `exit_held_quantity_diverged` has no other channel: this IS the only place
 * an operator learns the fill store is contradicting itself. The two do not
 * share one justification, so they are not one boolean.
 */
function needsBoundedRepeat(skip_reason: TraderSkipReason): boolean {
  return skip_reason === 'exit_held_quantity_diverged';
}

/**
 * Per-instrument bounded-repeat gate for exit-check skip rows. Restart-clean
 * and in-memory, matching `TraderDiagnosticThrottle`'s posture — one
 * instance per `buildTraderSteps` call, held for that composition root's
 * lifetime.
 */
export class ExitSkipWriteThrottle {
  readonly #episodes = new Map<string, ExitSkipEpisodeState>();

  /**
   * Whether an exit-check skip observed THIS tick should be written. Pure
   * with respect to this instrument's tracked history — does not itself
   * record the observation; call `record` immediately after, whether or not
   * a row was actually persisted (a `true` result can still end up unwritten
   * downstream, e.g. for lack of a `debate_id` — though callers should route
   * `no_open_position` around this throttle entirely, see `clearEpisode`'s
   * doc).
   */
  shouldWrite(instrument: string, skip_reason: TraderSkipReason): boolean {
    const prior = this.#episodes.get(instrument);
    const contiguousRepeat = prior?.lastObserved === skip_reason;
    const ticksSinceWrite = prior?.written.get(skip_reason);
    const budgetElapsed =
      ticksSinceWrite === undefined || ticksSinceWrite + 1 >= ALERT_REPEAT_EVERY_DIAGNOSTICS;

    // Literally the same reason as last tick, and it doesn't get its own
    // repeat cadence: pure onset-once silence, no matter how long it's
    // budget-eligible for — this is what keeps an ordinary unchanged skip
    // from ever re-alerting.
    if (contiguousRepeat && !needsBoundedRepeat(skip_reason)) return false;
    return budgetElapsed;
  }

  /**
   * Records this tick's observation and whether it was actually written.
   * Must be called exactly once per exit-check skip observation, immediately
   * after `shouldWrite` — the two are split because only the caller knows
   * whether a `shouldWrite: true` decision resolved to a real row (it also
   * needs a `debate_id`, which this throttle has no view of).
   */
  record(instrument: string, skip_reason: TraderSkipReason, wrote: boolean): void {
    const prior = this.#episodes.get(instrument);
    const written = new Map(prior?.written ?? []);
    for (const [reason, ticksSinceWrite] of written) written.set(reason, ticksSinceWrite + 1);
    if (wrote) written.set(skip_reason, 0);

    this.#episodes.set(instrument, { lastObserved: skip_reason, written });
  }

  /**
   * Clears one instrument's tracked state at an episode boundary: a fired
   * exit, or an observed `no_open_position` (never routed through
   * `shouldWrite`/`record` — there is no lot, and no debate, to attribute a
   * row to; `trader_log.debate_id` is `NOT NULL`, migration 0016). Either
   * way, a lot closed and reopened with the same first skip reason is a new
   * episode, not a suppressed repeat.
   */
  clearEpisode(instrument: string): void {
    this.#episodes.delete(instrument);
  }
}
