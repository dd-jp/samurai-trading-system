import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Bar } from '../../providers/market-data-service/index.js';
import { closeTimeOf, timeframeToMs } from '../../providers/market-data-service/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/index.js';
import type { ReplayTimeline } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

export const DEFAULT_STAGE2_TIMEFRAME = '1d';

export interface PolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface PolygonClient {
  fetchAggregates(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]>;
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

export interface Stage2Coverage {
  requestedFrom: Date;
  requestedTo: Date;
  firstBar?: Date | undefined;
  lastBar?: Date | undefined;
}

export function uncoveredRanges(
  window: DateRange,
  coverage: Stage2Coverage | undefined,
): DateRange[] {
  if (!coverage) return [window];

  const gaps: DateRange[] = [];
  if (window.start < coverage.requestedFrom) {
    gaps.push({ start: window.start, end: coverage.requestedFrom });
  }
  if (window.end > coverage.requestedTo) {
    const lastBar = coverage.lastBar;
    const start =
      lastBar !== undefined && lastBar < coverage.requestedTo ? lastBar : coverage.requestedTo;
    gaps.push({ start, end: window.end });
  }
  return gaps;
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const directory = dirname(dbPath);
  if (directory === '.') return;
  mkdirSync(directory, { recursive: true });
}

export interface Stage2HistoricalStoreOptions {
  timeframe: string;
  dbPath?: string;
}

export class Stage2HistoricalStore implements ReplayTimeline, InstrumentRegistry {
  private readonly db: BetterSqlite3.Database;
  readonly timeframe: string;

  constructor(
    private readonly client: PolygonClient,
    options: Stage2HistoricalStoreOptions,
  ) {
    timeframeToMs(options.timeframe);
    this.timeframe = options.timeframe;
    const dbPath = options.dbPath ?? ':memory:';
    ensureParentDirectory(dbPath);
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
      -- What has been ASKED of the vendor, which is not what came back (#495).
      -- A store that inferred coverage from bars alone could never call an
      -- intraday-ending window satisfied, because no daily bar opens at
      -- 18:17 — so it would re-request the tail on every run. See
      -- \`Stage2Coverage\`.
      --
      -- No migration: this schema is research scratch, private to this module
      -- and created on open, unlike the shared store's migration-managed one.
      -- An existing scratch file simply gains the table and, with no recorded
      -- request range, re-ingests once before becoming a no-op.
      CREATE TABLE IF NOT EXISTS stage2_coverage (
        instrument TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        requested_from TEXT NOT NULL,
        requested_to TEXT NOT NULL,
        PRIMARY KEY (instrument, timeframe)
      );
      -- (#664) Every read here filters on (instrument, timeframe, close_time),
      -- and the PRIMARY KEY is on OPEN time, so none of them could use it:
      -- \`bars\` and both timeline queries were full table SCANs. Invisible at
      -- ~500 daily rows per symbol; a cliff at minute resolution, where one
      -- instrument-year is ~98k rows and ten years across four symbols is
      -- ~4M.
      CREATE INDEX IF NOT EXISTS idx_stage2_bars_read
        ON stage2_bars (instrument, timeframe, close_time);
    `);
  }

  #coverage(symbol: string): Stage2Coverage | undefined {
    const requested = this.db
      .prepare(
        `SELECT requested_from, requested_to FROM stage2_coverage
          WHERE instrument = ? AND timeframe = ?`,
      )
      .get(symbol, this.timeframe) as { requested_from: string; requested_to: string } | undefined;
    if (!requested) return undefined;

    const bars = this.db
      .prepare(
        `SELECT MIN(open_time) AS first, MAX(open_time) AS last
           FROM stage2_bars WHERE instrument = ? AND timeframe = ?`,
      )
      .get(symbol, this.timeframe) as { first: string | null; last: string | null } | undefined;

    return {
      requestedFrom: fromStoredTimestamp(requested.requested_from),
      requestedTo: fromStoredTimestamp(requested.requested_to),
      firstBar: bars?.first ? fromStoredTimestamp(bars.first) : undefined,
      lastBar: bars?.last ? fromStoredTimestamp(bars.last) : undefined,
    };
  }

  #recordCoverage(symbol: string, window: DateRange, previous: Stage2Coverage | undefined): void {
    const from =
      previous && previous.requestedFrom < window.start ? previous.requestedFrom : window.start;
    const to = previous && previous.requestedTo > window.end ? previous.requestedTo : window.end;

