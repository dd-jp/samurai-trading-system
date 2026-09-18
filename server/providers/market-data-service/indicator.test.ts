import type { Clock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { FixtureDataSource } from './fixture-data-source.js';
import { computeIndicator, InsufficientBarsError, minimumBarsFor } from './indicators.js';
import { MarketDataServiceImpl } from './service.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';
import type { Bar, BarWindow, DataSource, IndicatorSpec, Mark } from './types.js';

function newStore() {
  return new SqliteMarketDataStore(openSharedStore(':memory:'));
}

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

class CountingDataSource implements DataSource {
  fetchBarsCallCount = 0;

  constructor(private readonly delegate: DataSource) {}

  async fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]> {
    this.fetchBarsCallCount += 1;
    return this.delegate.fetchBars(instrument, window, asOf);
  }

  async fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark> {
    return this.delegate.fetchMark(instrument, asOf, mode);
  }
}

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '1h';
const HOUR_MS = 60 * 60 * 1000;

function bar(closeTime: Date, close: number): Bar {
  return {
    instrument: INSTRUMENT,
    timeframe: TIMEFRAME,
    open_time: new Date(closeTime.getTime() - HOUR_MS),
    close_time: closeTime,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1,
    source: 'fixture',
  };
}

function buildBars(count: number, startTime: Date): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += Math.sin(i / 3) * 2;
    bars.push(bar(new Date(startTime.getTime() + i * HOUR_MS), price));
  }
  return bars;
}

function buildService(bars: Bar[], asOf: Date) {
  const fixture = new FixtureDataSource(
    bars,
    { price: 999, observed_at: asOf, source: 'fixture-live' },
    'crypto',
  );
  const counting = new CountingDataSource(fixture);
  const service = new MarketDataServiceImpl(
    counting,
    new ManualClock(asOf),
    'backtest',
    newStore(),
  );
  return { service, counting };
}

