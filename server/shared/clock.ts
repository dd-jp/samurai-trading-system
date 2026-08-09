/**
 * Injected clock — every stage reads time through this, never Date.now() directly.
 * Live: wall-clock. Backtest/replay: a simulated clock advancing deterministically.
 * See docs/specs/orchestrator-spec.md (Module: Determinism & Backtest) and
 * docs/specs/cost-model-backtest-spec.md for how this is injected in each mode.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * The replay clock the backtest harness owns and steps bar-by-bar
 * (cost-model-backtest-spec.md, "Module: Backtest Harness" — ticket #88).
 * Time only ever moves forward: `advanceTo` rejects a backwards step, so a
 * replay cannot rewind time to re-read a bar it has already passed.
 *
 * `now()` returns a fresh `Date` each call — the internal instant is never
 * handed out, so a stage that mutates the value it receives cannot move the
 * harness's clock.
 */
export class SimulatedClock implements Clock {
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  /**
   * Step to the next bar's timestamp. Re-advancing to the current instant is
   * a no-op (monotonic non-decreasing); stepping backwards throws.
   */
  advanceTo(next: Date): void {
    const target = next.getTime();
    if (target < this.current) {
      throw new Error(
        `SimulatedClock.advanceTo: refusing to step backwards from ${new Date(
          this.current,
        ).toISOString()} to ${next.toISOString()}`,
      );
    }
    this.current = target;
  }
}
