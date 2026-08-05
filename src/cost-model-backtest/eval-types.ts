/**
 * Contracts for the mined eval executor (ticket #90). See
 * docs/specs/cost-model-backtest-spec.md ("Backtest/Eval Executor — pybroker",
 * ADR-0001) and epic #58.
 *
 * **What "pybroker integration" means here.** ADR-0001 fixes TypeScript as the
 * core language and resolves the reuse posture as "mine the three repos for
 * patterns, no hard dependency ... Python repos remain pattern references
 * only, read during implementation, not imported". #88 (harness), #89
 * (metrics/splits/DSR) set that precedent; this ticket follows it. So the
 * deliverable is pybroker's *eval executor shape* — drive walk-forward/CPCV
 * splits over a run's trades and emit a metric suite per split — expressed in
 * TypeScript over this component's own primitives.
 *
 * **Fidelity caveat, stated rather than buried.** pybroker's sources are not
 * on disk in this worktree (`~/trading-system/pybroker/` does not exist, nor
 * does the `/tmp/pybroker-analysis.md` the briefing cites), so the executor
 * shape below is reconstructed from the spec's prose, not read off
 * `src/eval.py` / `src/strategy.py`. metrics.ts records the same limitation
 * for the formulas it implements.
 *
 * **Orchestration, not a second implementation.** The executor computes no
 * metric and generates no split of its own: it calls `generateSplits` (#89)
 * and `computeMetrics` (#89), and it prices nothing — `CostModel.fill` (#87)
 * has already priced every fill it reads. That is forced by the spec, which
 * makes `CostModel.fill` "the single fill authority (one implementation →
 * live metrics == backtest metrics, cross-spec §5)". A pybroker-flavoured
 * copy of the metric math here would be exactly the second implementation
 * that guarantee forbids.
 */

import type { ClosedTrade, Fill } from '../shared/index.js';
import type { SplitScheme } from './splits.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite, Split } from './validation-types.js';

/**
 * Read side of a completed replay: the realized record the eval path scores.
 *
 * A port of its own rather than a widening of Execution's `ExecutionStore`.
 * `ExecutionStore` is a write-side seam for the live path (`writeClosedTrade`,
 * `getFills`) and #90 has no business adding query methods to another
 * component's contract; the composition root adapts its store to this port.
 *
 * `fills` is here — not just `closedTrades` — because it is what makes
 * acceptance criterion 1 checkable. A `ClosedTrade` records net PnL and total
 * fees but carries no cost breakdown, so it cannot testify to *which* fill
 * model priced it. `Fill.cost_breakdown` can: it is populated only by the
 * Simulated adapter, mapped from `CostModelResult` (shared/types.ts). See
 * `assertCostModelPriced`.
 */
export interface ReplayTradeSource {
  /** Closed round-trips with `closed_at` inside `window`, ascending. */
  closedTrades(window: DateRange): Promise<readonly ClosedTrade[]>;
  /** Every fill of one lot, across all legs — the cost-model attestation. */
  fills(idempotency_key: string): Promise<readonly Fill[]>;
}

/**
 * One eval run's parameters.
 *
 * `averageCapital` and `periodsPerYear` are stated by the caller rather than
 * inferred, for the reason `SplitOptions.barMs` is (splits.ts): the executor
 * is handed a trade list and a timeline, and neither states the deployed
 * capital or the bar cadence. Guessing either silently mis-scales every ratio
 * in the suite — `averageCapital` is the turnover and return denominator,
 * `periodsPerYear` the annualization factor.
 *
 * `embargo` / `barMs` / `scheme` pass straight through to `generateSplits`;
 * they are not re-documented here.
 */
export interface EvalOptions {
  window: DateRange;
  averageCapital: number;
  periodsPerYear: number;
  /** Passed through to `generateSplits`; `cscv` is the PBO matrix's source. */
  scheme: SplitScheme;
  embargo: number;
  barMs: number;
}

/** One split's out-of-sample result: the split evaluated, and its suite. */
export interface SplitEval {
  split: Split;
  /** Computed over the split's **test** ranges only — the OOS sample. */
  metrics: MetricsSuite;
}

/**
 * The run's result. `splits` is the distribution user story 14 asks for —
 * the reason the splits exist at all — and `window` is the whole-sample suite
 * beside it.
 *
 * `window` is reported alongside rather than instead of the distribution: a
 * single full-sample number is precisely the cherry-pick the split schemes
 * defend against, so it never travels alone.
 */
export interface EvalReport {
  window: MetricsSuite;
  splits: SplitEval[];
}

/** Seam: the mined walk-forward/CPCV split + eval-metric executor. */
export interface EvalExecutor {
  evaluate(options: EvalOptions): Promise<EvalReport>;
}
