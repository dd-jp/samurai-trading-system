import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { UsEquityRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import {
  type Clock,
  describeThrownSafely,
  SystemClock,
  sanitizeLogText,
} from '../../../shared/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { createSignalsServer, type SignalsServer } from './server.js';
import { SignalStore } from './store.js';

const DEFAULT_PORT = 8789;

export interface SignalsArgs {
  readonly storePath: string;
  readonly port: number;
}

export function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`V2_SIGNALS_PORT must be an integer port (got ${raw})`);
  }
  return port;
}

export function parseSignalsArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SignalsArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { 'dry-run': { type: 'boolean', default: false }, store: { type: 'string' } },
    strict: true,
  });
  const dryRun = values['dry-run'];
  if (dryRun && values.store !== undefined) {
    throw new Error('--store and --dry-run are exclusive: --dry-run always uses the dry-run store');
  }
  return {
    storePath: values.store ?? (dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH),
    port: parsePort(env.V2_SIGNALS_PORT),
  };
}

export interface ComposedSignals {
  readonly server: SignalsServer;
  readonly db: StoreHandle;
}

export function composeSignals(args: SignalsArgs, clock: Clock): ComposedSignals {
  const db = openSharedStore(args.storePath);
  const server = createSignalsServer({
    port: args.port,
    store: new SignalStore(guardedStore(db, 'v2', { enabled: true }), clock),
    calendar: new UsEquityRegularHoursCalendar(),
    clock,
    onFault: (error) =>
      process.stderr.write(`v2 signals fault: ${sanitizeLogText(describeThrownSafely(error))}\n`),
  });
  return { server, db };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { server, db } = composeSignals(parseSignalsArgs(argv, env), new SystemClock());
  try {
    await server.start();
  } catch (error) {
    db.close();
    throw error;
  }
  process.stdout.write(`v2 signals API on ${server.url} (Swagger UI at ${server.url}/docs)\n`);
  const shutdown = () => {
    void server.stop().finally(() => db.close());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
