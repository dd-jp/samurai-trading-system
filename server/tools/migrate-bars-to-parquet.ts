import { isDeepStrictEqual } from 'node:util';
import { CsvBarsSource } from '../apps/v2/data/index.js';
import type { BarSeries } from '../pipeline/momentum/index.js';
import { DEFAULT_BAR_STORE_ROOT, ParquetBarStore } from '../providers/bar-store/index.js';
import { loadBarDirectory } from './backtest/momentum/bar-csv.js';
import { isMainModule } from './cli-entrypoint.js';

const VENUES = { alpaca: 'data/bars/alpaca', saxo: 'data/bars/saxo' } as const;

async function migrateVenue(
  store: ParquetBarStore,
  venue: keyof typeof VENUES,
): Promise<{ series: number; bars: number }> {
  const directory = VENUES[venue];
  const fromCsv = loadBarDirectory(directory);
  await store.write(venue, [...fromCsv.values()]);
  const fromParquet = await store.readVenue(venue);
  if (!isDeepStrictEqual([...fromParquet.keys()], [...fromCsv.keys()])) {
    throw new Error(`${venue}: Parquet symbols differ from CSV symbols`);
  }
  const v2Reader = new CsvBarsSource(directory);
  let bars = 0;
  for (const [symbol, csv] of fromCsv) {
    const parquet = fromParquet.get(symbol) as BarSeries;
    if (!isDeepStrictEqual(parquet, csv))
      throw new Error(`${venue} ${symbol}: Parquet differs from CSV`);
    if (venue === 'alpaca' && !isDeepStrictEqual(parquet, v2Reader.load(symbol))) {
      throw new Error(`${venue} ${symbol}: Parquet differs from the v2 CSV reader`);
    }
    bars += csv.bars.length;
  }
  return { series: fromCsv.size, bars };
}

if (isMainModule(import.meta.url)) {
  const root = process.argv[2] ?? DEFAULT_BAR_STORE_ROOT;
  const store = await ParquetBarStore.open(root);
  try {
    for (const venue of Object.keys(VENUES) as (keyof typeof VENUES)[]) {
      const { series, bars } = await migrateVenue(store, venue);
      console.log(`${venue}: ${series} series, ${bars} bars, Parquet identical to CSV`);
    }
  } finally {
    store.close();
  }
}
