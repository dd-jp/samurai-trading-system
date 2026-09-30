import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { UsEquityRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import {
  type Clock,
  describeThrownSafely,
  type Logger,
  SystemClock,
  sanitizeLogText,
} from '../../../shared/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  composeV2Root,
  knownSecretsFrom,
  llmKeysPresent,
  nousOptionsFrom,
  rootOptionsFor,
  V2_DRY_RUN_STORE_PATH,
  V2_STORE_PATH,
} from '../index.js';
import { ALL_PINS, verifyNousPins } from '../signal/index.js';
import { SIGNAL_POLL_MS, SignalLoop } from './loop.js';
import { createSignalsServer, type SignalsServer } from './server.js';
import { SignalStore } from './store.js';

const DEFAULT_PORT = 8789;

export interface SignalsArgs {
  readonly storePath: string;
  readonly port: number;
  readonly dryRun: boolean;
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
    dryRun,
  };
}

export interface ComposedSignals {
  readonly server: SignalsServer;
  readonly db: StoreHandle;
  readonly loop: SignalLoop;
}

const STDERR_LOGGER: Logger = {
  log: (entry) => {
    process.stderr.write(`${sanitizeLogText(JSON.stringify(entry))}\n`);
  },
};

export function composeSignals(
  args: SignalsArgs,
  clock: Clock,
  env: NodeJS.ProcessEnv = {},
  logger: Logger = STDERR_LOGGER,
): ComposedSignals {
  const db = openSharedStore(args.storePath);
  const store = new SignalStore(guardedStore(db, 'v2', { enabled: true }), clock);
  const calendar = new UsEquityRegularHoursCalendar();
  const loop = new SignalLoop({
    signals: store,
    calendar,
    clock,
    logger,
    openRoot: (tradingDate) =>
      composeV2Root({
        ...rootOptionsFor(args.dryRun, tradingDate, env, clock, logger),
        storePath: args.storePath,
      }),
  });
  const server = createSignalsServer({
    port: args.port,
    store,
    calendar,
    clock,
    onRecorded: () => {
      void loop.tick();
    },
    onFault: (error) =>
      process.stderr.write(`v2 signals fault: ${sanitizeLogText(describeThrownSafely(error))}\n`),
  });
  return { server, db, loop };
}

export type PinCheck = (dryRun: boolean, env: NodeJS.ProcessEnv) => Promise<void>;

const NOUS_PIN_CHECK: PinCheck = (dryRun, env) => {
  const nous = nousOptionsFrom(env);
  return verifyNousPins({
    dryRun,
    baseUrl: nous.nousBaseUrl,
    apiKey: nous.nousApiKey,
    pins: ALL_PINS,
    logger: STDERR_LOGGER,
    secrets: knownSecretsFrom(env),
  });
};

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  pinCheck: PinCheck = NOUS_PIN_CHECK,
): Promise<void> {
  const args = parseSignalsArgs(argv, env);
  if (
    !args.dryRun &&
    !llmKeysPresent({ tradingDate: '', dryRun: false, ...nousOptionsFrom(env) })
  ) {
    throw new Error(
      'v2 signals refuses a paper run without NOUS_BASE_URL and a Nous key: the veto cannot run',
    );
  }
  await pinCheck(args.dryRun, env);
  const { server, db, loop } = composeSignals(args, new SystemClock(), env);
  try {
    await server.start();
  } catch (error) {
    db.close();
    throw error;
  }
  process.stdout.write(`v2 signals API on ${server.url} (Swagger UI at ${server.url}/docs)\n`);
  const poll = setInterval(() => {
    void loop.tick();
  }, SIGNAL_POLL_MS);
  void loop.tick();
  const shutdown = () => {
    clearInterval(poll);
    void loop
      .tick()
      .then(() => server.stop())
      .finally(() => db.close());
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
