import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { migratedMemoryStore } from '../../shared/store/migrated-template.js';
import { type BarsSource, CfdCatalogue } from './data/index.js';
import {
  barWindowDigest,
  CFD_CATALOGUE_DIGEST_NAME,
  catalogueDigest,
  cycleInputDigests,
  DIGEST_FLOOR_BARS,
  inputChangesSince,
  journalledInputDigests,
  RecordingBarsSource,
  recordInputDigests,
} from './input-digest.js';

const EMPTY_SHA256 = createHash('sha256').digest('hex');
const WIDE = 1_000;

function bar(date: string, close: number): DailyBar {
  return { date, open: close, high: close, low: close, close, volume: 100, rawClose: close };
}

const UP: BarSeries = {
  symbol: 'UP',
  bars: [bar('2026-09-28', 10), bar('2026-09-29', 11), bar('2026-09-30', 12)],
};

function sourceOf(...series: BarSeries[]): BarsSource {
  const bySymbol = new Map(series.map((entry) => [entry.symbol, entry]));
  return { load: (symbol) => bySymbol.get(symbol) };
}

function withBar(series: BarSeries, index: number, change: Partial<DailyBar>): BarSeries {
  return {
    ...series,
    bars: series.bars.map((entry, i) => (i === index ? { ...entry, ...change } : entry)),
  };
}

function dayAt(offset: number): string {
  return new Date(Date.UTC(2025, 0, 1 + offset)).toISOString().slice(0, 10);
}

// count daily bars ending the day before LONG_DAY; offset shifts their first date earlier
function history(symbol: string, count: number, earlier = 0): BarSeries {
  const first = 600 - count - earlier;
  return {
    symbol,
    bars: Array.from({ length: count + earlier }, (_, i) => bar(dayAt(first + i), first + i)),
  };
}

const LONG_DAY = dayAt(600);

const CATALOGUE = new CfdCatalogue({ asOf: '2026-09-29', instruments: [] }, 'f'.repeat(64));
const clock = new SimulatedClock(new Date('2026-09-30T07:30:00.000Z'));

describe('barWindowDigest', () => {
  it('digests only the bars before the trading date, with their first and last dates', () => {
    expect(barWindowDigest('UP', UP, '2026-09-30', WIDE)).toEqual({
      input: 'bars',
      name: 'UP',
      sha256: barWindowDigest('UP', { ...UP, bars: UP.bars.slice(0, 2) }, '2026-10-01', WIDE)
        .sha256,
      first_bar_date: '2026-09-28',
      last_bar_date: '2026-09-29',
      row_count: 2,
      as_of: null,
    });
  });

  it('digests a name with no series as an empty window', () => {
    expect(barWindowDigest('GONE', undefined, '2026-09-30', WIDE)).toMatchObject({
      sha256: EMPTY_SHA256,
      first_bar_date: null,
      last_bar_date: null,
      row_count: 0,
    });
  });

  it('changes when a bar inside the window is rewritten, not for a bar on the day', () => {
    const base = barWindowDigest('UP', UP, '2026-09-30', WIDE).sha256;
    expect(
      barWindowDigest('UP', withBar(UP, 0, { rawClose: 9 }), '2026-09-30', WIDE).sha256,
    ).not.toBe(base);
    expect(barWindowDigest('UP', withBar(UP, 2, { close: 99 }), '2026-09-30', WIDE).sha256).toBe(
      base,
    );
    expect(
      barWindowDigest('UP', withBar(UP, 1, { date: '2026-09-27' }), '2026-09-30', WIDE).sha256,
    ).not.toBe(base);
    for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
      expect(
        barWindowDigest('UP', withBar(UP, 1, { [field]: 7 }), '2026-09-30', WIDE).sha256,
      ).not.toBe(base);
    }
  });
});

describe('barWindowDigest over a window (#2028)', () => {
  const long = history('UP', 300);

  it('digests only the last windowBars bars before the day', () => {
    expect(barWindowDigest('UP', long, LONG_DAY, 200)).toMatchObject({
      row_count: 200,
      first_bar_date: dayAt(400),
      last_bar_date: dayAt(599),
    });
  });

  it('changes for the oldest bar in the window, not for the one just before it', () => {
    const base = barWindowDigest('UP', long, LONG_DAY, 200).sha256;
    expect(barWindowDigest('UP', withBar(long, 100, { close: 1 }), LONG_DAY, 200).sha256).not.toBe(
      base,
    );
    expect(barWindowDigest('UP', withBar(long, 99, { close: 1 }), LONG_DAY, 200).sha256).toBe(base);
  });

  it('does not change when older bars are backfilled', () => {
    expect(barWindowDigest('UP', history('UP', 300, 50), LONG_DAY, 200)).toEqual(
      barWindowDigest('UP', long, LONG_DAY, 200),
    );
  });
});

describe('catalogueDigest', () => {
  it('carries the catalogue sha256 and asOf, or nulls when no catalogue was read', () => {
    expect(catalogueDigest(CATALOGUE)).toMatchObject({
      input: 'cfd_catalogue',
      name: CFD_CATALOGUE_DIGEST_NAME,
      sha256: 'f'.repeat(64),
      as_of: '2026-09-29',
    });
    expect(catalogueDigest(undefined)).toMatchObject({ sha256: null, as_of: null });
  });
});

