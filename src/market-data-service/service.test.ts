import { describe, expect, it } from 'vitest';
import type { Clock } from '../shared/clock.js';
import { FixtureDataSource } from './fixture-data-source.js';
import { MarketDataServiceImpl } from './service.js';
import type { Bar, Quote } from './types.js';

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }

  set(time: Date): void {
    this.time = time;
  }
}

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '1h';

function bar(closeTime: string, close: number, volume = 1): Bar {
  const closeDate = new Date(closeTime);
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    open_time: new Date(closeDate.getTime() - 60 * 60 * 1000),
    close_time: closeDate,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    source: 'fixture',
  };
}

const BARS: Bar[] = [
  bar('2026-07-15T09:00:00Z', 100), // strictly before asOf
  bar('2026-07-15T10:00:00Z', 110), // exactly at asOf
  bar('2026-07-15T11:00:00Z', 120), // forming candle — strictly after asOf
];

const ASOF = new Date('2026-07-15T10:00:00Z');

function buildService(mode: 'live' | 'backtest', clock: Clock, quote?: Quote) {
  const dataSource = new FixtureDataSource(
    BARS,
    { price: 999, observed_at: new Date('2026-07-15T10:59:59Z'), source: 'fixture-live' },
    'crypto',
    quote,
  );
  return new MarketDataServiceImpl(dataSource, clock, mode);
}

describe('MarketDataServiceImpl.getBars', () => {
  it('includes bars with close_time < asOf and close_time === asOf', async () => {
    const service = buildService('backtest', new ManualClock(ASOF));
    const bars = await service.getBars(INSTRUMENT, { timeframe: TIMEFRAME, lookback: 10 }, ASOF);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-07-15T09:00:00.000Z',
      '2026-07-15T10:00:00.000Z',
    ]);
  });

  it('never returns a bar whose close_time > asOf (the forming candle)', async () => {
    const service = buildService('backtest', new ManualClock(ASOF));
    const bars = await service.getBars(INSTRUMENT, { timeframe: TIMEFRAME, lookback: 10 }, ASOF);

    expect(bars.some((b) => b.close_time.getTime() > ASOF.getTime())).toBe(false);
  });

  it('resolves asOf from the injected Clock when not passed explicitly', async () => {
    const clock = new ManualClock(ASOF);
    const service = buildService('backtest', clock);

    const bars = await service.getBars(INSTRUMENT, { timeframe: TIMEFRAME, lookback: 10 });

    expect(bars).toHaveLength(2);
  });
});

describe('MarketDataServiceImpl.getMark', () => {
  it('backtest mode derives from the last completed bar and ignores the live mark', async () => {
    const service = buildService('backtest', new ManualClock(ASOF));

    const mark = await service.getMark(INSTRUMENT, ASOF);

    expect(mark.price).toBe(110); // last completed bar's close, not the live 999
    expect(mark.observed_at.toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });

  it('live mode reads the live mark, not the bar-derived value', async () => {
    const service = buildService('live', new ManualClock(ASOF));

    const mark = await service.getMark(INSTRUMENT, ASOF);

    expect(mark.price).toBe(999);
    expect(mark.observed_at.toISOString()).toBe('2026-07-15T10:59:59.000Z');
  });

  it('runs the same code path live and in replay, differing only by injected Clock/mode', async () => {
    const liveService = buildService('live', new ManualClock(new Date('2026-07-15T12:00:00Z')));
    const backtestService = buildService('backtest', new ManualClock(ASOF));

    const liveMark = await liveService.getMark(INSTRUMENT);
    const backtestMark = await backtestService.getMark(INSTRUMENT);

    expect(liveMark.price).toBe(999);
    expect(backtestMark.price).toBe(110);
  });
});

describe('MarketDataServiceImpl.getSpreadEstimate', () => {
  it('returns null for an instrument with no bid/ask source, not a fabricated value', async () => {
    const service = buildService('backtest', new ManualClock(ASOF));

    const spread = await service.getSpreadEstimate(INSTRUMENT, ASOF);

    expect(spread).toBeNull();
  });

  it('returns ask - bid where the source provides a quote', async () => {
    const quote: Quote = { bid: 99.5, ask: 100.5, observed_at: ASOF };
    const service = buildService('backtest', new ManualClock(ASOF), quote);

    const spread = await service.getSpreadEstimate(INSTRUMENT, ASOF);

    expect(spread).toBe(1);
  });

  it('returns null when the quote is timestamped after asOf (defensive PIT re-check)', async () => {
    const quote: Quote = { bid: 99.5, ask: 100.5, observed_at: new Date('2026-07-15T10:00:01Z') };
    const service = buildService('backtest', new ManualClock(ASOF), quote);

    const spread = await service.getSpreadEstimate(INSTRUMENT, ASOF);

    expect(spread).toBeNull();
  });
});

describe('MarketDataServiceImpl.getADV', () => {
  it('averages bars volume over the window, excluding the forming candle', async () => {
    const volumeBars: Bar[] = [
      bar('2026-07-15T08:00:00Z', 90, 10),
      bar('2026-07-15T09:00:00Z', 100, 20), // strictly before asOf
      bar('2026-07-15T10:00:00Z', 110, 30), // exactly at asOf
      bar('2026-07-15T11:00:00Z', 120, 999), // forming candle — must be excluded
    ];
    const dataSource = new FixtureDataSource(
      volumeBars,
      { price: 999, observed_at: ASOF, source: 'fixture-live' },
      'crypto',
    );
    const service = new MarketDataServiceImpl(dataSource, new ManualClock(ASOF), 'backtest');

    const adv = await service.getADV(INSTRUMENT, { timeframe: TIMEFRAME, lookback: 10 }, ASOF);

    expect(adv).toBe(20); // (10 + 20 + 30) / 3, forming candle excluded
  });

  it('throws rather than returning 0 when the window has no bars', async () => {
    const dataSource = new FixtureDataSource(
      [],
      { price: 999, observed_at: ASOF, source: 'fixture-live' },
      'crypto',
    );
    const service = new MarketDataServiceImpl(dataSource, new ManualClock(ASOF), 'backtest');

    await expect(
      service.getADV(INSTRUMENT, { timeframe: TIMEFRAME, lookback: 10 }, ASOF),
    ).rejects.toThrow();
  });
});
