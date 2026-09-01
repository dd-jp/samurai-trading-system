/**
 * The risk-adjusted outside benchmarks, as the Feedback Loop's own measurement
 * (#981, under #636 — the half #971 left open).
 *
 * #636's resolution named ONE owner for both halves: "the control arm and
 * outside benchmarks become additional columns in a suite that already runs on
 * this cadence." #971 shipped the control arm. These ports carry the benchmarks.
 *
 * ## How "secondary" is expressed structurally, not just visually
 *
 * CLAUDE.md, ADR-0014 amendment 2 and ADR-0017 §Consequences all say the same
 * thing: falsifier arm 2 is the PRIMARY matched control and an outside benchmark
 * never substitutes for it. That is enforced in three places here, none of them
 * a comment a future writer can ignore:
 *
 *  1. **`OutsideBenchmarkCycleInput.comparison`.** The cycle takes the
 *     `ArmComparison` FL has ALREADY computed this cycle, and reads its window
 *     off it. There is no `window_ms` on this input, so a benchmark cannot be
 *     measured over a window of its own choosing, and cannot be measured at all
 *     unless the matched control was measured first. #636: *"Outside benchmarks
 *     computed on approximate windows are not risk-adjusted comparisons, they
 *     are noise."*
 *  2. **No alert channel.** There is no `OutsideBenchmarkAlertChannel` on this
 *     input and no verdict type in this file. The matched control can wake a
 *     human (`ArmDivergenceAlertChannel`); a benchmark cannot, because a
 *     benchmark being ahead is not a falsifying result — it is context. There is
 *     no threshold here to change that with.
 *  3. **No `diverged`, no trade count, no PnL** on the persisted shape — see
 *     `OutsideBenchmarkPerformance`'s own header.
 *
 * ## D4 carries over unchanged
 *
 * `OutsideBenchmarkPerformance.max_drawdown_pct` is required, so no shape below
 * can present a benchmark's return without its drawdown — the same discipline
 * `ArmPerformance` applies to the arms, for the same reason
 * (`docs/research/12-edge-hypothesis-critique.md` D4).
 */
import type { Clock } from '../../../shared/index.js';
import type { ArmComparison } from '../../control-arm/index.js';
import type {
  BenchmarkSeriesSource,
  OutsideBenchmarkId,
  OutsideBenchmarkSample,
} from '../../outside-benchmark/index.js';

/**
 * Where each cycle's benchmark samples are written, and read back from.
 *
 * Persisted for exactly the reason `ArmComparisonSampleStore` is: the dashboard
 * runs in a DIFFERENT PROCESS from the orchestrator that computes this, so the
 * panel must show what FL actually measured rather than recomputing a number FL
 * never saw. Recomputing at snapshot time would also move the computation out of
 * the Feedback Loop, which is the one thing #636 decided.
 */
export interface OutsideBenchmarkSampleStore {
  /** One row per (cycle instant, benchmark). */
  append(sample: OutsideBenchmarkSample): void;
  /** Most-recently-computed first. Empty means no cycle has measured one yet. */
  getRecent(limit: number, asOf: Date): OutsideBenchmarkSample[];
}

/**
 * A benchmark FL could not measure this cycle, and why.
 *
 * NOT persisted — an absent row is what "not measured" looks like in the store,
 * and writing a zero-valued row would turn a data outage into a measurement.
 * This is returned so the caller can LOG the reason: absence from persistence,
 * presence in the log. Without it "the vendor 429'd" and "FL never ran" are the
 * same empty panel.
 */
export interface UnmeasuredOutsideBenchmark {
  benchmark: OutsideBenchmarkId;
  reason: string;
}

/** What one benchmark cycle produced: what it measured, and what it could not. */
export interface OutsideBenchmarkCycleResult {
  measured: OutsideBenchmarkSample[];
  unmeasured: UnmeasuredOutsideBenchmark[];
}

/** Everything `runOutsideBenchmarkCycle` consumes. */
export interface OutsideBenchmarkCycleInput {
  /** Wall-clock live, simulated T in replay — read only through this. */
  clock: Clock;
  /**
   * The matched control's comparison, ALREADY computed this cycle. The window
   * is read off it and never chosen here — reason 1 in the module header.
   *
   * The `ArmComparison` rather than the whole `ArmComparisonSample`: the
   * benchmark has no business seeing the divergence verdict, and cannot be
   * written to depend on it.
   */
  comparison: ArmComparison;
  series: BenchmarkSeriesSource;
  samples: OutsideBenchmarkSampleStore;
}
