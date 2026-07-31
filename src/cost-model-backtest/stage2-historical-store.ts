/**
 * Stage 2 historical OHLCV store (ticket #241) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Historical Data
 * Ingestion") and wayfinder map #154 (decisions #155, #157).
 *
 * Ingests daily bars from Polygon/Massive for the MVP universe and persists
 * them to a research-only scratch SQLite file — deliberately NOT the shared
 * store's `bars` table (that table, and its migration, don't exist yet; this
 * store's schema is private and unrelated). A fresh `Stage2HistoricalStore`
 * over `:memory:` is also the fixture shape for tests.
 *
 * The Polygon HTTP client is injected (`PolygonClient`), matching
 * `AlpacaDataSource`'s precedent in market-data-service/sources —
 * provisioning the API key is an ops/setup task, not this module's concern.
 *
 * `membershipDuring` reports every ingested symbol as currently listed
 * (`delisted_at: undefined`): none of the fixed MVP-universe six
 * (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) has been delisted, so there is no real
 * delisting data to source. The seam is real — `assertSurvivorshipFree` runs
 * against it — it simply has nothing to report for this universe.
 */
import BetterSqlite3 from 'better-sqlite3';
import type { Bar } from '../market-data-service/index.js';
import { closeTimeOf } from '../market-data-service/index.js';
import type { ReplayTimeline } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

const TIMEFRAME = '1d';

/** One Polygon daily aggregate, timestamped at the bar's open (epoch ms). */
export interface PolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** The transport seam — a real Polygon/Massive HTTP client, or a test fake. */
export interface PolygonClient {
  /** Daily aggregates for `symbol` over `window`, ascending by open time. */
  fetchAggregates(symbol: string, window: DateRange): Promise<PolygonAggregate[]>;
}

interface Stage2BarRow {
  instrument: string;
  timeframe: string;
  open_time: string;
  close_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Stage2ListingRow {
  symbol: string;
  delisted_at: string | null;
}

export class Stage2HistoricalStore implements ReplayTimeline, InstrumentRegistry {
  private readonly db: BetterSqlite3.Database;

  constructor(
    private readonly client: PolygonClient,
    dbPath = ':memory:',
  ) {
    this.db = new BetterSqlite3(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage2_bars (
        instrument TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (instrument, timeframe, open_time)
      );
      CREATE TABLE IF NOT EXISTS stage2_listing (
        symbol TEXT PRIMARY KEY,
        delisted_at TEXT
      );
    `);
  }

  /**
   * Fetches `symbol`'s daily aggregates over `window` from Polygon and
   * persists them. Idempotent per `(instrument, timeframe, open_time)` —
   * matching `SqliteMarketDataStore.appendBars`'s re-ingest-is-a-no-op
   * convention.
   */
  async ingest(symbol: string, window: DateRange): Promise<void> {
    const aggregates = await this.client.fetchAggregates(symbol, window);

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO stage2_bars
         (instrument, timeframe, open_time, close_time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const aggregate of aggregates) {
      const openTime = new Date(aggregate.t);
      const closeTime = closeTimeOf(openTime, TIMEFRAME);
      insert.run(
        symbol,
        TIMEFRAME,
        openTime.toISOString(),
        closeTime.toISOString(),
        aggregate.o,
        aggregate.h,
        aggregate.l,
        aggregate.c,
        aggregate.v,
      );
    }

    this.db
      .prepare(
        `INSERT INTO stage2_listing (symbol, delisted_at) VALUES (?, NULL)
         ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(symbol);
  }

  /**
   * Point-in-time read: bars for `symbol` with `close_time` inside `window`
   * (inclusive), ascending — the shape `proxySignal` (#242) and the replay
   * driver (#243) consume directly.
   */
  bars(symbol: string, window: DateRange): Bar[] {
    const rows = this.db
      .prepare(
        `SELECT instrument, timeframe, open_time, close_time, open, high, low, close, volume
           FROM stage2_bars
          WHERE instrument = ? AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(symbol, window.start.toISOString(), window.end.toISOString()) as Stage2BarRow[];

    return rows.map((row) => ({
      instrument: row.instrument,
      timeframe: row.timeframe,
      open_time: new Date(row.open_time),
      close_time: new Date(row.close_time),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      source: 'polygon',
    }));
  }

  /** `ReplayTimeline.barTimestamps` — the union of every ingested instrument's close times. */
  async barTimestamps(window: DateRange): Promise<readonly Date[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT close_time
           FROM stage2_bars
          WHERE close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(window.start.toISOString(), window.end.toISOString()) as { close_time: string }[];

    return rows.map((row) => new Date(row.close_time));
  }

  /** `InstrumentRegistry.membershipDuring` — see class doc for the "nothing delisted" posture. */
  async membershipDuring(_window: DateRange): Promise<InstrumentListing[]> {
    const rows = this.db
      .prepare('SELECT symbol, delisted_at FROM stage2_listing')
      .all() as Stage2ListingRow[];

    return rows.map((row) =>
      row.delisted_at === null
        ? { symbol: row.symbol }
        : { symbol: row.symbol, delisted_at: new Date(row.delisted_at) },
    );
  }
}
