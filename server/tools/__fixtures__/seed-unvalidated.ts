import { DuckDBInstance } from '@duckdb/node-api';
import type { BarSeries } from '../../pipeline/momentum/index.js';

export async function seedWithoutValidation(
  root: string,
  venue: string,
  series: readonly BarSeries[],
): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { threads: '1' });
  const db = await instance.connect();
  const rows = series.flatMap((one) =>
    one.bars.map(
      (bar) =>
        `('${venue}', '${one.symbol}', DATE '${bar.date}', ${bar.open}, ${bar.high}, ${bar.low}, ${bar.close}, ${bar.volume}, ${bar.rawClose})`,
    ),
  );
  await db.run(
    `COPY (SELECT venue, symbol, CAST(year(date) AS INTEGER) AS year, date, open, high, low, close, volume, raw_close FROM (VALUES ${rows.join(', ')}) AS staged(venue, symbol, date, open, high, low, close, volume, raw_close) ORDER BY symbol, date) TO '${root}' (FORMAT parquet, PARTITION_BY (venue, symbol, year), OVERWRITE_OR_IGNORE)`,
  );
  db.closeSync();
  instance.closeSync();
}
