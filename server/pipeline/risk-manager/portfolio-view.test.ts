import type {
  Bar,
  BarWindow,
  IndicatorSpec,
  IndicatorValue,
  Mark,
  MarketDataService,
  MarkRead,
} from '../../providers/market-data-service/index.js';
import { collectMarks } from '../../providers/market-data-service/index.js';
import type { OpenPosition } from '../../shared/index.js';
import {
  computePortfolioView,
  type PortfolioAccountingInput,
  StaleMarkError,
} from './portfolio-view.js';

const asOf = new Date('2026-07-15T09:30:00Z');

function makeMark(price: number, overrides: Partial<Mark> = {}): Mark {
  return { price, observed_at: asOf, source: 'test', asset_class: 'stocks', ...overrides };
}

function makeMarketData(prices: Record<string, number>): MarketDataService {
  const getMark = vi.fn(
    async (instrument: string, _asOf: Date): Promise<Mark> => makeMark(prices[instrument] ?? 0),
  );
  const service: MarketDataService = {
    getBars: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<Bar[]> => []),
    getIndicator: vi.fn(
      async (_i: string, _s: IndicatorSpec, _a: Date): Promise<IndicatorValue> => {
        throw new Error('not used in these tests');
      },
    ),
    getMark,
    getMarks: vi.fn(
      async (instruments: readonly string[], at: Date): Promise<Map<string, MarkRead>> =>
        collectMarks((instrument, a) => service.getMark(instrument, a), instruments, at),
    ),
    getSpreadEstimate: vi.fn(async (_i: string, _a: Date): Promise<number | null> => null),
    getQuote: vi.fn(async (_i: string, _a: Date): Promise<null> => null),
    getADV: vi.fn(async (_i: string, _w: BarWindow, _a: Date): Promise<number> => 0),
  };
  return service;
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
    clock: { now: () => asOf },
    cash: 100_000,
    peak_equity: 100_000,
    daily_basis: {
      crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
      stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
      portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
    },
    consecutive_losses: 0,
    max_mark_age: { crypto: 2 * 60_000, stocks: 15 * 60_000 },
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

