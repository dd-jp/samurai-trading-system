/**
 * How often ONE unrecorded venue instrument may cost an operator page
 * (#1550) — see `UnrecordedVenuePositionAlertChannel` for why the condition
 * needs a throttle at all.
 *
 * Half an hour, mirroring `FLATTEN_CANCEL_RETRY_EVERY_MS` (reconcile.ts,
 * #1500) rather than `FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS`'s hour. Both are
 * re-announcement intervals for a state that persists across polls, and the
 * two differ on what the re-announcement costs and what it is worth: the
 * zero-size one is a LOG line about a lot the store is already tracking, where
 * an hour keeps a multi-day wedge to a handful of lines; this is a real PAGE
 * about exposure the Risk Manager cannot see, on a book that is required to be
 * flat by close (ADR-0014), so the same half-hour #1500 chose for the other
 * condition that pages every pass is the closer precedent.
 *
 * Wall-clock, not poll-count: reconcile's cadence is whatever the host process
 * chooses (#921's 15s by default), and a poll-count repeat would make the page
 * frequency a silent function of that cadence instead of a stated interval —
 * `FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS`'s own reasoning.
 */
export const UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS = 30 * 60_000;

/**
 * Which of a reconcile pass's unrecorded instruments should page NOW.
 *
 * One instance per composition root (`production.ts`, `control-arm-wiring.ts`,
 * each `smoke-run.ts` scenario), threaded through every `Execution` surface
 * built from that root's deps — not a module-level singleton, for the reason
 * `FilledZeroSizeThrottle`'s doc gives and one more that is specific here: the
 * live and control arms read the SAME venue, so a shared instance would let
 * whichever arm polled first swallow the other's page. In-memory and
 * restart-clean: a process that just restarted has no evidence about the
 * previous process's passes, and re-paging a still-standing exposure once on
 * restart is the safe direction to be wrong in.
 */
export class UnrecordedVenuePositionThrottle {
  /** instrument -> epoch ms of the last page it produced. */
  readonly #lastPagedAtMs = new Map<string, number>();

  /**
   * The subset of `instruments` due a page, and — as one operation, which is
   * the point — the end of every episode this pass did NOT name.
   *
   * Call it ONLY for a pass whose venue read SUCCEEDED. A failed
   * `getOpenPositions()` names no instruments, and passing an empty list for
   * one would forget every standing episode and re-page the lot of them the
   * moment the endpoint recovered. Ignorance is not resolution — the same rule
   * `readVenuePositions` states for every other consumer of its result.
   *
   * First observation of an instrument is always due, so an exposure pages on
   * the pass that finds it rather than half an hour later (the "never
   * attempted is always due" shape `cancelDue` takes in reconcile.ts). `now`
   * is the caller's own clock reading, never read internally, so this stays
   * correct under the backtest clock.
   */
  dueFor(instruments: readonly string[], now: Date): string[] {
    const nowMs = now.getTime();
    const seen = new Set(instruments);
    for (const instrument of this.#lastPagedAtMs.keys()) {
      if (!seen.has(instrument)) this.#lastPagedAtMs.delete(instrument);
    }

    const due: string[] = [];
    for (const instrument of seen) {
      const lastPagedAtMs = this.#lastPagedAtMs.get(instrument);
      if (
        lastPagedAtMs !== undefined &&
        nowMs - lastPagedAtMs < UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS
      ) {
        continue;
      }
      this.#lastPagedAtMs.set(instrument, nowMs);
      due.push(instrument);
    }
    return due;
  }
}
