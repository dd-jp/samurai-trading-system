/**
 * One-off soak probe (#238): open ONE real paper lot through the system's own
 * execution path, so the running orchestrator's entry -> fill -> flatten ->
 * closed arc actually runs at least once.
 *
 * ## Why this tool has to exist
 *
 * The 2026-08-26 soak session produced 8 debates and 0 positions, so none of
 * the position lifecycle was exercised. The obvious shortcut — place an order
 * at Alpaca by hand — does NOT work, and the reason is worth recording:
 *
 *   - `reconcile()` (reconcile.ts) only ever adopts lots already in
 *     `open_positions`. A venue-side order the store never heard of is
 *     invisible to it, so nothing would flatten it.
 *   - `AlpacaBrokerAdapter.fetchNewFills` iterates `this.brackets`, a
 *     PROCESS-LOCAL map. A bracket this process submits is not in the running
 *     orchestrator's copy, so its entry fill would never be ingested either.
 *
 * The adapter rehydrates that map in its constructor from
 * `SqliteBrokerStateStore.loadBrackets('alpaca')` (alpaca-adapter.ts:301), so
 * the sequence that DOES work is: stop the orchestrator, run this, start it
 * again. The restart is not an inconvenience to be engineered away — it is
 * what makes the adoption path (`loadBrackets` + `reconcile`) run, which is
 * itself untested evidence.
 *
 * ## Operating procedure
 *
 *   1. Inside the equity entry window (13:30-14:45Z), SIGINT the soak.
 *   2. `yarn place-soak-position --confirm`   (omit --confirm for a dry run)
 *   3. Restart the soak.
 *   4. Expect the flatten on the tail tick at 19:55-20:00Z.
 *
 * The brackets are set deliberately WIDE (+/-5%) so neither leg can fire: the
 * point of the probe is the flat-by-close path, and a stop or target hit would
 * close the lot by a different route and prove something else.
 *
 * NOT covered by this probe, and it must not be reported as if it were:
 * `reconcile()`'s in-flight branch (needs a kill between write-ahead and ack)
 * and the residual-protection sweep (needs a partial flatten).
 */
import { randomUUID } from 'node:crypto';
import {
  LoggingOcoDoubleFillAlertChannel,
  LoggingUnpricedFillAlertChannel,
} from '../apps/orchestrator/console-channels.js';
import { JsonLogger } from '../apps/orchestrator/logger.js';
import { buildDefaultAlpacaBrokerClient } from '../apps/orchestrator/production.js';
import {
  AlpacaBrokerAdapter,
  ExecutionImpl,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../pipeline/execution/index.js';
import type { VerdictDecision } from '../pipeline/verdict/index.js';
import type { OrderIntent } from '../shared/index.js';
import { SystemClock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';

const INSTRUMENT = 'SPY';
const SIZE = 1;
/** Wide enough that neither protective leg can fire — see the file doc. */
const STOP_FRACTION = 0.95;
const TARGET_FRACTION = 1.05;
/** Marketable limit: through the touch so the entry fills promptly. */
const ENTRY_SLIPPAGE = 1.001;

async function latestTradePrice(instrument: string): Promise<number> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (key === undefined || secret === undefined) {
    throw new Error('ALPACA_API_KEY / ALPACA_API_SECRET must be set (use --env-file=.env.local)');
  }
  const response = await fetch(
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

/**
 * A dependency the Alpaca ENTRY path provably never touches, supplied as a
 * throwing proxy rather than a cast.
 *
 * `costModel`/`marketData`/`config.simulated` are documented on
 * `ExecutionInput` as "consumed by the Simulated adapter only", and the three
 * alert channels are read by the flatten/fill-sync surfaces, none of which
 * this probe drives. Casting the object to satisfy `tsc` would make a wrong
 * assumption fail somewhere unrelated and much later; this fails loudly, here,
 * naming the field.
 */
function unreachable<T extends object>(field: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      throw new Error(
        `place-soak-position: ExecutionInput.${field} was read (property '${String(property)}') — ` +
          'the probe assumed the entry path never touches it. Wire it properly rather than widening this stub.',
      );
    },
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const logger = new JsonLogger();
  const clock = new SystemClock();
  const now = clock.now();

  const last = await latestTradePrice(INSTRUMENT);
  const entry = round2(last * ENTRY_SLIPPAGE);
  const stop = round2(last * STOP_FRACTION);
  const target = round2(last * TARGET_FRACTION);

  // Marker-shaped, never hash-shaped: a probe lot must be greppable in
  // `trader_log`/`closed_trades` and must not be able to collide with a real
  // decision's hash(instrument + bar) key.
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

  console.log(
    JSON.stringify(
      { probe: idempotencyKey, last, entry, stop, target, size: SIZE, confirm },
      null,
      2,
    ),
  );

  if (!confirm) {
    console.log('DRY RUN — nothing submitted. Re-run with --confirm to place.');
    return;
  }

  const dbPath = process.env.SAMURAI_DB_PATH ?? 'data/samurai-paper.sqlite';
  const db = openSharedStore(dbPath);
  const client = buildDefaultAlpacaBrokerClient('paper', logger);
  const broker = new AlpacaBrokerAdapter({
    client,
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: new LoggingUnpricedFillAlertChannel(logger),
    ocoDoubleFillAlerts: new LoggingOcoDoubleFillAlertChannel(logger),
    logger,
  });

  const execution = new ExecutionImpl({
    trace_id: `soak-probe-${randomUUID()}`,
    clock,
    broker,
    store: new SqliteExecutionStore(db),
    mode: 'paper',
    logger,
    costModel: unreachable('costModel'),
    marketData: unreachable('marketData'),
    config: unreachable('config'),
    residualExposureAlerts: unreachable('residualExposureAlerts'),
    flattenOverfillAlerts: unreachable('flattenOverfillAlerts'),
    flattenReconcileAlerts: unreachable('flattenReconcileAlerts'),
  });

  const verdict: VerdictDecision = {
    status: 'go',
    order: intent,
    no_go_reason: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: idempotencyKey,
    timestamp: now,
  };

  const outcome = await execution.execute(verdict);
  console.log(JSON.stringify(outcome, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