describe('computePortfolioView — in-flight reservation (#1019)', () => {
  it('reserves the full requested notional of a write-ahead pending lot', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [
        makePosition({
          order_state: 'pending',
          requested_size: 100,
          filled_size: 0,
          conviction: 0.7,
        }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.reserved_exposure_by_instrument.AAPL).toBe(10_000);
    expect(view.reserved_exposure_by_class.stocks).toBe(10_000);
    expect(view.reserved_gross_exposure).toBe(10_000);
  });

  it('reserves only the UNFILLED remainder of a submitted lot', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ order_state: 'submitted', requested_size: 100, filled_size: 40 })],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.exposure_by_instrument.AAPL).toBe(4_000);
    expect(view.reserved_exposure_by_instrument.AAPL).toBe(6_000);
  });

  it('reserves nothing against a partially_filled lot, whose remainder has no release path', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [
        makePosition({ order_state: 'partially_filled', requested_size: 100, filled_size: 40 }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.reserved_exposure_by_instrument.AAPL).toBeUndefined();
    expect(view.reserved_gross_exposure).toBe(0);
  });

  it('reserves nothing against a filled lot', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ order_state: 'filled', requested_size: 100, filled_size: 100 })],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.exposure_by_instrument.AAPL).toBe(10_000);
    expect(view.reserved_gross_exposure).toBe(0);
  });

  it('never returns a negative reservation when the venue overfilled', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [
        makePosition({ order_state: 'submitted', requested_size: 100, filled_size: 120 }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.reserved_gross_exposure).toBe(0);
  });

  it('sums reservations per instrument and per class across lots', async () => {
    const marketData = makeMarketData({ AAPL: 100, 'BTC-USD': 50 });
    const input = makeInput({
      positions: [
        makePosition({
          idempotency_key: 'lot-1',
          order_state: 'pending',
          requested_size: 10,
          filled_size: 0,
        }),
        makePosition({
          idempotency_key: 'lot-2',
          order_state: 'submitted',
          requested_size: 5,
          filled_size: 0,
        }),
        makePosition({
          idempotency_key: 'lot-3',
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          order_state: 'pending',
          requested_size: 4,
          filled_size: 0,
        }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(view.reserved_exposure_by_instrument.AAPL).toBe(1_500);
    expect(view.reserved_exposure_by_class.stocks).toBe(1_500);
    expect(view.reserved_exposure_by_class.crypto).toBe(200);
    expect(view.reserved_gross_exposure).toBe(1_700);
  });

  describe('adopted zero-fill lot (#1568)', () => {
    it('reserves the full requested notional against a lot adopted `filled` with filled_size 0', async () => {
      const marketData = makeMarketData({ AAPL: 100 });
      const input = makeInput({
        positions: [makePosition({ order_state: 'filled', requested_size: 100, filled_size: 0 })],
        marketData,
      });

      const view = await computePortfolioView(input);

      expect(view.exposure_by_instrument.AAPL ?? 0).toBe(0);
      expect(view.reserved_exposure_by_instrument.AAPL).toBe(10_000);
      expect(view.reserved_exposure_by_class.stocks).toBe(10_000);
      expect(view.reserved_gross_exposure).toBe(10_000);
    });

    it('reserves the full requested notional against a lot adopted `partially_filled` with filled_size 0', async () => {
      const marketData = makeMarketData({ AAPL: 100 });
      const input = makeInput({
        positions: [
          makePosition({ order_state: 'partially_filled', requested_size: 100, filled_size: 0 }),
        ],
        marketData,
      });

      const view = await computePortfolioView(input);

      expect(view.reserved_exposure_by_instrument.AAPL).toBe(10_000);
      expect(view.reserved_gross_exposure).toBe(10_000);
    });

    it('still reserves nothing once the lot has real fill progress, even at `filled`/`partially_filled`', async () => {
      const marketData = makeMarketData({ AAPL: 100 });
      const input = makeInput({
        positions: [
          makePosition({ order_state: 'filled', requested_size: 100, filled_size: 30 }),
          makePosition({
            idempotency_key: 'lot-2',
            order_state: 'partially_filled',
            requested_size: 100,
            filled_size: 30,
          }),
        ],
        marketData,
      });

      const view = await computePortfolioView(input);

      expect(view.reserved_gross_exposure).toBe(0);
    });

    it('never returns a negative reservation for an adopted lot the venue reports overfilled', async () => {
      const marketData = makeMarketData({ AAPL: 100 });
      const input = makeInput({
        positions: [makePosition({ order_state: 'filled', requested_size: 100, filled_size: 120 })],
        marketData,
      });

      const view = await computePortfolioView(input);

      expect(view.reserved_gross_exposure).toBe(0);
    });
  });

  it('leaves equity, gross_exposure, drawdown and daily PnL byte-identical to a book with no in-flight lot', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const held = makePosition({ order_state: 'filled', requested_size: 10, filled_size: 10 });
    const inFlight = makePosition({
      idempotency_key: 'lot-2',
      order_state: 'pending',
      requested_size: 500,
      filled_size: 0,
      avg_entry_price: 0,
    });

    const without = await computePortfolioView(
      makeInput({ positions: [held], marketData, peak_equity: 200_000 }),
    );
    const with_ = await computePortfolioView(
      makeInput({ positions: [held, inFlight], marketData, peak_equity: 200_000 }),
    );

    expect(with_.gross_exposure).toBe(without.gross_exposure);
    expect(with_.equity).toBe(without.equity);
    expect(with_.drawdown_pct).toBe(without.drawdown_pct);
    expect(with_.daily_pnl).toStrictEqual(without.daily_pnl);
    expect(with_.reserved_gross_exposure).toBe(50_000);
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
    expect(view.exposure_by_instrument.AAPL).toBe(3_000);
  });

  it('throws rather than silently pricing exposure at 0 when a mark is missing', async () => {
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

    expect(view.equity).toBe(9_000);
    expect(view.drawdown_pct).toBeCloseTo(0.1);
  });

  it('never surfaces the raw cash figure on the returned view (#1572)', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      cash: 50_000,
    });

    const view = await computePortfolioView(input);

    expect(view).not.toHaveProperty('cash');
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
        makePosition({ instrument: 'AAPL', asset_class: 'stocks', avg_entry_price: 100 }),
        makePosition({
          idempotency_key: 'AAPL-2',
          instrument: 'AAPL',
          asset_class: 'stocks',
          filled_size: 50,
          avg_entry_price: 90,
        }),
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

    expect(view.daily_pnl.stocks).toEqual({ known: true, pct: 0.015 });
    expect(view.daily_pnl.crypto).toEqual({ known: true, pct: 0.2 });
    expect(view.daily_pnl.portfolio).toEqual({ known: true, pct: 0.215 });

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

    expect(view.daily_pnl.crypto.known).toBe(false);
    expect(view.daily_pnl.portfolio.known).toBe(false);
    expect(view.daily_pnl.stocks).toEqual({ known: true, pct: 0 });
  });
});

