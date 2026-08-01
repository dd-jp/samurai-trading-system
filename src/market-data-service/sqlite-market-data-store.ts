/**
 * SQLite-backed `MarketDataStore` over the `bars` / `latest_mark` tables
 * (#194) — the real store behind `MarketDataServiceImpl`'s Tier-2 bulk cache
 * and live mark table. See docs/specs/shared-sqlite-store-spec.md ("Market
 * Data Service" schema section) and docs/specs/market-data-service-spec.md
 * ("Module: Caching", "Module: Marks").
 *
 * `bars.close_time` is stored as ISO-8601 UTC TEXT, matching
 * `SqliteSetupStore`'s convention — `close_time <= ?` is a canonical string
 * comparison.
 */

import type { SharedStore } from '../shared/store/index.js';
import type { Bar, Mark, MarketDataStore } from './types.js';

interface BarRow {
  open_time: string;
  close_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

interface LatestMarkRow {
  price: number;
  observed_at: string;
  asset_class: 'crypto' | 'stocks';
  source: string;
}

export class SqliteMarketDataStore implements MarketDataStore {
  constructor(private readonly db: SharedStore) {}

  /**
   * `INSERT OR IGNORE` on the `(instrument, timeframe, open_time)` PK: a
   * re-ingested bar is silently a no-op rather than a duplicate row or a
   * thrown constraint error — the append-only history stays append-only
   * under retries.
   */
  appendBars(bars: readonly Bar[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO bars
         (instrument, timeframe, open_time, close_time, open, high, low, close, volume, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // One transaction per batch: better-sqlite3 otherwise wraps every run()
    // in its own implicit transaction, an fsync per bar — ~100x slower on
    // bulk backfills (code-review 2026-08-01, H9).
    this.db.transaction(() => {
      for (const bar of bars) {
        insert.run(
          bar.instrument,
          bar.timeframe,
          bar.open_time.toISOString(),
          bar.close_time.toISOString(),
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.source,
        );
      }
    })();
  }

  /**
   * Point-in-time bulk read: most recent `lookback` bars with
   * `close_time <= asOf`, ascending — matching `completedBars`' ordering so
   * this is a drop-in Tier-2 tier for the same callers.
   */
  readBars(instrument: string, timeframe: string, asOf: Date, lookback: number): Bar[] {
    const rows = this.db
      .prepare(
        `SELECT open_time, close_time, open, high, low, close, volume, source
           FROM bars
          WHERE instrument = ? AND timeframe = ? AND close_time <= ?
          ORDER BY close_time DESC
          LIMIT ?`,
      )
      .all(instrument, timeframe, asOf.toISOString(), lookback) as BarRow[];

    return rows
      .map(
        (row): Bar => ({
          instrument,
          timeframe,
          open_time: new Date(row.open_time),
          close_time: new Date(row.close_time),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          source: row.source,
        }),
      )
      .reverse();
  }

  /** One row per instrument — overwrites, since `latest_mark` holds only the current price. */
  upsertLatestMark(instrument: string, mark: Mark): void {
    this.db
      .prepare(
        `INSERT INTO latest_mark (instrument, price, observed_at, asset_class, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instrument) DO UPDATE SET
           price = excluded.price,
           observed_at = excluded.observed_at,
           asset_class = excluded.asset_class,
           source = excluded.source`,
      )
      .run(instrument, mark.price, mark.observed_at.toISOString(), mark.asset_class, mark.source);
  }

  readLatestMark(instrument: string): Mark | undefined {
    const row = this.db
      .prepare(
        'SELECT price, observed_at, asset_class, source FROM latest_mark WHERE instrument = ?',
      )
      .get(instrument) as LatestMarkRow | undefined;

    if (row === undefined) {
      return undefined;
    }

    return {
      price: row.price,
      observed_at: new Date(row.observed_at),
      asset_class: row.asset_class,
      source: row.source,
    };
  }
}
