/**
 * The #549 residual-protection sweep, tested across the crash windows the
 * durable marker (migration 0024) exists to close. "A restart" here is
 * `reconcile.test.ts`'s own definition: a SECOND `ExecutionImpl` over a FRESH
 * `SqliteExecutionStore` on the SAME database handle — everything in-memory
 * is gone, everything durable survives.
 */
import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import type { AssetClass, Clock, Fill, Logger, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import type { CostModel } from '../../tools/backtest/index.js';
import { ExecutionImpl } from './execute.js';
import { FilledZeroSizeThrottle } from './filled-zero-size-throttle.js';
import { ProtectiveRearmUnsupportedError } from './protective-rearm-unsupported.js';
import { MAX_RESIDUAL_REFLATTEN_ATTEMPTS } from './residual-reflatten.js';
import { openTestExecutionStore, TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  FlattenSubmissionWriteAhead,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from './types.js';

/**
 * #1214: the default `ExecutionInput.sessionCalendars` — an open venue for
 * both classes. A fresh pair per call so a test that swaps one in cannot
 * disturb another's.
 */
function openSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return { crypto: new AlwaysOpenCalendar(), stocks: new AlwaysOpenCalendar() };
}

const NOW = new Date('2026-08-07T16:00:00Z');
const OPENED_AT = new Date('2026-08-07T14:00:00Z');
const LOT = 'key-1';

async function seedPosition(
  store: TestExecutionStore,
  overrides: Partial<OpenPosition> = {},
): Promise<OpenPosition> {
  const position: OpenPosition = {
    idempotency_key: LOT,
    debate_id: 'debate-1',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    // NOT in reconcile's IN_FLIGHT set, so `reconcile()`'s bracket pass
    // leaves it alone and only the #549 sweep acts on it.
    order_state: 'partially_filled',
    broker_order_ids: [`${LOT}:entry`],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
  await store.writeAheadPosition(position);
  return position;
}

/** Persists the durable state a partial flatten leaves: entry 10, exit 4, lot not flat. */
async function seedPartiallyFlattenedFills(store: TestExecutionStore): Promise<void> {
  const entry: Fill = {
    idempotency_key: LOT,
    broker_fill_id: toBrokerFillId('e1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-08-07T15:00:00Z'),
  };
  const exit: Fill = {
    idempotency_key: LOT,
    broker_fill_id: toBrokerFillId('x1'),
    leg: 'exit',
    price: 104,
    qty: 4,
    fee: 0.4,
    timestamp: new Date('2026-08-07T15:30:00Z'),
  };
  await store.applyLotAdvance({
    idempotency_key: LOT,
    fills: [entry, exit],
    position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
  });
}

/**
 * #867's shape: the lot's legs were cancelled and the flatten was then
 * refused, so the entry fill is on record and NO exit fill is — the residual
 * is the whole held quantity.
 */
async function seedEntryOnlyFills(store: TestExecutionStore): Promise<void> {
  const entry: Fill = {
    idempotency_key: LOT,
    broker_fill_id: toBrokerFillId('e1'),
    leg: 'entry',
    price: 100,
    qty: 10,
    fee: 1,
    timestamp: new Date('2026-08-07T15:00:00Z'),
  };
  await store.applyLotAdvance({
    idempotency_key: LOT,
    fills: [entry],
    position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
  });
}

/** A flatten journal row on this lot's instrument, for the #1214 gates that read the journal. */
function flattenWriteAhead(key: string): FlattenSubmissionWriteAhead {
  return {
    idempotency_key: key,
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'sell',
    size: 6,
    submitted_at: NOW,
    lot_held_quantities: [{ idempotency_key: LOT, held: 6 }],
    exit_reason: 'flatten',
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
  };
}

/** A broker for the sweep: only `rearmProtectiveLegs` (scriptable) and reconcile's reads matter. */
class SweepBroker implements BrokerAdapter {
  readonly rearmCalls: Array<{ clientOrderId: string; qty: number }> = [];
  /** #1214: every residual re-flatten this sweep submitted, in call order. */
  readonly flattenCalls: Array<{
    clientOrderId: string;
    instrument: string;
    side: 'buy' | 'sell';
    size: number;
  }> = [];
  /** When set, `rearmProtectiveLegs` rejects with this. */
  rearmFailure: Error | undefined;
  /** When set, `submitFlatten` rejects with this. */
  flattenFailure: Error | undefined;

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [order.client_order_id],
      order_state: 'submitted',
    };
  }
  async fetchNewFills(_since: Date): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {}
  async rearmProtectiveLegs(
    clientOrderId: string,
    _instrument: string,
    _side: 'buy' | 'sell',
    qty: number,
  ): Promise<void> {
    this.rearmCalls.push({ clientOrderId, qty });
    if (this.rearmFailure !== undefined) throw this.rearmFailure;
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  /**
   * #1214 review: scriptable, keyed by client order id, so a test can give
   * `reconcile()` a real venue answer for a flatten it already acked. The
   * default `null` is "the adapter cannot reconfirm it", which every test
   * written before this relied on.
   */
  readonly resumeFlattenAnswers = new Map<string, NormalizedOrder>();
  async resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
    return this.resumeFlattenAnswers.get(clientOrderId) ?? null;
  }
  /**
   * #1214: the residual re-flatten's own submit. Recorded rather than
   * refused — closing the residual IS a sweep behaviour now, so a broker that
   * cannot express it would make every scenario below untestable.
   */
  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.flattenCalls.push({ clientOrderId, instrument, side, size });
    if (this.flattenFailure !== undefined) throw this.flattenFailure;
    return {
      client_order_id: clientOrderId,
      broker_order_ids: [clientOrderId],
      order_state: 'submitted',
    };
  }
  async cancel(): Promise<void> {}
  /** Empty so `reconcile()`'s unrecorded-position pass reports nothing. */
  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    return [];
  }
}

