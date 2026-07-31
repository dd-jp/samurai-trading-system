import { openSharedStore } from '../shared/store/index.js';
import { SqliteMarketDataStore } from './sqlite-market-data-store.js';
import type { Bar, Mark } from './types.js';

const INSTRUMENT = 'BTC-USD';
const TIMEFRAME = '1h';

function bar(closeTime: string, close: number, source = 'kraken'): Bar {
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
    volume: 1,
    source,
  };
}

function makeStore() {
  return new SqliteMarketDataStore(openSharedStore(':memory:'));
}

describe('SqliteMarketDataStore.appendBars', () => {
  it('persists new bars, keyed by (instrument, timeframe, open_time)', () => {
    const store = makeStore();

    store.appendBars([bar('2026-07-15T10:00:00Z', 100)]);

    expect(store.readBars(INSTRUMENT, TIMEFRAME, new Date('2030-01-01'), 10)).toEqual([
      bar('2026-07-15T10:00:00Z', 100),
    ]);
  });

  it('re-ingesting the same bar is idempotent — no duplicate row', () => {
    const store = makeStore();
    const oneBar = bar('2026-07-15T10:00:00Z', 100);

    store.appendBars([oneBar]);
    store.appendBars([oneBar]);
    store.appendBars([oneBar]);

    expect(store.readBars(INSTRUMENT, TIMEFRAME, new Date('2030-01-01'), 10)).toHaveLength(1);
  });

  it('is a no-op on an empty array', () => {
    const store = makeStore();

    expect(() => store.appendBars([])).not.toThrow();
    expect(store.readBars(INSTRUMENT, TIMEFRAME, new Date('2030-01-01'), 10)).toEqual([]);
  });
});

describe('SqliteMarketDataStore.readBars', () => {
  it('returns ascending by close_time, most recent `lookback` at or before asOf', () => {
    const store = makeStore();
    store.appendBars([
      bar('2026-07-15T08:00:00Z', 90),
      bar('2026-07-15T09:00:00Z', 100),
      bar('2026-07-15T10:00:00Z', 110),
      bar('2026-07-15T11:00:00Z', 120), // after asOf — excluded
    ]);

    const bars = store.readBars(INSTRUMENT, TIMEFRAME, new Date('2026-07-15T10:00:00Z'), 2);

    expect(bars.map((b) => b.close)).toEqual([100, 110]);
    expect(bars.map((b) => b.close_time.getTime())).toEqual(
      [...bars]
        .sort((a, b) => a.close_time.getTime() - b.close_time.getTime())
        .map((b) => b.close_time.getTime()),
    );
  });

  it('scopes reads to the requested instrument and timeframe', () => {
    const store = makeStore();
    store.appendBars([
      bar('2026-07-15T10:00:00Z', 100),
      { ...bar('2026-07-15T10:00:00Z', 200), instrument: 'ETH-USD' },
      { ...bar('2026-07-15T10:00:00Z', 300), timeframe: '1d' },
    ]);

    const bars = store.readBars(INSTRUMENT, TIMEFRAME, new Date('2030-01-01'), 10);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(100);
  });
});

describe('SqliteMarketDataStore latest_mark', () => {
  const MARK: Mark = {
    price: 61_000,
    observed_at: new Date('2026-07-15T10:00:00Z'),
    asset_class: 'crypto',
    source: 'kraken',
  };

  it('upserts one row per instrument, including asset_class', () => {
    const store = makeStore();

    store.upsertLatestMark(INSTRUMENT, MARK);

    expect(store.readLatestMark(INSTRUMENT)).toEqual(MARK);
  });

  it('overwrites in place on a second upsert — no new row, latest wins', () => {
    const store = makeStore();
    store.upsertLatestMark(INSTRUMENT, MARK);

    const updated: Mark = { ...MARK, price: 62_000, observed_at: new Date('2026-07-15T11:00:00Z') };
    store.upsertLatestMark(INSTRUMENT, updated);

    expect(store.readLatestMark(INSTRUMENT)).toEqual(updated);
  });

  it('returns undefined for an instrument with no recorded mark', () => {
    expect(makeStore().readLatestMark('never-seen')).toBeUndefined();
  });
});
