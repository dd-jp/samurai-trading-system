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
    // Routed through `service.getMark` rather than the `getMark` const, so a
    // test that REPLACES the property after construction (several below do)
    // still sees its own double through the batch path.
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
    // The default pass is instantaneous: marks come back at the same instant
    // the tick asked for them, so `readAt` and `asOf` coincide and every case
    // written before #1111 keeps its original arithmetic. The pass-latency
    // cases below set their own clock.
    clock: { now: () => asOf },
    cash: 100_000,
    peak_equity: 100_000,
    daily_basis: {
      crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
      stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
      portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
    },
    consecutive_losses: 0,
    // Wide enough that the existing cases, whose fixture marks are observed at
    // `asOf` exactly, never trip it. The #640 cases below set their own.
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

/**
 * #1019 — the submit-time reservation. `execute.ts` writes the lot with
 * `filled_size: 0` BEFORE it calls the broker and `ingestFills()` advances it
 * on a 15s poll, so between those two instants the caps in `index.ts` saw an
 * empty book. These pin that the unfilled remainder is reported, that it is
 * reported SEPARATELY from the valuation, and which order states may carry
 * one.
 */
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

    // `reconcile()`'s bracket pass revisits `pending`/`submitted` only, so a
    // remainder reserved here would never be released — see
    // `RESERVABLE_ORDER_STATES`.
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

  /**
   * #1568 — the ack-time shape #1019's cases above don't cover: an adapter's
   * `adopt` (a lookup hit on an idempotent retry, `saxo-adapter.ts`) can
   * return `filled`/`partially_filled` straight off the venue's own state,
   * with no quantity to advance `filled_size` past 0. `execute.ts` writes
   * that ack verbatim, so this shape is real and reachable — not merely
   * hypothetical the way an adapter fabricating a state would be.
   */
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

      // filled_size > 0 on both lots — the general #1019 exclusion still
      // applies, this fix only widens the filled_size === 0 subcase.
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

  /**
   * The load-bearing separation. `equity = cash + gross_exposure`, and `cash`
   * is the broker's figure, which is NOT debited at submit time either —
   * folding a reservation into `gross_exposure` would count the same order on
   * both sides of the balance and move a STICKY drawdown breaker off a
   * position that does not exist yet.
   */
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

  it('never surfaces the raw cash figure on the returned view (#1572)', async () => {
    const marketData = makeMarketData({ AAPL: 100 });
    const input = makeInput({
      positions: [makePosition({ filled_size: 10 })],
      marketData,
      cash: 50_000,
    });

    const view = await computePortfolioView(input);

    // `cash` is consumed once, above, to fold into `equity` — it is not a
    // field on `PortfolioView` (types.ts). No `EntryCapGate` in
    // risk-manager/index.ts can bind on it because there is nothing to read:
    // this is what makes #1572's "a cap that happens to bind on available
    // cash rather than exposure" premise false against this tree, not merely
    // unexercised by today's config.
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

describe('computePortfolioView — feed staleness (#640)', () => {
  /**
   * A market-data double whose marks carry an explicit observation time, which
   * `makeMarketData` above cannot express (it stamps every mark at `asOf`).
   */
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
      // Overridden alongside `getMark`, not inherited from the spread: the
      // base double's `getMarks` closes over the base's OWN `getMark`, so
      // leaving it would serve this describe's staleness cases a fresh
      // fixture mark and pass vacuously.
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

    // Rejects rather than valuing at the last known price. Exposure, drawdown
    // and daily PnL all derive from this number, so a frozen mark freezes
    // every limit that reads it — including the drawdown breaker, during
    // exactly the conditions that trip it.
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

    // A future observation is a clock disagreement, not a fresh mark, and the
    // operator reading the log needs to be pointed at the clock rather than at
    // the feed.
    await expect(computePortfolioView(input)).rejects.toThrow(/AHEAD of/);
  });

  // #939: `asOf` is the tick's START instant, and `getMark` is called some
  // milliseconds or seconds into the same pass, so a live-stamped mark
  // legitimately lands after `asOf` on a busy tick. That is pipeline
  // latency, not a clock disagreement — it must value the book, not abort
  // it. Reproduces the soak failure: 149ms/1083ms-ahead AAPL marks aborted
  // SPY's whole tick under the pre-#939 bare `age < 0` rule.
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

  // #1111: #939 bounded the same artifact at a 5000ms constant, calibrated
  // against the two sub-second cases above. The offset is our own elapsed time
  // between `asOf` and the read, so it scales with the pass — the 2026-09-04
  // paper session produced 67 refusals between 5020ms and ~145s ahead, not one
  // of them a mark past its own age bound. Freshness now measures from the
  // READ instant, at which no such offset exists at any pass duration.
  //
  // The offsets below are that session's real ones, from `orchestrator.log`
  // (AC7), each with its own instrument.
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
            // Stamped a beat before the read returned, which is where a live
            // quote clock puts it — and far ahead of `asOf`, which is what the
            // pre-#1111 coordinate refused on.
            [instrument]: { price: 100, observed_at: new Date(readAt.getTime() - 200) },
          }),
        });

        await expect(computePortfolioView(input)).resolves.toBeDefined();
      },
    );

    it('still refuses a mark genuinely past its bound, however long the pass took', async () => {
      // #640 is not weakened by the coordinate change: same 145s pass, but the
      // mark has not printed for 20 minutes.
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
      // AC4. The old message asserted "the two disagree" for what was only our
      // own elapsed time; that reading must be unreachable from pass latency.
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
      // AC2's other half: the distinction survives. A mark the venue stamped
      // after we already had it in hand cannot be pass latency at all.
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
    // One mark age, 5 minutes, held under both classes: past the 2-minute
    // crypto bound, inside the 15-minute stocks one.
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
    // A stocks lot whose mark comes back labelled `crypto` — an instrument-key
    // or routing mismatch. The bound applied must be the stocks one (15 min,
    // which this 5-minute mark passes); reading the class off the source's own
    // answer would let a mis-labelled mark pick the tighter bound and reject a
    // perfectly good valuation, or in the mirror case pick the looser one and
    // wave a stale mark through.
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
    // Non-vacuity for the whole describe: the same shape with a fresh mark
    // produces a real view, so the rejections above are the gate firing rather
    // than the fixture being broken.
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
  /**
   * A market-data double whose batch read answers for some instruments and
   * fails for others, which is the shape `MarketDataService.getMarks` exists to
   * express and `getMark` cannot.
   */
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

  /**
   * The correctness half of #289 H8 (2026-08-16 triage): every consumer of
   * `exposure_by_instrument` reads an ABSENT key as zero exposure —
   * `per_asset_cap - (… ?? 0)`, the class and subclass sums, the correlation
   * gate's `Object.keys()` — so a view built from a partial mark set hands
   * every cap a bigger envelope than the book justifies, on a live-money path.
   * There is no partial view that is also a conservative one.
   */
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

    // A rejecting `Promise.all` reported whichever lookup lost the race and
    // discarded the rest, so an operator saw one instrument and had to re-run
    // to learn the second was also dark.
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

    // Both are "this book cannot be valued right now"; splitting them across
    // two passes would make the operator fix one and rediscover the other.
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

    // The named type survives the batching: a caller distinguishing "the feed
    // is alive and lying" from a transport failure still can, without matching
    // on message text through an AggregateError wrapper.
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
    // A service that returns a Map missing a requested key. Guarded rather than
    // left to crash on `undefined.ok`, so the report names the dark position.
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
    // `describeThrown` prints `error.message` alone — never `cause`, never
    // `AggregateError.errors` — so a reason absent from the message text is one
    // the operator never sees.
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

      // The fresh name is still fully valued — the point of the ticket is
      // that one dark name stops blocking every OTHER position.
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
