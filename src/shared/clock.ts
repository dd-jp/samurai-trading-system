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
