/**
 * #1383: rebuilt from bounded-repeat (warn at 3, then every 8th thereafter)
 * to transition-only — report the transition, not the state, same shape as
 * `SequentialTickRunner.reportAdvisoryWarnings` (tick-runner.ts, #303). A lot
 * wedged for a 20h soak produced ~600 warns on the old periodic-repeat
 * cadence alone (measured: `fill_priced_at_zero_size` was 618/2102 structured
 * lines, 29.4%) — the cadence, not the severity, was the defect; downgrading
 * or threshold-gating it would have undone #1087's reason for existing
 * (`FILLED_WITH_ZERO_SIZE` breaking `advanceLot`'s total silence on a lot
 * adopted as filled with zero `filled_size`).
 */
export const ALERT_AFTER_CONSECUTIVE_ZERO_SIZE = 3;

interface ZeroSizeEpisode {
  consecutive: number;
  warned: boolean;
}

export class FilledZeroSizeThrottle {
  readonly #episodes = new Map<string, ZeroSizeEpisode>();

  /**
   * Whether THIS observation should warn: exactly once per episode, on the
   * poll where `consecutive` first reaches `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE`
   * — every later poll on the same still-wedged lot reports `warn: false`
   * until `clear()` starts a new episode.
   */
  observe(idempotencyKey: string): { warn: boolean; consecutive: number } {
    const prior = this.#episodes.get(idempotencyKey);
    const consecutive = (prior?.consecutive ?? 0) + 1;
    const warn = !prior?.warned && consecutive >= ALERT_AFTER_CONSECUTIVE_ZERO_SIZE;
    this.#episodes.set(idempotencyKey, { consecutive, warned: prior?.warned || warn });
    return { warn, consecutive };
  }

  /**
   * Ends a lot's episode (it advanced past zero, or closed). Returns whether
   * that episode ever warned, so the caller can log the matching `info`
   * "cleared" transition — but only for an episode that actually paged,
   * never for one that self-resolved inside the grace window (see
   * `ingest-fills.ts`'s call site).
   */
  clear(idempotencyKey: string): { hadWarned: boolean } {
    const hadWarned = this.#episodes.get(idempotencyKey)?.warned ?? false;
    this.#episodes.delete(idempotencyKey);
    return { hadWarned };
  }
}
