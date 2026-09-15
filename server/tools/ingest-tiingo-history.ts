/**
 * One-time 5-year history ingest via Tiingo (review 2026-08-06 A2) —
 * `npm run ingest-history`.
 *
 * Fills the persistent Stage-2 scratch store (`data/stage2-bars.sqlite`)
 * with the pinned 5-year window for the MVP universe, from Tiingo's free
 * tier instead of a paid Polygon depth SKU. Idempotent twice over: the
 * store's `INSERT OR IGNORE` dedups per bar, and `ingest`'s warm-cache
 * check skips the fetch entirely once the window is covered — so re-running
 * this after the first success costs zero API calls.
 *
 * After this has run once, `node dist/server/tools/run-stage2.js` reads the same
 * file and its own (free-tier, 2-year-capped) Polygon ingest finds nothing
 * to add — the 5-year MinBTL verdict becomes computable without any Polygon
 * entitlement.
 */
import {
  DEFAULT_STAGE2_TIMEFRAME,
  HttpTiingoClient,
  Stage2HistoricalStore,
} from './backtest/index.js';
import {
  CRYPTO_SYMBOLS,
  STAGE2_PINNED_WINDOW,
  STAGE2_SCRATCH_DB_PATH,
  STOCK_SYMBOLS,
} from './run-stage2.js';

export interface IngestHistoryDeps {
  client: HttpTiingoClient;
  dbPath: string;
  print?: (line: string) => void;
}

export async function ingestTiingoHistory(deps: IngestHistoryDeps): Promise<void> {
  const print = deps.print ?? console.log;
  // DAILY, stated explicitly (#664): this script backfills crypto daily
  // history, which is the only resolution `HttpTiingoClient` serves.
  const store = new Stage2HistoricalStore(deps.client, {
    timeframe: DEFAULT_STAGE2_TIMEFRAME,
    dbPath: deps.dbPath,
  });
  const window = STAGE2_PINNED_WINDOW;

  print(
    `Tiingo history ingest: ${STOCK_SYMBOLS.length + CRYPTO_SYMBOLS.length} symbols over ` +
      `${window.start.toISOString()} .. ${window.end.toISOString()} -> ${deps.dbPath}`,
  );
  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
    await store.ingest(symbol, window);
    const bars = store.bars(symbol, window);
    const earliest = bars[0]?.open_time.toISOString() ?? 'none';
    const latest = bars[bars.length - 1]?.open_time.toISOString() ?? 'none';
    print(`  ${symbol}: ${bars.length} bars (${earliest} .. ${latest})`);
  }
  print('done — re-runs are free once the window is covered.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestTiingoHistory({
    client: new HttpTiingoClient(),
    dbPath: STAGE2_SCRATCH_DB_PATH,
  }).catch((error: unknown) => {
    console.error('Tiingo history ingest failed:', error);
    process.exitCode = 1;
  });
}
