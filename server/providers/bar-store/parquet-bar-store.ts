import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type DuckDBConnection, DuckDBInstance, JSDuckDBValueConverter } from '@duckdb/node-api';
import type { BarSeries, DailyBar } from '../../pipeline/momentum/index.js';
import { assertSortedUniqueDates } from '../../pipeline/momentum/index.js';

export const DEFAULT_BAR_STORE_ROOT = 'data/bars/parquet';

const VENUE = /^[a-z]+$/;
const SYMBOL = /^[A-Z0-9][A-Z0-9.]*$/;
const HIVE_TYPES = "{'venue': VARCHAR, 'symbol': VARCHAR, 'year': INTEGER}";
const COLUMNS = 'symbol, CAST(date AS VARCHAR) AS date, open, high, low, close, volume, raw_close';

type BarColumns = [string[], string[], number[], number[], number[], number[], number[], number[]];

export class ParquetBarStore {
  private constructor(
    private readonly root: string,
    private readonly instance: DuckDBInstance,
    private readonly db: DuckDBConnection,
  ) {}

  static async open(root = DEFAULT_BAR_STORE_ROOT): Promise<ParquetBarStore> {
    // A multi-threaded partitioned COPY can split one partition across data_0/data_1 at a thread boundary, so the files are not reproducible
    const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
    return new ParquetBarStore(root, instance, await instance.connect());
  }

  async write(venue: string, series: readonly BarSeries[]): Promise<void> {
    requireVenue(venue);
    const symbols = new Set<string>();
    for (const one of series) {
      validateSeries(one);
      if (symbols.has(one.symbol)) throw new Error(`${venue}: ${one.symbol} written twice`);
      symbols.add(one.symbol);
    }
    if (symbols.size === 0) return;
    mkdirSync(this.root, { recursive: true });
    const staging = mkdtempSync(join(this.root, '.staging-'));
    try {
      await this.stage(venue, series);
      await this.db.run(
        `COPY (SELECT venue, symbol, CAST(year(CAST(date AS DATE)) AS INTEGER) AS year, CAST(date AS DATE) AS date, ` +
          `open, high, low, close, volume, raw_close FROM staged ORDER BY symbol, date) ` +
          `TO ${literal(staging)} (FORMAT parquet, PARTITION_BY (venue, symbol, year), OVERWRITE_OR_IGNORE)`,
      );
      const venueDir = join(this.root, `venue=${venue}`);
      mkdirSync(venueDir, { recursive: true });
      for (const symbol of [...symbols].sort()) {
        const target = join(venueDir, `symbol=${symbol}`);
        rmSync(target, { recursive: true, force: true });
        renameSync(join(staging, `venue=${venue}`, `symbol=${symbol}`), target);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
      await this.db.run('DROP TABLE IF EXISTS staged');
    }
  }

  async readVenue(venue: string): Promise<Map<string, BarSeries>> {
    requireVenue(venue);
    const venueDir = join(this.root, `venue=${venue}`);
    if (!existsSync(venueDir)) return new Map();
    return this.query(join(venueDir, 'symbol=*', 'year=*', '*.parquet'));
  }

  async readSeries(venue: string, symbol: string): Promise<BarSeries | undefined> {
    requireVenue(venue);
    requireSymbol(symbol);
    const symbolDir = join(this.root, `venue=${venue}`, `symbol=${symbol}`);
    if (!existsSync(symbolDir)) return undefined;
    return (await this.query(join(symbolDir, 'year=*', '*.parquet'))).get(symbol);
  }

  close(): void {
    this.db.closeSync();
    this.instance.closeSync();
  }

  private async stage(venue: string, series: readonly BarSeries[]): Promise<void> {
    await this.db.run(
      'CREATE OR REPLACE TEMP TABLE staged (venue VARCHAR, symbol VARCHAR, date VARCHAR, open DOUBLE, ' +
        'high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, raw_close DOUBLE)',
    );
    const appender = await this.db.createAppender('staged');
    for (const one of series) {
      for (const bar of one.bars) {
        appender.appendVarchar(venue);
        appender.appendVarchar(one.symbol);
        appender.appendVarchar(bar.date);
        appender.appendDouble(bar.open);
        appender.appendDouble(bar.high);
        appender.appendDouble(bar.low);
        appender.appendDouble(bar.close);
        appender.appendDouble(bar.volume);
        appender.appendDouble(bar.rawClose);
        appender.endRow();
      }
    }
    appender.closeSync();
  }

  private async query(glob: string): Promise<Map<string, BarSeries>> {
    const result = await this.db.stream(
      `SELECT ${COLUMNS} FROM read_parquet(${literal(glob)}, hive_partitioning = true, ` +
        `hive_types = ${HIVE_TYPES}) ORDER BY symbol, date`,
    );
    const bySymbol = new Map<string, DailyBar[]>();
    for (
      let chunk = await result.fetchChunk();
      chunk !== null && chunk.rowCount > 0;
      chunk = await result.fetchChunk()
    ) {
      appendChunk(bySymbol, chunk.convertColumns(JSDuckDBValueConverter) as unknown as BarColumns);
    }
    const series = new Map<string, BarSeries>();
    for (const [symbol, bars] of bySymbol) {
      const one = { symbol, bars };
      assertSortedUniqueDates(one);
      series.set(symbol, one);
    }
    return series;
  }
}

function appendChunk(bySymbol: Map<string, DailyBar[]>, columns: BarColumns): void {
  const [symbols, dates, opens, highs, lows, closes, volumes, rawCloses] = columns;
  let bars: DailyBar[] = [];
  let current: string | undefined;
  symbols.forEach((symbol, row) => {
    if (symbol !== current) {
      current = symbol;
      bars = bySymbol.get(symbol) ?? [];
      bySymbol.set(symbol, bars);
    }
    bars.push({
      date: dates[row] as string,
      open: opens[row] as number,
      high: highs[row] as number,
      low: lows[row] as number,
      close: closes[row] as number,
      volume: volumes[row] as number,
      rawClose: rawCloses[row] as number,
    });
  });
}

function requireVenue(venue: string): void {
  if (!VENUE.test(venue)) throw new Error(`bar store: invalid venue '${venue}'`);
}

function requireSymbol(symbol: string): void {
  if (!SYMBOL.test(symbol)) throw new Error(`bar store: invalid symbol '${symbol}'`);
}

function validateSeries(series: BarSeries): void {
  requireSymbol(series.symbol);
  if (series.bars.length === 0) throw new Error(`${series.symbol}: no bars to write`);
  assertSortedUniqueDates(series);
  for (const bar of series.bars) {
    const prices = [bar.open, bar.high, bar.low, bar.close, bar.rawClose];
    if (!prices.every((price) => Number.isFinite(price) && price > 0)) {
      throw new Error(`${series.symbol}: non-positive or non-finite price at ${bar.date}`);
    }
    if (!(Number.isFinite(bar.volume) && bar.volume >= 0)) {
      throw new Error(`${series.symbol}: invalid volume at ${bar.date}`);
    }
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
