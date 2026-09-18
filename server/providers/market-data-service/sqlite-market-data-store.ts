import type { StoreHandle } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
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
  constructor(private readonly db: StoreHandle) {}

  appendBars(bars: readonly Bar[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO bars
         (instrument, timeframe, open_time, close_time, open, high, low, close, volume, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      for (const bar of bars) {
        insert.run(
          bar.instrument,
          bar.timeframe,
          toStoredTimestamp(bar.open_time),
          toStoredTimestamp(bar.close_time),
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

  readBars(instrument: string, timeframe: string, asOf: Date, lookback: number): Bar[] {
    const rows = this.db
      .prepare(
        `SELECT open_time, close_time, open, high, low, close, volume, source
           FROM bars
          WHERE instrument = ? AND timeframe = ? AND close_time <= ?
          ORDER BY close_time DESC
          LIMIT ?`,
      )
      .all(instrument, timeframe, toStoredTimestamp(asOf), lookback) as BarRow[];

    return rows
      .map(
        (row): Bar => ({
          instrument,
          timeframe,
          open_time: fromStoredTimestamp(row.open_time),
          close_time: fromStoredTimestamp(row.close_time),
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
      .run(
        instrument,
        mark.price,
        toStoredTimestamp(mark.observed_at),
        mark.asset_class,
        mark.source,
      );
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
      observed_at: fromStoredTimestamp(row.observed_at),
      asset_class: row.asset_class,
      source: row.source,
    };
  }
}
