import type { ClosedTrade, Fill } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { assertCostModelPriced, toReturnSeries, toTradeSeries } from './trade-derivation.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2024-01-01T00:00:00.000Z');

function day(n: number): Date {
  return new Date(START.getTime() + n * DAY_MS);
}

const BARS = Array.from({ length: 10 }, (_, index) => day(index));
const WINDOW = { start: day(0), end: day(10) };
const CAPITAL = 100_000;

function closedTrade(overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
    idempotency_key: 'lot-1',
    debate_id: 'debate-1',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    entry: 100,
    stop: 90,
    filled_size: 10,
    realized_pnl_net: 500,
    fees_total: 12,
    opened_at: day(0),
    closed_at: day(1),
    close_reason: 'target',
    modelled_cost_charged: true,
    ...overrides,
  };
}

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    idempotency_key: 'lot-1',
    broker_fill_id: toBrokerFillId('fill-1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 6,
    timestamp: day(0),
    cost_breakdown: { spread_cost: 0.01, commission: 6, slippage: 0.02, market_impact: 0.03 },
    ...overrides,
  };
}

const TRADES: ClosedTrade[] = [
  closedTrade({
    idempotency_key: 'lot-1',
    realized_pnl_net: 500,
    entry: 100,
    filled_size: 10,
    opened_at: day(0),
    closed_at: day(1),
  }),
  closedTrade({
    idempotency_key: 'lot-2',
    realized_pnl_net: -200,
    entry: 50,
    filled_size: 20,
    opened_at: day(2),
    closed_at: day(3),
  }),
  closedTrade({
    idempotency_key: 'lot-3',
    realized_pnl_net: 300,
    entry: 200,
    filled_size: 5,
    opened_at: day(5),
    closed_at: day(6),
  }),
];

describe('toTradeSeries', () => {
  it('maps realized net PnL through unchanged, so expectancy stays net of costs', () => {
    const series = toTradeSeries(TRADES, { window: WINDOW, averageCapital: CAPITAL });

    expect(series.trades.map((trade) => trade.pnl)).toEqual([500, -200, 300]);
  });

  it('derives round-trip notional as entry x size x 2', () => {
    const series = toTradeSeries(TRADES, { window: WINDOW, averageCapital: CAPITAL });

    expect(series.trades.map((trade) => trade.notional)).toEqual([2000, 2000, 2000]);
  });

  it('carries the sample window and capital through as the metric denominators', () => {
    const series = toTradeSeries(TRADES, { window: WINDOW, averageCapital: CAPITAL });

    expect(series.averageCapital).toBe(CAPITAL);
    expect(series.window).toEqual(WINDOW);
  });

  it('preserves the open/close stamps exposure is measured from', () => {
    const [first] = toTradeSeries(TRADES, { window: WINDOW, averageCapital: CAPITAL }).trades;

    expect(first?.opened_at).toEqual(day(0));
    expect(first?.closed_at).toEqual(day(1));
  });
});

