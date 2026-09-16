/**
 * The Market Intelligence archive.
 *
 * `NousSentimentClient` hard-codes `retrievalEvidence: false` and
 * `GrokAgent.refresh` discards every item without evidence, so
 * `MarketIntelligenceStore` ingests `[]` on every refresh and the `sentiment`
 * and `fundamental` analysts report `NO_DATA_MARKER` on every production
 * tick. That emptiness measurably capped the stocks conviction ceiling at
 * 0.5478 against a 0.55 floor — a stock could never trade at any RSI, in any
 * market — caused by the muted analysts, not by the conviction formula.
 *
 * The rework decouples retrieval from scoring: deterministic fetchers write
 * immutable bytes here, and scoring is a separate pass over text we already
 * hold. No model is asked to *retrieve* anything, which is what made the old
 * design fail closed.
 *
 * Two invariants worth not breaking:
 *
 * `ingested_at` is the visibility gate; `updated_at` is not. `ingested_at`
 * is OUR knowledge time. `updated_at` is the VENDOR's revision stamp and can
 * be back-dated relative to when we received it, so filtering replay on
 * `updated_at` would admit a row we did not yet hold.
 *
 * Scores are stored, never recomputed at replay: per-item LLM scoring is
 * non-deterministic, and re-scoring would make two runs of one backtest
 * disagree (ADR-0003 §2). This does not mean every raw row has a scored item
 * behind it — a degraded scoring batch archives its bytes but not a
 * fabricated score — so `mi_archive_raw` and `mi_items` are allowed to
 * disagree on which rows exist; `hasItem` vs. `hasScoredItem` is the two
 * questions kept separate.
 *
 * This file does not go through `shared/store/sqlite-utils.ts`'s
 * `toStoredTimestamp`/`fromStoredTimestamp` — a deliberate deferral, since
 * this is a different DB with a separate migrations dir.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { AssetClass } from '../../../shared/index.js';
import { runMigrations } from '../../../shared/store/index.js';
import type { IntelligenceItem } from '../types.js';
import type { MiSourceId } from './mi-sources.js';

/** `<dir>/migrations`, resolved next to this module — source and build output alike */
const MI_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Whether a row is as good as live observation.
 *
 * `backfill` is not a lesser *source*, it is a weaker **lookahead guarantee**.
 * GDELT backfill is `live`-equivalent because its batch timestamp IS the
 * knowledge timestamp; Alpaca backfill is `backfill` because `created_at` is
 * publisher time, so the row asserts we would have seen it the instant it
 * published.
 */
type ArchiveFidelity = 'live' | 'backfill';

/** One immutable vendor record, exactly as fetched */
export interface RawArchiveRow {
  /**
   * `MiSourceId`, not `string`: a writer cannot reach the archive without
   * registering in `MI_SOURCES`, and registering forces a boot policy into
   * `MI_SOURCE_HYDRATION`. That is what stops a future source silently
   * inheriting whatever `hydrate()` happens to do.
   */
  source: MiSourceId;
  native_id: string;
  updated_at: Date;
  payload: string;
  ingested_at: Date;
  fidelity: ArchiveFidelity;
}

/** One normalized, scored item derived from a raw row */
export interface ArchivedItem {
  source: MiSourceId;
  native_id: string;
  updated_at: Date;
  entity: string;
  asset_class: AssetClass;
  item: IntelligenceItem;
  ingested_at: Date;
}

interface ItemRow {
  asset_class: string;
  item_json: string;
}

/** `mi_archive_raw` as SQLite hands it back — every column a string */
interface RawRow {
  source: MiSourceId;
  native_id: string;
  updated_at: string;
  payload: string;
  ingested_at: string;
  fidelity: ArchiveFidelity;
}

function toRawArchiveRow(row: RawRow): RawArchiveRow {
  return {
    source: row.source,
    native_id: row.native_id,
    updated_at: new Date(row.updated_at),
    payload: row.payload,
    ingested_at: new Date(row.ingested_at),
    fidelity: row.fidelity,
  };
}

/**
 * SQLite creates the database FILE, never the directory holding it, and the
 * scratch path convention is `data/…` which is gitignored — so it is absent on
 * every fresh clone and better-sqlite3 throws naming neither the path nor the
 * fix. `openSharedStore` and `Stage2HistoricalStore` both had to learn this;
 * so does this one.
 */
