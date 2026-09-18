import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { AssetClass } from '../../../shared/index.js';
import type { IntelligenceItem } from '../types.js';
import { type ArchivedItem, MiArchiveStore, type RawArchiveRow } from './mi-archive-store.js';
import { MI_SOURCES } from './mi-sources.js';

const ALL_SOURCES = Object.values(MI_SOURCES);

const T0 = new Date('2026-08-15T10:00:00Z');

function item(overrides: Partial<IntelligenceItem> = {}): IntelligenceItem {
  return {
    id: 'alpaca:1',
    source: 'alpaca',
    type: 'news',
    timestamp: T0,
    entity: 'AAPL',
    headline: 'Apple beats on revenue',
    sentiment: 1,
    confidence: 0.8,
    ...overrides,
  };
}

function raw(overrides: Partial<RawArchiveRow> = {}): RawArchiveRow {
  return {
    source: MI_SOURCES.alpacaNews,
    native_id: '1',
    updated_at: T0,
    payload: '{"id":1}',
    ingested_at: T0,
    fidelity: 'live',
    ...overrides,
  };
}

function archived(overrides: Partial<ArchivedItem> = {}): ArchivedItem {
  return {
    source: MI_SOURCES.alpacaNews,
    native_id: '1',
    updated_at: T0,
    entity: 'AAPL',
    asset_class: 'stocks' as AssetClass,
    item: item(),
    ingested_at: T0,
    ...overrides,
  };
}

