import { randomUUID } from 'node:crypto';
import {
  assertStorePathMatchesMode,
  buildDefaultAlpacaBrokerClient,
  JsonLogger,
  loggingAlertChannel,
} from '../apps/orchestrator/index.js';
import { resolveUsEquitySessionCalendar } from '../apps/orchestrator/production/us-equity-session-source.js';
import {
  ALPACA_CREDENTIAL_ENV_VARS,
  AlpacaBrokerAdapter,
  executeVerdict,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
  type SubmitInput,
} from '../pipeline/execution/index.js';
import type { VerdictDecision } from '../pipeline/verdict/index.js';
import type { OrderIntent } from '../shared/index.js';
import { SystemClock } from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';
import { failExitCodeOnRejection, isMainModule } from './cli-entrypoint.js';

const PROBE_MODE = 'paper' as const;
const PROBE_ENVIRONMENT = 'paper' as const;

const INSTRUMENT = 'SPY';
const SIZE = 1;
const STOP_FRACTION = 0.95;
const TARGET_FRACTION = 1.05;
const ENTRY_SLIPPAGE = 1.001;

export async function latestTradePrice(
  instrument: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const vars = ALPACA_CREDENTIAL_ENV_VARS[PROBE_ENVIRONMENT];
  const key = env[vars.key];
  const secret = env[vars.secret];
  if (key === undefined || secret === undefined) {
    throw new Error(`${vars.key} / ${vars.secret} must be set (use --env-file=.env.local)`);
  }
  const response = await fetchFn(
    `https://data.alpaca.markets/v2/stocks/${instrument}/trades/latest`,
    { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } },
  );
  if (!response.ok) {
    throw new Error(`latest trade lookup failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { trade?: { p?: number } };
  const price = body.trade?.p;
  if (typeof price !== 'number' || !(price > 0)) {
    throw new Error(`latest trade lookup returned no usable price: ${JSON.stringify(body)}`);
  }
  return price;
}

function snapshotSourceAbsent<T extends object>(field: keyof SubmitInput): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(
        `place-soak-position: SubmitInput.${field} was read (property '${String(property)}') — ` +
          'this probe wires no market-data feed or cost model, so the submit snapshot is left null.',
      );
    },
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function refuseOrWarnWhenClosed(
  open: boolean,
  now: Date,
  confirm: boolean,
  log: (line: string) => void,
): void {
  if (open) return;
  const closed =
    `US equities are closed at ${now.toISOString()} — a limit order placed now would rest ` +
    'unfilled rather than open the lot this probe exists to open. Run it inside the ' +
    'equity entry window (13:30-14:45Z).';
  if (confirm) {
    throw new Error(closed);
  }
  log(`WARNING (dry run continues): ${closed}`);
}

export function probeOrder(
  now: Date,
  last: number,
): { idempotencyKey: string; entry: number; stop: number; target: number; intent: OrderIntent } {
  const entry = round2(last * ENTRY_SLIPPAGE);
  const stop = round2(last * STOP_FRACTION);
  const target = round2(last * TARGET_FRACTION);

  const idempotencyKey = `soak-lifecycle-probe-${now.toISOString().slice(0, 10)}`;

  const intent: OrderIntent = {
    idempotency_key: idempotencyKey,
    instrument: INSTRUMENT,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: SIZE,
    entry,
    stop,
    target,
    time_in_force: 'day',
    decision_timestamp: now,
    decided_at: now,
    metadata: {
      debate_id: idempotencyKey,
      conviction: 0.5,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: 0, no_precedent: true },
    },
  };
  return { idempotencyKey, entry, stop, target, intent };
}

export function refuseWhenHeld(held: readonly { idempotency_key: string }[]): void {
  if (held.length > 0) {
    throw new Error(
      `refusing to place: ${held.length} open lot(s) already held for ${INSTRUMENT} ` +
        `(${held.map((lot) => lot.idempotency_key).join(', ')}). Let the running orchestrator ` +
        'flatten them before probing again.',
    );
  }
}

export function opened(status: string): boolean {
  return status === 'submitted' || status === 'deduped';
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const logger = new JsonLogger();
  const clock = new SystemClock();
  const now = clock.now();

  const calendar = await resolveUsEquitySessionCalendar({ logger, now: () => clock.now() });
  refuseOrWarnWhenClosed(calendar.isOpen(now), now, confirm, (line) => console.log(line));

  const last = await latestTradePrice(INSTRUMENT);
  const { idempotencyKey, entry, stop, target, intent } = probeOrder(now, last);

  console.log(
    JSON.stringify(
      { probe: idempotencyKey, last, entry, stop, target, size: SIZE, confirm },
      null,
      2,
    ),
  );

  const dbPath = sharedStorePath(PROBE_MODE);
  assertStorePathMatchesMode({ dbPath, mode: PROBE_MODE });
  const db = openSharedStore(dbPath);
  const client = buildDefaultAlpacaBrokerClient(PROBE_MODE, logger);
  const broker = new AlpacaBrokerAdapter({
    client,
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: loggingAlertChannel('unpricedFillAlerts', logger),
    ocoDoubleFillAlerts: loggingAlertChannel('ocoDoubleFillAlerts', logger),
    logger,
  });

  const store = new SqliteExecutionStore(db);
  const input: SubmitInput = {
    trace_id: `soak-probe-${randomUUID()}`,
    clock,
    broker,
    store,
    logger,
    costModel: snapshotSourceAbsent('costModel'),
    marketData: snapshotSourceAbsent('marketData'),
    config: snapshotSourceAbsent('config'),
  };

  refuseWhenHeld((await store.getOpenPositions()).filter((lot) => lot.instrument === INSTRUMENT));

  if (!confirm) {
    console.log('DRY RUN — nothing submitted. Re-run with --confirm to place.');
    db.close();
    return;
  }

  const verdict: VerdictDecision = {
    status: 'go',
    order: intent,
    no_go_reason: null,
    no_go_detail: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: idempotencyKey,
    timestamp: now,
  };

  const outcome = await executeVerdict(input, verdict);
  console.log(JSON.stringify(outcome, null, 2));

  if (!opened(outcome.status)) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  void failExitCodeOnRejection(main());
}
