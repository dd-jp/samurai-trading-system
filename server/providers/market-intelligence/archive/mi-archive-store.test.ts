import type { AssetClass } from '../../../shared/index.js';
import type { IntelligenceItem } from '../types.js';
import { type ArchivedItem, MiArchiveStore, type RawArchiveRow } from './mi-archive-store.js';
import { MI_SOURCES } from './mi-sources.js';

/** Every read in this file that is not specifically about source filtering. */
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
    // JSON has no Date type; the store's window filter compares Dates, so a
    // string here would silently make every window comparison false.
    expect(read[0]?.timestamp).toBeInstanceOf(Date);
  });

  it('does not leak items across asset classes', () => {
    const store = new MiArchiveStore();

    store.write([raw()], [archived()]);

    expect(store.itemsKnownAt('crypto', T0, ALL_SOURCES)).toEqual([]);
  });

  /**
   * The replay contract (#558). `ingested_at <= asOf` is the whole no-lookahead
   * guarantee for this layer — the MI analogue of the bars idiom
   * `close_time <= asOf`.
   */
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

    /**
     * The distinction that #558 had to correct in #554's wording, and the one
     * that a reasonable implementation gets wrong: `updated_at` is the VENDOR's
     * revision stamp and can be back-dated relative to when we received it.
     * Gating on it would admit a row we did not yet hold — which is reading the
     * future.
     */
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

      // At T0 the vendor's stamp is already in the past, but we had not
      // received the row. It must not be visible.
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

      // Both revisions are held, so a replay at T0 sees the original and a
      // replay after the correction sees both — rather than the correction
      // retroactively rewriting what was knowable earlier.
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

  /**
   * One raw article carries a `symbols[]` array, so an article about three
   * tickers is three items. Keying without `entity` would silently keep one —
   * and the analyst would then see news for AAPL but not for TSLA from the same
   * story, which is a data loss no test downstream would attribute here.
   */
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

  /**
   * The specced 90-day purge (#1060). Keyed on `ingested_at` — the same
   * column `itemsKnownAt`/`hasItem` treat as the visibility gate — NOT
   * `updated_at`, which is the vendor's revision stamp and can be back-dated
   * relative to when we actually received the row.
   */
  describe('purgeOlderThan (#1060)', () => {
    const NOW = new Date('2026-09-03T00:00:00Z');
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(NOW.getTime() - NINETY_DAYS_MS);

    it('deletes rows strictly older than the cutoff and leaves the rest untouched', () => {
      const store = new MiArchiveStore();
      const old = new Date(cutoff.getTime() - 1); // 1ms older than the window
      const fresh = new Date(cutoff.getTime() + 1); // 1ms inside the window

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

    /**
     * The off-by-one this predicate invites: a row EXACTLY on the cutoff is
     * exactly 90 days old, not OLDER than 90 days, so "purge records older
     * than 90 days" keeps it. `< cutoff` (not `<=`) is what that reading
     * requires.
     */
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

    /**
     * #1042 proposes a payload exemption for Reddit vendor bytes — the purge
     * must not assume every row carries one. `payload` is `NOT NULL` today,
     * so an empty string stands in for "no payload"; the predicate never
     * references the column at all, so age is the only thing that decides.
     */
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
  });
});
