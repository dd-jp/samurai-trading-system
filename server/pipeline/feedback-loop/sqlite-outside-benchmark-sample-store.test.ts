/**
 * Persistence round-trip for the outside benchmarks (#981).
 *
 * Every value asserted here is deliberately NON-DEFAULT and distinct from every
 * other value in the row — no zeroes, no repeated numbers, no value SQLite could
 * produce by accident. A round-trip test built from defaults passes just as
 * happily when a column is never written at all, which is the failure it exists
 * to catch.
 */
import { openSharedStore } from '../../shared/store/index.js';
import type { OutsideBenchmarkSample } from '../outside-benchmark/index.js';
import { SqliteOutsideBenchmarkSampleStore } from './sqlite-outside-benchmark-sample-store.js';

const COMPUTED_AT = new Date('2026-09-01T12:00:00.000Z');
const WINDOW_FROM = new Date('2026-08-02T12:00:00.000Z');
const WINDOW_TO = new Date('2026-09-01T11:30:00.000Z');

function makeSample(overrides: Partial<OutsideBenchmarkSample> = {}): OutsideBenchmarkSample {
  return {
    computed_at: COMPUTED_AT,
    from: WINDOW_FROM,
    to: WINDOW_TO,
    performance: {
      benchmark: 'spy',
      buy_and_hold_return_pct: 0.0371,
      max_drawdown_pct: 0.0189,
      observation_count: 21,
    },
    ...overrides,
  };
}

describe('SqliteOutsideBenchmarkSampleStore (#981)', () => {
  it('round-trips every column with distinct non-default values', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    store.append(makeSample());
    const [read] = store.getRecent(10, COMPUTED_AT);

    // Each of these would survive a column that is never threaded only if the
    // default happened to equal it — and none of them is a plausible default
    expect(read.computed_at).toEqual(COMPUTED_AT);
    expect(read.from).toEqual(WINDOW_FROM);
    expect(read.to).toEqual(WINDOW_TO);
    expect(read.performance.benchmark).toBe('spy');
    expect(read.performance.buy_and_hold_return_pct).toBe(0.0371);
    expect(read.performance.max_drawdown_pct).toBe(0.0189);
    expect(read.performance.observation_count).toBe(21);
  });

  it('keeps the window DISTINCT from the cycle instant on the way back out', () => {
    // `window_to` is the arm comparison's `to`, which is not the same instant as
    // `computed_at` — a store that wrote `computed_at` into all three timestamp
    // columns would pass a laxer test and silently claim the benchmark covered
    // a window it did not
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    store.append(makeSample());
    const [read] = store.getRecent(10, COMPUTED_AT);

    expect(read.to.getTime()).not.toBe(read.computed_at.getTime());
    expect(read.from.getTime()).toBeLessThan(read.to.getTime());
  });

  it('stores both benchmarks for one cycle without either overwriting the other', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    store.append(makeSample());
    store.append(
      makeSample({
        performance: {
          benchmark: 'sixty_forty',
          buy_and_hold_return_pct: 0.0224,
          max_drawdown_pct: 0.0102,
          observation_count: 21,
        },
      }),
    );

    const rows = store.getRecent(10, COMPUTED_AT);
    expect(rows).toHaveLength(2);
    // The composite primary key is (computed_at, benchmark): same instant, two
    // benchmarks, two rows. A `computed_at`-only key would have kept one.
    expect(rows.map((r) => r.performance.benchmark).sort()).toEqual(['sixty_forty', 'spy']);
    // One cycle's rows must come back with BYTE-IDENTICAL `computed_at` strings,
    // not merely equal instants: the dashboard panel groups a cycle by string
    // equality on the wire value (`row.computed_at === latest.computed_at`), so
    // a round trip that lost, gained or reformatted a millisecond on one row
    // would make the panel render one benchmark and report the other as "not
    // measured this cycle" — a data-outage claim invented by a serializer
    const stamps = rows.map((r) => r.computed_at.toISOString());
    expect(new Set(stamps).size).toBe(1);
    expect(
      rows.find((r) => r.performance.benchmark === 'spy')?.performance.buy_and_hold_return_pct,
    ).toBe(0.0371);
    expect(
      rows.find((r) => r.performance.benchmark === 'sixty_forty')?.performance
        .buy_and_hold_return_pct,
    ).toBe(0.0224);
  });

  it('replaces rather than duplicates a re-run of the same cycle instant', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    store.append(makeSample());
    store.append(
      makeSample({
        performance: {
          benchmark: 'spy',
          buy_and_hold_return_pct: 0.0412,
          max_drawdown_pct: 0.0155,
          observation_count: 22,
        },
      }),
    );

    const rows = store.getRecent(10, COMPUTED_AT);
    // A restart re-measuring the same window is not a second point in the trend
    expect(rows).toHaveLength(1);
    expect(rows[0].performance.buy_and_hold_return_pct).toBe(0.0412);
  });

  it('never returns a sample computed after `asOf`', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    store.append(makeSample());
    const before = new Date(COMPUTED_AT.getTime() - 1);

    expect(store.getRecent(10, before)).toEqual([]);
  });

  it('returns most-recently-computed first', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);
    const later = new Date(COMPUTED_AT.getTime() + 24 * 60 * 60 * 1000);

    store.append(makeSample());
    store.append(makeSample({ computed_at: later }));

    const rows = store.getRecent(10, later);
    expect(rows[0].computed_at).toEqual(later);
    expect(rows[1].computed_at).toEqual(COMPUTED_AT);
  });

  it('refuses a benchmark outside the settled set', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteOutsideBenchmarkSampleStore(db);

    expect(() =>
      store.append(
        makeSample({
          performance: {
            // @ts-expect-error #636 settled the benchmark set (SPY, 60/40) and
            // #981's non-goals rule out reopening it. The type rejects this at
            // compile time and the table's CHECK rejects it at runtime — the
            // second is what stops a hand-written INSERT or a repair script
            // creating a silent third series in the panel's trend
            benchmark: 'nasdaq',
            buy_and_hold_return_pct: 0.01,
            max_drawdown_pct: 0.01,
            observation_count: 5,
          },
        }),
      ),
    ).toThrow();
  });
});
