import { ProtectiveRearmUnsupportedError } from '../../apps/v2/execution/alpaca/protective-rearm-unsupported.js';
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
import { UnrecordedVenuePositionThrottle } from './unrecorded-venue-position-throttle.js';

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

class SweepBroker implements BrokerAdapter {
  readonly rearmCalls: Array<{ clientOrderId: string; qty: number }> = [];
  readonly flattenCalls: Array<{
    clientOrderId: string;
    instrument: string;
    side: 'buy' | 'sell';
    size: number;
  }> = [];
  rearmFailure: Error | undefined;
  flattenFailure: Error | undefined;

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [order.client_order_id],
      order_state: 'submitted',
    };
  }
  async fetchNewFills(_since: string): Promise<NormalizedFill[]> {
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
  readonly resumeFlattenAnswers = new Map<string, NormalizedOrder>();
  async resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
    return this.resumeFlattenAnswers.get(clientOrderId) ?? null;
  }
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
    unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    logger,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
  };
}

describe('residual-protection sweep (#549)', () => {
  it('window (a): crash after the exit fill persisted, before the re-arm attempt — the restarted reconcile() retries and clears the marker', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
    const alerts = makeResidualExposureAlerts();
    const report = await new ExecutionImpl(makeInput(broker, restartedStore, alerts)).reconcile();

    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
    const divergence = report.divergences.find((entry) => entry.idempotency_key === LOT);
    expect(divergence?.action).toBe('adopted');
    expect(divergence?.kind).toBe('sweep');
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.corrected).toBeGreaterThanOrEqual(1);
    expect(alerts.alerts).toEqual([]);
  });

  it('window (b): re-arm succeeded venue-side but crashed before confirming — the sweep retry is adopt-or-place, not a double submit', async () => {
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);

    const restartedStore = new TestExecutionStore(db);
    const broker = new SweepBroker();
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

    const second = await execution.sweepResidualProtection();
    expect(second).toEqual({ checked: 0, divergences: [] });
    expect(broker.rearmCalls).toHaveLength(1);
  });

  it('window (c): the observing poll’s re-arm threw and the process lived — the marker survives, the sweep retries and clears it without paging twice', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { order_state: 'filled', filled_size: 10, avg_entry_price: 100 });
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
            timestamp: '2026-08-07T15:30:00.000Z',
          },
        ];
      }
    })();
    failingBroker.rearmFailure = new Error('venue briefly unreachable');
    const alerts = makeResidualExposureAlerts();
    const execution = new ExecutionImpl(makeInput(failingBroker, store, alerts));

    await execution.ingestFills();

    expect(alerts.alerts).toHaveLength(1);
    const marker = await store.getResidualProtectionMarker(LOT);
    expect(marker?.unprotected_since).not.toBeNull();
    expect(marker?.alerted_at).not.toBeNull();

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
            timestamp: '2026-08-07T15:00:00.000Z',
          },
          {
            client_order_id: LOT,
            broker_fill_id: toBrokerFillId('x1'),
            leg: 'exit',
            price: 104,
            qty: 4,
            fee: 0.4,
            timestamp: '2026-08-07T15:30:00.000Z',
          },
        ];
      }
    })();
    const alerts = makeResidualExposureAlerts();
    await new ExecutionImpl(makeInput(broker, store, alerts)).ingestFills();

    expect(broker.rearmCalls).toEqual([{ clientOrderId: LOT, qty: 6 }]);
    expect(await store.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });

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

    const second = await execution.sweepResidualProtection();
    const third = await execution.sweepResidualProtection();
    expect(second.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(third.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
    expect(broker.rearmCalls).toHaveLength(3);
    expect(alerts.alerts).toHaveLength(1);

    broker.rearmFailure = undefined;
    await execution.sweepResidualProtection();
    expect(await restartedStore.getResidualProtectionMarker(LOT)).toEqual({
      unprotected_since: null,
      alerted_at: null,
    });
  });

  it('CLOSES the residual instead of paging when the venue can never re-arm (#1214)', async () => {
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

    expect(broker.flattenCalls).toEqual([
      { clientOrderId: `${LOT}:residual-reflatten-1`, instrument: 'AAPL', side: 'sell', size: 6 },
    ]);
    expect(await restartedStore.getFlattenAttribution(`${LOT}:residual-reflatten-1`)).toMatchObject(
      { lot_idempotency_keys: [LOT], exit_reason: 'flatten' },
    );
    expect(await restartedStore.getUnresolvedFlattens()).toEqual([
      expect.objectContaining({
        idempotency_key: `${LOT}:residual-reflatten-1`,
        status: 'submitted',
      }),
    ]);
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
    expect(result.divergences[0]?.escalation).toBe('residual_sweep_reflatten_submitted');
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
    expect(result.divergences[0]?.escalation).toBe('residual_sweep_rearm_unsupported');
  });

  it('stands down while a flatten on the same instrument is still unresolved (#1214)', async () => {
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

    const result = await execution.sweepResidualProtection();

    expect(broker.flattenCalls).toEqual([]);
    expect(alerts.alerts).toEqual([]);
    expect(
      (await restartedStore.getResidualProtectionMarker(LOT))?.unprotected_since,
    ).not.toBeNull();
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        event: 'residual_reflatten_skipped',
        payload: expect.objectContaining({ reason: 'own_reflatten_in_flight' }),
      }),
    );
    expect(result.divergences[0]?.escalation).toBe('residual_sweep_reflatten_in_flight');
  });

  it('prefers this lot’s OWN re-flatten when several unresolved rows name the instrument (#1214 review round 2, finding 6)', async () => {
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
    const { db, store } = openTestExecutionStore();
    await seedPosition(store);
    await seedPartiallyFlattenedFills(store);
    await store.markResidualUnprotected(LOT, NOW);
    for (let attempt = 1; attempt <= MAX_RESIDUAL_REFLATTEN_ATTEMPTS; attempt++) {
      const key = `${LOT}:residual-reflatten-${attempt}`;
      await store.writeAheadFlatten(flattenWriteAhead(key));
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

    broker.resumeFlattenAnswers.set(firstKey, {
      client_order_id: firstKey,
      broker_order_ids: [firstKey],
      order_state: 'rejected',
      filled_qty: 0,
    });

    const restartedStore = new TestExecutionStore(db);
    await new ExecutionImpl(makeInput(broker, restartedStore)).reconcile();

    expect(broker.flattenCalls.map((call) => call.clientOrderId)).toEqual([
      firstKey,
      `${LOT}:residual-reflatten-2`,
    ]);
    expect((await restartedStore.getFlattenSubmission(firstKey))?.status).toBe('error');
  });

  it('CLOSES a #867 full-quantity lot too — no exit fill is not exit-path ownership (#1214 review)', async () => {
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
    expect(result.divergences[0]?.escalation).toBe('residual_sweep_rearm_retry_failed');
    expect(alerts.alerts[0]).toMatchObject({ rearm_unsupported: false });
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
    expect(delivered).toHaveLength(0);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).toBeNull();

    await execution.sweepResidualProtection();
    expect(delivered).toHaveLength(1);
    expect((await restartedStore.getResidualProtectionMarker(LOT))?.alerted_at).not.toBeNull();

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

  describe('sweep containment branches', () => {
    it('a hostile thrown value on one lot does not abort the pass — the remaining marked lots are still swept (#1262)', async () => {
      const FIRST = 'key-hostile';
      const SECOND = 'key-second';
      const { db, store } = openTestExecutionStore();
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

      expect(broker.rearmCalls).toEqual([
        { clientOrderId: FIRST, qty: 6 },
        { clientOrderId: SECOND, qty: 6 },
      ]);
      expect(await hostileStore.getResidualProtectionMarker(SECOND)).toEqual({
        unprotected_since: null,
        alerted_at: null,
      });
      expect(result.checked).toBe(2);

      expect(
        (await hostileStore.getResidualProtectionMarker(FIRST))?.unprotected_since,
      ).not.toBeNull();
      const failed = result.divergences.find((entry) => entry.idempotency_key === FIRST);
      expect(failed?.action).toBe('undetermined');
      expect(failed?.reason).toContain('[unrenderable error]');
      expect(failed?.escalation).toBe('residual_sweep_lot_unsettled');
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

      expect(alerts.alerts).toEqual([
        expect.objectContaining({
          idempotency_key: LOT,
          residual_qty: 10,
          residual_qty_is_upper_bound: true,
        }),
      ]);
      expect(broker.rearmCalls).toEqual([]);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(result.divergences[0]?.escalation).toBe('residual_sweep_size_read_failed');
      expect(
        (await failingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();
    });

    it('refuses a non-finite recomputed residual — alert, no broker call, marker stays', async () => {
      const { db, store } = openTestExecutionStore();
      await seedPosition(store);
      await store.markResidualUnprotected(LOT, NOW);

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
      expect(alerts.alerts[0]?.residual_qty).toBe(10);
      expect(alerts.alerts[0]?.residual_qty_is_upper_bound).toBe(true);
      expect(result.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(result.divergences.map((entry) => entry.kind)).toEqual(['sweep']);
      expect(result.divergences[0]?.reason).toContain('NaN');
      expect(result.divergences[0]?.escalation).toBe('residual_sweep_garbage_residual');
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

      expect(broker.rearmCalls).toHaveLength(1);
      expect(alerts.alerts).toEqual([]);
      expect(first.divergences.map((entry) => entry.action)).toEqual(['undetermined']);
      expect(
        (await confirmFailingStore.getResidualProtectionMarker(LOT))?.unprotected_since,
      ).not.toBeNull();

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
      await execution.sweepResidualProtection();
      expect(alerts.alerts).toHaveLength(2);
    });
  });

  describe('the exact divergence and log record of each sweep outcome', () => {
    const divergence = (reason: string, escalation?: string) => ({
      idempotency_key: LOT,
      instrument: 'AAPL',
      store_state: 'partially_filled',
      broker_state: null,
      action: 'undetermined',
      kind: 'sweep',
      reason,
      ...(escalation === undefined ? {} : { escalation }),
    });
    const logLine = (
      event: string,
      level: string,
      message: string,
      payload: Record<string, unknown>,
    ) => ({
      trace_id: 'trace-sweep',
      stage: 'execution',
      event,
      level,
      message,
      payload: { idempotency_key: LOT, ...payload },
    });
    const DEDUP_HELD_MESSAGE =
      "residual-exposure page dedup was already held by another surface — this pass's page " +
      'was a duplicate; the durable record stays single-writer';

    async function markedLot(fills: 'partial' | 'none' | 'flat' = 'partial') {
      const opened = openTestExecutionStore();
      await seedPosition(opened.store);
      if (fills === 'partial') await seedPartiallyFlattenedFills(opened.store);
      if (fills === 'flat') {
        await seedPartiallyFlattenedFills(opened.store);
        await opened.store.applyLotAdvance({
          idempotency_key: LOT,
          fills: [
            {
              idempotency_key: LOT,
              broker_fill_id: toBrokerFillId('x2'),
              leg: 'exit',
              price: 104,
              qty: 6,
              fee: 0.6,
              timestamp: new Date('2026-08-07T15:45:00Z'),
            },
          ],
          position_update: {
            filled_size: 10,
            avg_entry_price: 100,
            order_state: 'partially_filled',
          },
        });
      }
      await opened.store.markResidualUnprotected(LOT, NOW);
      return opened;
    }

    async function sweepWith(store: TestExecutionStore, broker: SweepBroker) {
      const logger = recordingLogger();
      const result = await new ExecutionImpl(
        makeInput(broker, store, makeResidualExposureAlerts(), logger),
      ).sweepResidualProtection();
      return { result, logger };
    }

    it('reports nothing and keeps the marker for a marked lot with no entry fill yet', async () => {
      const { store } = await markedLot('none');
      const broker = new SweepBroker();

      const { result } = await sweepWith(store, broker);

      expect(result).toEqual({ checked: 1, divergences: [] });
      expect(broker.rearmCalls).toEqual([]);
      expect((await store.getResidualProtectionMarker(LOT))?.unprotected_since).not.toBeNull();
    });

    it('adopts a lot that reads flat', async () => {
      const { store } = await markedLot('flat');

      const { result } = await sweepWith(store, new SweepBroker());

      expect(result.divergences).toEqual([
        {
          ...divergence(
            'marked lot reads flat on the persisted fill record — nothing left unprotected; ' +
              'residual-protection marker cleared',
          ),
          action: 'adopted',
        },
      ]);
    });

    it('adopts a successfully re-armed residual', async () => {
      const { store } = await markedLot();

      const { result, logger } = await sweepWith(store, new SweepBroker());

      expect(result.divergences).toEqual([
        {
          ...divergence(
            'protective legs re-armed for residual 6 by the #549 sweep — ' +
              'residual-protection marker cleared',
          ),
          action: 'adopted',
        },
      ]);
      expect(logger.entries).toEqual([]);
    });

    it('records a failed fill read', async () => {
      const { db } = await markedLot();
      const store = new (class extends TestExecutionStore {
        override async getFills(): Promise<never> {
          throw new Error('fills table unreadable');
        }
      })(db);

      const { result, logger } = await sweepWith(store, new SweepBroker());

      expect(result.divergences).toEqual([
        divergence(
          'marked residual could not be recomputed (fill read failed): fills table unreadable',
          'residual_sweep_size_read_failed',
        ),
      ]);
      expect(logger.entries).toContainEqual(
        logLine(
          'residual_size_read_failed',
          'error',
          'sweepResidualProtection: store read failed while recomputing a marked residual — ' +
            'alerting with the upper-bound requested_size instead',
          { error: 'fills table unreadable' },
        ),
      );
    });

    it('refuses an infinite residual against a finite exit', async () => {
      const { db } = await markedLot('none');
      const store = new (class extends TestExecutionStore {
        override async getFills(): Promise<Fill[]> {
          const base = { idempotency_key: LOT, price: 100, fee: 0, timestamp: NOW };
          return [
            {
              ...base,
              broker_fill_id: toBrokerFillId('e1'),
              leg: 'entry',
              qty: Number.POSITIVE_INFINITY,
            },
            { ...base, broker_fill_id: toBrokerFillId('x1'), leg: 'exit', qty: 4 },
          ];
        }
      })(db);
      const broker = new SweepBroker();

      const { result } = await sweepWith(store, broker);

      expect(broker.rearmCalls).toEqual([]);
      expect(result.divergences).toEqual([
        divergence(
          'marked residual recomputes to Infinity (non-finite or non-positive) while the fill ' +
            'record reads not-flat — refusing to re-arm a garbage quantity; check the store by hand',
          'residual_sweep_garbage_residual',
        ),
      ]);
    });

    it('records a retryable re-arm failure', async () => {
      const { store } = await markedLot();
      const broker = new SweepBroker();
      broker.rearmFailure = new Error('venue still down');

      const { result, logger } = await sweepWith(store, broker);

      expect(result.divergences).toEqual([
        divergence(
          're-arm retry failed for residual 6: venue still down',
          'residual_sweep_rearm_retry_failed',
        ),
      ]);
      expect(logger.entries).toContainEqual(
        logLine(
          'residual_rearm_failed',
          'error',
          'sweepResidualProtection: broker.rearmProtectiveLegs retry failed — the marker ' +
            'stays and the next pass retries',
          { residual_qty: 6, error: 'venue still down' },
        ),
      );
      expect(logger.entries.filter((entry) => entry.message === DEDUP_HELD_MESSAGE)).toEqual([]);
    });

    it('records a permanent re-arm refusal the shut venue could not close', async () => {
      const { db } = await markedLot();
      const store = new (class extends TestExecutionStore {
        override async markResidualRearmUnsupportedAlerted(): Promise<never> {
          throw new Error('unsupported dedup write refused');
        }
      })(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false',
      );
      const shutCalendar: TradingCalendar = {
        isOpen: () => false,
        isTradingDay: () => true,
        sessionStart: () => NOW,
        sessionEnd: () => NOW,
      };
      const logger = recordingLogger();

      const result = await new ExecutionImpl(
        makeInput(broker, store, makeResidualExposureAlerts(), logger, {
          crypto: new AlwaysOpenCalendar(),
          stocks: shutCalendar,
        }),
      ).sweepResidualProtection();

      expect(result.divergences).toEqual([
        divergence(
          'this lot can never be re-armed and the residual 6 could not be closed either — see ' +
            'the residual_reflatten_* log line for which gate stood the re-flatten down: ' +
            'IsOcoOrderSupported false',
          'residual_sweep_rearm_unsupported',
        ),
      ]);
      expect(logger.entries).toContainEqual(
        logLine(
          'residual_rearm_unsupported',
          'error',
          'sweepResidualProtection: arming protective legs for this lot is permanently ' +
            'refused, so no pass of this sweep can protect it — the marker stays and only ' +
            'manual action at the venue clears it',
          { residual_qty: 6, error: 'IsOcoOrderSupported false' },
        ),
      );
      expect(logger.entries).toContainEqual(
        logLine(
          'residual_alert_mark_failed',
          'warn',
          'markResidualRearmUnsupportedAlerted failed — the next sweep pass may page a second ' +
            'time for a permanent gap that was already alerted (noisy, not unsafe; #1447)',
          { error: 'unsupported dedup write refused' },
        ),
      );
    });

    it('records the re-flatten it submitted in place of a re-arm', async () => {
      const { store } = await markedLot();
      const broker = new SweepBroker();
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false',
      );

      const { result } = await sweepWith(store, broker);

      expect(result.divergences).toEqual([
        divergence(
          'this lot can never be re-armed, so residual 6 was CLOSED instead (#1214): market ' +
            "order 'key-1:residual-reflatten-1' is live at the venue and the marker clears when " +
            'its fill lands',
          'residual_sweep_reflatten_submitted',
        ),
      ]);
    });

    it('keeps an in-flight own re-flatten undetermined', async () => {
      const { store } = await markedLot();
      const ownKey = `${LOT}:residual-reflatten-1`;
      await store.writeAheadFlatten(flattenWriteAhead(ownKey));
      await store.resolveFlattenSubmitted(
        ownKey,
        { order_state: 'submitted', broker_order_ids: [ownKey] },
        NOW,
      );
      const broker = new SweepBroker();
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false',
      );

      const { result } = await sweepWith(store, broker);

      expect(result.divergences).toEqual([
        divergence(expect.any(String), 'residual_sweep_reflatten_in_flight'),
      ]);
    });

    it('records a lot whose settlement threw', async () => {
      const { db } = await markedLot();
      const store = new (class extends TestExecutionStore {
        override async confirmResidualProtected(): Promise<never> {
          throw new Error('marker write refused');
        }
      })(db);

      const { result, logger } = await sweepWith(store, new SweepBroker());

      expect(result.divergences).toEqual([
        divergence(
          'residual-protection sweep failed: marker write refused',
          'residual_sweep_lot_unsettled',
        ),
      ]);
      expect(logger.entries).toEqual([
        logLine(
          'residual_sweep_lot_unsettled',
          'error',
          'sweepResidualProtection: one marked lot could not be settled this pass — the ' +
            'marker stays and the next pass retries',
          { error: 'marker write refused' },
        ),
      ]);
    });

    it('logs a failed alert-dedup write', async () => {
      const { db } = await markedLot();
      const store = new (class extends TestExecutionStore {
        override async markResidualAlerted(): Promise<never> {
          throw new Error('dedup write refused');
        }
      })(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new Error('venue still down');

      const { logger } = await sweepWith(store, broker);

      expect(logger.entries).toContainEqual(
        logLine(
          'residual_alert_mark_failed',
          'warn',
          'markResidualAlerted failed — the next sweep pass may page a second time for an ' +
            'episode that was already alerted (noisy, not unsafe)',
          { error: 'dedup write refused' },
        ),
      );
    });

    it('notes a page whose dedup another surface already held', async () => {
      const { db } = await markedLot();
      const store = new (class extends TestExecutionStore {
        override async markResidualAlerted(): Promise<boolean> {
          return false;
        }
      })(db);
      const broker = new SweepBroker();
      broker.rearmFailure = new Error('venue still down');

      const { logger } = await sweepWith(store, broker);

      expect(logger.entries).toContainEqual({
        trace_id: 'trace-sweep',
        stage: 'execution',
        level: 'info',
        message: DEDUP_HELD_MESSAGE,
        payload: { idempotency_key: LOT },
      });
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
      await expect(store.markResidualAlerted(LOT, later)).resolves.toBe(false);
      expect((await store.getResidualProtectionMarker(LOT))?.alerted_at).toBe(NOW.toISOString());
      await expect(store.markResidualAlerted('no-such-lot', NOW)).resolves.toBe(false);

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
      await store.markResidualAlerted(LOT, new Date('2026-08-07T15:00:00Z'));

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

      await expect(store.markResidualAlerted(LOT, NOW)).resolves.toBe(true);
      await expect(store.markResidualRearmUnsupportedAlerted(LOT, NOW)).resolves.toBe(true);
      const later = new Date('2026-08-07T17:00:00Z');
      await expect(store.markResidualRearmUnsupportedAlerted(LOT, later)).resolves.toBe(false);
      expect(await store.getResidualRearmUnsupportedAlertedAtRaw(LOT)).toBe(NOW.toISOString());
    });
  });
});