describe('MiArchiveStore', () => {
  it('round-trips a written item for the asset class that owns it', () => {
    const store = new MiArchiveStore();

    store.write([raw()], [archived()]);

    const read = store.itemsKnownAt('stocks', T0, ALL_SOURCES);
    expect(read).toHaveLength(1);
    expect(read[0]?.headline).toBe('Apple beats on revenue');
    expect(read[0]?.sentiment).toBe(1);
    expect(read[0]?.timestamp).toBeInstanceOf(Date);
  });

  it('does not leak items across asset classes', () => {
    const store = new MiArchiveStore();

    store.write([raw()], [archived()]);

    expect(store.itemsKnownAt('crypto', T0, ALL_SOURCES)).toEqual([]);
  });

  describe('ingested_at is the visibility gate (#558)', () => {
    it('hides a row ingested after asOf', () => {
      const store = new MiArchiveStore();
      const later = new Date('2026-08-15T12:00:00Z');

      store.write(
        [raw({ ingested_at: later })],
        [archived({ ingested_at: later, item: item({ timestamp: later }) })],
      );

      expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)).toEqual([]);
      expect(store.itemsKnownAt('stocks', later, ALL_SOURCES)).toHaveLength(1);
    });

    it('gates on OUR ingest time, not the vendor revision stamp', () => {
      const store = new MiArchiveStore();
      const vendorStampedInThePast = new Date('2026-08-01T00:00:00Z');
      const weActuallyReceivedIt = new Date('2026-08-15T12:00:00Z');

      store.write(
        [raw({ updated_at: vendorStampedInThePast, ingested_at: weActuallyReceivedIt })],
        [
          archived({
            updated_at: vendorStampedInThePast,
            ingested_at: weActuallyReceivedIt,
            item: item({ timestamp: vendorStampedInThePast }),
          }),
        ],
      );

      expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)).toEqual([]);
      expect(store.itemsKnownAt('stocks', weActuallyReceivedIt, ALL_SOURCES)).toHaveLength(1);
    });
  });

  describe('revisions are appended, not collapsed (#554)', () => {
    it('keeps the earlier text alongside the correction', () => {
      const store = new MiArchiveStore();
      const revisedAt = new Date('2026-08-15T11:00:00Z');

      store.write([raw()], [archived()]);
      store.write(
        [raw({ updated_at: revisedAt, payload: '{"id":1,"rev":2}', ingested_at: revisedAt })],
        [
          archived({
            updated_at: revisedAt,
            ingested_at: revisedAt,
            item: item({ headline: 'Apple beats on revenue (corrected)' }),
          }),
        ],
      );

      expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)).toHaveLength(1);
      expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)[0]?.headline).toBe(
        'Apple beats on revenue',
      );
      expect(store.itemsKnownAt('stocks', revisedAt, ALL_SOURCES)).toHaveLength(2);
      expect(store.rawRows(MI_SOURCES.alpacaNews)).toHaveLength(2);
    });
  });

  it('re-ingesting an overlapping window is a no-op, not a duplicate', () => {
    const store = new MiArchiveStore();

    store.write([raw()], [archived()]);
    store.write([raw()], [archived()]);

    expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)).toHaveLength(1);
    expect(store.rawRows(MI_SOURCES.alpacaNews)).toHaveLength(1);
  });

  describe('hasScoredItem', () => {
    it('is false before anything is written', () => {
      const store = new MiArchiveStore();
      expect(store.hasScoredItem(MI_SOURCES.alpacaNews, '1', T0, 'AAPL')).toBe(false);
    });

    it('is true once a matching item is written', () => {
      const store = new MiArchiveStore();
      store.write([raw()], [archived()]);
      expect(store.hasScoredItem(MI_SOURCES.alpacaNews, '1', T0, 'AAPL')).toBe(true);
    });

    it('is false for a raw row archived with no item — the degraded-batch case', () => {
      const store = new MiArchiveStore();
      store.write([raw()], []);

      expect(store.hasItem(MI_SOURCES.alpacaNews, '1', T0)).toBe(true);
      expect(store.hasScoredItem(MI_SOURCES.alpacaNews, '1', T0, 'AAPL')).toBe(false);
    });

    it('is keyed on entity — one raw row can yield several entities, scored independently', () => {
      const store = new MiArchiveStore();
      store.write([raw()], [archived({ entity: 'AAPL', item: item({ entity: 'AAPL' }) })]);

      expect(store.hasScoredItem(MI_SOURCES.alpacaNews, '1', T0, 'AAPL')).toBe(true);
      expect(store.hasScoredItem(MI_SOURCES.alpacaNews, '1', T0, 'TSLA')).toBe(false);
    });
  });

  it('keeps one item per entity from a single raw record', () => {
    const store = new MiArchiveStore();

    store.write(
      [raw()],
      [
        archived({ entity: 'AAPL', item: item({ entity: 'AAPL' }) }),
        archived({ entity: 'TSLA', item: item({ entity: 'TSLA' }) }),
      ],
    );

    expect(store.itemsKnownAt('stocks', T0, ALL_SOURCES)).toHaveLength(2);
  });

  it('reports the newest updated_at as an incremental cursor', () => {
    const store = new MiArchiveStore();
    const later = new Date('2026-08-15T11:00:00Z');

    expect(store.latestUpdatedAt(MI_SOURCES.alpacaNews)).toBeUndefined();

    store.write([raw()], [archived()]);
    store.write([raw({ updated_at: later })], [archived({ updated_at: later })]);

    expect(store.latestUpdatedAt(MI_SOURCES.alpacaNews)?.toISOString()).toBe(later.toISOString());
  });

  it('records fidelity so a backtest cannot silently blend two lookahead guarantees', () => {
    const store = new MiArchiveStore();

    store.write([raw({ fidelity: 'backfill' })], [archived()]);

    expect(store.rawRows(MI_SOURCES.alpacaNews)[0]?.fidelity).toBe('backfill');
  });

  describe('purgeOlderThan (#1060)', () => {
    const NOW = new Date('2026-09-03T00:00:00Z');
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(NOW.getTime() - NINETY_DAYS_MS);

    it('deletes rows strictly older than the cutoff and leaves the rest untouched', () => {
      const store = new MiArchiveStore();
      const old = new Date(cutoff.getTime() - 1);
      const fresh = new Date(cutoff.getTime() + 1);

      store.write(
        [
          raw({ native_id: 'old', updated_at: old, ingested_at: old }),
          raw({ native_id: 'fresh', updated_at: fresh, ingested_at: fresh }),
        ],
        [
          archived({ native_id: 'old', updated_at: old, ingested_at: old }),
          archived({ native_id: 'fresh', updated_at: fresh, ingested_at: fresh }),
        ],
      );

      const result = store.purgeOlderThan(cutoff);

      expect(result).toEqual({ rawDeleted: 1, itemsDeleted: 1 });
      expect(store.rawRows(MI_SOURCES.alpacaNews).map((r) => r.native_id)).toEqual(['fresh']);
      expect(store.itemsKnownAt('stocks', NOW, ALL_SOURCES)).toHaveLength(1);
    });

    it('keeps a row exactly on the cutoff — exactly 90 days old is not "older than" 90 days', () => {
      const store = new MiArchiveStore();

      store.write(
        [raw({ native_id: 'on-edge', updated_at: cutoff, ingested_at: cutoff })],
        [archived({ native_id: 'on-edge', updated_at: cutoff, ingested_at: cutoff })],
      );

      const result = store.purgeOlderThan(cutoff);

      expect(result).toEqual({ rawDeleted: 0, itemsDeleted: 0 });
      expect(store.rawRows(MI_SOURCES.alpacaNews)).toHaveLength(1);
      expect(store.itemsKnownAt('stocks', NOW, ALL_SOURCES)).toHaveLength(1);
    });

    it('deletes or retains a row with no payload purely by age, never by payload presence', () => {
      const store = new MiArchiveStore();
      const old = new Date(cutoff.getTime() - 1);
      const fresh = new Date(cutoff.getTime() + 1);

      store.write(
        [
          raw({ native_id: 'old-no-payload', updated_at: old, ingested_at: old, payload: '' }),
          raw({
            native_id: 'fresh-no-payload',
            updated_at: fresh,
            ingested_at: fresh,
            payload: '',
          }),
        ],
        [],
      );

      store.purgeOlderThan(cutoff);

      const remaining = store.rawRows(MI_SOURCES.alpacaNews).map((r) => r.native_id);
      expect(remaining).toEqual(['fresh-no-payload']);
    });

    it('does nothing when every row is inside the window', () => {
      const store = new MiArchiveStore();
      store.write([raw()], [archived()]);

      expect(store.purgeOlderThan(cutoff)).toEqual({ rawDeleted: 0, itemsDeleted: 0 });
      expect(store.rawRows(MI_SOURCES.alpacaNews)).toHaveLength(1);
    });

    it('does nothing against an empty store', () => {
      const store = new MiArchiveStore();
      expect(store.purgeOlderThan(cutoff)).toEqual({ rawDeleted: 0, itemsDeleted: 0 });
    });

    it('deletes through an index on both tables, not a full scan (#1060)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mi-archive-plan-'));
      const dbPath = join(dir, 'archive.sqlite');
      const store = new MiArchiveStore(dbPath);
      store.write([raw()], [archived()]);
      store.close();

      const db = new BetterSqlite3(dbPath, { readonly: true });
      const planFor = (table: 'mi_archive_raw' | 'mi_items'): string =>
        (
          db
            .prepare(`EXPLAIN QUERY PLAN DELETE FROM ${table} WHERE ingested_at < ?`)
            .all(cutoff.toISOString()) as { detail: string }[]
        )
          .map((row) => row.detail)
          .join(' | ');

      const rawPlan = planFor('mi_archive_raw');
      const itemsPlan = planFor('mi_items');
      db.close();

      expect(rawPlan).toContain('idx_mi_archive_raw_ingested');
      expect(rawPlan).not.toContain('SCAN');
      expect(itemsPlan).toContain('idx_mi_items_ingested');
      expect(itemsPlan).not.toContain('SCAN');
    });
  });

  describe('rawRowsBetween (#1086)', () => {
    const hour = (n: number): Date => new Date(T0.getTime() + n * 60 * 60 * 1000);

    function seeded(): MiArchiveStore {
      const store = new MiArchiveStore();
      store.write(
        [
          raw({ source: MI_SOURCES.gdeltGkg, native_id: 'a', updated_at: hour(0) }),
          raw({ source: MI_SOURCES.gdeltGkg, native_id: 'b', updated_at: hour(1) }),
          raw({ source: MI_SOURCES.gdeltGkg, native_id: 'c', updated_at: hour(2) }),
          raw({ source: MI_SOURCES.alpacaNews, native_id: 'd', updated_at: hour(1) }),
        ],
        [],
      );
      return store;
    }

    it('returns one source over a half-open span of vendor time, in order', () => {
      const rows = seeded().rawRowsBetween(MI_SOURCES.gdeltGkg, hour(0), hour(2));

      expect(rows.map((row) => row.native_id)).toEqual(['a', 'b']);
    });

    it('returns nothing for a span the archive does not reach', () => {
      expect(seeded().rawRowsBetween(MI_SOURCES.gdeltGkg, hour(-5), hour(-1))).toEqual([]);
    });

    it('seeks through migration 0003s index rather than scanning the source', () => {
      const dir = mkdtempSync(join(tmpdir(), 'mi-archive-window-plan-'));
      const dbPath = join(dir, 'archive.sqlite');
      const store = new MiArchiveStore(dbPath);
      store.write([raw({ source: MI_SOURCES.gdeltGkg })], []);
      store.close();

      const db = new BetterSqlite3(dbPath, { readonly: true });
      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM mi_archive_raw
              WHERE source = ? AND updated_at >= ? AND updated_at < ?
              ORDER BY updated_at ASC`,
          )
          .all(MI_SOURCES.gdeltGkg, T0.toISOString(), T0.toISOString()) as { detail: string }[]
      )
        .map((row) => row.detail)
        .join(' | ');
      db.close();

      expect(plan).toContain('idx_mi_archive_raw_source_updated');
      expect(plan).not.toContain('SCAN');
    });
  });
});
