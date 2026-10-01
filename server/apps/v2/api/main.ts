import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { V2ModeWire } from '../../../../contracts/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../../providers/bar-store/index.js';
import {
  type Clock,
  describeThrownSafely,
  SystemClock,
  sanitizeLogText,
} from '../../../shared/index.js';
import { guardedStore, openMigratedStore, type StoreHandle } from '../../../shared/store/index.js';
import { onTerminationSignal, runWhenInvoked } from '../../../tools/cli-entrypoint.js';
import { BarsMarketData, ParquetMarkSource, parseBoeGbpUsdCsv } from '../data/index.js';
import { FX_PATH, V2_DRY_RUN_STORE_PATH, V2_STORE_PATH } from '../index.js';
import { parseListenPort } from '../json-http.js';
import { researchStorePath } from '../trial-ledger.js';
import { DASHBOARD_TOKEN_ENV_VAR } from './auth.js';
import { DEFAULT_BUNDLE_ROOT } from './bundle.js';
import { ControlWriter } from './control-writer.js';
import { EvidenceReader } from './evidence.js';
import { JournalReader } from './journal-reader.js';
import { OverviewReader } from './overview.js';
import { PositionsPanel } from './positions.js';
import { ReconcileReader } from './records.js';
import { ResearchReader } from './research.js';
import { createV2DashboardServer, type V2DashboardServer } from './server.js';

const CONTROLS_SCHEMA_VERSION = 82;
const DEFAULT_PORT = 8788;

export interface V2DashboardArgs {
  readonly storePath: string;
  readonly barStoreRoot: string;
  readonly fxPath: string;
  readonly researchStorePath: string;
  readonly bundleRoot: string;
  readonly mode: V2ModeWire;
  readonly host: string;
  readonly port: number;
}

function storePathFor(dryRun: boolean, store: string | undefined): string {
  if (store === undefined) return dryRun ? V2_DRY_RUN_STORE_PATH : V2_STORE_PATH;
  if (dryRun) {
    throw new Error(
      '--store and --dry-run are exclusive: --dry-run always reads the dry-run store',
    );
  }
  return store;
}

export function parseDashboardArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): V2DashboardArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'dry-run': { type: 'boolean', default: false },
      store: { type: 'string' },
      bars: { type: 'string', default: DEFAULT_BAR_STORE_ROOT },
      fx: { type: 'string', default: FX_PATH },
      research: { type: 'string' },
      bundle: { type: 'string', default: DEFAULT_BUNDLE_ROOT },
    },
    strict: true,
  });
  const dryRun = values['dry-run'];
  return {
    storePath: storePathFor(dryRun, values.store),
    barStoreRoot: values.bars,
    fxPath: values.fx,
    researchStorePath: values.research ?? researchStorePath(env),
    bundleRoot: values.bundle,
    mode: dryRun ? 'dry-run' : 'paper',
    host: env.HOST ?? '127.0.0.1',
    port: parseListenPort(env.V2_DASHBOARD_PORT, DEFAULT_PORT, 'V2_DASHBOARD_PORT'),
  };
}

export function readFxOrNone(fxPath: string): ReturnType<typeof parseBoeGbpUsdCsv> {
  try {
    return parseBoeGbpUsdCsv(readFileSync(fxPath, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `v2 dashboard: no FX rates (${sanitizeLogText(describeThrownSafely(error))}); USD marks unavailable\n`,
    );
    return [];
  }
}

export interface ComposedDashboard {
  readonly server: V2DashboardServer;
  readonly db: StoreHandle;
  readonly store: StoreHandle;
}

export function composeV2Dashboard(
  args: V2DashboardArgs,
  env: NodeJS.ProcessEnv,
  clock: Clock,
): ComposedDashboard {
  const fx = readFxOrNone(args.fxPath);
  const positions = new PositionsPanel(
    new ParquetMarkSource(args.barStoreRoot),
    new BarsMarketData({ load: () => undefined }, fx),
  );
  const db = openMigratedStore(args.storePath, CONTROLS_SCHEMA_VERSION);
  try {
    const store = guardedStore(db, 'dashboard', { enabled: true });
    const reader = new OverviewReader(store, clock, args.mode, positions);
    const journal = new JournalReader(store);
    const research = new ResearchReader(args.researchStorePath, clock);
    const evidence = new EvidenceReader(store, clock);
    const reconcile = new ReconcileReader(store);
    const server = createV2DashboardServer({
      host: args.host,
      port: args.port,
      token: env[DASHBOARD_TOKEN_ENV_VAR],
      bundleRoot: args.bundleRoot,
      overview: () => reader.read(),
      controls: new ControlWriter(store, clock),
      journal: (query) => journal.read(query),
      research: () => research.read(),
      evidence: () => evidence.read(),
      reconcile: () => reconcile.read(),
      onFault: (error) =>
        process.stderr.write(
          `v2 dashboard fault: ${sanitizeLogText(describeThrownSafely(error))}\n`,
        ),
    });
    return { server, db, store };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const { server, db } = composeV2Dashboard(parseDashboardArgs(argv, env), env, new SystemClock());
  await server.start();
  process.stdout.write(`v2 dashboard API on ${server.url}\n`);
  onTerminationSignal(() => server.stop().finally(() => db.close()));
}

void runWhenInvoked(import.meta.url, () => main(process.argv.slice(2), process.env));
