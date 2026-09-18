import type { ClosedTrade, Fill } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { EvalOptions, ReplayTradeSource } from './eval-types.js';
import { computeMetrics } from './metrics.js';
import { generateSplits } from './splits.js';
import { toReturnSeries, toTradeSeries } from './trade-derivation.js';
import type { ReplayTimeline } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2024-01-01T00:00:00.000Z');
const CAPITAL = 100_000;

function day(n: number): Date {
  return new Date(START.getTime() + n * DAY_MS);
}

const BARS = Array.from({ length: 600 }, (_, index) => day(index));
const WINDOW = { start: day(0), end: day(600) };

const TRADES: ClosedTrade[] = Array.from({ length: 6 }, (_, group) => [
  tradeAt(`lot-${group}-win`, 100 * group + 20, 1000),
  tradeAt(`lot-${group}-loss`, 100 * group + 60, -400),
]).flat();

function tradeAt(idempotency_key: string, openDay: number, pnl: number): ClosedTrade {
  return {
    idempotency_key,
    debate_id: `debate-${idempotency_key}`,
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: pnl,
    fees_total: 12,
    opened_at: day(openDay),
    closed_at: day(openDay + 1),
    close_reason: pnl > 0 ? 'target' : 'stop',
    modelled_cost_charged: true,
  };
}

function pricedFills(trade: ClosedTrade): Fill[] {
  return (['entry', 'exit'] as const).map((leg) => ({
    idempotency_key: trade.idempotency_key,
    broker_fill_id: toBrokerFillId(`${trade.idempotency_key}-${leg}`),
    leg,
    price: trade.entry,
    qty: trade.filled_size,
    fee: 6,
    timestamp: leg === 'entry' ? trade.opened_at : trade.closed_at,
    cost_breakdown: { spread_cost: 0.01, commission: 6, slippage: 0.02, market_impact: 0.03 },
  }));
}

function sourceOf(
  trades: readonly ClosedTrade[],
  fillsFor: (trade: ClosedTrade) => Fill[] = pricedFills,
): ReplayTradeSource {
  return {
    closedTrades: async (window) =>
      trades.filter(
        (trade) =>
          trade.closed_at.getTime() >= window.start.getTime() &&
          trade.closed_at.getTime() <= window.end.getTime(),
      ),
    fills: async (idempotency_key) => {
      const trade = trades.find((candidate) => candidate.idempotency_key === idempotency_key);
      return trade === undefined ? [] : fillsFor(trade);
    },
  };
}

const TIMELINE: ReplayTimeline = { barTimestamps: async () => BARS };

const OPTIONS: EvalOptions = {
  window: WINDOW,
  averageCapital: CAPITAL,
  periodsPerYear: 365,
  scheme: 'walk_forward',
  embargo: 0,
  barMs: DAY_MS,
};

function executorOf(source: ReplayTradeSource = sourceOf(TRADES)): EvalExecutorImpl {
  return new EvalExecutorImpl({ source, timeline: TIMELINE });
}

describe("EvalExecutorImpl — acceptance criterion 1: our CostModel.fill, not pybroker's", () => {
  it("scores a run whose every fill carries the cost model's breakdown", async () => {
    await expect(executorOf().evaluate(OPTIONS)).resolves.toBeDefined();
  });

  it('refuses to score a run containing a fill no cost model priced', async () => {
    const unpriced = sourceOf(TRADES, (trade) =>
      pricedFills(trade).map(({ cost_breakdown: _dropped, ...rest }) => rest),
    );

    await expect(executorOf(unpriced).evaluate(OPTIONS)).rejects.toThrow(
      /not priced by CostModel\.fill/,
    );
  });

  it('fails before producing any metrics, not after', async () => {
    const unpriced = sourceOf(TRADES, () => []);

    await expect(executorOf(unpriced).evaluate(OPTIONS)).rejects.toThrow(/has no fills/);
  });
});

describe('EvalExecutorImpl — acceptance criterion 2: split boundaries', () => {
  it('scores exactly the splits our own generator produces', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    expect(report.splits.map((evaluated) => evaluated.split)).toEqual(
      generateSplits(WINDOW, 'walk_forward', { embargo: 0, barMs: DAY_MS }),
    );
  });

  it('emits one scored suite per fold — a distribution, not one number', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    expect(report.splits).toHaveLength(5);
  });

  it('scores each fold over its own test slice only', async () => {
    const report = await executorOf().evaluate(OPTIONS);

    for (const { metrics } of report.splits) {
      expect(metrics.profit_factor).toBeCloseTo(2.5, 12);
      expect(metrics.expectancy).toBeCloseTo(300, 12);
      expect(metrics.turnover).toBeCloseTo(0.04, 12);
      expect(metrics.exposure).toBeCloseTo(0.02, 12);
    }
  });

  it('refuses CPCV rather than under-reporting exposure across the group gap', async () => {
    await expect(executorOf().evaluate({ ...OPTIONS, scheme: 'cpcv' })).rejects.toThrow(
      /disjoint test ranges/,
    );
  });
});

describe('EvalExecutorImpl — acceptance criterion 3: one metric implementation', () => {
  function scoreDirectly(trades: readonly ClosedTrade[]) {
    const seriesOptions = { window: WINDOW, averageCapital: CAPITAL };
    return computeMetrics(
      toReturnSeries(trades, BARS, { ...seriesOptions, periodsPerYear: 365 }),
      toTradeSeries(trades, seriesOptions),
    );
  }

  it('produces the same MetricsSuite as scoring the trade record directly', async () => {
    const report = await executorOf(sourceOf(TRADES)).evaluate(OPTIONS);

    expect(report.window).toEqual(scoreDirectly(TRADES));
  });

  it('matches on every field of the suite, not just the headline ratio', async () => {
    const directMetrics = scoreDirectly(TRADES);

    const report = await executorOf(sourceOf(TRADES)).evaluate(OPTIONS);

    for (const field of Object.keys(directMetrics) as (keyof typeof directMetrics)[]) {
      expect(report.window[field]).toBeCloseTo(directMetrics[field], 12);
    }
  });

  it('agrees with hand-computed values, so neither side is the sole reference', async () => {
    const report = await executorOf(sourceOf(TRADES)).evaluate(OPTIONS);

    expect(report.window.profit_factor).toBeCloseTo(2.5, 12);
    expect(report.window.expectancy).toBeCloseTo(300, 12);
    expect(report.window.turnover).toBeCloseTo(0.24, 12);
    expect(report.window.exposure).toBeCloseTo(0.02, 12);
  });
});
