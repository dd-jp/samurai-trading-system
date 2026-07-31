/**
 * SQLite-backed `CiiSnapshotStore` over the `cii_snapshots` table (#182). See
 * docs/specs/shared-sqlite-store-spec.md ("Market Intelligence" schema
 * section) and cii-snapshot.ts.
 *
 * `INSERT OR IGNORE` on the `(country_code, captured_at)` PK matches
 * `SqliteMarketDataStore.appendBars`'s convention: a re-recorded snapshot
 * (e.g. a retried capture run) is a silent no-op, not a duplicate row or a
 * thrown constraint error — the append-only history stays append-only.
 *
 * `OR IGNORE` swallows *every* constraint violation, not just the PK
 * collision it's meant to dedupe — including the `score BETWEEN 0 AND 100`
 * CHECK, which would otherwise make a caller bug (an out-of-range score)
 * fail silently instead of loudly. `record` checks the range itself first
 * so that case still throws.
 */
import type { SharedStore } from '../../shared/store/index.js';
import type { CiiSnapshotRow, CiiSnapshotStore } from './cii-snapshot.js';

export class SqliteCiiSnapshotStore implements CiiSnapshotStore {
  constructor(private readonly db: SharedStore) {}

  record(row: CiiSnapshotRow): void {
    if (row.score < 0 || row.score > 100) {
      throw new Error(
        `record: score ${row.score} for country=${row.country_code} is out of range [0, 100].`,
      );
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO cii_snapshots (country_code, score, captured_at)
         VALUES (?, ?, ?)`,
      )
      .run(row.country_code, row.score, row.captured_at.toISOString());
  }

  /** Ascending by `captured_at` — the shape the eventual correlation study reads. */
  readHistory(countryCode: string, from: Date, to: Date): CiiSnapshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT country_code, score, captured_at
           FROM cii_snapshots
          WHERE country_code = ? AND captured_at >= ? AND captured_at <= ?
          ORDER BY captured_at ASC`,
      )
      .all(countryCode, from.toISOString(), to.toISOString()) as {
      country_code: string;
      score: number;
      captured_at: string;
    }[];

    return rows.map((row) => ({
      country_code: row.country_code,
      score: row.score,
      captured_at: new Date(row.captured_at),
    }));
  }
}
