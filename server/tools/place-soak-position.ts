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
 * ## What it refuses to do
 *
 * Every refusal below exists because the probe's whole value is that the lot
 * it opens is the one the running orchestrator manages. A probe that lands
 * anywhere else looks identical in this tool's output and proves nothing:
 *
 *   - **Paper only, and the store must agree.** `PROBE_MODE` is not settable,
 *     and the store is resolved through `sharedStorePath()` +
 *     `assertStorePathMatchesMode` — the same two calls the orchestrator makes
 *     (index.ts:610) — rather than a literal path. Writing a lot into a
 *     database the running process never reads is the failure that already
 *     cost this soak one false start on 2026-08-25.
 *   - **Regular session only**, on the orchestrator's own calendar. A limit
 *     order into a closed market rests unfilled, and the procedure above then
 *     quietly describes something that did not happen.
 *   - **One probe lot at a time.** `executeExit` assumes one side per
 *     instrument and splits a flatten oldest-lot-first, so a second lot
 *     changes what the flatten measures.
 *   - **Non-zero exit on a refused `ExecutionResult`.** `deduped` is a success
 *     (today's probe already exists); anything else is not.
 *
 * NOT covered by this probe, and it must not be reported as if it were: the
 * residual-protection sweep (needs a partial flatten). `reconcile()`'s
 * in-flight branch IS covered, as it turned out — the store is left at
 * `submitted` while the venue fills, so the restart's reconcile adopts it.
 */
import { randomUUID } from 'node:crypto';
import {
  LoggingOcoDoubleFillAlertChannel,
  LoggingUnpricedFillAlertChannel,
} from '../apps/orchestrator/console-channels.js';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import { JsonLogger } from '../apps/orchestrator/logger.js';
import { resolveUsEquitySessionCalendar } from '../apps/orchestrator/production/us-equity-session-source.js';
import { buildDefaultAlpacaBrokerClient } from '../apps/orchestrator/production.js';
import {
  ALPACA_CREDENTIAL_ENV_VARS,
  AlpacaBrokerAdapter,
  ExecutionImpl,
  FilledZeroSizeThrottle,
  SqliteBrokerStateStore,
  SqliteExecutionStore,
} from '../pipeline/execution/index.js';
import type { VerdictDecision } from '../pipeline/verdict/index.js';
import type { OrderIntent } from '../shared/index.js';
import { SystemClock } from '../shared/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';

/**
 * Paper, and not a parameter. A probe that could be pointed at the live
 * account by an env var is a probe that will be, and ADR-0015's book is real
 * money — see `assertStorePathMatchesMode` below, which is what makes the
 * store agree with this rather than leaving the two independently settable.
 */
const PROBE_MODE = 'paper' as const;
const PROBE_ENVIRONMENT = 'paper' as const;

const INSTRUMENT = 'SPY';
const SIZE = 1;
/** Wide enough that neither protective leg can fire — see the file doc. */
const STOP_FRACTION = 0.95;
const TARGET_FRACTION = 1.05;
/** Marketable limit: through the touch so the entry fills promptly. */
const ENTRY_SLIPPAGE = 1.001;

async function latestTradePrice(instrument: string): Promise<number> {
  // Named from the exported map rather than as literals here, which is what
  // its own docblock asks of every caller: a second copy of the strings is
  // free to drift out of agreement with the client that actually reads them.
  const vars = ALPACA_CREDENTIAL_ENV_VARS[PROBE_ENVIRONMENT];
  const key = process.env[vars.key];
  const secret = process.env[vars.secret];
  if (key === undefined || secret === undefined) {
    throw new Error(`${vars.key} / ${vars.secret} must be set (use --env-file=.env.local)`);
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

  // Refuse outside the regular session, on the SAME calendar the paper
  // orchestrator gates its ticks with: `resolveUsEquitySessionCalendar`, which
  // fetches Alpaca's live session table and only falls back to the
  // hand-entered `UsEquityRegularHoursCalendar` when that fetch fails. The
  // fallback is what this guard used to call directly, and it is wrong on a
  // half-day (13:00 ET close): it would report open, the probe would place,
  // and the venue would be shut — on exactly the day nobody would look.
  //
  // A limit order placed into a closed market does not fill; it rests, and the
  // operating procedure above — restart, then expect the flatten on the tail
  // tick — quietly becomes untrue while looking like it worked. Checked before
  // the price lookup so a closed-market run costs no trade API call.
  //
  // A dry run WARNS rather than throws: the docblock promises that omitting
  // --confirm previews the wiring, and an operator checking that at 22:00Z
  // should get the preview, not an exception.
  const calendar = await resolveUsEquitySessionCalendar({ logger, now: () => clock.now() });
  if (!calendar.isOpen(now)) {
    const closed =
      `US equities are closed at ${now.toISOString()} — a limit order placed now would rest ` +
      'unfilled rather than open the lot this probe exists to open. Run it inside the ' +
      'equity entry window (13:30-14:45Z).';
    if (confirm) {
      throw new Error(closed);
    }
    console.log(`WARNING (dry run continues): ${closed}`);
  }

  const last = await latestTradePrice(INSTRUMENT);
  const entry = round2(last * ENTRY_SLIPPAGE);
  const stop = round2(last * STOP_FRACTION);
  const target = round2(last * TARGET_FRACTION);

  // Marker-shaped, never hash-shaped: a probe lot must be greppable in
  // `trader_log`/`closed_trades` and must not be able to collide with a real
  // decision's sha256({ instrument, bar, side }[, arm]) key.
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

  console.log(
    JSON.stringify(
      { probe: idempotencyKey, last, entry, stop, target, size: SIZE, confirm },
      null,
      2,
    ),
  );

  // `sharedStorePath()` + `assertStorePathMatchesMode`, NOT a literal path and
  // not an env var invented here. The orchestrator resolves its store exactly
  // this way (index.ts:610), and a probe that resolved it any other way could
  // write a lot into a database the running process never reads — which is the
  // failure that already cost this soak one false start, on 2026-08-25, when a
  // stale store made the spend cap read $1.71 of a fresh run's $50.
  const dbPath = sharedStorePath(PROBE_MODE);
  assertStorePathMatchesMode({ dbPath, mode: PROBE_MODE });
  const db = openSharedStore(dbPath);
  const client = buildDefaultAlpacaBrokerClient(PROBE_MODE, logger);
  const broker = new AlpacaBrokerAdapter({
    client,
    state: new SqliteBrokerStateStore(db),
    unpricedFillAlerts: new LoggingUnpricedFillAlertChannel(logger),
    ocoDoubleFillAlerts: new LoggingOcoDoubleFillAlertChannel(logger),
    logger,
  });

  const store = new SqliteExecutionStore(db);
  const execution = new ExecutionImpl({
    trace_id: `soak-probe-${randomUUID()}`,
    clock,
    broker,
    store,
    mode: PROBE_MODE,
    logger,
    costModel: unreachable('costModel'),
    marketData: unreachable('marketData'),
    config: unreachable('config'),
    residualExposureAlerts: unreachable('residualExposureAlerts'),
    flattenOverfillAlerts: unreachable('flattenOverfillAlerts'),
    flattenReconcileAlerts: unreachable('flattenReconcileAlerts'),
    // #1087 review, pass 2: a real instance, not `unreachable()` like the
    // alert channels above. Those are provably dead here (this probe never
    // hits a flatten/reconcile path); this one is merely UNUSED today (the
    // probe only calls `execute()`, never `ingestFills()`) — a distinction
    // worth keeping separate, because this tool runs against the LIVE
    // broker, and a future call added here for symmetry (or a copy-paste
    // into a sibling tool that does poll) would throw against production
    // instead of harmlessly counting nothing. A throttle is one Map, empty
    // until observed — free to construct even when never read.
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
  });

  // One probe lot at a time. `executeExit` assumes every lot it finds for an
  // instrument is the same side ("v1 per-lot design", execute.ts), and splits
  // a flatten's fills across them oldest-first — so a second probe opened on
  // top of a live one does not merely double the exposure, it changes what the
  // flatten this probe exists to observe is actually measuring.
  const held = (await store.getOpenPositions()).filter((lot) => lot.instrument === INSTRUMENT);
  if (held.length > 0) {
    throw new Error(
      `refusing to place: ${held.length} open lot(s) already held for ${INSTRUMENT} ` +
        `(${held.map((lot) => lot.idempotency_key).join(', ')}). Let the running orchestrator ` +
        'flatten them before probing again.',
    );
  }

  // The dry run stops HERE, not before the block above: resolving the store,
  // rehydrating the adapter's bracket map and checking for a held lot are the
  // parts most likely to throw, and a preview that returned before reaching
  // them proved nothing about the wiring it claims to preview.
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

  const outcome = await execution.execute(verdict);
  console.log(JSON.stringify(outcome, null, 2));

  // An operator tool that prints a refusal and exits 0 is a tool whose failure
  // is invisible to whatever ran it. `deduped` is a success — it means today's
  // probe lot already exists — so only the genuine refusals are non-zero.
  if (outcome.status !== 'submitted' && outcome.status !== 'deduped') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
