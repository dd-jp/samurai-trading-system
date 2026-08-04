import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { FixtureDataSource } from './fixture-data-source.js';
import { computeIndicator } from './indicators.js';
import { MarketDataServiceImpl } from './service.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';
import type { Bar, BarWindow, DataSource, Mark } from './types.js';

function newStore() {
  return new SqliteMarketDataStore(openSharedStore(':memory:'));
}

class ManualClock implements Clock {
  constructor(private time: Date) {}

  now(): Date {
    return this.time;
  }
}

/** Wraps a DataSource to count fetchBars calls — proves the bulk tier reads
 * the window once per getIndicator call, not once per bar. */
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

/** Deterministic, non-monotonic-looking closes so RSI/EMA aren't degenerate. */
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
    const spec = { indicator: 'sma', params: { period: 10 }, lookback: 20 };

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
      { indicator: 'sma', params: {}, lookback: 5 },
      asOf,
    );
    const longLookback = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: {}, lookback: 15 },
      asOf,
    );

    expect(shortLookback.value).not.toBe(longLookback.value);
  });

  it('reads the bulk tier once per call, even over a large sequential bar range', async () => {
    const bigBars = buildBars(3000, start);
    const bigAsOf = bigBars[2500].close_time;
    const { service, counting } = buildService(bigBars, bigAsOf);

    await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: { period: 50 }, lookback: 2000 },
      bigAsOf,
    );

    expect(counting.fetchBarsCallCount).toBe(1);
  });

  it('serves repeat reads within a tick from the Tier-1 cache without re-fetching', async () => {
    const { service, counting } = buildService(bars, asOf);
    const spec = { indicator: 'ema', params: { period: 10 }, lookback: 20 };

    await service.getIndicator(INSTRUMENT, spec, asOf);
    await service.getIndicator(INSTRUMENT, spec, asOf);

    expect(counting.fetchBarsCallCount).toBe(1);
  });

  it('sets as_of_bar_close to the close_time of the last bar used', async () => {
    const { service } = buildService(bars, asOf);
    const result = await service.getIndicator(
      INSTRUMENT,
      { indicator: 'sma', params: { period: 5 }, lookback: 10 },
      asOf,
    );

    expect(result.as_of_bar_close.toISOString()).toBe(asOf.toISOString());
  });
});

/**
 * Ascending order is `computeIndicator`'s documented precondition, and every
 * production indicator computation funnels through it — `getIndicator` here,
 * plus the three call sites that slice their own bars (`trader/decide.ts`,
 * `proxy-strategy.ts`, `replay-driver.ts`). Documenting a contract does not
 * enforce it, and the failure mode is silent: a reversed window yields a
 * plausible-looking number, not an error, and every stop derived from it is
 * mispriced. So the assertion is tested at the choke point rather than at any
 * one caller.
 */
describe('computeIndicator — bar ordering is enforced, not assumed', () => {
  const start = new Date('2026-07-01T00:00:00Z');
  const ascending = buildBars(20, start);

  it('throws on a descending window instead of returning a wrong number', () => {
    const descending = [...ascending].reverse();

    expect(() =>
      computeIndicator(descending, { indicator: 'atr', params: {}, lookback: 14 }),
    ).toThrow(/ascending by close_time/);
  });

  it('throws on a single bar out of sequence, not just a fully reversed window', () => {
    // The realistic feed fault: one straggler stamped in the past. A
    // fully-reversed array is the easy case; this is the one that would slip
    // through a cheaper "is the first bar before the last bar" check.
    const interleaved = [...ascending];
    const straggler = interleaved[3] as Bar;
    interleaved[3] = interleaved[11] as Bar;
    interleaved[11] = straggler;

    expect(() =>
      computeIndicator(interleaved, { indicator: 'sma', params: {}, lookback: 20 }),
    ).toThrow(/ascending by close_time/);
  });

  it('accepts equal close_times — an inversion corrupts the maths, a duplicate does not', () => {
    const duplicated = [...ascending];
    duplicated[5] = { ...(duplicated[4] as Bar) };

    expect(() =>
      computeIndicator(duplicated, { indicator: 'atr', params: {}, lookback: 14 }),
    ).not.toThrow();
  });

  it('leaves a correctly ordered window untouched', () => {
    expect(
      computeIndicator(ascending, { indicator: 'atr', params: {}, lookback: 14 }),
    ).toBeGreaterThan(0);
  });
});