describe('computePortfolioView — feed staleness (#640)', () => {
  function makeMarketDataObservedAt(
    marks: Record<string, { price: number; observed_at: Date; asset_class?: 'crypto' | 'stocks' }>,
  ): MarketDataService {
    const getMark = vi.fn(async (instrument: string, _a: Date): Promise<Mark> => {
      const entry = marks[instrument];
      if (!entry) throw new Error(`no fixture mark for ${instrument}`);
      return {
        price: entry.price,
        observed_at: entry.observed_at,
        source: 'test',
        asset_class: entry.asset_class ?? 'stocks',
      };
    });
    return {
      ...makeMarketData({}),
      getMark,
      getMarks: vi.fn(
        async (instruments: readonly string[], at: Date): Promise<Map<string, MarkRead>> =>
          collectMarks(getMark, instruments, at),
      ),
    };
  }

  it('refuses to value the book when a held instrument’s mark is stale', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
      }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(/past the 900000ms bound/);
  });

  it('names the instrument and the observed age', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
      }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(/'AAPL'/);
    await expect(computePortfolioView(input)).rejects.toThrow(/1200000ms old when read at/);
  });

  it('says so explicitly when the mark is AHEAD of our clock', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() + 60_000) },
      }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(/AHEAD of/);
  });

  it('values the book when a held instrument’s mark is observed slightly AFTER asOf (pass latency, #939)', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() + 149) },
      }),
    });

    await expect(computePortfolioView(input)).resolves.toBeDefined();
  });

  it('values the book when a held instrument’s mark is observed over a second AFTER asOf (pass latency, #939)', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() + 1083) },
      }),
    });

    await expect(computePortfolioView(input)).resolves.toBeDefined();
  });

  describe('pass latency does not refuse the book (#1111)', () => {
    it.each([
      ['GOOGL', 5_022],
      ['META', 55_815],
      ['MARA', 82_730],
      ['COIN', 89_718],
      ['MSTR', 144_576],
    ])(
      'values the book when %s’s mark arrives %sms after asOf, itself fresh',
      async (instrument, passLatencyMs) => {
        const readAt = new Date(asOf.getTime() + passLatencyMs);
        const input = makeInput({
          positions: [makePosition({ instrument })],
          clock: { now: () => readAt },
          marketData: makeMarketDataObservedAt({
            [instrument]: { price: 100, observed_at: new Date(readAt.getTime() - 200) },
          }),
        });

        await expect(computePortfolioView(input)).resolves.toBeDefined();
      },
    );

    it('still refuses a mark genuinely past its bound, however long the pass took', async () => {
      const input = makeInput({
        positions: [makePosition()],
        clock: { now: () => new Date(asOf.getTime() + 144_576) },
        marketData: makeMarketDataObservedAt({
          AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
        }),
      });

      await expect(computePortfolioView(input)).rejects.toThrow(StaleMarkError);
    });

    it('never blames the clocks for a slow pass, at any magnitude', async () => {
      const input = makeInput({
        positions: [makePosition()],
        clock: { now: () => new Date(asOf.getTime() + 144_576) },
        marketData: makeMarketDataObservedAt({
          AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
        }),
      });

      await expect(computePortfolioView(input)).rejects.toThrow(/past the 900000ms bound/);
      await expect(computePortfolioView(input)).rejects.not.toThrow(/AHEAD/);
    });

    it('reports how long the pass took alongside the refusal', async () => {
      const input = makeInput({
        positions: [makePosition()],
        clock: { now: () => new Date(asOf.getTime() + 55_815) },
        marketData: makeMarketDataObservedAt({
          AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
        }),
      });

      await expect(computePortfolioView(input)).rejects.toThrow(/read it 55815ms after its asOf/);
    });

    it('still reports a mark stamped ahead of the READ instant as a clock disagreement', async () => {
      const readAt = new Date(asOf.getTime() + 55_815);
      const input = makeInput({
        positions: [makePosition()],
        clock: { now: () => readAt },
        marketData: makeMarketDataObservedAt({
          AAPL: { price: 100, observed_at: new Date(readAt.getTime() + 60_000) },
        }),
      });

      await expect(computePortfolioView(input)).rejects.toThrow(/60000ms AHEAD of/);
      await expect(computePortfolioView(input)).rejects.toThrow(/clock and the venue.s disagree/);
    });
  });

  it('applies the bound for each position’s OWN asset class', async () => {
    const observed_at = new Date(asOf.getTime() - 5 * 60_000);

    const asStocks = makeInput({
      positions: [makePosition({ instrument: 'AAPL', asset_class: 'stocks' })],
      marketData: makeMarketDataObservedAt({ AAPL: { price: 100, observed_at } }),
    });
    const asCrypto = makeInput({
      positions: [
        makePosition({
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          idempotency_key: 'BTC-USD-2026-07-15T09:30:00Z',
        }),
      ],
      marketData: makeMarketDataObservedAt({
        'BTC-USD': { price: 100, observed_at, asset_class: 'crypto' },
      }),
    });

    await expect(computePortfolioView(asStocks)).resolves.toBeDefined();
    await expect(computePortfolioView(asCrypto)).rejects.toThrow(/past the 120000ms bound/);
  });

  it('takes the class from the POSITION, not from the mark the source returned', async () => {
    const input = makeInput({
      positions: [makePosition({ instrument: 'AAPL', asset_class: 'stocks' })],
      marketData: makeMarketDataObservedAt({
        AAPL: {
          price: 100,
          observed_at: new Date(asOf.getTime() - 5 * 60_000),
          asset_class: 'crypto',
        },
      }),
    });

    await expect(computePortfolioView(input)).resolves.toBeDefined();
  });

  it('values the book normally when every mark is inside its bound', async () => {
    const input = makeInput({
      positions: [makePosition()],
      marketData: makeMarketDataObservedAt({
        AAPL: { price: 110, observed_at: new Date(asOf.getTime() - 60_000) },
      }),
    });

    const view = await computePortfolioView(input);

    expect(view.exposure_by_instrument.AAPL).toBe(11_000);
  });
});

