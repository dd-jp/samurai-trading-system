/**
 * One entry point for the data-loading jobs — `yarn data <command>`.
 *
 * Replaces two near-identical `package.json` scripts (`ingest-history`,
 * `backfill-market-data`) that differed only in which file they pointed at.
 * Both remain available under their old script names, which now delegate here,
 * because a runbook or cron entry may name either.
 *
 * Deliberately a dispatcher rather than a merge: the two jobs load different
 * data from different vendors for different purposes (Stage-2 research history
 * from Tiingo; warm-start bars for the live universe from the free stack), and
 * collapsing them into one "load data" command would hide that a run of one
 * says nothing about the coverage of the other.
 *
 * Both underlying modules keep their own `import.meta.url === argv[1]` guards,
 * so they still run standalone. That guard is why this file calls the exported
 * functions directly instead of importing for side effects — imported as a
 * module, neither self-starts. This file carries the same guard for the same
 * reason: dispatching is what it does when RUN, not when LOADED.
 */

import { pathToFileURL } from 'node:url';
import { runFromEnvironment as backfillFromEnvironment } from './backfill-market-data.js';
import { HttpTiingoClient } from './backtest/index.js';
import { ingestTiingoHistory } from './ingest-tiingo-history.js';
import { STAGE2_SCRATCH_DB_PATH } from './run-stage2.js';

/** Each command's runner, keyed by the word the operator types */
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
    'Usage: yarn data <command>\n\n' +
    'Commands:\n' +
    '  ingest-history         Stage-2 research history from Tiingo into the\n' +
    '                         scratch database (re-runs are free once covered).\n' +
    '  backfill-market-data   Warm-start OHLCV bars for every DEFAULT_UNIVERSE\n' +
    '                         instrument, from the free stack.\n'
  );
}

/** Dispatch one command. Exported so a test can drive it without spawning. */
export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[2];

  if (command === undefined || command === '--help' || command === '-h') {
    // Not an error when asked for explicitly; an error when simply omitted,
    // because a bare `yarn data` that silently did nothing would read as
    // success
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

// Runs only when executed directly, never on import — the same guard
// `run-stage2.ts` and the two underlying jobs use. Without it, importing this
// module for its `COMMANDS` map (a test, or a barrel that happens to re-export
// it) would parse argv and start a network-backed ingest as a side effect
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv);
}