describe('MarketDataServiceImpl.getIndicator', () => {
  const start = new Date('2026-07-01T00:00:00Z');
  const bars = buildBars(50, start);
  const asOf = bars[29].close_time;

  it('is byte-identical across repeated calls with identical inputs', async () => {
    const { service } = buildService(bars, asOf);
    const spec: IndicatorSpec = {
      indicator: 'sma',
      params: { period: 10 },
      timeframe: '1h',
      lookback: 20,
    };

    const first = await service.getIndicator(INSTRUMENT, spec, asOf);
    const second = await service.getIndicator(INSTRUMENT, spec, asOf);
    const third = await new MarketDataServiceImpl(
      new CountingDataSource(
        new FixtureDataSource(bars, { price: 999, observed_at: asOf, source: 'x' }, 'crypto'),
      ),
      new ManualClock(asOf),
      'backtest',
      newStore(),
    ).getIndicator(INSTRUMENT, spec, asOf);

    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });

  it('never collides two different lookback windows for the same indicator+instrument+asOf', async () => {
    const { service } = buildService(bars, asOf);
    const shortLookback = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: {}, timeframe: '1h', lookback: 5 },
      asOf,
    );
    const longLookback = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: {}, timeframe: '1h', lookback: 15 },
      asOf,
    );

    expect(shortLookback.value).not.toBe(longLookback.value);
  });

  it("serves a NON-1h spec off that timeframe's bars (#315)", async () => {
    const fourHour = bars.map((source, i) => ({
      ...source,
      timeframe: '4h',
      close: source.close + 1_000 + i,
      open: source.close + 1_000 + i,
      high: source.close + 1_001 + i,
      low: source.close + 999 + i,
    }));
    const { service } = buildService([...bars, ...fourHour], asOf);

    const hourly = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: {}, timeframe: '1h', lookback: 5 },
      asOf,
    );
    const fourHourly = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: {}, timeframe: '4h', lookback: 5 },
      asOf,
    );

    expect(fourHourly.value).toBeGreaterThan(hourly.value + 900);
  });

  it('never collides two specs differing ONLY in timeframe (#315)', async () => {
    const fourHour = bars.map((source, i) => ({
      ...source,
      timeframe: '4h',
      close: source.close + 1_000 + i,
      open: source.close + 1_000 + i,
      high: source.close + 1_001 + i,
      low: source.close + 999 + i,
    }));
    const { service } = buildService([...bars, ...fourHour], asOf);
    const spec: IndicatorSpec = { indicator: 'sma', params: {}, timeframe: '1h', lookback: 5 };

    const first = await service.getIndicator(INSTRUMENT, { ...spec, timeframe: '1h' }, asOf);
    const second = await service.getIndicator(INSTRUMENT, { ...spec, timeframe: '4h' }, asOf);
    const firstAgain = await service.getIndicator(INSTRUMENT, { ...spec, timeframe: '1h' }, asOf);

    expect(second.value).not.toBe(first.value);
    expect(firstAgain.value).toBe(first.value);
  });

  it('reads the bulk tier once per call, even over a large sequential bar range', async () => {
    const bigBars = buildBars(3000, start);
    const bigAsOf = bigBars[2500].close_time;
    const { service, counting } = buildService(bigBars, bigAsOf);

    await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: { period: 50 }, timeframe: '1h', lookback: 2000 },
      bigAsOf,
    );

    expect(counting.fetchBarsCallCount).toBe(1);
  });

  it('serves repeat reads within a tick from the Tier-1 cache without re-fetching', async () => {
    const { service, counting } = buildService(bars, asOf);
    const spec: IndicatorSpec = {
      indicator: 'ema',
      params: { period: 10 },
      timeframe: '1h',
      lookback: 20,
    };

    await service.getIndicator(INSTRUMENT, spec, asOf);
    await service.getIndicator(INSTRUMENT, spec, asOf);

    expect(counting.fetchBarsCallCount).toBe(1);
  });

  it('sets as_of_bar_close to the close_time of the last bar used', async () => {
    const { service } = buildService(bars, asOf);
    const result = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: { period: 5 }, timeframe: '1h', lookback: 10 },
      asOf,
    );

    expect(result.as_of_bar_close.toISOString()).toBe(asOf.toISOString());
  });

  it('reports RSI 50, not 100, on a strictly flat window (#725)', async () => {
    const flatBars = buildBars(20, start).map((flatBar) => ({ ...flatBar, close: 100 }));
    const { service } = buildService(flatBars, flatBars[19]?.close_time as Date);

    const result = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'rsi', params: { period: 14 }, timeframe: '1h', lookback: 20 },
      flatBars[19]?.close_time as Date,
    );

    expect(result.value).toBe(50);
  });

  it('rejects rather than serving an indicator the stored window is too short for (#319)', async () => {
    const shortHistory = buildBars(8, start);
    const coldAsOf = shortHistory[7]?.close_time as Date;
    const { service } = buildService(shortHistory, coldAsOf);

    await expect(
      service.getIndicator(
        INSTRUMENT,
        { indicator: 'atr', params: { period: 14 }, timeframe: '1h', lookback: 15 },
        coldAsOf,
      ),
    ).rejects.toThrow(InsufficientBarsError);
  });
});