describe('computePortfolioView — batch mark read (#289 H8)', () => {
  function makeBatchMarketData(
    marks: Record<string, { price: number; observed_at?: Date } | { error: string }>,
  ): MarketDataService {
    return {
      ...makeMarketData({}),
      getMarks: vi.fn(
        async (instruments: readonly string[], _a: Date): Promise<Map<string, MarkRead>> =>
          new Map(
            instruments.map((instrument): [string, MarkRead] => {
              const entry = marks[instrument];
              if (entry === undefined || 'error' in entry) {
                return [
                  instrument,
                  { ok: false, error: new Error(entry?.error ?? `no fixture for ${instrument}`) },
                ];
              }
              return [
                instrument,
                {
                  ok: true,
                  mark: {
                    price: entry.price,
                    observed_at: entry.observed_at ?? asOf,
                    source: 'test',
                    asset_class: 'stocks',
                  },
                },
              ];
            }),
          ),
      ),
    };
  }

  function twoPositions(): OpenPosition[] {
    return [
      makePosition({ instrument: 'AAPL', idempotency_key: 'AAPL-k' }),
      makePosition({ instrument: 'MSFT', idempotency_key: 'MSFT-k' }),
    ];
  }

  it('reads every held instrument in one batch call, not one call per instrument', async () => {
    const marketData = makeBatchMarketData({ AAPL: { price: 100 }, MSFT: { price: 200 } });
    const input = makeInput({ positions: twoPositions(), marketData });

    const view = await computePortfolioView(input);

    expect(marketData.getMarks).toHaveBeenCalledTimes(1);
    expect(marketData.getMark).not.toHaveBeenCalled();
    expect(view.exposure_by_instrument).toEqual({ AAPL: 10_000, MSFT: 20_000 });
  });

  it('refuses to produce a view at all when any mark is missing', async () => {
    const input = makeInput({
      positions: twoPositions(),
      marketData: makeBatchMarketData({ AAPL: { price: 100 }, MSFT: { error: 'feed down' } }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(/MSFT/);
  });

  it('names every unreadable instrument, not just the first', async () => {
    const input = makeInput({
      positions: twoPositions(),
      marketData: makeBatchMarketData({
        AAPL: { error: 'feed down for AAPL' },
        MSFT: { error: 'feed down for MSFT' },
      }),
    });

    const error = await computePortfolioView(input).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(/AAPL/);
    expect(String((error as Error).message)).toMatch(/MSFT/);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it('folds a STALE mark into the same report as an unreadable one', async () => {
    const input = makeInput({
      positions: twoPositions(),
      marketData: makeBatchMarketData({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
        MSFT: { error: 'feed down for MSFT' },
      }),
    });

    const error = await computePortfolioView(input).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toMatch(/AAPL/);
    expect(String((error as Error).message)).toMatch(/MSFT/);
  });

  it('throws the single failure unwrapped when exactly one instrument failed', async () => {
    const input = makeInput({
      positions: [makePosition({ instrument: 'AAPL', idempotency_key: 'AAPL-k' })],
      marketData: makeBatchMarketData({
        AAPL: { price: 100, observed_at: new Date(asOf.getTime() - 20 * 60_000) },
      }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(StaleMarkError);
  });

  it('values two lots of the same name off one asked-for instrument', async () => {
    const marketData = makeBatchMarketData({ AAPL: { price: 100 } });
    const input = makeInput({
      positions: [
        makePosition({ instrument: 'AAPL', idempotency_key: 'AAPL-1' }),
        makePosition({ instrument: 'AAPL', idempotency_key: 'AAPL-2' }),
      ],
      marketData,
    });

    const view = await computePortfolioView(input);

    expect(marketData.getMarks).toHaveBeenCalledWith(['AAPL'], asOf);
    expect(view.exposure_by_instrument.AAPL).toBe(20_000);
  });

  it('refuses when the batch answers but omits an instrument it was asked for', async () => {
    const marketData: MarketDataService = {
      ...makeMarketData({}),
      getMarks: vi.fn(async (): Promise<Map<string, MarkRead>> => new Map()),
    };
    const input = makeInput({ positions: [makePosition({ instrument: 'AAPL' })], marketData });

    await expect(computePortfolioView(input)).rejects.toThrow(
      /no entry for held instrument 'AAPL'/,
    );
  });

  it('carries the source reason in the thrown message, not only in cause', async () => {
    const input = makeInput({
      positions: [makePosition({ instrument: 'AAPL' })],
      marketData: makeBatchMarketData({ AAPL: { error: '429 rate limited' } }),
    });

    await expect(computePortfolioView(input)).rejects.toThrow(/429 rate limited/);
  });

  it('carries every source reason when more than one instrument is unreadable', async () => {
    const input = makeInput({
      positions: [
        makePosition({ instrument: 'AAPL', idempotency_key: 'AAPL-1' }),
        makePosition({ instrument: 'MSFT', idempotency_key: 'MSFT-1' }),
      ],
      marketData: makeBatchMarketData({
        AAPL: { error: '429 rate limited' },
        MSFT: { error: 'unknown symbol' },
      }),
    });

    const thrown = await computePortfolioView(input).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toMatch(/429 rate limited/);
    expect((thrown as AggregateError).message).toMatch(/unknown symbol/);
  });

  describe('unvaluable_marks: exclude — the EXIT path (#841)', () => {
    it('values what it can and names what it could not, instead of refusing the book', async () => {
      const input = makeInput({
        positions: twoPositions(),
        marketData: makeBatchMarketData({ AAPL: { price: 100 }, MSFT: { error: 'feed down' } }),
        unvaluable_marks: 'exclude',
      });

      const view = await computePortfolioView(input);

      expect(view.exposure_by_instrument).toEqual({ AAPL: 10_000 });
      expect(view.gross_exposure).toBe(10_000);
      expect(view.unvalued_instruments).toEqual(['MSFT']);
    });

    it('excludes a STALE mark on the same terms as an unreadable one', async () => {
      const input = makeInput({
        positions: twoPositions(),
        marketData: makeBatchMarketData({
          AAPL: { price: 100 },
          MSFT: { price: 200, observed_at: new Date(asOf.getTime() - 60 * 60_000) },
        }),
        unvaluable_marks: 'exclude',
      });

      const view = await computePortfolioView(input);

      expect(view.unvalued_instruments).toEqual(['MSFT']);
      expect(view.exposure_by_instrument.MSFT).toBeUndefined();
    });

    it('reports an empty list — never a degraded one — when every mark reads cleanly', async () => {
      const input = makeInput({
        positions: twoPositions(),
        marketData: makeBatchMarketData({ AAPL: { price: 100 }, MSFT: { price: 200 } }),
        unvaluable_marks: 'exclude',
      });

      const view = await computePortfolioView(input);

      expect(view.unvalued_instruments).toEqual([]);
      expect(view.exposure_by_instrument).toEqual({ AAPL: 10_000, MSFT: 20_000 });
    });

    it("defaults to 'refuse' when the field is omitted — the conservative direction", async () => {
      const input = makeInput({
        positions: twoPositions(),
        marketData: makeBatchMarketData({ AAPL: { price: 100 }, MSFT: { error: 'feed down' } }),
      });

      await expect(computePortfolioView(input)).rejects.toThrow(/MSFT/);
    });
  });
});
