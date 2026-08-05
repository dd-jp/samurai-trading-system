import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../trading-calendar.js';
import type { BarWindow, DataSource } from '../types.js';
import { type AlpacaBar, type AlpacaClient, AlpacaDataSource } from './alpaca-source.js';
import { type CcxtClient, CcxtDataSource, type CcxtOhlcv } from './ccxt-source.js';
import { type IbkrClient, IbkrDataSource, type IbkrHistoricalBar } from './ibkr-source.js';

const WINDOW: BarWindow = { timeframe: '1h', lookback: 10 };
const ASOF = new Date('2026-07-15T18:00:00Z'); // 14:00 ET, mid-session

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
  const cases: Array<[string, DataSource, string]> = [
    ['ccxt', new CcxtDataSource(ccxtClient), 'kraken'],
    ['alpaca', new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' }), 'alpaca'],
    ['ibkr', new IbkrDataSource(ibkrClient), 'ibkr'],
  ];

  for (const [name, source, expectedProvenance] of cases) {
    it(`${name} produces canonical bars with derived close_time`, async () => {
      const bars = await source.fetchBars('AAPL', WINDOW, ASOF);

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
      new CcxtDataSource(ccxtClient).fetchBars('AAPL', WINDOW, ASOF),
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
    const mark = await new CcxtDataSource(ccxtClient).fetchMark('BTC/USD', ASOF, 'live');

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
    const emptyTicker = new CcxtDataSource({
      ...ccxtClient,
      fetchTicker: async () => ({ last: undefined, timestamp: undefined }),
    });

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
    const source = new CcxtDataSource(ccxtClient);

    const bars = await source.fetchBars('BTC/USD', WINDOW, new Date('2026-07-15T15:00:00Z'));

    expect(bars.map((b) => b.close_time.toISOString())).toEqual(['2026-07-15T15:00:00.000Z']);
  });

  it('honours the lookback count, returning the most recent bars', async () => {
    const source = new CcxtDataSource(ccxtClient);

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

    await source.fetchBars('AAPL', { ...WINDOW, partial: 'allow' }, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback, 'allow');

    // Unset means "no opt-in" — the client applies its own fail-loud default.
    await source.fetchBars('AAPL', WINDOW, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback, undefined);
  });
});