function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

/** `data/samurai-mi-{mode}.sqlite` — the path convention, in one place */
export function miArchivePath(mode: string): string {
  return `data/samurai-mi-${mode}.sqlite`;
}

/**
 * The specced retention window, in days. `docs/specs/market-
 * intelligence-spec.md` states it in six places, none of which had an
 * implementation until this one — a 90-day-old news item is not useful to a
 * backtest replay of last week, and the archive stores vendor payloads, the
 * largest rows this system persists.
 */
export const DEFAULT_MI_ARCHIVE_RETENTION_DAYS = 90;

export class MiArchiveStore {
  private readonly db: BetterSqlite3.Database;

  /**
   * `readonly` is what `backtest` mode opens the PAPER archive with: no
   * snapshot to keep current, always the deepest history available, and it
   * matches the bars precedent where backtest bypasses caches and never
   * writes. MI has its own file, so a backtest reading it cannot contend
   * with the money path's writer at all.
   */
  constructor(dbPath = ':memory:', options: { readonly?: boolean } = {}) {
    if (options.readonly === true) {
      this.db = new BetterSqlite3(dbPath, { readonly: true });
      return;
    }
    ensureParentDirectory(dbPath);
    this.db = new BetterSqlite3(dbPath);
    // WAL so a read-only backtest handle does not block the live writer, and
    // vice versa. The whole point of the separate file is that these two never
    // wait on each other
    this.db.pragma('journal_mode = WAL');
    runMigrations(this.db, MI_MIGRATIONS_DIR);
  }

