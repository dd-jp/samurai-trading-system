import { completedBars, deriveBacktestMark, normalizeBars, type RawCandle } from './ingestion.js';
import { AlwaysOpenCalendar, UsEquityRegularHoursCalendar } from './trading-calendar.js';
import type { Bar } from './types.js';

function candle(openTime: string, close: number): RawCandle {
  return { open_time: new Date(openTime), open: close, high: close, low: close, close, volume: 7 };
}

const CRYPTO_CONTEXT = {
  instrument: 'BTC/USD',
  timeframe: '1h',
  source: 'kraken',
  calendar: new AlwaysOpenCalendar(),
};

const STOCK_CONTEXT = {
  instrument: 'AAPL',
  timeframe: '1h',
  source: 'alpaca',
  calendar: new UsEquityRegularHoursCalendar(),
};

describe('normalizeBars', () => {
  it('derives close_time from the source-native open timestamp', () => {
    const [bar] = normalizeBars([candle('2026-07-15T10:00:00Z', 100)], CRYPTO_CONTEXT);

    expect(bar?.open_time.toISOString()).toBe('2026-07-15T10:00:00.000Z');
    expect(bar?.close_time.toISOString()).toBe('2026-07-15T11:00:00.000Z');
  });

  it('stamps instrument, timeframe and source provenance onto every bar', () => {
    const [bar] = normalizeBars([candle('2026-07-15T10:00:00Z', 100)], CRYPTO_CONTEXT);

    expect(bar).toMatchObject({
      instrument: 'BTC/USD',
      timeframe: '1h',
      source: 'kraken',
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 7,
    });
  });

  it('returns bars ordered by close_time regardless of source ordering', () => {
    const bars = normalizeBars(
      [candle('2026-07-15T12:00:00Z', 120), candle('2026-07-15T10:00:00Z', 100)],
      CRYPTO_CONTEXT,
    );

    expect(bars.map((b) => b.close)).toEqual([100, 120]);
  });

  it('keeps every crypto candle — 24/7, no session boundaries', () => {
    const bars = normalizeBars(
      [candle('2026-07-12T03:00:00Z', 100), candle('2026-07-12T04:00:00Z', 101)],
      CRYPTO_CONTEXT,
    );

    expect(bars).toHaveLength(2);
  });

  it('never produces a stock bar outside trading hours', () => {
    // 13:30 UTC = 09:30 ET open (EDT). Pre-market, in-session, and after-close.
    const bars = normalizeBars(
      [
        candle('2026-07-15T12:00:00Z', 1), // 08:00 ET — pre-market
        candle('2026-07-15T14:00:00Z', 2), // 10:00 ET — in session
        candle('2026-07-15T20:00:00Z', 3), // 16:00 ET — opens at the bell, closed
        candle('2026-07-15T22:00:00Z', 4), // 18:00 ET — after hours
      ],
      STOCK_CONTEXT,
    );

    expect(bars.map((b) => b.close)).toEqual([2]);
  });

  it('drops stock bars on non-trading days', () => {
    const bars = normalizeBars([candle('2026-07-18T17:00:00Z', 1)], STOCK_CONTEXT);

    expect(bars).toEqual([]);
  });

  it('admits daily stock bars, which open at midnight outside the session', () => {
    // A '1d' bar timestamped at 00:00 ET would be dropped by an intraday
    // session check; it must be judged on whether the day trades at all.
    const bars = normalizeBars([candle('2026-07-15T04:00:00Z', 100)], {
      ...STOCK_CONTEXT,
      timeframe: '1d',
    });

    expect(bars).toHaveLength(1);
    expect(bars[0]?.close_time.toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('drops daily stock bars on non-trading days', () => {
    const bars = normalizeBars([candle('2026-07-18T04:00:00Z', 100)], {
      ...STOCK_CONTEXT,
      timeframe: '1d',
    });

    expect(bars).toEqual([]);
  });
});

describe('completedBars', () => {
  const bars = normalizeBars(
    [
      candle('2026-07-15T08:00:00Z', 100), // closes 09:00
      candle('2026-07-15T09:00:00Z', 110), // closes 10:00 — exactly asOf
      candle('2026-07-15T10:00:00Z', 120), // closes 11:00 — forming
    ],
    CRYPTO_CONTEXT,
  );
  const asOf = new Date('2026-07-15T10:00:00Z');

  it('includes a bar closing exactly at asOf and excludes the forming bar', () => {
    expect(completedBars(bars, asOf, 10).map((b) => b.close)).toEqual([100, 110]);
  });

  it('returns the most recent lookback bars', () => {
    expect(completedBars(bars, asOf, 1).map((b) => b.close)).toEqual([110]);
  });
});

describe('deriveBacktestMark', () => {
  const bars: Bar[] = normalizeBars(
    [candle('2026-07-15T08:00:00Z', 100), candle('2026-07-15T09:00:00Z', 110)],
    CRYPTO_CONTEXT,
  );

  it("returns the last completed bar's close, observed at that bar's close_time", () => {
    const mark = deriveBacktestMark(bars, 'BTC/USD', new Date('2026-07-15T10:00:00Z'), 'crypto');

    expect(mark).toEqual({
      price: 110,
      observed_at: new Date('2026-07-15T10:00:00.000Z'),
      source: 'kraken',
      asset_class: 'crypto',
    });
  });

  it('ignores bars not yet complete at asOf', () => {
    const mark = deriveBacktestMark(bars, 'BTC/USD', new Date('2026-07-15T09:30:00Z'), 'crypto');

    expect(mark.price).toBe(100);
  });

  it('throws rather than fabricating a price when no bar has completed', () => {
    expect(() =>
      deriveBacktestMark(bars, 'BTC/USD', new Date('2026-07-15T07:00:00Z'), 'crypto'),
    ).toThrow(/No completed bar/);
  });
});
