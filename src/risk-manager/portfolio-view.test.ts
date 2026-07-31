import { describe, expect, it, vi } from 'vitest';
import type {
  Bar,
  BarWindow,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
} from '../market-data-service/types.js';
import type { OpenPosition } from '../shared/types.js';
import { computePortfolioView, type PortfolioAccountingInput } from './portfolio-view.js';

const asOf = new Date('2026-07-15T09:30:00Z');

function makeMark(price: number, overrides: Partial<Mark> = {}): Mark {
  return { price, observed_at: asOf, source: 'test', asset_class: 'stocks', ...overrides };
}

function makeMarketData(prices: Record<string, number>): MarketDataService {
  const getMark = vi.fn(
    async (instrument: string, _asOf: Date): Promise<Mark> => makeMark(prices[instrument] ?? 0),
  );
  return {
    getBars: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<Bar[]> => []),
    getIndicator: vi.fn(
      async (_i: string, _s: IndicatorSpec, _a: Date): Promise<IndicatorValue> => {
        throw new Error('not used in these tests');
      },
    ),
    getMark,
    getSpreadEstimate: vi.fn(async (_i: string, _a: Date): Promise<number | null> => null),
    getADV: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<number> => 0),
  };
}

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: 'AAPL-2026-07-15T09:30:00Z',
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 100,
    avg_entry_price: 100,
    stop: 95,
    target: 110,
    order_state: 'filled',
    broker_order_ids: ['order-1'],
    opened_at: asOf,
    decision_timestamp: asOf,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PortfolioAccountingInput> = {}): PortfolioAccountingInput {
  return {
    positions: [],
    marketData: makeMarketData({}),
    asOf,
    cash: 100_000,
    peak_equity: 100_000,
    daily_pnl_pct: 0,
    consecutive_losses: 0,
    ...overrides,
  };
}

describe('computePortfolioView — exposure from filled_size', () => {
  it('a partially-filled position exposure reflects filled quantity only, never requested', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ requested_size: 100, filled_size: 40 })],
      marketData,
    });

    const view = await computePortfolioView(input);

    // 40 filled * 100 mark = 4,000 — not 100 * 100 = 10,000.
    expect(view.exposure_by_instrument.AAPL).toBe(4_000);
    expect(view.gross_exposure).toBe(4_000);
  });

  it('an unfilled (pending) position contributes zero exposure', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ requested_size: 100, filled_size: 0 })],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.exposure_by_instrument.AAPL).toBe(0);
    expect(view.gross_exposure).toBe(0);
  });
});

describe('computePortfolioView — mark sourcing', () => {
  it('sources the mark from MDS getMark at the given asOf', async () => {
    const marketData = makeMarketData({ AAPL: 150 });
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      asOf,
    });

    await computePortfolioView(input);

    expect(marketData.getMark).toHaveBeenCalledWith('AAPL', asOf);
  });

  it('dedupes getMark calls per unique instrument across multiple lots', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [
        makePosition({ idempotency_key: 'lot-1', filled_size: 10 }),
        makePosition({ idempotency_key: 'lot-2', filled_size: 20 }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(marketData.getMark).toHaveBeenCalledTimes(1);
    // 10 + 20 filled, aggregated onto the one instrument.
    expect(view.exposure_by_instrument.AAPL).toBe(3_000);
  });
});

describe('computePortfolioView — aggregation', () => {
  it('splits exposure by asset class', async () => {
    const marketData = makeMarketData({ AAPL: 100, 'BTC-USD': 50_000 });
    const input = makeInput({
      positions: [
        makePosition({ instrument: 'AAPL', asset_class: 'stocks', filled_size: 10 }),
        makePosition({
          idempotency_key: 'BTC-USD-2026-07-15T09:30:00Z',
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          filled_size: 1,
        }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.exposure_by_class).toEqual({ crypto: 50_000, stocks: 1_000 });
    expect(view.gross_exposure).toBe(51_000);
  });

  it('with no positions, exposure is zero and equity equals cash', async () => {
    const input = makeInput({ positions: [], cash: 100_000 });

    const view = await computePortfolioView(input);

    expect(view.gross_exposure).toBe(0);
    expect(view.exposure_by_instrument).toEqual({});
    expect(view.exposure_by_class).toEqual({ crypto: 0, stocks: 0 });
    expect(view.equity).toBe(100_000);
  });
});

describe('computePortfolioView — equity and drawdown', () => {
  it('equity is cash plus mark-to-market of open positions', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      cash: 50_000,
    });

    const view = await computePortfolioView(input);

    expect(view.equity).toBe(51_000);
  });

  it('computes drawdown as peak-to-trough on equity', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      cash: 8_000,
      peak_equity: 10_000,
    });

    const view = await computePortfolioView(input);

    // equity = 8,000 + 1,000 = 9,000; drawdown = (10,000 - 9,000) / 10,000
    expect(view.equity).toBe(9_000);
    expect(view.drawdown_pct).toBeCloseTo(0.1);
  });
});

describe('computePortfolioView — pass-through fields', () => {
  it('passes daily_pnl_pct and consecutive_losses through unchanged', async () => {
    const input = makeInput({ daily_pnl_pct: -0.02, consecutive_losses: 3 });

    const view = await computePortfolioView(input);

    expect(view.daily_pnl_pct).toBe(-0.02);
    expect(view.consecutive_losses).toBe(3);
  });
});
