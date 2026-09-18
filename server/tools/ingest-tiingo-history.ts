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