    this.db
      .prepare(
        `INSERT INTO stage2_coverage (instrument, timeframe, requested_from, requested_to)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(instrument, timeframe) DO UPDATE SET
           requested_from = excluded.requested_from,
           requested_to = excluded.requested_to`,
      )
      .run(symbol, this.timeframe, toStoredTimestamp(from), toStoredTimestamp(to));
  }

  async ingest(symbol: string, window: DateRange): Promise<void> {
    const coverage = this.#coverage(symbol);
    for (const gap of uncoveredRanges(window, coverage)) {
      this.#persist(symbol, await this.client.fetchAggregates(symbol, gap, this.timeframe));
    }
    this.#recordCoverage(symbol, window, coverage);

    this.db
      .prepare(
        `INSERT INTO stage2_listing (symbol, delisted_at) VALUES (?, NULL)
         ON CONFLICT(symbol) DO NOTHING`,
      )
      .run(symbol);
  }

  #persist(symbol: string, aggregates: PolygonAggregate[]): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO stage2_bars
         (instrument, timeframe, open_time, close_time, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction((rows: PolygonAggregate[]) => {
      for (const aggregate of rows) {
        const openTime = new Date(aggregate.t);
        const closeTime = closeTimeOf(openTime, this.timeframe);
        upsert.run(
          symbol,
          this.timeframe,
          toStoredTimestamp(openTime),
          toStoredTimestamp(closeTime),
          aggregate.o,
          aggregate.h,
          aggregate.l,
          aggregate.c,
          aggregate.v,
        );
      }
    })(aggregates);
  }

  bars(symbol: string, window: DateRange): Bar[] {
    const rows = this.db
      .prepare(
        `SELECT instrument, timeframe, open_time, close_time, open, high, low, close, volume
           FROM stage2_bars
          WHERE instrument = ? AND timeframe = ?
            AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(
        symbol,
        this.timeframe,
        toStoredTimestamp(window.start),
        toStoredTimestamp(window.end),
      ) as Stage2BarRow[];

    return rows.map((row) => ({
      instrument: row.instrument,
      timeframe: row.timeframe,
      open_time: fromStoredTimestamp(row.open_time),
      close_time: fromStoredTimestamp(row.close_time),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      source: 'polygon',
    }));
  }

  async barTimestamps(window: DateRange): Promise<readonly Date[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT close_time
           FROM stage2_bars
          WHERE timeframe = ? AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(this.timeframe, toStoredTimestamp(window.start), toStoredTimestamp(window.end)) as {
      close_time: string;
    }[];

    return rows.map((row) => fromStoredTimestamp(row.close_time));
  }

  timelineFor(symbols: readonly string[]): ReplayTimeline {
    if (symbols.length === 0) {
      throw new Error(
        'Stage2HistoricalStore.timelineFor: at least one symbol is required — an empty scope ' +
          'yields an empty timeline, which fails much later as "no bars in the sample".',
      );
    }

    return {
      barTimestamps: async (window: DateRange): Promise<readonly Date[]> =>
        this.barTimestampsFor(symbols, window),
    };
  }

  private barTimestampsFor(
    symbols: readonly string[],
    window: DateRange,
  ): Promise<readonly Date[]> {
    const placeholders = symbols.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT close_time
           FROM stage2_bars
          WHERE instrument IN (${placeholders})
            AND timeframe = ?
            AND close_time >= ? AND close_time <= ?
          ORDER BY close_time ASC`,
      )
      .all(
        ...symbols,
        this.timeframe,
        toStoredTimestamp(window.start),
        toStoredTimestamp(window.end),
      ) as {
      close_time: string;
    }[];

    if (rows.length === 0) {
      const ingested = (
        this.db
          .prepare('SELECT DISTINCT instrument FROM stage2_bars WHERE timeframe = ?')
          .all(this.timeframe) as {
          instrument: string;
        }[]
      ).map((row) => row.instrument);

      const unknown = symbols.filter((symbol) => !ingested.includes(symbol));

      throw new Error(
        `Stage2HistoricalStore.timelineFor: no bars for [${symbols.join(', ')}] at ` +
          `${this.timeframe} between ` +
          `${window.start.toISOString()} and ${window.end.toISOString()}. ` +
          (unknown.length > 0
            ? `Never ingested: [${unknown.join(', ')}]. Ingested: [${ingested.join(', ')}].`
            : 'Those symbols are ingested but have no bars inside this window.'),
      );
    }

    return Promise.resolve(rows.map((row) => fromStoredTimestamp(row.close_time)));
  }

  async membershipDuring(_window: DateRange): Promise<InstrumentListing[]> {
    const rows = this.db
      .prepare('SELECT symbol, delisted_at FROM stage2_listing')
      .all() as Stage2ListingRow[];

    return rows.map((row) =>
      row.delisted_at === null
        ? { symbol: row.symbol }
        : { symbol: row.symbol, delisted_at: fromStoredTimestamp(row.delisted_at) },
    );
  }
}