describe('computeIndicator — a period-N indicator is never computed over fewer than N inputs', () => {
  const start = new Date('2026-07-01T00:00:00Z');
  const PERIOD = 14;

  const CASES = [
    { indicator: 'sma', required: PERIOD },
    { indicator: 'ema', required: PERIOD },
    { indicator: 'rsi', required: PERIOD + 1 },
    { indicator: 'atr', required: PERIOD + 1 },
  ] as const;

  it.each(CASES)(
    'throws for $indicator one bar short of its $required',
    ({ indicator, required }) => {
      const spec = { indicator, params: { period: PERIOD }, timeframe: '1h', lookback: required };

      expect(minimumBarsFor(spec)).toBe(required);
      expect(() => computeIndicator(buildBars(required - 1, start), spec)).toThrow(
        InsufficientBarsError,
      );
    },
  );

  it.each(CASES)('computes $indicator at exactly its $required', ({ indicator, required }) => {
    const spec = { indicator, params: { period: PERIOD }, timeframe: '1h', lookback: required };

    const value = computeIndicator(buildBars(required, start), spec);

    expect(Number.isFinite(value)).toBe(true);
  });

  it('refuses the exact case #319 names: 3 bars presented as an ATR(14)', () => {
    const threeBars = buildBars(3, start);
    const spec: IndicatorSpec = {
      indicator: 'atr',
      params: { period: 14 },
      timeframe: '1h',
      lookback: 15,
    };

    const twoRangeMean = computeIndicator(threeBars, {
      indicator: 'atr',
      params: { period: 2 },
      timeframe: '1h',
      lookback: 3,
    });
    expect(twoRangeMean).toBeGreaterThan(0);

    expect(() => computeIndicator(threeBars, spec)).toThrow(InsufficientBarsError);
  });

  it('carries the arity in the error, so a caller can degrade without parsing text', () => {
    const spec: IndicatorSpec = {
      indicator: 'rsi',
      params: { period: 14 },
      timeframe: '1h',
      lookback: 15,
    };

    try {
      computeIndicator(buildBars(9, start), spec);
      expect.unreachable('computeIndicator should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientBarsError);
      const insufficient = error as InsufficientBarsError;
      expect(insufficient.name).toBe('InsufficientBarsError');
      expect(insufficient.indicator).toBe('rsi');
      expect(insufficient.period).toBe(14);
      expect(insufficient.required).toBe(15);
      expect(insufficient.received).toBe(9);
    }
  });

  it('measures against params.period, not the lookback, when the two differ', () => {
    const spec: IndicatorSpec = {
      indicator: 'sma',
      params: { period: 10 },
      timeframe: '1h',
      lookback: 50,
    };

    expect(minimumBarsFor(spec)).toBe(10);
    expect(Number.isFinite(computeIndicator(buildBars(10, start), spec))).toBe(true);
    expect(() => computeIndicator(buildBars(9, start), spec)).toThrow(InsufficientBarsError);
  });

  it('falls back to the lookback as the period when params.period is absent', () => {
    const spec: IndicatorSpec = { indicator: 'sma', params: {}, timeframe: '1h', lookback: 20 };

    expect(minimumBarsFor(spec)).toBe(20);
    expect(() => computeIndicator(buildBars(19, start), spec)).toThrow(InsufficientBarsError);
  });

  it('reports the ORDERING fault, not the length, when a window is both', () => {
    const bothWrong = [...buildBars(3, start)].reverse();

    expect(() =>
      computeIndicator(bothWrong, {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      }),
    ).toThrow(/ascending by close_time/);
  });

  it('rejects a zero or negative period instead of silently meaning the whole window', () => {
    const twenty = buildBars(20, start);

    expect(() =>
      computeIndicator(twenty, {
        indicator: 'sma',
        params: { period: 0 },
        timeframe: '1h',
        lookback: 20,
      }),
    ).toThrow(/positive integer/);
    expect(() =>
      computeIndicator(twenty, {
        indicator: 'sma',
        params: { period: -5 },
        timeframe: '1h',
        lookback: 20,
      }),
    ).toThrow(/positive integer/);
  });
});

describe('computeIndicator — bar ordering is enforced, not assumed', () => {
  const start = new Date('2026-07-01T00:00:00Z');
  const ascending = buildBars(20, start);

  it('throws on a descending window instead of returning a wrong number', () => {
    const descending = [...ascending].reverse();

    expect(() =>
      computeIndicator(descending, { indicator: 'atr', params: {}, timeframe: '1h', lookback: 14 }),
    ).toThrow(/ascending by close_time/);
  });

  it('throws on a single bar out of sequence, not just a fully reversed window', () => {
    const interleaved = [...ascending];
    const straggler = interleaved[3] as Bar;
    interleaved[3] = interleaved[11] as Bar;
    interleaved[11] = straggler;

    expect(() =>
      computeIndicator(interleaved, {
        indicator: 'sma',
        params: {},
        timeframe: '1h',
        lookback: 20,
      }),
    ).toThrow(/ascending by close_time/);
  });

  it('accepts equal close_times — an inversion corrupts the maths, a duplicate does not', () => {
    const duplicated = [...ascending];
    duplicated[5] = { ...(duplicated[4] as Bar) };

    expect(() =>
      computeIndicator(duplicated, { indicator: 'atr', params: {}, timeframe: '1h', lookback: 14 }),
    ).not.toThrow();
  });

  it('leaves a correctly ordered window untouched', () => {
    expect(
      computeIndicator(ascending, { indicator: 'atr', params: {}, timeframe: '1h', lookback: 14 }),
    ).toBeGreaterThan(0);
  });
});