function makeResidualExposureAlerts(): ResidualExposureAlertChannel & {
  alerts: ResidualExposureAlert[];
} {
  const alerts: ResidualExposureAlert[] = [];
  return {
    alerts,
    async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
      alerts.push(alert);
    },
  };
}

function makeInput(
  broker: BrokerAdapter,
  store: TestExecutionStore,
  residualExposureAlerts: ResidualExposureAlertChannel = makeResidualExposureAlerts(),
  logger: Logger = recordingLogger(),
  // #1214: overridable so a test can shut the venue and prove the residual
  // re-flatten stands down rather than firing a market order into it.
  sessionCalendars: Record<AssetClass, TradingCalendar> = openSessionCalendars(),
): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  };
  const clock: Clock = { now: () => NOW };
  return {
    trace_id: 'trace-sweep',
    clock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    sessionCalendars,
    residualExposureAlerts,
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    logger,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
  };
}

describe('residual-protection sweep (#549)', () => {
  it('window (a): crash after the exit fill persisted, before the re-arm attempt — the restarted reconcile() retries and clears the marker', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    // The durable trace the crashed poll left: `redistributeOneFlatten`
    // marks a named lot's unclosed share BEFORE any advance persists, so
    // this exact state — exit fill durable, marker durable, no re-arm ever
    // attempted, nothing left in the fill feed — is what a restart finds.
    await store.markResidualUnprotected(LOT, NOW);

    // Restart: fresh store instance + fresh broker over the same database.
    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    const alerts = makeResidualExposureAlerts();
    const report = await new ExecutionImpl(makeInput(broker, restartedStore, alerts)).reconcile();

    // The sweep, not the fill path, re-armed the residual (10 − 4 = 6).
    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    // Marker cleared only because protection was CONFIRMED.
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
    // Reported through reconcile's own divergence surface, and counted.
    const divergence = report.divergences.find((entry) => entry.idempotency_key === LOT);
    expect(divergence?.action).toBe('adopted');
    // Distinct from `reconcileLot`'s bracket rows: this row DOES flow
    // through `reconcileDivergenceLevel()` (it's read off `report.divergences`
    // right above, same array that loop consumes) but never demotes, since
    // the demotion predicate requires `kind === 'bracket'` (#1122 review
    // round 3 — round 1's comment here claimed "never routed", which this
    // very assertion's lookup path contradicts).
    expect(divergence?.kind).toBe('sweep');
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.corrected).toBeGreaterThanOrEqual(1);
    // A successful retry pages nobody.
    expect(alerts.alerts).toEqual([]);
  });

  it('window (b): re-arm succeeded venue-side but crashed before confirming — the sweep retry is adopt-or-place, not a double submit', async () => {
    // The seam-level contract: the sweep retries through the SAME
    // `rearmProtectiveLegs` call, and the adapter resolves it by ADOPTING
    // the live prior order under the deterministic wire id (asserted against
    // the real AlpacaBrokerAdapter in alpaca-adapter.test.ts, "re-arm
    // adopt-or-place (#549)"). Here: the retry resolving must clear the
    // marker exactly as a fresh place does, and must call the seam ONCE.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker(); // resolves = adopted-or-placed, either way confirmed.
    const execution = new ExecutionImpl(makeInput(broker, restartedStore));
    const result = await execution.sweepResidualProtection();

    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(result.checked).toBe(1);
    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(result.divergences.map((entry) => entry.kind)).toEqual(['sweep']);
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });

    // And the pass after that is a no-op: nothing marked, no broker call.
    const second = await execution.sweepResidualProtection();
    expect(second).toEqual({ checked: 0, divergences: [] });
    expect(broker.rearmCalls).toHaveLength(1);
  });

  it('window (c): the observing poll’s re-arm threw and the process lived — the marker survives, the sweep retries and clears it without paging twice', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { order_state: 'filled', filled_size: 10, avg_entry_price: 100 });
    // Entry already on record from an earlier poll; THIS poll offers the
    // partial exit fill, whose re-arm fails — the real ingest path writes
    // the marker and the alert dedup.
    await store.applyLotAdvance({
      idempotency_key: LOT,
      fills: [
        {
          idempotency_key: LOT,
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          price: 100,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:00:00Z'),
        },
      ],
      position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'filled' },
    });

    const failingBroker = new (class extends SweepBroker {
      override async fetchNewFills(): Promise<NormalizedFill[]> {
        return [
          {
            client_order_id: LOT,
            broker_fill_id: toBrokerFillId('x1'),
            leg: 'exit',
            price: 104,
            qty: 4,
            fee: 0.4,
            timestamp: new Date('2026-08-07T15:30:00Z'),
          },
        ];
      }
    })();
    failingBroker.rearmFailure = new Error('venue briefly unreachable');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(failingBroker, store, alerts));

    await execution.ingestFills();

    // The observing poll alerted once (the pre-#549 behaviour) AND left the
    // durable episode: marked unprotected, marked alerted.
    expect(alerts.alerts).toHaveLength(1);
    const marker = await store.getResidualProtectionMarker(LOT);
    expect(marker?.unprotected_since).not.toBeNull();
    expect(marker?.alerted_at).not.toBeNull();

    // The venue heals; the fill-sync-cadence sweep (same live Execution, no
    // restart) retries, confirms, clears — and does NOT page again.
    failingBroker.rearmFailure = undefined;
    const result = await execution.sweepResidualProtection();

    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
    expect(alerts.alerts).toHaveLength(1);
  });

  it('window (d): protection was confirmed on the observing poll — no marker survives and the sweep no-ops', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store, { order_state: 'filled', filled_size: 10, avg_entry_price: 100 });
    const broker = new (class extends SweepBroker {
      override async fetchNewFills(): Promise<NormalizedFill[]> {
        return [
          {
            client_order_id: LOT,
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            price: 100,
            qty: 10,
            fee: 1,
            timestamp: new Date('2026-08-07T15:00:00Z'),
          },
          {
            client_order_id: LOT,
            broker_fill_id: toBrokerFillId('x1'),
            leg: 'exit',
            price: 104,
            qty: 4,
            fee: 0.4,
            timestamp: new Date('2026-08-07T15:30:00Z'),
          },
        ];
      }
    })();
    const alerts = makeResidualExposureAlerts();
    await new ExecutionImpl(makeInput(broker, store, alerts)).ingestFills();

    // The observing poll re-armed successfully → marker cleared same poll.
    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });

    // Restart: the sweep finds nothing — no retry, no alert, no divergence.
    const restartedStore = new TestExecutionStore(db);
    const restartedBroker = new SweepBroker();
    const result = await new ExecutionImpl(
      makeInput(restartedBroker, restartedStore),
    ).sweepResidualProtection();
    expect(result).toEqual({ checked: 0, divergences: [] });
    expect(restartedBroker.rearmCalls).toEqual([]);
    expect(alerts.alerts).toEqual([]);
  });

  it('escalates from the SWEEP when the retry fails — once per episode, not once per pass (#342)', async () => {
    // Window (a) shape — the crash meant NO inline alert ever fired — so the
    // sweep is the only surface left that can page.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new Error('venue still down');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts));

    const first = await execution.sweepResidualProtection();
    expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({
      idempotency_key: LOT,
      residual_qty: 6,
      residual_qty_is_upper_bound: false,
    });

    // Pass 2 and 3: retried (every attempt), NOT re-paged (once per episode).
    const second = await execution.sweepResidualProtection();
    const third = await execution.sweepResidualProtection();
    expect(second.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(third.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(broker.rearmCalls).toHaveLength(3);
    expect(alerts.alerts).toHaveLength(1);

    // The episode ends when a retry finally confirms — and a FUTURE episode
    // may page afresh, because the dedup clears with the marker.
    broker.rearmFailure = undefined;
    await execution.sweepResidualProtection();
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
  });

  it('CLOSES the residual instead of paging when the venue can never re-arm (#1214)', async () => {
    // Saxo: every pool line reports `IsOcoOrderSupported: false`, so
    // `rearmProtectiveLegs` refuses before it ever reaches the venue. David's
    // 2026-09-08 decision (option 2) makes that refusal trigger a re-flatten
    // rather than another page: this lot was already being closed, and
    // finishing the job is the action that matches the intent.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError(
      'saxo',
      'IsOcoOrderSupported false on every pool line',
    );
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    const result = await execution.sweepResidualProtection();

    // A market order for exactly the residual, on the CLOSING side, under a
    // key derived from the lot's own.
    expect(broker.flattenCalls).toEqual([
      { clientOrderId: `${LOT}:residual-reflatten-1`, instrument: 'AAPL', side: 'sell', size: 6 },
    ]);
    // Journalled BEFORE the submit — without that row `getFlattenAttribution`
    // cannot route the fill back to this lot when it lands.
    expect(await restartedStore.getFlattenAttribution(`${LOT}:residual-reflatten-1`)).toMatchObject(
      { lot_idempotency_keys: [LOT], exit_reason: 'flatten' },
    );
    expect(await restartedStore.getUnresolvedFlattens()).toEqual([
      expect.objectContaining({
        idempotency_key: `${LOT}:residual-reflatten-1`,
        status: 'submitted',
      }),
    ]);
    // NOT paged: the residual is being closed, not abandoned.
    expect(alerts.alerts).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_submitted',
        payload: expect.objectContaining({ idempotency_key: LOT, residual_qty: 6 }),
      }),
    );
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]?.action).toBe('undetermined');
    expect(result.divergences[0]?.reason).toMatch(/was CLOSED instead/);
    // Still marked: the order is live, not filled. The marker clears when the
    // fill lands and the lot reads flat.
    expect(
      (await restartedStore.getResidualProtectionMarker(LOT))?.unprotected_since,
    ).not.toBeNull();
  });

  it('never fires a market order into a shut venue — it pages instead (#1214)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    // NOW is 16:00Z = 12:00 New York on a Friday, which IS inside the US
    // session — so the shut venue has to come from the instrument's own
    // calendar disagreeing, not from the clock. `AlwaysOpenCalendar` is what
    // every other test here uses; this one asks a calendar that says no.
    const shutCalendar: TradingCalendar = {
      isOpen: () => false,
      isTradingDay: () => true,
      sessionStart: () => NOW,
      sessionEnd: () => NOW,
    };
    const execution = new ExecutionImpl(
      makeInput(broker, restartedStore, alerts, logger, {
        crypto: new AlwaysOpenCalendar(),
        stocks: shutCalendar,
      }),
    );

    const result = await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts[0]).toMatchObject({ idempotency_key: LOT, rearm_unsupported: true });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'venue_shut' }),
      }),
    );
    expect(result.divergences[0]?.reason).toMatch(/could not be closed either/);
  });

  it('stands down while a flatten on the same instrument is still unresolved (#1214)', async () => {
    // The daily flat-by-close cadence and this path can name the same lot;
    // the decision forbids both submitting. The journal is the referee.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);
    await store.writeAheadFlatten(flattenWriteAhead('daily-flatten-1'));

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'flatten_in_flight' }),
      }),
    );
  });

  it('does NOT page while this lot’s own re-flatten is still working (#1214 review, finding 4)', async () => {
    // The pass right after a successful submit sees the very order it sent.
    // Paging here would tell the operator the residual "could not be closed"
    // of a lot with a live closing order, and the page's remedy — act at the
    // venue by hand — would be a THIRD submitter. Contrast the test above: a
    // flatten belonging to someone else still pages, because that one leaves
    // this lot's residual genuinely unattended.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);
    const ownKey = `${LOT}:residual-reflatten-1`;
    await store.writeAheadFlatten(flattenWriteAhead(ownKey));
    await store.resolveFlattenSubmitted(
      ownKey,
      { order_state: 'submitted', broker_order_ids: [ownKey] },
      NOW,
    );

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toEqual([]);
    // The marker stays: protection is still NOT confirmed, and it is the
    // re-flatten's fill that clears it.
    expect(
      (await restartedStore.getResidualProtectionMarker(LOT))?.unprotected_since,
    ).not.toBeNull();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'own_reflatten_in_flight' }),
      }),
    );
  });

  it('prefers this lot’s OWN re-flatten when several unresolved rows name the instrument (#1214 review round 2, finding 6)', async () => {
    // `writeAheadFlatten`'s own gate makes two unresolved rows on one
    // instrument unreachable going forward, so this state can only be
    // pre-gate data — but it is data a live database can hold, and the
    // classification it feeds decides whether this pass PAGES. Picking by
    // `Array.find` over the scan meant picking by table order: here the
    // someone-else's row sorts first, so a plain `find` reports
    // `flatten_in_flight` and pages about a lot whose own closing order is
    // working. THE MUTATION THIS KILLS: drop the own-key preference in
    // `reflattenResidual` and take `onInstrument[0]`.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);
    const ownKey = `${LOT}:residual-reflatten-1`;
    const insert = db.prepare(
      `INSERT INTO flatten_submissions (
         idempotency_key, instrument, asset_class, side, size, status,
         order_state, broker_order_ids, submitted_at, resolved_at, arm
       ) VALUES (?, 'AAPL', 'stocks', 'sell', 6, 'submitted', 'submitted', ?, ?, ?, 'live')`,
    );
    // Inserted first, so `find` over the scan would return this one.
    insert.run(
      'daily-flatten-1',
      JSON.stringify(['daily-flatten-1']),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    insert.run(ownKey, JSON.stringify([ownKey]), NOW.toISOString(), NOW.toISOString());

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'own_reflatten_in_flight' }),
      }),
    );
  });

  it('stops after MAX_RESIDUAL_REFLATTEN_ATTEMPTS and falls back to the page (#1214)', async () => {
    // The bound is DURABLE, not an in-memory counter: three spent keys in the
    // journal are what stop the fourth attempt, so a restart cannot reset it.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);
    for (let attempt = 1; attempt <= MAX_RESIDUAL_REFLATTEN_ATTEMPTS; attempt++) {
      const key = `${LOT}:residual-reflatten-${attempt}`;
      await store.writeAheadFlatten(flattenWriteAhead(key));
      // Resolved, so the instrument has no unresolved flatten and the walk
      // reaches the bound rather than standing down on the gate before it.
      await store.resolveFlattenError(key, 'the venue rejected the residual', NOW);
    }

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'attempts_exhausted' }),
      }),
    );
  });

  it('a re-flatten the venue refused without filling does not wedge the mechanism (#1214 review)', async () => {
    // The wedge: `fills_swept_at` is the ONLY thing that ever bounds a
    // 'submitted' flatten row, and only `ingestFills()` sets it, only for a
    // flatten that produced fills. A re-flatten the venue rejected outright
    // therefore had nothing that could resolve it — `getUnresolvedFlattens()`
    // named its instrument forever, across restarts, so every later attempt
    // stood down on 'flatten_in_flight' and 'attempts_exhausted' was never
    // reached.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const firstKey = `${LOT}:residual-reflatten-1`;

    await new ExecutionImpl(
      makeInput(broker, new TestExecutionStore(db)),
    ).sweepResidualProtection();
    expect(broker.flattenCalls.map((call) => call.clientOrderId)).toEqual([firstKey]);

    // The venue's verdict on it: terminal, and it closed nothing.
    broker.resumeFlattenAnswers.set(firstKey, {
      client_order_id: firstKey,
      broker_order_ids: [firstKey],
      order_state: 'rejected',
      filled_qty: 0,
    });

    // A restart, then one reconcile pass: its flatten loop settles the dead
    // row, and the #549 sweep that runs later in the SAME pass then finds the
    // instrument clear and walks on to the next key.
    const restartedStore = new TestExecutionStore(db);
    await new ExecutionImpl(makeInput(broker, restartedStore)).reconcile();

    expect(broker.flattenCalls.map((call) => call.clientOrderId)).toEqual([
      firstKey,
      `${LOT}:residual-reflatten-2`,
    ]);
    expect((await restartedStore.getFlattenSubmission(firstKey))?.status).toBe('error');
  });

  it('CLOSES a #867 full-quantity lot too — no exit fill is not exit-path ownership (#1214 review)', async () => {
    // `markLotsUnprotected` (execute.ts) marks lots whose legs were cancelled
    // before a flatten the cancel loop then refused: full held quantity, no
    // exit fill. This module used to stand those down on `exitQty === 0`,
    // reasoning that `resolveExitRetryKey` still owned them — but that chain
    // hangs off the ORDER's per-bar key, so nothing derives lot ownership from
    // an exit-fill count, and the lot is naked by exactly the definition #1214
    // says to close. What actually prevents two submitters is
    // `writeAheadFlatten`'s atomic per-instrument refusal (see the
    // 'flatten_in_flight' cases above), which holds in both orderings.
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedEntryOnlyFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    // The WHOLE held quantity, not a remainder — nothing was ever sold.
    expect(broker.flattenCalls).toEqual([
      {
        clientOrderId: `${LOT}:residual-reflatten-1`,
        instrument: 'AAPL',
        side: 'sell',
        size: 10,
      },
    ]);
    expect(alerts.alerts).toEqual([]);
  });

  it("leaves a thrown submitFlatten at 'submitting' for reconcile, and pages (#1214)", async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    broker.flattenFailure = new Error('venue timed out');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    // Ambiguous, so never resolved to 'error': the venue may have seen it.
    expect(await restartedStore.getUnresolvedFlattens()).toEqual([
      expect.objectContaining({
        idempotency_key: `${LOT}:residual-reflatten-1`,
        status: 'submitting',
      }),
    ]);
    expect(alerts.alerts).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'residual_reflatten_failed' }),
    );
  });

  it('never submits unjournalled — a failed write-ahead ends the attempt (#1214)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    restartedStore.writeAheadFlatten = async () => {
      throw new Error('disk full');
    };
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts, logger));

    await execution.sweepResidualProtection();

    // A market order with no attribution row is the worst state this design
    // can reach: nothing routes its fill, so the lot stays open in the store
    // while flat at the venue.
    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', event: 'residual_reflatten_failed' }),
    );
  });

  it('pages rather than guessing when the calendar cannot answer (#1214)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new ProtectiveRearmUnsupportedError('saxo', 'IsOcoOrderSupported false');
    const alerts = makeResidualExposureAlerts();
    const logger = recordingLogger();
    const throwingCalendar: TradingCalendar = {
      isOpen() {
        throw new Error('calendar coverage ends before this instant');
      },
      isTradingDay: () => true,
      sessionStart: () => NOW,
      sessionEnd: () => null,
    };
    const execution = new ExecutionImpl(
      makeInput(broker, restartedStore, alerts, logger, {
        crypto: new AlwaysOpenCalendar(),
        stocks: throwingCalendar,
      }),
    );

    await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toHaveLength(1);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'session_unknown' }),
      }),
    );
  });

  it('keeps an ordinary re-arm failure readable as retryable (#1214)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new Error('venue briefly unreachable');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts));

    const result = await execution.sweepResidualProtection();

    expect(result.divergences[0]?.reason).toMatch(/re-arm retry failed/);
    expect(alerts.alerts[0]).toMatchObject({ rearm_unsupported: false });
    // #1214 is scoped to a PERMANENT gap. An ordinary failure is still a
    // retry, and a market order must not be spent on one.
    expect(broker.flattenCalls).toEqual([]);
  });

  it('re-pages on the next pass when the alert channel swallowed the first delivery — dedup records only accepted pages (#549 review)', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    broker.rearmFailure = new Error('venue still down');
    // A transport that is DOWN for the first delivery and healthy after —
    // the transient outage that must not permanently silence the page.
    const delivered: ResidualExposureAlert[] = [];
    let failDeliveriesRemaining = 1;
    const flakyChannel: ResidualExposureAlertChannel = {
      async postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void> {
        if (failDeliveriesRemaining > 0) {
          failDeliveriesRemaining -= 1;
          throw new Error('alert transport outage');
        }
        delivered.push(alert);
      },
    };
    const execution = new ExecutionImpl(makeInput(broker, restartedStore, flakyChannel));

    await execution.sweepResidualProtection();
    // The delivery was swallowed, so the episode must NOT read as alerted.
    expect(delivered).toHaveLength(0);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).toBeNull();

    // Next pass: still failing, transport healthy — the page goes out now,
    // and only now is the dedup recorded.
    await execution.sweepResidualProtection();
    expect(delivered).toHaveLength(1);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).not.toBeNull();

    // And a third pass stays deduped.
    await execution.sweepResidualProtection();
    expect(delivered).toHaveLength(1);
  });

  it('clears a marker whose lot reads flat on the persisted record without any broker call', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store);
    await store.applyLotAdvance({
      idempotency_key: LOT,
      fills: [
        {
          idempotency_key: LOT,
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          price: 100,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:00:00Z'),
        },
        {
          idempotency_key: LOT,
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          price: 104,
          qty: 10,
          fee: 1,
          timestamp: new Date('2026-08-07T15:30:00Z'),
        },
      ],
      position_update: { filled_size: 10, avg_entry_price: 100, order_state: 'partially_filled' },
    });
    await store.markResidualUnprotected(LOT, NOW);

    const broker = new SweepBroker();
    const result = await new ExecutionImpl(makeInput(broker, store)).sweepResidualProtection();

    expect(broker.rearmCalls).toEqual([]);
    expect(result.divergences.map((entry) => entry.action)).toEqual(['adopted']);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
  });

  it('excludes terminal lots from the worklist — a closed lot with a stale marker is settled, not swept', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store);
    await store.markResidualUnprotected(LOT, NOW);
    await store.updatePositionState(LOT, { order_state: 'closed', broker_order_ids: [] });

    expect(await store.getUnprotectedResidualLots()).toEqual([]);
  });

  // #549 review (cycle 2): every containment branch of `sweepOne`, pinned
  // directly — not through the smoke run's happy path and not through
  // fill-sync's mocked surface.
  describe('sweep containment branches', () => {
    it('a hostile thrown value on one lot does not abort the pass — the remaining marked lots are still swept (#1262)', async () => {
      const FIRST = 'key-hostile';
      const SECOND = 'key-second';
      const { db, store } = openTestExecutionStore();
      // `getUnprotectedResidualLots()` orders by `opened_at`, so the hostile
      // lot is swept FIRST and everything after it is what a throw would cost.
      await seedPosition(store, {
        idempotency_key: FIRST,
        opened_at: new Date('2026-08-07T13:00:00Z'),
        broker_order_ids: [`${FIRST}:entry`],
      });
      await seedPosition(store, {
        idempotency_key: SECOND,
        instrument: 'MSFT',
        opened_at: new Date('2026-08-07T14:00:00Z'),
        broker_order_ids: [`${SECOND}:entry`],
      });
      for (const key of [FIRST, SECOND]) {
        await store.applyLotAdvance({
          idempotency_key: key,
          fills: [
            {
              idempotency_key: key,
              broker_fill_id: toBrokerFillId(`${key}-e1`),
              leg: 'entry',
              price: 100,
              qty: 10,
              fee: 1,
              timestamp: new Date('2026-08-07T15:00:00Z'),
            },
            {
              idempotency_key: key,
              broker_fill_id: toBrokerFillId(`${key}-x1`),
              leg: 'exit',
              price: 104,
              qty: 4,
              fee: 0.4,
              timestamp: new Date('2026-08-07T15:30:00Z'),
            },
          ],
          position_update: {
            filled_size: 10,
            avg_entry_price: 100,
            order_state: 'partially_filled',
          },
        });
        await store.markResidualUnprotected(key, NOW);
      }

      // Circular (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
      // (defeats the `String()` fallback too) — the same construction
      // orchestrator.test.ts uses to defeat `describeThrown` itself. Thrown
      // from `confirmResidualProtected`, which `sweepOne` calls OUTSIDE its own
      // try blocks, so it lands in the per-lot catch inside the `for` loop.
      const hostile: Record<string, unknown> = {
        [Symbol.toPrimitive]: () => {
          throw new Error('render boom');
        },
      };
      hostile.self = hostile;

      const hostileStore = new (class extends TestExecutionStore {
        override async confirmResidualProtected(key: string): Promise<void> {
          if (key === FIRST) throw hostile;
          await super.confirmResidualProtected(key);
        }
      })(db);
      const broker = new SweepBroker();
      const result = await new ExecutionImpl(
        makeInput(broker, hostileStore),
      ).sweepResidualProtection();

      // THE DAMAGE THIS PINS: the loop reached the second lot at all. Before
      // the guard, rendering the hostile value threw out of the per-lot catch
      // and out of `sweepResidualProtection` itself, so the second lot was
      // never re-armed and its residual stayed naked until some later pass.
      expect(broker.rearmCalls).toEqual([
        { clientOrderId: FIRST, qty: 6 },
        { clientOrderId: SECOND, qty: 6 },
      ]);
      expect(await hostileStore.getResidualProtectionMarker(SECOND)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
      expect(result.checked).toBe(2);

      // And the first lot's failure is RECORDED, not swallowed: its marker
      // survives for the next pass and the divergence names the render
      // failure with the shared placeholder.
      expect(
        (await hostileStore.getResidualProtectionMarker(FIRST))?.unprotected_since,
      ).not.toBeNull();
      const failed = result.divergences.find((entry) => entry.idempotency_key === FIRST);
      expect(failed?.action).toBe('undetermined');
      expect(failed?.reason).toContain('[unrenderable error]');
    });

    it('pages the upper-bound requested_size and keeps the marker when the fill read fails', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const failingStore = new (class extends TestExecutionStore {
        override async getFills(): Promise<never> {
          throw new Error('fills table unreadable');
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const result = await new ExecutionImpl(
        makeInput(broker, failingStore, alerts),
      ).sweepResidualProtection();

      // The exact residual is unknowable — the page carries the lot's whole
      // requested size, flagged as an upper bound (#569's semantics).
      expect(alerts.alerts).toEqual([
        expect.objectContaining({
          idempotency_key: LOT,
          residual_qty: 10,
          residual_qty_is_upper_bound: true,
        }),
      ]);
      // No re-arm was attempted off a figure that could not be computed.
      expect(broker.rearmCalls).toEqual([]);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      // The marker stays for the next pass's fresh read.
      expect(
        (await failingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();
    });

    it('refuses a non-finite recomputed residual — alert, no broker call, marker stays', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

      // Entry and exit both sum to Infinity: `coversQty(Inf, Inf)` is false
      // (Inf − Inf·ε is NaN, and Inf >= NaN is false) so the lot reads
      // not-flat, while the residual recomputes to NaN — the exact
      // store-numbers-disagree shape the guard refuses to hand the broker.
      const garbageStore = new (class extends TestExecutionStore {
        override async getFills(): Promise<Fill[]> {
          const base = {
            idempotency_key: LOT,
            price: 100,
            fee: 0,
            timestamp: new Date('2026-08-07T15:00:00Z'),
          };
          return [
            {
              ...base,
              broker_fill_id: toBrokerFillId('e1'),
              leg: 'entry',
              qty: Number.POSITIVE_INFINITY,
            },
            {
              ...base,
              broker_fill_id: toBrokerFillId('x1'),
              leg: 'exit',
              qty: Number.POSITIVE_INFINITY,
            },
          ];
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const result = await new ExecutionImpl(
        makeInput(broker, garbageStore, alerts),
      ).sweepResidualProtection();

      expect(broker.rearmCalls).toEqual([]);
      expect(alerts.alerts).toHaveLength(1);
      // #549 review (round 3): the page must never carry the garbage value —
      // NaN serializes to null and a negative reads as nonsense. It carries
      // the upper-bound requested_size with the upper-bound flag, mirroring
      // the fill-read-failure path; the divergence reason keeps the real
      // recomputed value for diagnosis.
      expect(alerts.alerts[0]?.residual_qty).toBe(10);
      expect(alerts.alerts[0]?.residual_qty_is_upper_bound).toBe(true);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(result.divergences.map((entry) => entry.kind)).toEqual(['sweep']);
      expect(result.divergences[0]?.reason).toContain('NaN');
      expect(
        (await garbageStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();
    });

    it('contains a confirm-write failure after a successful re-arm — undetermined, no page, next pass re-verifies', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const confirmFailingStore = new (class extends TestExecutionStore {
        failConfirm = true;
        override async confirmResidualProtected(idempotency_key: string): Promise<void> {
          if (this.failConfirm) throw new Error('marker write refused');
          return super.confirmResidualProtected(idempotency_key);
        }
      })(db);
      const broker = new SweepBroker();
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, confirmFailingStore, alerts));

      const first = await execution.sweepResidualProtection();

      // The re-arm itself succeeded — a bookkeeping failure is NOT a naked
      // residual, so nobody is paged; the outer containment reports it and
      // the marker survives for the next pass's idempotent re-verify.
      expect(broker.rearmCalls).toHaveLength(1);
      expect(alerts.alerts).toEqual([]);
      expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(
        (await confirmFailingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();

      // The store heals: the next pass re-verifies (idempotent re-arm) and
      // finally clears the marker.
      confirmFailingStore.failConfirm = false;
      const second = await execution.sweepResidualProtection();
      expect(second.divergences.map((entry) => entry.action)).toEqual(['adopted']);
      expect(await confirmFailingStore.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
    });

    it('contains an alert-dedup mark failure — the page went out, the pass survives, the next pass may re-page', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const markFailingStore = new (class extends TestExecutionStore {
        override async markResidualAlerted(): Promise<never> {
          throw new Error('dedup write refused');
        }
      })(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new Error('venue still down');
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, markFailingStore, alerts));

      const first = await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(1);
      expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      // The dedup never persisted, so the next pass re-pages — noisy, not
      // unsafe, exactly the trade the catch documents.
      await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(2);
    });
  });

  describe('the marker store methods (migration 0024)', () => {
    it('markResidualUnprotected keeps the FIRST observation and never resets the alert dedup', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      const first = new Date('2026-08-07T15:00:00Z');
      await store.markResidualUnprotected(LOT, first);
      await store.markResidualAlerted(LOT, NOW);
      await store.markResidualUnprotected(LOT, new Date('2026-08-07T15:45:00Z'));

      expect(await store.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: first.toISOString(),
        alerted_at: NOW.toISOString(),
      });
      const [row] = await store.getUnprotectedResidualLots();
      expect(row?.unprotected_since).toEqual(first);
      expect(row?.alerted_at).toEqual(NOW);
      expect(row?.position.idempotency_key).toBe(LOT);
    });

    it('markResidualUnprotected refuses a key with no lot — a marker protecting nothing must not silently succeed', async () => {
      const { store } = openTestExecutionStore();
      await expect(store.markResidualUnprotected('no-such-lot', NOW)).rejects.toThrow(
        /no open_positions row/,
      );
    });

    it('markResidualAlerted is first-writer-wins: conditional on the episode being un-alerted, reporting who won (#549 review)', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

      const later = new Date('2026-08-07T17:00:00Z');
      await expect(store.markResidualAlerted(LOT, NOW)).resolves.toBe(true);
      // A second surface arriving later does NOT overwrite the record — the
      // dedup holds regardless of caller ordering.
      await expect(store.markResidualAlerted(LOT, later)).resolves.toBe(false);
      expect((await store.getResidualProtectionMarker(LOT))?.alerted_at).toBe(NOW.toISOString());
      // An unknown key is `false`, never a throw — the write is a claim, not
      // an assertion the lot exists.
      await expect(store.markResidualAlerted('no-such-lot', NOW)).resolves.toBe(false);

      // The claim re-opens with the episode: confirm clears both columns,
      // and a NEW episode's first writer wins again.
      await store.confirmResidualProtected(LOT);
      await store.markResidualUnprotected(LOT, later);
      await expect(store.markResidualAlerted(LOT, later)).resolves.toBe(true);
    });

    it('confirmResidualProtected clears both columns and is a no-op on an unmarked lot', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);
      await store.markResidualAlerted(LOT, NOW);
      await store.confirmResidualProtected(LOT);
      expect(await store.getResidualProtectionMarker(LOT)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
      // No throw on the already-clear (or unknown) key — the sweep and the
      // observing poll may race to clear.
      await expect(store.confirmResidualProtected(LOT)).resolves.toBeUndefined();
      await expect(store.confirmResidualProtected('no-such-lot')).resolves.toBeUndefined();
    });
  });

  describe('#1447: the truthful permanent-gap page has its own dedup', () => {
    it('a pre-attempt page already recorded must not suppress the later venue-refusal page', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);
      // Simulates a store-read-failure/non-finite-residual page that already
      // fired for this episode BEFORE any re-arm was even attempted — the
      // general dedup is spent, exactly the pre-condition #1447 was filed
      // against.
      await store.markResidualAlerted(LOT, new Date('2026-08-07T15:00:00Z'));

      const restartedStore = new TestExecutionStore(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false',
      );
      // Force the #1214 re-flatten remedy to fail too, so this pass falls
      // through to the page — same technique as "never submits unjournalled"
      // above.
      restartedStore.writeAheadFlatten = async () => {
        throw new Error('disk full');
      };
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts));

      await execution.sweepResidualProtection();

      // The general dedup being already-set must not have blocked this.
      expect(alerts.alerts).toEqual([
        expect.objectContaining({ idempotency_key: LOT, rearm_unsupported: true }),
      ]);
      expect(await restartedStore.getResidualRearmUnsupportedAlertedAtRaw(LOT)).not.toBeNull();
    });

    it('once fired, the venue-refusal page stays quiet on a later pass (once per episode)', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await seedPartiallyFlattenedFills(store);
      await store.markResidualUnprotected(LOT, NOW);

      const restartedStore = new TestExecutionStore(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false',
      );
      restartedStore.writeAheadFlatten = async () => {
        throw new Error('disk full');
      };
      const alerts = makeResidualExposureAlerts();
      const execution = new ExecutionImpl(makeInput(broker, restartedStore, alerts));

      await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(1);

      await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(1);
    });

    it('confirmResidualProtected clears the permanent-gap dedup too, so a LATER episode pages afresh', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);
      await store.markResidualRearmUnsupportedAlerted(LOT, NOW);
      expect(await store.getResidualRearmUnsupportedAlertedAtRaw(LOT)).not.toBeNull();

      await store.confirmResidualProtected(LOT);
      expect(await store.getResidualRearmUnsupportedAlertedAtRaw(LOT)).toBeNull();

      const later = new Date('2026-08-07T17:00:00Z');
      await store.markResidualUnprotected(LOT, later);
      await expect(store.markResidualRearmUnsupportedAlerted(LOT, later)).resolves.toBe(true);
    });

    it('markResidualRearmUnsupportedAlerted is first-writer-wins, independent of markResidualAlerted', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

      // The general dedup is exercised first — it must not gate this one.
      await expect(store.markResidualAlerted(LOT, NOW)).resolves.toBe(true);
      await expect(store.markResidualRearmUnsupportedAlerted(LOT, NOW)).resolves.toBe(true);
      // Second writer for the SAME dedup loses; the general dedup is untouched.
      const later = new Date('2026-08-07T17:00:00Z');
      await expect(store.markResidualRearmUnsupportedAlerted(LOT, later)).resolves.toBe(false);
      expect(await store.getResidualRearmUnsupportedAlertedAtRaw(LOT)).toBe(NOW.toISOString());
    });
  });
});
