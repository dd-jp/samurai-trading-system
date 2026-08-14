import { formingCandleClient } from '../forming-candle-client.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../trading-calendar.js';
import type { BarWindow, DataSource } from '../types.js';
import { type AlpacaBar, type AlpacaClient, AlpacaDataSource } from './alpaca-source.js';
import {
  type CcxtClient,
  CcxtDataSource,
  CcxtDataUnderfetchError,
  type CcxtOhlcv,
  CcxtPaginationError,
} from './ccxt-source.js';
import { type IbkrClient, IbkrDataSource, type IbkrHistoricalBar } from './ibkr-source.js';

const WINDOW: BarWindow = { timeframe: '1h', lookback: 10 };
const ASOF = new Date('2026-07-15T18:00:00Z'); // 14:00 ET, mid-session

/**
 * `WINDOW`, opted in to a short read (#497).
 *
 * The fixtures below are two candles asserting NORMALIZATION — field shape,
 * provenance, close_time derivation — against a `lookback: 10` window, so they
 * are genuinely short and always were. Alpaca and IBKR never noticed because
 * their loud short-read guard lives in the HTTP client (`AlpacaHttpDataClient`,
 * #292), which these stub clients replace. ccxt has no repo-owned client to
 * hold that guard, so it lives in the source and these fixtures now have to say
 * out loud what they were relying on silently.
 *
 * Only the ccxt cases use this. Widening the shared `WINDOW` instead would
 * break the #292 test that pins `partial: undefined` reaching the client.
 */
const SHORT_FIXTURE_WINDOW: BarWindow = { ...WINDOW, partial: 'allow' };

/** Every ccxt fixture here is Kraken-shaped; `source` is required since #497. */
const KRAKEN: { source: string } = { source: 'kraken' };

/**
 * The same two candles expressed in each source's wire format: 14:00 and
 * 15:00 UTC (10:00/11:00 ET — both in session), closing at 15:00 and 16:00.
 */
const CCXT_ROWS: CcxtOhlcv[] = [
  [Date.parse('2026-07-15T14:00:00Z'), 100, 105, 99, 104, 11],
  [Date.parse('2026-07-15T15:00:00Z'), 104, 108, 103, 107, 12],
];

const ALPACA_BARS: AlpacaBar[] = [
  { t: '2026-07-15T14:00:00Z', o: 100, h: 105, l: 99, c: 104, v: 11 },
  { t: '2026-07-15T15:00:00Z', o: 104, h: 108, l: 103, c: 107, v: 12 },
];

const IBKR_BARS: IbkrHistoricalBar[] = [
  { time: '2026-07-15T14:00:00Z', open: 100, high: 105, low: 99, close: 104, volume: 11 },
  { time: '2026-07-15T15:00:00Z', open: 104, high: 108, low: 103, close: 107, volume: 12 },
];

const ccxtClient: CcxtClient = {
  fetchOHLCV: async () => CCXT_ROWS,
  fetchTicker: async () => ({ last: 999, timestamp: Date.parse('2026-07-15T17:59:30Z') }),
};

const alpacaClient: AlpacaClient = {
  getBars: async () => ALPACA_BARS,
  getLatestQuote: async () => ({ t: '2026-07-15T17:59:30Z', ap: 1001, bp: 997 }),
};

const ibkrClient: IbkrClient = {
  getHistoricalBars: async () => IBKR_BARS,
  getLastTrade: async () => ({ price: 999, time: '2026-07-15T17:59:30Z' }),
};

