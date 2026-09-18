import { pathToFileURL } from 'node:url';
import { runFromEnvironment as backfillFromEnvironment } from './backfill-market-data.js';
import { HttpTiingoClient } from './backtest/index.js';
import { ingestTiingoHistory } from './ingest-tiingo-history.js';
import { STAGE2_SCRATCH_DB_PATH } from './run-stage2.js';

const COMMANDS: Readonly<Record<string, () => Promise<void>>> = {
  'ingest-history': () =>
    ingestTiingoHistory({
      client: new HttpTiingoClient(),
      dbPath: STAGE2_SCRATCH_DB_PATH,
    }),
  'backfill-market-data': () => backfillFromEnvironment(),
};

function usage(): string {
  return (
    'Usage: npm run data -- <command>\n\n' +
    'Commands:\n' +
    '  ingest-history         Stage-2 research history from Tiingo into the\n' +
    '                         scratch database (re-runs are free once covered).\n' +
    '  backfill-market-data   Warm-start OHLCV bars for every DEFAULT_UNIVERSE\n' +
    '                         instrument, from the free stack.\n'
  );
}

export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[2];

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(usage());
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  const run = COMMANDS[command];
  if (run === undefined) {
    console.error(`Unknown command ${JSON.stringify(command)}.\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  try {
    await run();
  } catch (error) {
    console.error(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv);
}
