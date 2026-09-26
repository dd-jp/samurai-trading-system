import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { V2ModeWire } from '../../../../contracts/index.js';
import { type Clock, SystemClock } from '../../../shared/index.js';
import { guardedStore, openMigratedStore, type StoreHandle } from '../../../shared/store/index.js';
import { V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { DASHBOARD_TOKEN_ENV_VAR } from './auth.js';
import { ControlWriter } from './control-writer.js';
import { OverviewReader } from './overview.js';
import { createV2DashboardServer, type V2DashboardServer } from './server.js';

const CONTROLS_SCHEMA_VERSION = 70;
const DEFAULT_PORT = 8788;

export interface V2DashboardArgs {
  readonly storePath: string;
  readonly mode: V2ModeWire;
  readonly host: string;
  readonly port: number;
}

export function parseDashboardArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): V2DashboardArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { 'dry-run': { type: 'boolean', default: false }, store: { type: 'string' } },
    strict: true,
  });
  const dryRun = values['dry-run'];
  const port = Number(env.V2_DASHBOARD_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`V2_DASHBOARD_PORT must be an integer port (got ${env.V2_DASHBOARD_PORT})`);
  }
  return {
    storePath: values.store ?? (dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH),
    mode: dryRun ? 'dry-run' : 'paper',
    host: env.HOST ?? '127.0.0.1',
    port,
  };
}

export interface ComposedDashboard {
  readonly server: V2DashboardServer;
  readonly db: StoreHandle;
}

export function composeV2Dashboard(
  args: V2DashboardArgs,
  env: NodeJS.ProcessEnv,
  clock: Clock,
): ComposedDashboard {
  const db = openMigratedStore(args.storePath, CONTROLS_SCHEMA_VERSION);
  try {
    const store = guardedStore(db, 'dashboard');
    const reader = new OverviewReader(store, clock, args.mode);
    const server = createV2DashboardServer({
      host: args.host,
      port: args.port,
      token: env[DASHBOARD_TOKEN_ENV_VAR],
      overview: () => reader.read(),
      controls: new ControlWriter(store, clock),
    });
    return { server, db };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { server, db } = composeV2Dashboard(parseDashboardArgs(argv, env), env, new SystemClock());
  await server.start();
  process.stdout.write(`v2 dashboard API on ${server.url}\n`);
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
