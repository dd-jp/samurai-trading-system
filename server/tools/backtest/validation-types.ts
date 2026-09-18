import type { DateRange } from './universe.js';

export interface ReturnSeries {
  returns: readonly number[];
  periodsPerYear: number;
}

interface Trade {
  instrument: string;
  pnl: number;
  notional: number;
  opened_at: Date;
  closed_at: Date;
}

export interface TradeSeries {
  trades: readonly Trade[];
  averageCapital: number;
  window: DateRange;
}

export type { MetricsSuite } from '../../../contracts/index.js';

export interface Split {
  train: DateRange[];
  test: DateRange[];
}

export interface MinBtlVerdict {
  limit: number;
  distinct_configs: number;
  exceeded: boolean;
}

export interface PboVerdict {
  pbo: number;
  verdict: 'accept' | 'reject';
}
