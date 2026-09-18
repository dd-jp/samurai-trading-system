import { formingCandleClient } from '../forming-candle-client.js';
import {
  AlwaysOpenCalendar,
  type TradingCalendar,
  UsEquityRegularHoursCalendar,
} from '../trading-calendar.js';
import type { BarWindow } from '../types.js';
import { type AlpacaBar, AlpacaDataSource, type AlpacaMarketDataClient } from './alpaca-source.js';

const WINDOW: BarWindow = { timeframe: '1h', lookback: 10 };
const ASOF = new Date('2026-07-15T18:00:00Z');

const ALPACA_BARS: AlpacaBar[] = [
  { t: '2026-07-15T14:00:00Z', o: 100, h: 105, l: 99, c: 104, v: 11 },
  { t: '2026-07-15T15:00:00Z', o: 104, h: 108, l: 103, c: 107, v: 12 },
];

const alpacaClient: AlpacaMarketDataClient = {
  getBars: async () => ALPACA_BARS,
  getLatestQuote: async () => ({ t: '2026-07-15T17:59:30Z', ap: 1001, bp: 997 }),
};

describe('the source normalizes into the canonical Bar shape', () => {
  it('produces canonical bars with derived close_time', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

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
        source: 'alpaca',
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
        source: 'alpaca',
      },
    ]);
  });
});

describe('marks', () => {
  it('alpaca live mark is the quote midpoint observed at the quote time', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

    const mark = await source.fetchMark('AAPL', ASOF, 'live');

    expect(mark).toEqual({
      price: 999,
      observed_at: new Date('2026-07-15T17:59:30Z'),
      source: 'alpaca',
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

    expect(mark.price).toBe(104);
    expect(mark.observed_at).toEqual(new Date('2026-07-15T15:00:00Z'));
  });
});

describe('market-hours gating', () => {
  const outOfHoursAlpacaBars: AlpacaBar[] = [
    { t: '2026-07-15T12:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
    { t: '2026-07-15T14:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 },
    { t: '2026-07-15T22:00:00Z', o: 3, h: 3, l: 3, c: 3, v: 3 },
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
    const source = new AlpacaDataSource(alpacaClient, {
      asset_class: 'stocks',
      calendar: closedAllWeek,
    });

    expect(await source.fetchBars('AAPL', WINDOW, ASOF)).toEqual([]);
  });

  it('defaults to regular US equity hours when no calendar is injected', async () => {
    const injected = new AlpacaDataSource(alpacaClient, {
      asset_class: 'stocks',
      calendar: new UsEquityRegularHoursCalendar(),
    });
    const defaulted = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

    expect(await defaulted.fetchBars('AAPL', WINDOW, ASOF)).toEqual(
      await injected.fetchBars('AAPL', WINDOW, ASOF),
    );
  });
});

describe('point-in-time discipline holds at the source', () => {
  it('excludes the forming bar and includes one closing exactly at asOf', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

    const bars = await source.fetchBars('AAPL', WINDOW, new Date('2026-07-15T15:00:00Z'));

    expect(bars.map((b) => b.close_time.toISOString())).toEqual(['2026-07-15T15:00:00.000Z']);
  });

  it('honours the lookback count, returning the most recent bars', async () => {
    const source = new AlpacaDataSource(alpacaClient, { asset_class: 'stocks' });

    const bars = await source.fetchBars('AAPL', { timeframe: '1h', lookback: 1 }, ASOF);

    expect(bars.map((b) => b.close)).toEqual([107]);
  });
});

describe("the window's short-read policy reaches the source client (#292)", () => {
  it('forwards window.partial to AlpacaMarketDataClient.getBars, and undefined when unset', async () => {
    const getBars = vi.fn(async (): Promise<AlpacaBar[]> => ALPACA_BARS);
    const source = new AlpacaDataSource(
      { getBars, getLatestQuote: async () => ({ t: ASOF.toISOString(), ap: 1, bp: 1 }) },
      { asset_class: 'stocks' },
    );

    await source.fetchBars('AAPL', { ...WINDOW, partial: 'allow' }, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback + 1, 'allow');

    await source.fetchBars('AAPL', WINDOW, ASOF);
    expect(getBars).toHaveBeenLastCalledWith('AAPL', '1h', ASOF, WINDOW.lookback + 1, undefined);
  });
});

describe('raw fetch requests one extra bar for the forming candle (#362)', () => {
  it('still returns the caller-requested count of completed bars when the newest raw candle is forming', async () => {
    const asOf = new Date('2026-07-15T18:30:00Z');
    const source = new AlpacaDataSource(formingCandleClient(asOf), { asset_class: 'crypto' });

    const bars = await source.fetchBars('BTC-USD', { timeframe: '1h', lookback: 14 }, asOf);

    expect(bars).toHaveLength(14);
    expect(bars.every((bar) => bar.close_time.getTime() <= asOf.getTime())).toBe(true);
  });
});
