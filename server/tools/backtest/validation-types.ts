export type { MetricsSuite } from '../../../contracts/index.js';

export interface MinBtlVerdict {
  limit: number;
  distinct_configs: number;
  exceeded: boolean;
}

export interface PboVerdict {
  pbo: number;
  verdict: 'accept' | 'reject';
}
