import type { BenchmarkObservation } from './outside-benchmark.js';

export interface BenchmarkSeriesSource {
  getDailyCloses(instrument: string, from: Date, to: Date): Promise<BenchmarkObservation[]>;
}
