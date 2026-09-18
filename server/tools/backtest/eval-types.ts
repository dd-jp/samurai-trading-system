import type { ClosedTrade, Fill } from '../../shared/index.js';
import type { SplitScheme } from './splits.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite, Split } from './validation-types.js';

export interface ReplayTradeSource {
  closedTrades(window: DateRange): Promise<readonly ClosedTrade[]>;
  fills(idempotency_key: string): Promise<readonly Fill[]>;
}

export interface EvalOptions {
  window: DateRange;
  averageCapital: number;
  periodsPerYear: number;
  scheme: SplitScheme;
  embargo: number;
  barMs: number;
}

export interface SplitEval {
  split: Split;
  metrics: MetricsSuite;
}

export interface EvalReport {
  window: MetricsSuite;
  splits: SplitEval[];
}

export interface EvalExecutor {
  evaluate(options: EvalOptions): Promise<EvalReport>;
}
