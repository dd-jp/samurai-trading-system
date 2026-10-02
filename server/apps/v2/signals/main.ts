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
import { onTerminationSignal, runWhenInvoked } from '../../../tools/cli-entrypoint.js';
import {
  type Heartbeat,
  type HeartbeatFetch,
  NO_HEARTBEAT,
  optionalHeartbeat,
} from '../heartbeat.js';
import {
  composeV2Root,
  knownSecretsFrom,
  llmKeysPresent,
  nousOptionsFrom,
  rootOptionsFor,
  V2_DRY_RUN_STORE_PATH,
  V2_STORE_PATH,
} from '../index.js';
import { parseListenPort } from '../json-http.js';
import { ALL_PINS, verifyNousPins } from '../signal/index.js';
import { SignalsLiveness } from './liveness.js';
import { SIGNAL_POLL_MS, SignalLoop } from './loop.js';
import { createSignalsServer, type SignalsServer } from './server.js';
import { SignalStore } from './store.js';

const DEFAULT_PORT = 8789;
const SIGNALS_PING_ENV = 'HEALTHCHECKS_SIGNALS_PING_URL';

export interface SignalsArgs {
  readonly storePath: string;
  readonly port: number;
  readonly dryRun: boolean;
}

export function parsePort(raw: string | undefined): number {
  return parseListenPort(raw, DEFAULT_PORT, 'V2_SIGNALS_PORT');
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
  readonly liveness: SignalsLiveness;
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
  heartbeat: Heartbeat = NO_HEARTBEAT,
): ComposedSignals {
  const db = openSharedStore(args.storePath);
  const store = new SignalStore(guardedStore(db, 'v2', { enabled: true }), clock);
  const calendar = new UsEquityRegularHoursCalendar();
  const liveness = new SignalsLiveness(heartbeat, () => clock.now().getTime());
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
    onPass: (ok) => liveness.passFinished(ok),
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
  return { server, db, loop, liveness };
}

export function signalsHeartbeat(
  args: SignalsArgs,
  env: NodeJS.ProcessEnv,
  fetchImpl: HeartbeatFetch,
  logger: Logger,
): Heartbeat {
  return optionalHeartbeat(
    {
      dryRun: args.dryRun,
      envName: SIGNALS_PING_ENV,
      subject: 'signals process',
      onUnset: (message) =>
        logger.log({
          trace_id: 'v2-signals',
          stage: 'v2',
          level: 'warn',
          event: 'v2_signals_heartbeat_unset',
          message,
        }),
    },
    env,
    fetchImpl,
    logger,
  );
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
  fetchImpl: HeartbeatFetch = fetch,
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
  const heartbeat = signalsHeartbeat(args, env, fetchImpl, STDERR_LOGGER);
  const { server, db, loop, liveness } = composeSignals(
    args,
    new SystemClock(),
    env,
    STDERR_LOGGER,
    heartbeat,
  );
  try {
    await server.start();
  } catch (error) {
    db.close();
    throw error;
  }
  process.stdout.write(`v2 signals API on ${server.url} (Swagger UI at ${server.url}/docs)\n`);
  const poll = setInterval(() => {
    void loop.tick();
    liveness.beat();
  }, SIGNAL_POLL_MS);
  void loop.tick();
  onTerminationSignal(() => {
    clearInterval(poll);
    return loop
      .tick()
      .then(() => server.stop())
      .finally(() => db.close());
  });
}

void runWhenInvoked(import.meta.url, () => main(process.argv.slice(2), process.env));
