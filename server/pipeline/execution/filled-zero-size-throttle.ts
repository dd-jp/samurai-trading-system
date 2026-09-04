/**
 * Throttle for `FILLED_WITH_ZERO_SIZE` (#1087, ingest-fills.ts) — a lot
 * `reconcile()` adopted as `filled`/`partially_filled` whose `filled_size`
 * is still zero. Unthrottled, this fires on EVERY poll for as long as the
 * lot stays wedged: at the 2026-09-03 incident's 15-second cadence that is
 * thousands of identical lines over the ~14.6h the affected lot went
 * unnoticed.
 *
 * Same bounded-repeat shape as `MiCoverageMonitor` (mi-coverage.ts, #752) and
 * `TickSkipThrottle` (tick-skip-alert.ts, #1084): alert on the first
 * occurrence, then every Nth poll while the condition persists — never a new
 * pattern.
 */

/** Alert on the FIRST poll a lot is observed wedged — same posture as `MiCoverageMonitor`'s `ALERT_AFTER_CONSECUTIVE_NO_DATA`: this class of gap should never happen, so waiting buys nothing. */
export const ALERT_AFTER_CONSECUTIVE_ZERO_SIZE = 1;

/**
 * How often the warning repeats while the lot stays wedged, counted in
 * further consecutive wedged polls after the first. Every 8th poll, the same
 * repeat interval `ALERT_REPEAT_EVERY_NO_DATA`/`ALERT_REPEAT_EVERY_DEGRADED_TICKS`
 * use — frequent enough to stay visible, rare enough that the log stream
 * (this mechanism's channel — see `FILLED_WITH_ZERO_SIZE`'s own doc) is not
 * flooded with an unbroken run of identical lines.
 */
export const ALERT_REPEAT_EVERY_ZERO_SIZE = 8;

function shouldWarnAt(consecutive: number): boolean {
  if (consecutive < ALERT_AFTER_CONSECUTIVE_ZERO_SIZE) return false;
  return (consecutive - ALERT_AFTER_CONSECUTIVE_ZERO_SIZE) % ALERT_REPEAT_EVERY_ZERO_SIZE === 0;
}

/**
 * Per-lot consecutive-poll counter, keyed by `idempotency_key` — one lot's
 * wedge says nothing about another's, unlike `TickSkipThrottle`'s single
 * whole-pass scalar. In memory and restart-clean, the same posture
 * `MiCoverageMonitor`/`TraderDiagnosticThrottle` take: a process that just
 * restarted has no evidence about the previous process's polls, and a crash
 * is already alarmed by the heartbeat's silence.
 *
 * One instance per running `Execution` surface (constructed once at the
 * composition root — `ExecutionInput.filledZeroSizeThrottle` — and reused
 * across every poll `ingestFills()` runs on that surface, the same lifetime
 * `ExecutionImpl` itself has), NOT a module-level singleton: the live and
 * control arms poll independently and must not share, or leak into, each
 * other's throttle state, and two `ExecutionImpl` instances built in the
 * same test process must not either.
 */
export class FilledZeroSizeThrottle {
  readonly #consecutive = new Map<string, number>();

  /**
   * Records this poll's wedged observation for one lot and reports whether
   * the warning is due. Callers must call `clear` once the lot is no longer
   * wedged (advanceLot's zero-size branch), or a lot that goes on to close
   * healthily leaves an orphaned entry here for the life of the process —
   * bounded by total positions ever opened, not by anything that recovers on
   * its own.
   */
  observe(idempotencyKey: string): { warn: boolean; consecutive: number } {
    const consecutive = (this.#consecutive.get(idempotencyKey) ?? 0) + 1;
    this.#consecutive.set(idempotencyKey, consecutive);
    return { warn: shouldWarnAt(consecutive), consecutive };
  }

  /** Clears one lot's counter — call once it is no longer observed wedged. */
  clear(idempotencyKey: string): void {
    this.#consecutive.delete(idempotencyKey);
  }
}
