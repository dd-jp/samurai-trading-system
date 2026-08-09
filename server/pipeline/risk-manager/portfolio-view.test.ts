import type {
  Bar,
  BarWindow,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
} from '../../providers/market-data-service/index.js';
import type { OpenPosition } from '../../shared/index.js';
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
    daily_basis: {
      crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
      stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
      portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
    },
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

  it('throws rather than silently pricing exposure at 0 when a mark is missing', async () => {
    // A conforming MarketDataService can't return "no mark" (getMark always
    // resolves to a priced Mark or rejects) — this simulates the only way
    // the internal marks map can hold an unusable entry: a malformed/NaN
    // price slipping through the service boundary. The guard exists so that
    // case fails loudly instead of understating exposure to Risk.
    const marketData = makeMarketData({ AAPL: 150 });
    marketData.getMark = vi
      .fn()
      .mockResolvedValue({ ...makeMark(150), price: undefined }) as MarketDataService['getMark'];
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      asOf,
    });

    await expect(computePortfolioView(input)).rejects.toThrow("no mark for held instrument 'AAPL'");
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
  it('divides realized PnL by session-open equity, per class, and passes losses through', async () => {
    const input = makeInput({
      daily_basis: {
        crypto: { known: true, open_equity: 100_000, realized_pnl: -2_000 },
        stocks: { known: true, open_equity: 50_000, realized_pnl: 500 },
        portfolio: { known: true, open_equity: 100_000, realized_pnl: -1_500 },
      },
      consecutive_losses: 3,
    });

    const view = await computePortfolioView(input);

    // No open positions in this fixture, so the unrealized term is 0 and each
    // figure is realized/open_equity against its OWN class's denominator.
    expect(view.daily_pnl.crypto).toEqual({ known: true, pct: -0.02 });
    expect(view.daily_pnl.stocks).toEqual({ known: true, pct: 0.01 });
    expect(view.daily_pnl.portfolio).toEqual({ known: true, pct: -0.015 });
    expect(view.consecutive_losses).toBe(3);
  });

  it('adds the unrealized mark-to-market term without fetching any mark twice', async () => {
    const marketData = makeMarketData({ AAPL: 110, 'BTC-USD': 40_000 });
    const input = makeInput({
      marketData,
      positions: [
        // +10/share on 100 shares = +1,000 unrealized.
        makePosition({ instrument: 'AAPL', asset_class: 'stocks', avg_entry_price: 100 }),
        // A second lot in the same instrument, to prove the dedupe holds.
        makePosition({
          idempotency_key: 'AAPL-2',
          instrument: 'AAPL',
          asset_class: 'stocks',
          filled_size: 50,
          avg_entry_price: 90,
        }),
        // Short 2 BTC entered at 50k, now 40k = +20,000 unrealized.
        makePosition({
          idempotency_key: 'BTC-1',
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          side: 'sell',
          filled_size: 2,
          avg_entry_price: 50_000,
        }),
      ],
      daily_basis: {
        crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
        stocks: { known: true, open_equity: 100_000, realized_pnl: -500 },
        portfolio: { known: true, open_equity: 100_000, realized_pnl: -500 },
      },
    });

    const view = await computePortfolioView(input);

    // stocks unrealized = (110-100)*100 + (110-90)*50 = 1,000 + 1,000 = 2,000
    // → (-500 + 2,000) / 100,000
    expect(view.daily_pnl.stocks).toEqual({ known: true, pct: 0.015 });
    // crypto is short: (40,000-50,000) * 2 * -1 = +20,000 → 20,000/100,000
    expect(view.daily_pnl.crypto).toEqual({ known: true, pct: 0.2 });
    // portfolio spans both unrealized terms: (-500 + 22,000) / 100,000
    expect(view.daily_pnl.portfolio).toEqual({ known: true, pct: 0.215 });

    // #332's explicit constraint: the daily-PnL math reuses the marks the
    // exposure math already fetched — one call per unique instrument, no more.
    expect(marketData.getMark).toHaveBeenCalledTimes(2);
  });

  it('carries an unknown basis through as unknown, never as a zero percentage', async () => {
    const input = makeInput({
      daily_basis: {
        crypto: { known: false, reason: 'no snapshot for this session' },
        stocks: { known: true, open_equity: 50_000, realized_pnl: 0 },
        portfolio: { known: false, reason: 'no snapshot for this session' },
      },
    });

    const view = await computePortfolioView(input);

    // The whole point of the union: an absent denominator must not surface as
    // `pct: 0`, which the daily-loss breaker would read as a flat day.
    expect(view.daily_pnl.crypto.known).toBe(false);
    expect(view.daily_pnl.portfolio.known).toBe(false);
    expect(view.daily_pnl.stocks).toEqual({ known: true, pct: 0 });
  });
});
