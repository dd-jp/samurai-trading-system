import type { ClosedTrade } from '../../shared/index.js';
import type {
  EvalExecutor,
  EvalOptions,
  EvalReport,
  ReplayTradeSource,
  SplitEval,
} from './eval-types.js';
import { computeMetrics } from './metrics.js';
import { generateSplits } from './splits.js';
import { assertCostModelPriced, toReturnSeries, toTradeSeries } from './trade-derivation.js';
import type { ReplayTimeline } from './types.js';
import type { DateRange } from './universe.js';
import type { MetricsSuite } from './validation-types.js';

export interface EvalExecutorDeps {
  source: ReplayTradeSource;
  timeline: ReplayTimeline;
}

export class EvalExecutorImpl implements EvalExecutor {
  constructor(private readonly deps: EvalExecutorDeps) {}

  async evaluate(options: EvalOptions): Promise<EvalReport> {
    const trades = await this.deps.source.closedTrades(options.window);

    for (const trade of trades) {
      assertCostModelPriced(trade, await this.deps.source.fills(trade.idempotency_key));
    }

    const bars = await this.deps.timeline.barTimestamps(options.window);

    const splits = generateSplits(options.window, options.scheme, {
      embargo: options.embargo,
      barMs: options.barMs,
    });

    const splitEvals: SplitEval[] = splits.map((split) => ({
      split,
      metrics: this.score(trades, bars, testRangeOf(split.test), options),
    }));

    return {
      window: this.score(trades, bars, options.window, options),
      splits: splitEvals,
    };
  }

  private score(
    trades: readonly ClosedTrade[],
    bars: readonly Date[],
    sample: DateRange,
    options: EvalOptions,
  ): MetricsSuite {
    const seriesOptions = { window: sample, averageCapital: options.averageCapital };
    const sampleTrades = trades.filter((trade) => within(trade.closed_at, sample));
    const sampleBars = bars.filter((bar) => within(bar, sample));

    return computeMetrics(
      toReturnSeries(sampleTrades, sampleBars, {
        ...seriesOptions,
        periodsPerYear: options.periodsPerYear,
      }),
      toTradeSeries(sampleTrades, seriesOptions),
    );
  }
}

function testRangeOf(test: readonly DateRange[]): DateRange {
  const range = test[0];

  if (range === undefined) {
    throw new Error('EvalExecutor: split has an empty test side — there is no sample to score.');
  }
  if (test.length > 1) {
    throw new Error(
      `EvalExecutor: cannot score a split with ${test.length} disjoint test ranges (CPCV). ` +
        'MetricsSuite.exposure is measured against a single contiguous TradeSeries.window, so ' +
        'spanning the gap between test groups would under-report exposure. Scoring CPCV needs ' +
        'TradeSeries to carry a list of sample ranges; use scheme "walk_forward" or "cscv" ' +
        'until it does.',
    );
  }

  return range;
}

function within(at: Date, range: DateRange): boolean {
  return at.getTime() >= range.start.getTime() && at.getTime() <= range.end.getTime();
}
