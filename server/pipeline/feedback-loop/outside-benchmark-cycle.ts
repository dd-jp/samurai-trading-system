/**
 * The Feedback Loop's outside-benchmark cycle (#981, under #636).
 *
 * The companion to `arm-comparison-cycle.ts` and deliberately NOT part of it:
 * #981's non-goals rule out any change to falsifier arm 2's computation,
 * persistence, alerting or panel, so this is added ALONGSIDE that mechanism
 * rather than woven into it. What it shares is the window — and it takes that
 * as an input rather than deriving its own, which is the whole correctness
 * argument (see `types/outside-benchmark.ts`).
 *
 * It reimplements no math: `buildOutsideBenchmark` (pipeline/outside-benchmark/)
 * derives return and drawdown together off one series, with a required
 * `max_drawdown_pct` so that no return-only view of a benchmark can be built.
 *
 * ## Why one benchmark's failure does not lose the others
 *
 * Each benchmark is measured independently and its failure is caught
 * independently. A vendor gap in AGG must not cost the operator the SPY reading
 * — they are different measurements that happen to run on the same cadence, and
 * a shared try/catch would make the weakest series the ceiling for all of them.
 */
import {
  BENCHMARK_COMPOSITION,
  type BenchmarkLeg,
  type BenchmarkObservation,
  buildOutsideBenchmark,
  OUTSIDE_BENCHMARKS,
} from '../outside-benchmark/index.js';
import type {
  OutsideBenchmarkCycleInput,
  OutsideBenchmarkCycleResult,
} from './types/outside-benchmark.js';

/**
 * One cycle: for each benchmark, fetch its legs over the MATCHED CONTROL'S
 * window, measure return and drawdown together, and persist.
 *
 * Async, unlike `runArmComparisonCycle`, because the benchmark series comes
 * from a data vendor rather than from `closed_trades`. The composition root
 * therefore has to handle the promise explicitly — see `production.ts`.
 *
 * Nothing is persisted for a benchmark that could not be measured. An absent
 * row means "not measured this cycle"; a present row means FL looked and got an
 * answer. Writing a zero-return row for a failed fetch would put a fabricated
 * benchmark on the operator's panel, which is worse than an absent one — so the
 * reason travels back in `unmeasured` for the caller to log instead.
 */
export async function runOutsideBenchmarkCycle(
  input: OutsideBenchmarkCycleInput,
): Promise<OutsideBenchmarkCycleResult> {
  const computed_at = input.clock.now();
  // The window is the matched control's, copied — never recomputed from the
  // clock. Recomputing `now - 30d` here would drift from the arm comparison by
  // however long the cycle took, and #636 makes an approximate window noise
  // rather than a comparison.
  const { from, to } = input.comparison;

  const result: OutsideBenchmarkCycleResult = { measured: [], unmeasured: [] };

  for (const benchmark of OUTSIDE_BENCHMARKS) {
    try {
      const legs: { leg: BenchmarkLeg; observations: BenchmarkObservation[] }[] = [];

      for (const leg of BENCHMARK_COMPOSITION[benchmark]) {
        legs.push({
          leg,
          observations: await input.series.getDailyCloses(leg.instrument, from, to),
        });
      }

      const performance = buildOutsideBenchmark({ benchmark, legs, from, to });
      const sample = { computed_at, from, to, performance };
      input.samples.append(sample);
      result.measured.push(sample);
    } catch (error) {
      result.unmeasured.push({
        benchmark,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
