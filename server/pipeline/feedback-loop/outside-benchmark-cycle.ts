
import { describeThrownSafely } from '../../shared/index.js';
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

export async function runOutsideBenchmarkCycle(
  input: OutsideBenchmarkCycleInput,
): Promise<OutsideBenchmarkCycleResult> {
  const computed_at = input.clock.now();
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
        reason: describeThrownSafely(error),
      });
    }
  }

  return result;
}