  /**
   * Writes raw rows and their derived items in ONE transaction.
   *
   * Either array may be empty — a raw row with no item is how a degraded
   * scoring batch keeps its bytes without fabricating a score (the caller
   * writes `items: []` in that case). The reverse is NOT valid: an item
   * whose raw row is missing has no provenance, and provenance is what
   * `retrievalEvidence` means — an item is evidenced iff it links archive
   * rows we fetched. Not enforced by a foreign key (`PRAGMA foreign_keys` is
   * off here, see the class doc), so a caller must still write an item's raw
   * row — here or in an earlier call — before the item.
   *
   * `INSERT OR IGNORE` on the natural key, matching the bars idiom:
   * re-fetching an overlapping window is a no-op rather than a duplicate. A
   * genuine revision arrives with a different `updated_at` and is therefore
   * a new row, not a conflict.
   */
  write(raws: readonly RawArchiveRow[], items: readonly ArchivedItem[]): void {
    const insertRaw = this.db.prepare(
      `INSERT OR IGNORE INTO mi_archive_raw
         (source, native_id, updated_at, payload, ingested_at, fidelity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertItem = this.db.prepare(
      `INSERT OR IGNORE INTO mi_items
         (source, native_id, updated_at, entity, asset_class, timestamp,
          sentiment, confidence, item_json, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const raw of raws) {
        insertRaw.run(
          raw.source,
          raw.native_id,
          raw.updated_at.toISOString(),
          raw.payload,
          raw.ingested_at.toISOString(),
          raw.fidelity,
        );
      }
      for (const row of items) {
        insertItem.run(
          row.source,
          row.native_id,
          row.updated_at.toISOString(),
          row.entity,
          row.asset_class,
          row.item.timestamp.toISOString(),
          row.item.sentiment,
          row.item.confidence,
          JSON.stringify(row.item),
          row.ingested_at.toISOString(),
        );
      }
    })();
  }

  /**
   * Everything knowable at `asOf` for one asset class — the replay read
   * contract.
   *
   * `ingested_at <= asOf` is the whole guarantee, and it is the MI analogue
   * of the bars idiom `close_time <= asOf`. Live passes `clock.now()` and
   * sees everything; a backtest passes simulated `t` and sees exactly what
   * had been fetched by then.
   *
   * `sources` narrows the read to the sources the CALLER may replay, because
   * not every archived item means the same thing when it is read back.
   * Startup hydration passes `HYDRATING_MI_SOURCES`; see `mi-sources.ts`.
   */
  itemsKnownAt(
    asset_class: AssetClass,
    asOf: Date,
    sources: readonly MiSourceId[],
  ): IntelligenceItem[] {
    // Required, not optional-with-a-default. A default would be a silent
    // policy, and the whole point of `MI_SOURCE_HYDRATION` is that the
    // policy is stated where it is decided. Callers pass
    // `HYDRATING_MI_SOURCES` for the boot read; an offline re-derivation
    // names the one source it is re-deriving
    if (sources.length === 0) return [];
    const placeholders = sources.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT asset_class, item_json FROM mi_items
          WHERE asset_class = ? AND ingested_at <= ?
            AND source IN (${placeholders})
          ORDER BY timestamp ASC`,
      )
      .all(asset_class, asOf.toISOString(), ...sources) as ItemRow[];

    return rows.map((row) => {
      const item = JSON.parse(row.item_json) as IntelligenceItem;
      // JSON has no Date type; the store's window filter compares Dates
      return { ...item, timestamp: new Date(item.timestamp) };
    });
  }

  /**
   * Is this exact vendor revision's raw payload already archived?
   *
   * The fetch-side dedup gate ONLY: whether another `mi_archive_raw` row for
   * this article would be redundant. NOT whether it needs scoring — a raw
   * row can exist with no scored item behind it (a batch that degraded
   * still archives its bytes, `write`'s doc explains why), so using this to
   * decide scoring eligibility would silently exempt a degraded article
   * from every future attempt. `hasScoredItem` is that gate.
   */
  hasItem(source: MiSourceId, native_id: string, updated_at: Date): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM mi_archive_raw
          WHERE source = ? AND native_id = ? AND updated_at = ?`,
      )
      .get(source, native_id, updated_at.toISOString()) as { present: number } | undefined;

    return row !== undefined;
  }

  /**
   * Is this exact vendor revision already SCORED, for this entity?
   *
   * The pre-scoring dedup gate (`hasItem` is not it — see its doc). A
   * refresh window deliberately overlaps the previous one (a publisher can
   * stamp its time slightly behind the wire), so most of what a poll
   * returns already has a scored item. Re-scoring one would bill tokens for
   * an answer already on disk and, worse, mint a SECOND, different score
   * for one row — non-determinism banned from replay. Keyed on all four
   * columns of `mi_items`' own primary key, `entity` included: one raw row
   * can yield several entities' items (a multi-symbol article), scored
   * independently.
   */
  hasScoredItem(source: MiSourceId, native_id: string, updated_at: Date, entity: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM mi_items
          WHERE source = ? AND native_id = ? AND updated_at = ? AND entity = ?`,
      )
      .get(source, native_id, updated_at.toISOString(), entity) as { present: number } | undefined;

    return row !== undefined;
  }

  /**
   * The newest `updated_at` held for a source, or undefined when it has never
   * been fetched. Fetchers use it as an incremental cursor so a restart does
   * not re-request from 2015.
   */
  latestUpdatedAt(source: MiSourceId): Date | undefined {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS newest FROM mi_archive_raw WHERE source = ?')
      .get(source) as { newest: string | null } | undefined;

    return row?.newest == null ? undefined : new Date(row.newest);
  }

  /** Raw rows for re-derivation — the point of keeping the bytes */
  rawRows(source: MiSourceId): RawArchiveRow[] {
    const rows = this.db
      .prepare('SELECT * FROM mi_archive_raw WHERE source = ? ORDER BY ingested_at ASC')
      .all(source) as RawRow[];

    return rows.map(toRawArchiveRow);
  }

  /**
   * Raw rows for one source over a half-open span of VENDOR time, `[from, to)`.
   *
   * The read a trailing-window derivation needs. `rawRows` above is the
   * whole table for a source, which is the right shape for an offline
   * re-normalization and the wrong one for a statistic recomputed every
   * poll: the GDELT half of the paper archive is 168,026 rows and this
   * window is ~20,000 of them.
   *
   * Keyed on `updated_at`, NOT `ingested_at` — different questions.
   * `ingested_at` is our knowledge time, the replay visibility gate;
   * `updated_at` is the vendor's own stamp, which is what a window ABOUT
   * the news has to be measured over. Safe for GDELT specifically because
   * its batch time IS its knowledge time (`0001_mi_archive.sql` records why
   * its backfill is `'live'` fidelity); a source whose `updated_at` can
   * precede its `ingested_at` — Alpaca's publisher time — must not use this
   * read for a lookahead-sensitive purpose without adding that filter.
   *
   * Half-open so consecutive windows tile without double-counting the row
   * on the boundary, and indexed by migration 0003.
   */
  rawRowsBetween(source: MiSourceId, from: Date, to: Date): RawArchiveRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mi_archive_raw
          WHERE source = ? AND updated_at >= ? AND updated_at < ?
          ORDER BY updated_at ASC`,
      )
      .all(source, from.toISOString(), to.toISOString()) as RawRow[];

    return rows.map(toRawArchiveRow);
  }

  /**
   * The specced 90-day purge (#1060), applied against BOTH tables.
   *
   * Keyed on `ingested_at` — the same visibility-gate column `itemsKnownAt`
   * and `hasItem` key on — not `updated_at`, which is the vendor's revision
   * stamp and can be back-dated relative to when we actually received a row.
   * A window measured on `updated_at` could purge a row we only just
   * received, which is exactly backwards for a retention policy meant to
   * bound disk by AGE of our own knowledge.
   *
   * `< cutoff`, not `<=`: a row exactly on the cutoff is exactly as old as
   * the window allows, not OLDER than it, so "purge records older than N
   * days" keeps it.
   *
   * Both tables, not just `mi_archive_raw`. This store does not turn on
   * `PRAGMA foreign_keys` (see `toArchivedItem` in `polymarket-agent.ts` for
   * why), so purging only the parent table would silently orphan `mi_items`
   * rows rather than fail loudly — the same drift-goes-unnoticed hazard that
   * comment already names. The predicate never references `payload`, so a
   * row with no payload (#1042's proposed Reddit exemption) is purged or kept
   * purely by age, exactly like every other row.
   *
   * One transaction, so a crash between the two deletes cannot leave a
   * `mi_items` row pointing at a raw row that is already gone.
   *
   * Both deletes are indexed. `mi_archive_raw` had `idx_mi_archive_raw_
   * ingested (ingested_at)` since migration 0001; `mi_items` did not —
   * `idx_mi_items_class_ingested (asset_class, ingested_at)` is a composite
   * keyed FIRST on `asset_class`, which SQLite cannot use for a range on the
   * trailing column when the query has no `asset_class` predicate, as this
   * one does not. Migration 0002 adds `idx_mi_items_ingested (ingested_at)`
   * for exactly this delete; `mi-archive-store.test.ts` pins both plans via
   * `EXPLAIN QUERY PLAN` against a real on-disk file.
   */
  purgeOlderThan(cutoff: Date): { rawDeleted: number; itemsDeleted: number } {
    const cutoffIso = cutoff.toISOString();
    return this.db.transaction(() => {
      const itemsDeleted = this.db
        .prepare('DELETE FROM mi_items WHERE ingested_at < ?')
        .run(cutoffIso).changes;
      const rawDeleted = this.db
        .prepare('DELETE FROM mi_archive_raw WHERE ingested_at < ?')
        .run(cutoffIso).changes;
      return { rawDeleted, itemsDeleted };
    })();
  }

  /**
   * The persisted consecutive-refusal streak for one curated row (#1120),
   * `0` when it has never been refused or has answered since. Read before a
   * fresh process's first refusal so the count continues across a restart
   * instead of restarting at 1 — see migration 0004.
   */
  refusalStreak(source: MiSourceId, row_id: string): number {
    const row = this.db
      .prepare('SELECT streak FROM mi_refusal_streaks WHERE source = ? AND row_id = ?')
      .get(source, row_id) as { streak: number } | undefined;

    return row?.streak ?? 0;
  }

  /** Persists `streak` as the row's current consecutive-refusal count */
  recordRefusalStreak(
    source: MiSourceId,
    row_id: string,
    streak: number,
    reason: string,
    asOf: Date,
  ): void {
    this.db
      .prepare(
        `INSERT INTO mi_refusal_streaks (source, row_id, streak, last_reason, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, row_id) DO UPDATE SET
           streak = excluded.streak,
           last_reason = excluded.last_reason,
           updated_at = excluded.updated_at`,
      )
      .run(source, row_id, streak, reason, asOf.toISOString());
  }

  /** Clears the persisted streak once a row answers again — see `recordRefusalStreak` */
  clearRefusalStreak(source: MiSourceId, row_id: string): void {
    this.db
      .prepare('DELETE FROM mi_refusal_streaks WHERE source = ? AND row_id = ?')
      .run(source, row_id);
  }

  close(): void {
    this.db.close();
  }
}