describe('RecordingBarsSource', () => {
  it('records each name read once, sorted, at the floor window, and forgets them on clear', () => {
    const recording = new RecordingBarsSource(sourceOf(UP));
    expect(recording.load('UP')).toBe(UP);
    expect(recording.load('GONE')).toBeUndefined();
    recording.load('UP');
    expect([...recording.windows()]).toEqual([
      ['GONE', 240],
      ['UP', 240],
    ]);
    recording.clear();
    expect([...recording.windows()]).toEqual([]);
  });

  it('keeps the deepest counted read of each name, never less than the floor', () => {
    const recording = new RecordingBarsSource(sourceOf(UP));
    recording.noteWindow('UP', 400);
    recording.noteWindow('UP', 260);
    recording.load('UP');
    recording.noteWindow('ZED', 20);
    recording.load('ZED');
    recording.noteWindow('ABC', 201);
    expect([...recording.windows()]).toEqual([
      ['ABC', 201],
      ['UP', 400],
      ['ZED', 240],
    ]);
  });

  it('floors at the deepest look-back of the whole-series readers', () => {
    expect(DIGEST_FLOOR_BARS).toBe(240);
  });
});

describe('the input digest journal', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = migratedMemoryStore();
  });

  afterEach(() => {
    db.close();
  });

  const digests = (source: BarsSource, catalogue: CfdCatalogue | undefined) =>
    cycleInputDigests(
      source,
      new Map([
        ['UP', WIDE],
        ['GONE', WIDE],
      ]),
      catalogue,
      '2026-09-30',
    );

  const journalLong = (series: BarSeries, windowBars: number) =>
    recordInputDigests(
      db,
      clock,
      LONG_DAY,
      cycleInputDigests(sourceOf(series), new Map([['UP', windowBars]]), undefined, LONG_DAY),
    );
  const changedNames = (series: BarSeries) =>
    inputChangesSince(db, LONG_DAY, sourceOf(series), undefined).map(
      ({ journalled }) => journalled.name,
    );

  it('reads back what a cycle journalled, the first cycle of the day kept', () => {
    recordInputDigests(db, clock, '2026-09-30', digests(sourceOf(UP), CATALOGUE));
    recordInputDigests(db, clock, '2026-09-30', digests(sourceOf(), undefined));
    expect(journalledInputDigests(db, '2026-09-30')).toEqual(digests(sourceOf(UP), CATALOGUE));
    expect(journalledInputDigests(db, '2026-10-01')).toEqual([]);
  });

  it('refuses an update or a delete', () => {
    recordInputDigests(db, clock, '2026-09-30', digests(sourceOf(UP), CATALOGUE));
    expect(() => db.exec("UPDATE v2_input_digests SET sha256 = 'x'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM v2_input_digests')).toThrow(/append-only/);
  });

  it('reports no change for untouched inputs and each changed input by name', () => {
    recordInputDigests(db, clock, '2026-09-30', digests(sourceOf(UP), CATALOGUE));
    expect(inputChangesSince(db, '2026-09-30', sourceOf(UP), CATALOGUE)).toEqual([]);
    const split = withBar(UP, 1, { close: 5.5, rawClose: 11 });
    const refreshed = new CfdCatalogue({ asOf: '2026-09-30', instruments: [] }, 'e'.repeat(64));
    const changes = inputChangesSince(db, '2026-09-30', sourceOf(split), refreshed);
    expect(changes.map(({ journalled, current }) => [journalled.name, current.input])).toEqual([
      ['UP', 'bars'],
      [CFD_CATALOGUE_DIGEST_NAME, 'cfd_catalogue'],
    ]);
    expect(changes[1]?.current.as_of).toBe('2026-09-30');
  });

  it('journals each name over the window the cycle read it to', () => {
    journalLong(history('UP', 300), 230);
    expect(journalledInputDigests(db, LONG_DAY)[0]).toMatchObject({
      name: 'UP',
      row_count: 230,
      first_bar_date: dayAt(370),
    });
  });

  it('ignores older bars backfilled behind a full window, but not a change inside it', () => {
    journalLong(history('UP', 300), 260);
    expect(changedNames(history('UP', 300, 40))).toEqual([]);
    expect(changedNames(withBar(history('UP', 300), 40, { close: 1 }))).toEqual(['UP']);
    expect(changedNames(withBar(history('UP', 300), 39, { close: 1 }))).toEqual([]);
  });

  it('reports older bars backfilled behind a history shorter than the floor', () => {
    journalLong(history('UP', 150), 240);
    expect(changedNames(history('UP', 150))).toEqual([]);
    expect(changedNames(history('UP', 150, 1))).toEqual(['UP']);
  });

  it('reproduces a whole-history digest journalled before the window', () => {
    journalLong(history('UP', 300), 300);
    expect(changedNames(history('UP', 300))).toEqual([]);
    expect(changedNames(history('UP', 300, 1))).toEqual([]);
    expect(changedNames(withBar(history('UP', 300), 0, { close: 1 }))).toEqual(['UP']);
  });

  it('reads no digests from a store whose schema predates the table', () => {
    db.exec('DROP TABLE v2_input_digests');
    expect(inputChangesSince(db, '2026-09-30', sourceOf(UP), CATALOGUE)).toEqual([]);
  });
});