describe('every source normalizes into the same Bar shape', () => {
  const cases: Array<[string, DataSource, string, BarWindow]> = [
    ['ccxt', new CcxtDataSource(ccxtClient, KRAKEN), 'kraken', SHORT_FIXTURE_WINDOW],
    ['alpaca', new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' }), 'alpaca', WINDOW],
    ['ibkr', new IbkrDataSource(ibkrClient), 'ibkr', WINDOW],
  ];

  for (const [name, source, expectedProvenance, window] of cases) {
    it(`${name} produces canonical bars with derived close_time`, async () => {
      const bars = await source.fetchBars('AAPL', window, ASOF);

      expect(bars).toEqual([
        {
          instrument: 'AAPL',
          timeframe: '1h',
          open_time: new Date('2026-07-15T14:00:00Z'),
          close_time: new Date('2026-07-15T15:00:00Z'),
          open: 100,
          high: 105,
          low: 99,
          close: 104,
          volume: 11,
          source: expectedProvenance,
        },
        {
          instrument: 'AAPL',
          timeframe: '1h',
          open_time: new Date('2026-07-15T15:00:00Z'),
          close_time: new Date('2026-07-15T16:00:00Z'),
          open: 104,
          high: 108,
          low: 103,
          close: 107,
          volume: 12,
          source: expectedProvenance,
        },
      ]);
    });
  }

  it('produces bars that are field-identical across sources but for provenance', async () => {
    const [fromCcxt, fromAlpaca, fromIbkr] = await Promise.all([
      new CcxtDataSource(ccxtClient, KRAKEN).fetchBars('AAPL', SHORT_FIXTURE_WINDOW, ASOF),
      new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' }).fetchBars('AAPL', WINDOW, ASOF),
      new IbkrDataSource(ibkrClient).fetchBars('AAPL', WINDOW, ASOF),
    ]);

    const withoutSource = (bars: Awaited<ReturnType<DataSource['fetchBars']>>) =>
      bars.map(({ source: _source, ...rest }) => rest);

    expect(withoutSource(fromAlpaca)).toEqual(withoutSource(fromCcxt));
    expect(withoutSource(fromIbkr)).toEqual(withoutSource(fromCcxt));
  });
});

describe('marks', () => {
  it('ccxt live mark observes the ticker price at the ticker timestamp', async () => {
    const mark = await new CcxtDataSource(ccxtClient, KRAKEN).fetchMark('BTC/USD', ASOF, 'live');

    expect(mark).toEqual({
      price: 999,
      observed_at: new Date('2026-07-15T17:59:30Z'),
      source: 'kraken',
      asset_class: 'crypto',
    });
  });

  it('alpaca live mark is the quote midpoint observed at the quote time', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

    const mark = await source.fetchMark('AAPL', ASOF, 'live');

    expect(mark).toEqual({
      price: 999, // midpoint of 997/1001
      observed_at: new Date('2026-07-15T17:59:30Z'),
      source: 'alpaca',
      asset_class: 'stocks',
    });
  });

  it('ibkr live mark observes the last trade at its trade time', async () => {
    const mark = await new IbkrDataSource(ibkrClient).fetchMark('AAPL', ASOF, 'live');

    expect(mark).toEqual({
      price: 999,
      observed_at: new Date('2026-07-15T17:59:30Z'),
      source: 'ibkr',
      asset_class: 'stocks',
    });
  });

  it('serves a legitimately stale stock mark when the market is closed, rather than failing', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });
    const sundayNight = new Date('2026-07-19T23:00:00Z');

    const mark = await source.fetchMark('AAPL', sundayNight, 'live');

    expect(mark.price).toBe(999);
    expect(mark.observed_at).toEqual(new Date('2026-07-15T17:59:30Z'));
  });

  it('backtest mark derives from the last completed bar and ignores the live quote', async () => {
    const source = new AlpacaDataSource(alpacaClient, {
      asset_class: 'stocks',
      markTimeframe: '1h',
    });

    const mark = await source.fetchMark('AAPL', new Date('2026-07-15T15:30:00Z'), 'backtest');

    // The 15:00-close bar, not the live 999 quote.
    expect(mark.price).toBe(104);
    expect(mark.observed_at).toEqual(new Date('2026-07-15T15:00:00Z'));
  });

  it('rejects a ccxt ticker with nothing observable rather than inventing a price', async () => {
    const emptyTicker = new CcxtDataSource(
      { ...ccxtClient, fetchTicker: async () => ({ last: undefined, timestamp: undefined }) },
      KRAKEN,
    );

    await expect(emptyTicker.fetchMark('BTC/USD', ASOF, 'live')).rejects.toThrow(
      /no last price\/timestamp/,
    );
  });
});

