import type { Clock } from '../../../shared/index.js';
import type { ArmComparison } from '../../control-arm/index.js';
import type {
  BenchmarkSeriesSource,
  OutsideBenchmarkId,
  OutsideBenchmarkSample,
} from '../../outside-benchmark/index.js';

export interface OutsideBenchmarkSampleStore {
  append(sample: OutsideBenchmarkSample): void;
  getRecent(limit: number, asOf: Date): OutsideBenchmarkSample[];
}

interface UnmeasuredOutsideBenchmark {
  benchmark: OutsideBenchmarkId;
  reason: string;
}

export interface OutsideBenchmarkCycleResult {
  measured: OutsideBenchmarkSample[];
  unmeasured: UnmeasuredOutsideBenchmark[];
}

export interface OutsideBenchmarkCycleInput {
  clock: Clock;
  comparison: ArmComparison;
  series: BenchmarkSeriesSource;
  samples: OutsideBenchmarkSampleStore;
}