describe('toReturnSeries', () => {
  it('buckets realized PnL into the bar it was realized on', () => {
    const series = toReturnSeries(TRADES, BARS, {
      window: WINDOW,
      averageCapital: CAPITAL,
      periodsPerYear: 365,
    });

    expect(series.returns).toEqual([0, 0.005, 0, -0.002, 0, 0, 0.003, 0, 0, 0]);
  });

  it('sums several trades closing on the same bar', () => {
    const series = toReturnSeries(
      [
        closedTrade({ idempotency_key: 'a', realized_pnl_net: 500, closed_at: day(2) }),
        closedTrade({ idempotency_key: 'b', realized_pnl_net: -100, closed_at: day(2) }),
      ],
      BARS,
      { window: WINDOW, averageCapital: CAPITAL, periodsPerYear: 365 },
    );

    expect(series.returns[2]).toBeCloseTo(0.004, 12);
  });

  it('attributes a mid-bar close forward, never to the bar before it', () => {
    const midBar = new Date(day(2).getTime() + DAY_MS / 2);
    const series = toReturnSeries(
      [closedTrade({ realized_pnl_net: 500, closed_at: midBar })],
      BARS,
      { window: WINDOW, averageCapital: CAPITAL, periodsPerYear: 365 },
    );

    expect(series.returns[2]).toBe(0);
    expect(series.returns[3]).toBeCloseTo(0.005, 12);
  });

  it('carries the caller-stated annualization cadence rather than inferring one', () => {
    const series = toReturnSeries(TRADES, BARS, {
      window: WINDOW,
      averageCapital: CAPITAL,
      periodsPerYear: 252,
    });

    expect(series.periodsPerYear).toBe(252);
  });

  it('rejects a trade closing after the last bar of its sample', () => {
    expect(() =>
      toReturnSeries([closedTrade({ closed_at: day(99) })], BARS, {
        window: WINDOW,
        averageCapital: CAPITAL,
        periodsPerYear: 365,
      }),
    ).toThrow(/after the last bar/);
  });

  it('rejects a non-positive capital denominator instead of dividing by it', () => {
    expect(() =>
      toReturnSeries(TRADES, BARS, { window: WINDOW, averageCapital: 0, periodsPerYear: 365 }),
    ).toThrow(/averageCapital must be > 0/);
  });

  it('rejects an empty bar sample rather than returning an empty series', () => {
    expect(() =>
      toReturnSeries(TRADES, [], { window: WINDOW, averageCapital: CAPITAL, periodsPerYear: 365 }),
    ).toThrow(/no bars in the sample/);
  });
});

describe('assertCostModelPriced', () => {
  it('accepts fills carrying the cost breakdown CostModel.fill produces', () => {
    expect(() =>
      assertCostModelPriced(closedTrade(), [fill({ leg: 'entry' }), fill({ leg: 'exit' })]),
    ).not.toThrow();
  });

  it('rejects a fill with no cost breakdown — some other fill model priced it', () => {
    const unpriced: Fill = {
      idempotency_key: 'lot-1',
      broker_fill_id: toBrokerFillId('fill-2'),
      leg: 'exit',
      price: 110,
      qty: 10,
      fee: 6,
      timestamp: day(1),
    };

    expect(() => assertCostModelPriced(closedTrade(), [fill(), unpriced])).toThrow(
      /not priced by CostModel\.fill/,
    );
  });

  it('rejects a closed trade with no fills at all', () => {
    expect(() => assertCostModelPriced(closedTrade(), [])).toThrow(/has no fills/);
  });
});

describe('toReturnSeries bar attribution — binary search equivalence (#289)', () => {
  function linearAttribution(bars: readonly Date[], closedAt: Date): number {
    return bars.findIndex((bar) => bar.getTime() >= closedAt.getTime());
  }

  const start = Date.UTC(2026, 0, 1);
  const DAY = 86_400_000;
  const bars = Array.from({ length: 200 }, (_, i) => new Date(start + i * DAY));
  const WINDOW_200D = { start: new Date(start), end: new Date(start + 200 * DAY) };

  it('attributes to the same bar as the linear scan, across every boundary case', () => {
    const probes: Date[] = [new Date(start - DAY)];
    for (const bar of bars) {
      probes.push(
        new Date(bar.getTime() - 1),
        new Date(bar.getTime()),
        new Date(bar.getTime() + 1),
      );
    }
    probes.push(new Date(start + 500 * DAY));

    for (const [index, closedAt] of probes.entries()) {
      const expected = linearAttribution(bars, closedAt);
      const trades =
        expected === -1
          ? []
          : [
              closedTrade({
                idempotency_key: `k-${index}`,
                closed_at: closedAt,
                realized_pnl_net: 7,
              }),
            ];

      if (expected === -1) continue;

      const series = toReturnSeries(trades, bars, {
        averageCapital: 100,
        periodsPerYear: 252,
        window: WINDOW_200D,
      });
      const attributed = series.returns.findIndex((r) => r !== 0);

      expect(attributed).toBe(expected);
    }
  });

  it('still throws for a trade closing after the last bar', () => {
    const closed_at = new Date(bars[bars.length - 1].getTime() + DAY);

    expect(() =>
      toReturnSeries([closedTrade({ closed_at, realized_pnl_net: 1 })], bars, {
        averageCapital: 100,
        periodsPerYear: 252,
        window: WINDOW_200D,
      }),
    ).toThrow(/after the last bar/);
  });
});