describe('market-hours gating', () => {
  const outOfHoursAlpacaBars: AlpacaBar[] = [
    { t: '2026-07-15T12:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }, // 08:00 ET pre-market
    { t: '2026-07-15T14:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }, // 10:00 ET in session
    { t: '2026-07-15T22:00:00Z', o: 3, h: 3, l: 3, c: 3, v: 3 }, // 18:00 ET after hours
  ];

  it('never produces stock bars outside trading hours, even when the source returns them', async () => {
    const source = new AlpacaDataSource(
      { ...alpacaClient, getBars: async () => outOfHoursAlpacaBars },
      { asset_class: 'stocks' },
    );

    const bars = await source.fetchBars('AAPL', WINDOW, new Date('2026-07-16T00:00:00Z'));

    expect(bars.map((b) => b.close)).toEqual([2]);
  });

  it('keeps 24/7 crypto bars on the same Alpaca source when asset_class is crypto', async () => {
    const source = new AlpacaDataSource(
      { ...alpacaClient, getBars: async () => outOfHoursAlpacaBars },
      { asset_class: 'crypto' },
    );

    const bars = await source.fetchBars('BTC/USD', WINDOW, new Date('2026-07-16T00:00:00Z'));

    expect(bars.map((b) => b.close)).toEqual([1, 2, 3]);
  });

  it('gates on an injected calendar, so the real session table can replace the default', async () => {
    const alwaysOpen = new AlwaysOpenCalendar();
    const closedAllWeek: TradingCalendar = {
      isOpen: () => false,
      isTradingDay: () => false,
      sessionStart: (instant) => alwaysOpen.sessionStart(instant),
      sessionEnd: () => null,
    };
    const source = new IbkrDataSource(ibkrClient, { calendar: closedAllWeek });

    expect(await source.fetchBars('AAPL', WINDOW, ASOF)).toEqual([]);
  });

  it('defaults to regular US equity hours when no calendar is injected', async () => {
    const injected = new IbkrDataSource(ibkrClient, {
      calendar: new UsEquityRegularHoursCalendar(),
    });
    const defaulted = new IbkrDataSource(ibkrClient);

    expect(await defaulted.fetchBars('AAPL', WINDOW, ASOF)).toEqual(
      await injected.fetchBars('AAPL', WINDOW, ASOF),
    );
  });
});

describe('point-in-time discipline holds at the source', () => {
  it('excludes the forming bar and includes one closing exactly at asOf', async () => {
    const source = new CcxtDataSource(ccxtClient, KRAKEN);

    const bars = await source.fetchBars(
      'BTC/USD',
      SHORT_FIXTURE_WINDOW,
      new Date('2026-07-15T15:00:00Z'),
    );

    expect(bars.map((b) => b.close_time.toISOString())).toEqual(['2026-07-15T15:00:00.000Z']);
  });

  it('honours the lookback count, returning the most recent bars', async () => {
    const source = new CcxtDataSource(ccxtClient, KRAKEN);

    const bars = await source.fetchBars('BTC/USD', { timeframe: '1h', lookback: 1 }, ASOF);

    expect(bars.map((b) => b.close)).toEqual([107]);
  });
});

describe("the window's short-read policy reaches the source client (#292)", () => {
  it('forwards window.partial to AlpacaClient.getBars, and undefined when unset', async () => {
    const getBars = vi.fn(async (): Promise<AlpacaBar[]> => ALPACA_BARS);
    const source = new AlpacaDataSource(
      { getBars, getLatestQuote: async () => ({ t: ASOF.toISOString(), ap: 1, bp: 1 }) },
      { asset_class: 'stocks' },
    );

    // `WINDOW.lookback + 1`, not `WINDOW.lookback` (issue #362): the raw
    // fetch is widened by `FORMING_BAR_FETCH_MARGIN` so a forming candle
    // dropped by `completedBars` still leaves `WINDOW.lookback` completed.
    await source.fetchBars('AAPL', { ...WINDOW, partial: 'allow' }, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback + 1, 'allow');

    // Unset means "no opt-in" — the client applies its own fail-loud default.
    await source.fetchBars('AAPL', WINDOW, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback + 1, undefined);
  });
});

describe('raw fetch requests one extra bar for the forming candle (#362)', () => {
  it('still returns the caller-requested count of completed bars when the newest raw candle is forming', async () => {
    const asOf = new Date('2026-07-15T18:30:00Z'); // mid-hour: 18:00 candle is still forming
    const source = new AlpacaDataSource(formingCandleClient(asOf), { asset_class: 'crypto' });

    const bars = await source.fetchBars('BTC-USD', { timeframe: '1h', lookback: 14 }, asOf);

    expect(bars).toHaveLength(14);
    expect(bars.every((bar) => bar.close_time.getTime() <= asOf.getTime())).toBe(true);
  });
});

describe('ccxt paginates instead of silently truncating (#497)', () => {
  const HOUR = 3_600_000;

  /**
   * A venue holding `count` hourly candles ending at `endsAt` which, like every
   * real exchange, CAPS a single response at `cap` and reports the capped page
   * as a complete success. That cap is the whole bug: 300 candles on Coinbase,
   * 720 on Kraken, and no error either way.
   */
  function cappedVenue(options: { count: number; endsAt: Date; cap: number }) {
    const candles: CcxtOhlcv[] = Array.from({ length: options.count }, (_, i) => {
      const t = options.endsAt.getTime() - (options.count - 1 - i) * HOUR;
      return [t, 1, 1, 1, 1, 1];
    });
    const sinceArgs: number[] = [];

    const client: CcxtClient = {
      fetchOHLCV: async (_symbol, _timeframe, since = 0, limit) => {
        sinceArgs.push(since);
        return candles
          .filter(([t]) => t >= since)
          .slice(0, Math.min(limit ?? options.cap, options.cap));
      },
      fetchTicker: async () => ({ last: 1, timestamp: options.endsAt.getTime() }),
    };

    return { client, sinceArgs };
  }

  it('walks past the venue cap to serve the whole window, where one call returned the cap', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    // 800 hours of history behind a 300-candle cap: more than two pages, so a
    // single unpaginated call cannot cover it however large the `limit` asked.
    const venue = cappedVenue({ count: 800, endsAt: asOf, cap: 300 });
    const source = new CcxtDataSource(venue.client, { source: 'coinbase' });

    const bars = await source.fetchBars('BTC/USD', { timeframe: '1h', lookback: 500 }, asOf);

    expect(bars).toHaveLength(500);
    // The pre-#497 implementation issued exactly one request and would have
    // returned 300 raw candles here — reported as success.
    expect(venue.sinceArgs.length).toBeGreaterThan(1);
    expect(bars.at(-1)?.close_time).toEqual(asOf);
  });

  it('advances the cursor past the last bar kept, so no page re-fetches what it holds', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    const venue = cappedVenue({ count: 800, endsAt: asOf, cap: 300 });
    const source = new CcxtDataSource(venue.client, { source: 'coinbase' });

    await source.fetchBars('BTC/USD', { timeframe: '1h', lookback: 500 }, asOf);

    // Asserted before the ordering check, which a single-request walk would
    // otherwise satisfy vacuously — that is exactly the pre-#497 behaviour
    // this test exists to exclude.
    expect(venue.sinceArgs.length).toBeGreaterThan(1);
    const strictlyIncreasing = venue.sinceArgs.every(
      (since, i) => i === 0 || since > (venue.sinceArgs[i - 1] ?? 0),
    );
    expect(strictlyIncreasing).toBe(true);
  });

  it('spends fewer requests on a venue whose larger cap pageLimit declares', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    const small = cappedVenue({ count: 800, endsAt: asOf, cap: 300 });
    const large = cappedVenue({ count: 800, endsAt: asOf, cap: 1000 });
    const window = { timeframe: '1h', lookback: 500 } as const;

    await new CcxtDataSource(small.client, { source: 'coinbase' }).fetchBars(
      'BTC/USD',
      window,
      asOf,
    );
    await new CcxtDataSource(large.client, { source: 'bitstamp', pageLimit: 1000 }).fetchBars(
      'BTC/USD',
      window,
      asOf,
    );

    expect(large.sinceArgs.length).toBeLessThan(small.sinceArgs.length);
  });

  it('terminates on a venue that re-serves the same page forever, rather than spinning', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    let calls = 0;
    // Ignores `since` entirely — always the same three candles, always
    // non-empty. An empty-page check alone would never end this walk.
    const stuck: CcxtClient = {
      fetchOHLCV: async () => {
        calls++;
        return [
          [asOf.getTime() - 3 * HOUR, 1, 1, 1, 1, 1],
          [asOf.getTime() - 2 * HOUR, 1, 1, 1, 1, 1],
          [asOf.getTime() - HOUR, 1, 1, 1, 1, 1],
        ];
      },
      fetchTicker: async () => ({ last: 1, timestamp: asOf.getTime() }),
    };
    const source = new CcxtDataSource(stuck, { source: 'coinbase' });

    const bars = await source.fetchBars(
      'BTC/USD',
      { timeframe: '1h', lookback: 2, partial: 'allow' },
      asOf,
    );

    expect(bars).toHaveLength(2);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('refuses to page forever when the venue advances but never reaches asOf', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    // One new candle per request, from deep history: real forward progress, so
    // the no-progress check cannot end it — this is what maxPages is for.
    const crawling: CcxtClient = {
      fetchOHLCV: async (_symbol, _timeframe, since = 0) => [[since, 1, 1, 1, 1, 1]],
      fetchTicker: async () => ({ last: 1, timestamp: asOf.getTime() }),
    };
    const source = new CcxtDataSource(crawling, { source: 'coinbase' });

    await expect(
      source.fetchBars('BTC/USD', { timeframe: '1h', lookback: 10 }, asOf),
    ).rejects.toThrow(CcxtPaginationError);
  });

  it('reports exhausted history loudly once pagination has stopped, not as a short success', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    // Only 5 hours of history exist; 50 bars are asked for.
    const venue = cappedVenue({ count: 5, endsAt: asOf, cap: 300 });
    const source = new CcxtDataSource(venue.client, { source: 'coinbase' });

    await expect(
      source.fetchBars('BTC/USD', { timeframe: '1h', lookback: 50 }, asOf),
    ).rejects.toThrow(CcxtDataUnderfetchError);
  });

  it("still serves the short window when the caller opts in with partial: 'allow'", async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    const venue = cappedVenue({ count: 5, endsAt: asOf, cap: 300 });
    const source = new CcxtDataSource(venue.client, { source: 'coinbase' });

    const bars = await source.fetchBars(
      'BTC/USD',
      { timeframe: '1h', lookback: 50, partial: 'allow' },
      asOf,
    );

    expect(bars.length).toBeLessThan(50);
    expect(bars.length).toBeGreaterThan(0);
  });

  it('stamps provenance with the venue the caller named, since there is no default to be wrong', async () => {
    const asOf = new Date('2026-07-15T18:00:00Z');
    const venue = cappedVenue({ count: 50, endsAt: asOf, cap: 300 });

    const bars = await new CcxtDataSource(venue.client, { source: 'coinbase' }).fetchBars(
      'BTC/USD',
      { timeframe: '1h', lookback: 10 },
      asOf,
    );

    expect(bars.every((bar) => bar.source === 'coinbase')).toBe(true);
  });
});
