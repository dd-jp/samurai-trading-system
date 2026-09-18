import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import type {
  AssetClass,
  Clock,
  Fill,
  Logger,
  OpenPosition,
  OrderIntent,
} from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import type { CostModel } from '../../tools/backtest/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ExecutionImpl } from './execute.js';
import { FilledZeroSizeThrottle } from './filled-zero-size-throttle.js';
import {
  FLATTEN_CANCEL_RETRY_EVERY_MS,
  UNRESOLVABLE_FLATTEN_MAX_AGE_MS,
  UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS,
} from './reconcile.js';
import { openTestExecutionStore, type TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  FlattenReconcileAlert,
  FlattenReconcileAlertChannel,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from './types.js';
import type {
  UnrecordedVenuePositionAlert,
  UnrecordedVenuePositionAlertChannel,
} from './unrecorded-venue-position-alert.js';
import {
  UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS,
  UnrecordedVenuePositionThrottle,
} from './unrecorded-venue-position-throttle.js';
import { WEDGED_ZERO_FILL_ABANDON_AFTER_MS } from './wedged-zero-fill-sweep.js';

const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

const NOW = new Date('2026-07-15T14:00:00Z');
const fixedClock: Clock = { now: () => NOW };
const KEY = 'key-aapl-1355';

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: KEY,
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    decided_at: new Date('2026-07-15T13:55:00Z'),
    metadata: {
      debate_id: 'debate-abc123',
      conviction: 0.72,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1.2,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 5, weighted_mean_r: 0.4, no_precedent: false },
    },
    ...overrides,
  };
}

function makeGo(orderOverrides: Partial<OrderIntent> = {}): VerdictDecision {
  const order = makeIntent(orderOverrides);
  return {
    status: 'go',
    order,
    no_go_reason: null,
    no_go_detail: null,
    approval_path: 'automated',
    would_require_approval: true,
    idempotency_key: order.idempotency_key,
    timestamp: NOW,
  };
}

function pendingPosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    idempotency_key: KEY,
    debate_id: 'debate-abc123',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 100,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    order_state: 'pending',
    broker_order_ids: [],
    opened_at: NOW,
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    conviction: 0.72,
    converged: true,
    ...overrides,
  };
}

function makeBroker(): BrokerAdapter & {
  book: Map<string, NormalizedOrder>;
  submits: NativeBracketRequest[];
  failLookup: string | null;
  venuePositions: NormalizedPosition[];
  failPositions: string | null;
  flattenBook: Map<string, NormalizedOrder>;
  failFlattenLookup: string | null;
  resumeFlattenCalls: string[];
  cancelCalls: Array<{ client_order_id: string; instrument: string }>;
  failCancel: string | null;
  onCancel: (() => void) | null;
  venueReads: number;
} {
  return {
    book: new Map<string, NormalizedOrder>(),
    submits: [] as NativeBracketRequest[],
    failLookup: null as string | null,
    flattenBook: new Map<string, NormalizedOrder>(),
    failFlattenLookup: null as string | null,
    resumeFlattenCalls: [] as string[],
    venueReads: 0,

    async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
      this.submits.push(order);
      const ack: NormalizedOrder = {
        client_order_id: order.client_order_id,
        broker_order_ids: [`${order.client_order_id}:entry`],
        order_state: 'submitted',
        filled_qty: 0,
      };
      this.book.set(order.client_order_id, ack);
      return {
        client_order_id: order.client_order_id,
        broker_order_ids: ack.broker_order_ids,
        order_state: 'submitted',
      };
    },

    async getOrder(clientOrderId: string): Promise<NormalizedOrder | null> {
      if (this.failLookup !== null) throw new Error(this.failLookup);
      return this.book.get(clientOrderId) ?? null;
    },

    async resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
      this.resumeFlattenCalls.push(clientOrderId);
      if (this.failFlattenLookup !== null) throw new Error(this.failFlattenLookup);
      return this.flattenBook.get(clientOrderId) ?? null;
    },

    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },

    async resizeProtectiveLegs(): Promise<void> {},

    async rearmProtectiveLegs(): Promise<void> {},

    venuePositions: [] as NormalizedPosition[],
    failPositions: null as string | null,
    async getOpenPositions(): Promise<NormalizedPosition[]> {
      this.venueReads += 1;
      if (this.failPositions !== null) throw new Error(this.failPositions);
      return this.venuePositions;
    },

    async submitFlatten(): Promise<never> {
      throw new Error('makeBroker.submitFlatten: reconcile() does not flatten');
    },
    cancelCalls: [] as Array<{ client_order_id: string; instrument: string }>,
    failCancel: null as string | null,
    async cancel(clientOrderId: string, instrument: string): Promise<void> {
      this.cancelCalls.push({ client_order_id: clientOrderId, instrument });
      this.onCancel?.();
      if (this.failCancel !== null) throw new Error(this.failCancel);
    },
    onCancel: null as (() => void) | null,
  };
}

function makeInput(
  store: TestExecutionStore,
  broker: BrokerAdapter,
  flattenReconcileAlerts: FlattenReconcileAlertChannel = {
    postFlattenReconcileAlert: async () => {},
  },
  logger: Logger = recordingLogger(),
  unrecordedVenuePositionAlerts: UnrecordedVenuePositionAlertChannel = {
    postUnrecordedVenuePositionAlert: async () => {},
  },
  unrecordedVenuePositionThrottle: UnrecordedVenuePositionThrottle = new UnrecordedVenuePositionThrottle(),
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

  return {
    trace_id: 'trace-86',
    clock: fixedClock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    sessionCalendars: OPEN_SESSION_CALENDARS,
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts,
    unrecordedVenuePositionAlerts,
    unrecordedVenuePositionThrottle,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    logger,
  };
}

describe('reconcile — crash between write-ahead and broker ack', () => {
  it('marks the lot rejected when the venue never received the order, and the replay does not double-submit', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();

    const restarted = new ExecutionImpl(makeInput(store, broker));
    const report = await restarted.reconcile();

    expect(report.checked).toBe(1);
    expect(report.corrected).toBe(1);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      idempotency_key: KEY,
      store_state: 'pending',
      broker_state: null,
      action: 'rejected',
      kind: 'bracket',
    });
    expect((await store.getPosition(KEY))?.order_state).toBe('rejected');

    expect(broker.submits).toHaveLength(0);

    expect(await store.countAllPositions()).toBe(1);

    const replay = await restarted.execute(makeGo());
    expect(replay.status).toBe('deduped');
    expect(broker.submits).toHaveLength(0);
    expect(await store.countAllPositions()).toBe(1);
  });

  it('adopts the broker state when the order did land, and the replay still does not double-submit', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();
    broker.book.set(KEY, {
      client_order_id: KEY,
      broker_order_ids: [`${KEY}:entry`, `${KEY}:stop`],
      order_state: 'submitted',
      filled_qty: 0,
    });

    const restarted = new ExecutionImpl(makeInput(store, broker));
    const report = await restarted.reconcile();

    expect(report.corrected).toBe(1);
    expect(report.divergences[0]).toMatchObject({
      store_state: 'pending',
      broker_state: 'submitted',
      action: 'adopted',
      kind: 'bracket',
    });

    const settled = await store.getPosition(KEY);
    expect(settled?.order_state).toBe('submitted');
    expect(settled?.broker_order_ids).toEqual([`${KEY}:entry`, `${KEY}:stop`]);

    expect(await store.countAllPositions()).toBe(1);
    expect(broker.submits).toHaveLength(0);

    const replay = await restarted.execute(makeGo());
    expect(replay.status).toBe('deduped');
    expect(broker.submits).toHaveLength(0);
  });

  it('recovers a real crash mid-submit: the same decision, executed twice across a restart, reaches the venue once', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const crashing = {
      ...broker,
      async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
        await broker.submitBracket(order);
        throw new Error('connection lost before ack');
      },
    };

    const before = new ExecutionImpl(makeInput(store, crashing));
    const crashed = await before.execute(makeGo());
    expect(crashed.status).toBe('error');
    expect((await store.getPosition(KEY))?.order_state).toBe('pending');
    expect(broker.submits).toHaveLength(1);

    const after = new ExecutionImpl(makeInput(store, broker));
    await after.reconcile();
    expect((await store.getPosition(KEY))?.order_state).toBe('submitted');

    const replay = await after.execute(makeGo());
    expect(replay.status).toBe('deduped');

    expect(broker.submits).toHaveLength(1);
    expect(await store.countAllPositions()).toBe(1);
  });
});

describe('reconcile — store-vs-broker divergence', () => {
  it('corrects the store in favour of the broker and reports the divergence', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({ order_state: 'submitted', broker_order_ids: [`${KEY}:entry`] }),
    );
    const broker = makeBroker();
    broker.book.set(KEY, {
      client_order_id: KEY,
      broker_order_ids: [`${KEY}:entry`],
      order_state: 'filled',
      filled_qty: 100,
    });

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getPosition(KEY))?.order_state).toBe('filled');
    expect(report.divergences[0]).toMatchObject({
      store_state: 'submitted',
      broker_state: 'filled',
      action: 'adopted',
      kind: 'bracket',
    });
    expect(report.divergences[0]?.reason).toContain('broker says');
  });

  it('leaves filled_size alone when adopting — the Fill rows own it', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition({ order_state: 'submitted' }));
    const broker = makeBroker();
    broker.book.set(KEY, {
      client_order_id: KEY,
      broker_order_ids: [],
      order_state: 'filled',
      filled_qty: 100,
    });

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getPosition(KEY))?.filled_size).toBe(0);
    expect((await store.getOpenPositions()).map((p) => p.idempotency_key)).toEqual([KEY]);
  });

  it('reports no divergence and writes nothing when store and broker agree', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({ order_state: 'submitted', broker_order_ids: [`${KEY}:entry`] }),
    );
    const broker = makeBroker();
    broker.book.set(KEY, {
      client_order_id: KEY,
      broker_order_ids: [`${KEY}:entry`],
      order_state: 'submitted',
      filled_qty: 0,
    });
    store.writeLog.length = 0;

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.checked).toBe(1);
    expect(report.corrected).toBe(0);
    expect(report.divergences).toEqual([]);
    expect(store.writeLog).toEqual([]);
  });

  it('is idempotent — a second pass finds nothing left to correct', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();
    broker.book.set(KEY, {
      client_order_id: KEY,
      broker_order_ids: [`${KEY}:entry`],
      order_state: 'submitted',
      filled_qty: 0,
    });

    const execution = new ExecutionImpl(makeInput(store, broker));
    await execution.reconcile();
    const second = await execution.reconcile();

    expect(second.corrected).toBe(0);
    expect(second.divergences).toEqual([]);
  });
});

describe('reconcile — scope and safety', () => {
  it('leaves the record untouched and flags it when the adapter cannot answer', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();
    broker.failLookup = 'venue unreachable';
    store.writeLog.length = 0;

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getPosition(KEY))?.order_state).toBe('pending');
    expect(store.writeLog).toEqual([]);
    expect(report.corrected).toBe(0);
    expect(report.divergences[0]).toMatchObject({
      action: 'undetermined',
      broker_state: null,
      kind: 'bracket',
      reason: 'venue unreachable',
    });
  });

  it('only reconciles in-flight lots, leaving the fill lifecycle to ingestFills()', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({ idempotency_key: 'key-pending', order_state: 'pending' }),
    );
    await store.writeAheadPosition(
      pendingPosition({ idempotency_key: 'key-submitted', order_state: 'submitted' }),
    );
    await store.writeAheadPosition(
      pendingPosition({ idempotency_key: 'key-partial', order_state: 'partially_filled' }),
    );
    await store.writeAheadPosition(
      pendingPosition({ idempotency_key: 'key-filled', order_state: 'filled' }),
    );
    const broker = makeBroker();

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.checked).toBe(2);
    expect(report.divergences.map((d) => d.idempotency_key).sort()).toEqual([
      'key-pending',
      'key-submitted',
    ]);
    expect((await store.getPosition('key-partial'))?.order_state).toBe('partially_filled');
    expect((await store.getPosition('key-filled'))?.order_state).toBe('filled');
  });

  it('reports an empty pass when nothing is in flight', async () => {
    const { store } = openTestExecutionStore();
    const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    expect(report).toMatchObject({ checked: 0, corrected: 0, divergences: [] });
    expect(report.timestamp).toEqual(NOW);
  });
});

describe('reconcile — the terminal-row sweep (#1088)', () => {
  const OLD_ENOUGH = new Date('2026-07-14T13:00:00Z');
  const TOO_RECENT = new Date('2026-07-14T15:00:00Z');

  it('deletes an old enough rejected row with filled_size = 0', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-old-rejected',
        order_state: 'rejected',
        filled_size: 0,
        decision_timestamp: OLD_ENOUGH,
      }),
    );

    const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    expect(report.swept).toBe(1);
    expect(await store.getPosition('key-old-rejected')).toBeNull();
  });

  it.each(['rejected', 'cancelled', 'expired'] as const)(
    'sweeps an old enough %s row with filled_size = 0',
    async (order_state) => {
      const { store } = openTestExecutionStore();
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: `key-old-${order_state}`,
          order_state,
          filled_size: 0,
          decision_timestamp: OLD_ENOUGH,
        }),
      );

      const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

      expect(report.swept).toBe(1);
      expect(await store.getPosition(`key-old-${order_state}`)).toBeNull();
    },
  );

  it('leaves a terminal row untouched when it is not old enough yet', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-recent-rejected',
        order_state: 'rejected',
        filled_size: 0,
        decision_timestamp: TOO_RECENT,
      }),
    );

    const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    expect(report.swept).toBe(0);
    expect((await store.getPosition('key-recent-rejected'))?.order_state).toBe('rejected');
  });

  it('never sweeps a closed row, however old — retained per the HMRC/CGT retention requirement', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-old-closed',
        order_state: 'closed',
        filled_size: 100,
        decision_timestamp: OLD_ENOUGH,
      }),
    );

    const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    expect(report.swept).toBe(0);
    expect((await store.getPosition('key-old-closed'))?.order_state).toBe('closed');
  });

  it('never sweeps a terminal row with filled_size > 0 that is not closed — left as an unexplained anomaly, not guessed at', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-old-rejected-partial',
        order_state: 'rejected',
        filled_size: 50,
        decision_timestamp: OLD_ENOUGH,
      }),
    );

    const report = await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    expect(report.swept).toBe(0);
    expect((await store.getPosition('key-old-rejected-partial'))?.order_state).toBe('rejected');
  });

  it('never sweeps a live (non-terminal) row', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-live',
        order_state: 'pending',
        filled_size: 0,
        decision_timestamp: OLD_ENOUGH,
      }),
    );
    const broker = makeBroker();
    broker.book.set('key-live', {
      client_order_id: 'key-live',
      broker_order_ids: [],
      order_state: 'pending',
      filled_qty: 0,
    });

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.swept).toBe(0);
    expect((await store.getPosition('key-live'))?.order_state).toBe('pending');
  });

  it(
    'AC3: crash-restart recovers the same live positions before and after the sweep runs — ' +
      'seeded live rows plus old and recent terminal rows',
    async () => {
      const { store } = openTestExecutionStore();
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: 'key-live-1',
          instrument: 'AAPL',
          order_state: 'submitted',
          filled_size: 0,
          decision_timestamp: OLD_ENOUGH,
        }),
      );
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: 'key-live-2',
          instrument: 'MSFT',
          order_state: 'partially_filled',
          filled_size: 40,
          decision_timestamp: OLD_ENOUGH,
        }),
      );
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: 'key-term-old-rejected',
          order_state: 'rejected',
          filled_size: 0,
          decision_timestamp: OLD_ENOUGH,
        }),
      );
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: 'key-term-recent-cancelled',
          order_state: 'cancelled',
          filled_size: 0,
          decision_timestamp: TOO_RECENT,
        }),
      );
      await store.writeAheadPosition(
        pendingPosition({
          idempotency_key: 'key-term-old-closed',
          order_state: 'closed',
          filled_size: 100,
          decision_timestamp: OLD_ENOUGH,
        }),
      );

      const broker = makeBroker();
      broker.book.set('key-live-1', {
        client_order_id: 'key-live-1',
        broker_order_ids: [],
        order_state: 'submitted',
        filled_qty: 0,
      });

      const before = await store.getOpenPositions();

      const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();
      expect(report.swept).toBe(1);

      const after = await store.getOpenPositions();
      expect(after.map((p) => p.idempotency_key).sort()).toEqual(
        before.map((p) => p.idempotency_key).sort(),
      );
      expect(after.map((p) => p.idempotency_key).sort()).toEqual(['key-live-1', 'key-live-2']);

      expect(await store.getPosition('key-term-recent-cancelled')).not.toBeNull();
      expect(await store.getPosition('key-term-old-closed')).not.toBeNull();
      expect(await store.getPosition('key-term-old-rejected')).toBeNull();
    },
  );
});

describe('reconcile — the flatten-journal sweep (#519, #526)', () => {
  const FLATTEN_KEY = 'flatten-aapl-exit';

  async function writeAheadFlatten(
    store: TestExecutionStore,
    overrides: Partial<Parameters<TestExecutionStore['writeAheadFlatten']>[0]> = {},
  ): Promise<void> {
    await store.writeAheadFlatten({
      idempotency_key: FLATTEN_KEY,
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: NOW,
      lot_held_quantities: [{ idempotency_key: 'key-aapl-entry', held: 10 }],
      exit_reason: 'flatten',
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
      ...overrides,
    });
  }

  it('resolves a flatten stuck at "submitting" when the venue names an order — the lost-ack case', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'submitted',
      filled_qty: 0,
    });

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.resumeFlattenCalls).toEqual([FLATTEN_KEY]);
    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      idempotency_key: FLATTEN_KEY,
      instrument: 'AAPL',
      store_state: 'pending',
      broker_state: 'submitted',
      action: 'adopted',
      kind: 'flatten',
    });
    expect(report.corrected).toBe(1);

    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('submitted');
    expect(row?.order_state).toBe('submitted');
    expect(row?.broker_order_ids).toBe(JSON.stringify([`${FLATTEN_KEY}:order`]));
    expect(row?.resolved_at).not.toBeNull();
  });

  it('resolves a "submitting" flatten to error when the venue authoritatively has no such order', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.divergences[0]).toMatchObject({
      idempotency_key: FLATTEN_KEY,
      store_state: 'pending',
      broker_state: null,
      action: 'rejected',
      kind: 'flatten',
    });
    expect(report.corrected).toBe(1);

    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('error');
    expect(row?.reason).toContain('write-ahead never landed');
  });

  it('leaves an ALREADY-ACKED row untouched and alerts, rather than mis-resolving it to error, when the venue later answers null INSIDE the bound', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    await store.resolveFlattenSubmitted(
      FLATTEN_KEY,
      { order_state: 'submitted', broker_order_ids: [`${FLATTEN_KEY}:order`] },
      NOW,
    );
    const broker = makeBroker();
    const alerts: FlattenReconcileAlert[] = [];
    const flattenReconcileAlerts: FlattenReconcileAlertChannel = {
      postFlattenReconcileAlert: async (alert) => {
        alerts.push(alert);
      },
    };

    const report = await new ExecutionImpl(
      makeInput(store, broker, flattenReconcileAlerts),
    ).reconcile();

    expect(report.divergences[0]).toMatchObject({
      idempotency_key: FLATTEN_KEY,
      store_state: 'submitted',
      broker_state: null,
      action: 'undetermined',
      kind: 'flatten',
    });
    expect(report.corrected).toBe(0);

    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('submitted');
    expect(row?.order_state).toBe('submitted');
    expect(row?.broker_order_ids).toBe(JSON.stringify([`${FLATTEN_KEY}:order`]));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.idempotency_key).toBe(FLATTEN_KEY);
    expect(alerts[0]?.reason).toContain('previously acked');
  });

  async function ackedFlatten(store: TestExecutionStore, submitted_at: Date): Promise<void> {
    await writeAheadFlatten(store, { submitted_at });
    await store.resolveFlattenSubmitted(
      FLATTEN_KEY,
      { order_state: 'submitted', broker_order_ids: [`${FLATTEN_KEY}:order`] },
      submitted_at,
    );
  }

  function workingFlattenBook(broker: ReturnType<typeof makeBroker>): void {
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'submitted',
      filled_qty: 0,
    });
  }

  it('cancels an acked flatten the venue still reports WORKING once it is past the bound', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    const broker = makeBroker();
    workingFlattenBook(broker);
    const alerts: FlattenReconcileAlert[] = [];

    const report = await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(broker.cancelCalls).toEqual([{ client_order_id: FLATTEN_KEY, instrument: 'AAPL' }]);
    expect(report.divergences[0]?.reason).toContain('CANCELLED');
    expect(report.divergences[0]?.action).toBe('adopted');
    expect(report.divergences[0]?.escalation).toBe('wedge_cancelled');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.idempotency_key).toBe(FLATTEN_KEY);

    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('submitted');
    expect(row?.fills_swept_at).toBeNull();
    expect((await store.getUnresolvedFlattens()).map((r) => r.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('does NOT cancel an acked working flatten that is still inside the bound', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS - 1)));
    const broker = makeBroker();
    workingFlattenBook(broker);

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([]);
    expect(report.divergences[0]?.action).toBe('adopted');
    expect(report.divergences[0]?.escalation).toBeUndefined();
  });

  it('does NOT cancel a row the venue already reports terminal — there is nothing working to cancel', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    const broker = makeBroker();
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'cancelled',
      filled_qty: 4,
    });

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([]);
    expect((await store.getUnresolvedFlattens()).map((r) => r.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('alerts and leaves the row blocking when the venue refuses the cancel', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    const broker = makeBroker();
    workingFlattenBook(broker);
    broker.failCancel = 'venue refused the cancel';
    const alerts: FlattenReconcileAlert[] = [];

    const report = await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(report.divergences[0]?.reason).toContain('cancel FAILED');
    expect(alerts[0]?.reason).toContain('cancel FAILED');
    expect((await store.getUnresolvedFlattens()).map((r) => r.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('leaves the record untouched and alerts when the adapter cannot answer at all', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.failFlattenLookup = 'venue unreachable';
    const alerts: FlattenReconcileAlert[] = [];
    const flattenReconcileAlerts: FlattenReconcileAlertChannel = {
      postFlattenReconcileAlert: async (alert) => {
        alerts.push(alert);
      },
    };

    const report = await new ExecutionImpl(
      makeInput(store, broker, flattenReconcileAlerts),
    ).reconcile();

    expect(report.corrected).toBe(0);
    expect(report.divergences[0]).toMatchObject({
      idempotency_key: FLATTEN_KEY,
      action: 'undetermined',
      broker_state: null,
      kind: 'flatten',
      reason: 'venue unreachable',
    });
    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('submitting');
    expect(alerts).toEqual([
      expect.objectContaining({ idempotency_key: FLATTEN_KEY, reason: 'venue unreachable' }),
    ]);
  });

  async function heldLot(store: TestExecutionStore, filled_size: number): Promise<void> {
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-aapl-entry',
        order_state: 'filled',
        filled_size,
        requested_size: filled_size,
        avg_entry_price: 100,
      }),
    );
  }

  function neverConfirmed(broker: ReturnType<typeof makeBroker>, venueQty: number): void {
    broker.failFlattenLookup = 'order-details endpoint 503';
    broker.venuePositions = [
      { instrument: 'AAPL', qty: venueQty, side: 'buy', avg_entry_price: 100 },
    ];
  }

  it('cancels a never-confirmed flatten past the bound and releases it only because the venue still holds the whole lot', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 10);

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([{ client_order_id: FLATTEN_KEY, instrument: 'AAPL' }]);
    expect(
      report.divergences.find((divergence) => divergence.idempotency_key === FLATTEN_KEY),
    ).toMatchObject({ action: 'rejected', kind: 'flatten' });
    expect((await store.getFlattenSubmission(FLATTEN_KEY))?.status).toBe('error');
    expect(await store.getUnresolvedFlattens()).toEqual([]);
  });

  it('keeps a never-confirmed flatten blocking when the venue holds LESS than the store does — something filled', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 6);
    const alerts: FlattenReconcileAlert[] = [];

    const report = await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(broker.cancelCalls).toHaveLength(1);
    expect(alerts[0]?.reason).toContain('attribute them by hand');
    expect(
      report.divergences.find((divergence) => divergence.idempotency_key === FLATTEN_KEY)
        ?.escalation,
    ).toBe('never_confirmed_coverage_short');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a never-confirmed flatten blocking when the venue holds MORE than the store does', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    broker.failFlattenLookup = 'order-details endpoint 503';
    broker.venuePositions = [{ instrument: 'AAPL', qty: 14, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts[0]?.reason).toContain('a surplus the store has no lot for');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a never-confirmed flatten blocking when the venue holds the same size SHORT against a long lot', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    broker.failFlattenLookup = 'order-details endpoint 503';
    broker.venuePositions = [{ instrument: 'AAPL', qty: -10, side: 'sell', avg_entry_price: 100 }];

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('refuses to release when the venue book moves WHILE the cancel is in flight', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 10);
    broker.onCancel = () => {
      broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    };
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(broker.cancelCalls).toHaveLength(1);
    expect(alerts[0]?.reason).toContain('attribute them by hand');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a never-confirmed flatten blocking when the store holds lots on BOTH sides', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await store.writeAheadPosition(
      pendingPosition({
        idempotency_key: 'key-aapl-short',
        side: 'sell',
        order_state: 'filled',
        filled_size: 10,
        requested_size: 10,
        avg_entry_price: 100,
      }),
    );
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    broker.failFlattenLookup = 'order-details endpoint 503';
    broker.venuePositions = [];
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts[0]?.reason).toContain('NETTED');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a never-confirmed flatten blocking when the venue refuses the cancel', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 10);
    broker.failCancel = 'venue refused the cancel';

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    const divergence = report.divergences.find(
      (candidate) => candidate.idempotency_key === FLATTEN_KEY,
    );
    expect(divergence?.reason).toContain('cancel FAILED');
    expect(divergence?.escalation).toBe('never_confirmed_cancel_failed');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a never-confirmed flatten blocking when the venue book could not be read this pass', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 10);
    broker.failPositions = 'positions endpoint 503';

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toHaveLength(1);
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  async function terminalUnsweptFlatten(
    store: TestExecutionStore,
    broker: ReturnType<typeof makeBroker>,
    seenTerminalForMs: number | null,
    submittedAgoMs = 6 * 60 * 60 * 1_000,
  ): Promise<void> {
    await ackedFlatten(store, new Date(NOW.getTime() - submittedAgoMs));
    if (seenTerminalForMs !== null) {
      await store.markFlattenTerminalUnsweptChecked(
        FLATTEN_KEY,
        new Date(NOW.getTime() - seenTerminalForMs),
      );
    }
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'cancelled',
      filled_qty: 4,
    });
  }

  async function bookedPartialExit(store: TestExecutionStore): Promise<void> {
    await heldLot(store, 10);
    const exit: Fill = {
      idempotency_key: 'key-aapl-entry',
      broker_fill_id: toBrokerFillId('x1'),
      leg: 'exit',
      price: 104,
      qty: 4,
      fee: 0,
      timestamp: new Date(NOW.getTime() - 60_000),
    };
    await store.applyLotAdvance({ idempotency_key: 'key-aapl-entry', fills: [exit] });
  }

  it('releases a terminal flatten whose fills were applied but never marked swept, on the venue book', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];

    const report = await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(
      report.divergences.find((divergence) => divergence.idempotency_key === FLATTEN_KEY),
    ).toMatchObject({ action: 'rejected', kind: 'flatten' });
    expect(alerts[0]?.reason).toContain('INFERENCE');
    expect(await store.getUnresolvedFlattens()).toEqual([]);
    expect(await store.isRetryableFlattenError(FLATTEN_KEY)).toBe(true);
  });

  it('keeps a terminal unswept flatten blocking when the venue holds LESS than the store has booked', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts[0]?.reason).toContain('attribute them by hand');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a terminal unswept flatten blocking when the venue book could not be read', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1);
    broker.failPositions = 'positions endpoint 503';

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('leaves a terminal unswept flatten alone inside the bound — ingestFills is still owed its sweep', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS - 1);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts).toEqual([]);
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('starts the window when the row is FIRST seen terminal, not when it was submitted', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, null);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];
    const readsBefore = broker.venueReads;

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts).toEqual([]);
    expect(broker.venueReads - readsBefore).toBe(1);
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
    expect((await store.getUnresolvedFlattens())[0]?.terminal_unswept_checked_at).toEqual(NOW);
  });

  it('costs one venue read and one page per window, not one per poll', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];
    const input = makeInput(store, broker, {
      postFlattenReconcileAlert: async (alert) => {
        alerts.push(alert);
      },
    });

    await new ExecutionImpl(input).reconcile();
    await new ExecutionImpl(input).reconcile();

    expect(alerts).toHaveLength(1);
    expect(broker.venueReads).toBe(3);
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('keeps a terminal unswept flatten blocking when the venue holds MORE than the store has booked', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await terminalUnsweptFlatten(store, broker, UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1);
    broker.venuePositions = [{ instrument: 'AAPL', qty: 9, side: 'buy', avg_entry_price: 100 }];
    const alerts: FlattenReconcileAlert[] = [];

    await new ExecutionImpl(
      makeInput(store, broker, {
        postFlattenReconcileAlert: async (alert) => {
          alerts.push(alert);
        },
      }),
    ).reconcile();

    expect(alerts[0]?.reason).toContain('attribute them by hand');
    expect(alerts[0]?.reason).toContain('1800s after this sweep last examined it');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('writes the venue state it released on — a submitting row is acked before any release', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - 6 * 60 * 60 * 1_000),
    });
    await store.markFlattenTerminalUnsweptChecked(
      FLATTEN_KEY,
      new Date(NOW.getTime() - (UNSWEPT_TERMINAL_FLATTEN_MAX_AGE_MS + 1)),
    );
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'cancelled',
      filled_qty: 4,
    });
    broker.venuePositions = [{ instrument: 'AAPL', qty: 6, side: 'buy', avg_entry_price: 100 }];

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(await store.getUnresolvedFlattens()).toEqual([]);
    const released = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(released?.order_state).toBe('cancelled');
    expect(released?.broker_order_ids).toBe(JSON.stringify([`${FLATTEN_KEY}:order`]));
    expect(released?.resolved_at).not.toBeNull();
  });

  it('does NOT cancel a never-confirmed flatten that is still inside the bound', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS - 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 10);

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([]);
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('marks a never-confirmed flatten throttled from re-cancelling as its own distinct escalation', async () => {
    const { store } = openTestExecutionStore();
    await heldLot(store, 10);
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)),
    });
    const broker = makeBroker();
    neverConfirmed(broker, 6);
    const input = makeInput(store, broker);

    await new ExecutionImpl(input).reconcile();
    const second = await new ExecutionImpl(input).reconcile();

    expect(broker.cancelCalls).toHaveLength(1);
    const divergence = second.divergences.find(
      (candidate) => candidate.idempotency_key === FLATTEN_KEY,
    );
    expect(divergence?.action).toBe('undetermined');
    expect(divergence?.escalation).toBe('never_confirmed_throttled');
  });

  it('does not re-cancel or re-page a wedged row inside FLATTEN_CANCEL_RETRY_EVERY_MS', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    const broker = makeBroker();
    workingFlattenBook(broker);
    const alerts: FlattenReconcileAlert[] = [];
    const input = makeInput(store, broker, {
      postFlattenReconcileAlert: async (alert) => {
        alerts.push(alert);
      },
    });

    await new ExecutionImpl(input).reconcile();
    await new ExecutionImpl(input).reconcile();

    expect(broker.cancelCalls).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('cancels again once the last attempt is older than FLATTEN_CANCEL_RETRY_EVERY_MS', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    await store.markFlattenCancelAttempted(
      FLATTEN_KEY,
      new Date(NOW.getTime() - (FLATTEN_CANCEL_RETRY_EVERY_MS + 1)),
    );
    const broker = makeBroker();
    workingFlattenBook(broker);

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([{ client_order_id: FLATTEN_KEY, instrument: 'AAPL' }]);
  });

  it('resolves a row whose lookup kept throwing as soon as the adapter can answer again — ignorance is not age-bounded', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store, {
      submitted_at: new Date(NOW.getTime() - 10 * UNRESOLVABLE_FLATTEN_MAX_AGE_MS),
    });
    await store.resolveFlattenSubmitted(
      FLATTEN_KEY,
      { order_state: 'submitted', broker_order_ids: [`${FLATTEN_KEY}:order`] },
      NOW,
    );
    const broker = makeBroker();
    broker.failFlattenLookup = 'venue unreachable';

    const unreachable = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(unreachable.divergences[0]).toMatchObject({ action: 'undetermined', kind: 'flatten' });
    expect((await store.getFlattenSubmission(FLATTEN_KEY))?.status).toBe('submitted');

    broker.failFlattenLookup = null;
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'rejected',
      filled_qty: 0,
    });

    const answered = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(answered.divergences[0]).toMatchObject({ action: 'rejected', kind: 'flatten' });
    expect((await store.getFlattenSubmission(FLATTEN_KEY))?.status).toBe('error');
    expect(await store.getUnresolvedFlattens()).toEqual([]);
  });

  it('logs a fixed, self-authored message (never the channel error) when the fallback alert itself fails to deliver', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.failFlattenLookup = 'venue unreachable';
    const failingFlattenReconcileAlerts: FlattenReconcileAlertChannel = {
      postFlattenReconcileAlert: async () => {
        throw new Error('Bearer super-secret-transport-token rejected the request');
      },
    };
    const logger = recordingLogger();

    const report = await new ExecutionImpl(
      makeInput(store, broker, failingFlattenReconcileAlerts, logger),
    ).reconcile();

    expect(report.divergences[0]).toMatchObject({
      idempotency_key: FLATTEN_KEY,
      action: 'undetermined',
      kind: 'flatten',
    });
    const entry = logger.entries.find((e) =>
      e.message.includes('postFlattenReconcileAlert delivery failed'),
    );
    expect(entry).toMatchObject({
      level: 'error',
      payload: { idempotency_key: FLATTEN_KEY, instrument: 'AAPL' },
    });
    expect(JSON.stringify(entry)).not.toContain('super-secret-transport-token');
  });

  it('survives a throwing logger on the fallback-alert-failure path — reconcile still resolves', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.failFlattenLookup = 'venue unreachable';
    const failingFlattenReconcileAlerts: FlattenReconcileAlertChannel = {
      postFlattenReconcileAlert: async () => {
        throw new Error('transport down');
      },
    };
    const throwingLogger: Logger = {
      log: () => {
        throw new Error('EPIPE');
      },
    };

    await expect(
      new ExecutionImpl(
        makeInput(store, broker, failingFlattenReconcileAlerts, throwingLogger),
      ).reconcile(),
    ).resolves.toMatchObject({
      divergences: [expect.objectContaining({ action: 'undetermined' })],
    });
  });

  it('does not re-poll a row once markFlattenFillsSwept has run — the #519/#526 bound (migration 0023)', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    await store.resolveFlattenSubmitted(
      FLATTEN_KEY,
      { order_state: 'submitted', broker_order_ids: [`${FLATTEN_KEY}:order`] },
      NOW,
    );
    await store.markFlattenFillsSwept(FLATTEN_KEY, NOW);
    const broker = makeBroker();

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.resumeFlattenCalls).toEqual([]);
    expect(report.divergences).toEqual([]);
    expect(report.checked).toBe(0);
  });

  it('does not resolve an "error" row — already terminal, nothing left to ask', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    await store.resolveFlattenError(FLATTEN_KEY, 'cancel failed', NOW);
    const broker = makeBroker();

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.resumeFlattenCalls).toEqual([]);
    expect(report.checked).toBe(0);
  });

  it('keeps re-polling an acked-but-unswept row across repeated passes — bounded by fills_swept, not by a single resolution', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.flattenBook.set(FLATTEN_KEY, {
      client_order_id: FLATTEN_KEY,
      broker_order_ids: [`${FLATTEN_KEY}:order`],
      order_state: 'filled',
      filled_qty: 10,
    });

    const execution = new ExecutionImpl(makeInput(store, broker));
    const first = await execution.reconcile();
    const second = await execution.reconcile();

    expect(broker.resumeFlattenCalls).toEqual([FLATTEN_KEY, FLATTEN_KEY]);
    expect(first.divergences[0]?.action).toBe('adopted');
    expect(second.divergences[0]?.action).toBe('adopted');
  });

  it('checked counts flatten rows alongside in-flight lots', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    await writeAheadFlatten(store);
    const broker = makeBroker();

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.checked).toBe(2);
  });
});

describe('reconcile — a position the venue holds and the store does not (#429)', () => {
  it('reports it, and writes nothing', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [
      { instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: 2_000 },
    ];

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.divergences).toHaveLength(1);
    expect(report.divergences[0]).toMatchObject({
      instrument: 'ETH-USD',
      action: 'unrecorded',
      broker_state: null,
      kind: 'unrecorded',
    });
    expect(report.divergences[0]?.reason).toContain('invisible to the Risk Manager');
    expect(report.corrected).toBe(0);
    expect(await store.countAllPositions()).toBe(0);
  });

  it('stays quiet about an instrument the store already has an open lot for', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();
    const known = (await store.getOpenPositions())[0];
    broker.venuePositions = [
      { instrument: known?.instrument ?? '', qty: 1, side: 'buy', avg_entry_price: 100 },
    ];

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.divergences.filter((d) => d.action === 'unrecorded')).toEqual([]);
  });

  it('degrades to a report when the positions endpoint is down, without losing the store-side pass', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();
    broker.failPositions = 'venue positions unreachable';

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.corrected).toBe(1);
    const undetermined = report.divergences.filter((d) => d.action === 'undetermined');
    expect(undetermined).toHaveLength(1);
    expect(undetermined[0]?.kind).toBe('unrecorded');
    expect(undetermined[0]?.reason).toContain('venue positions unreachable');
  });

  it('reports every unrecorded instrument, not just the first', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [
      { instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null },
      { instrument: 'SOL-USD', qty: -10, side: 'sell', avg_entry_price: null },
    ];

    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(report.divergences.map((d) => d.instrument).sort()).toEqual(['ETH-USD', 'SOL-USD']);
  });
});

describe('reconcile — the unrecorded venue position PAGES (#1550)', () => {
  function movableClock(at: Date): Clock & { advanceBy: (ms: number) => void } {
    let now = at;
    return { now: () => now, advanceBy: (ms) => (now = new Date(now.getTime() + ms)) };
  }

  it('pages on the pass that finds it, carrying the venue instrument, quantity and side', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [
      { instrument: 'ETH-USD', qty: -3, side: 'sell', avg_entry_price: 2_000 },
    ];
    const alerts = recordingUnrecordedAlertsFor();

    await new ExecutionImpl(makeInput(store, broker, undefined, undefined, alerts)).reconcile();

    expect(alerts.posted).toEqual([
      { trace_id: 'trace-86', instrument: 'ETH-USD', qty: -3, side: 'sell', observed_at: NOW },
    ]);
  });

  it('does not page again on the next pass inside the re-page window', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const alerts = recordingUnrecordedAlertsFor();
    const clock = movableClock(NOW);
    const input = { ...makeInput(store, broker, undefined, undefined, alerts), clock };

    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS - 1);
    await new ExecutionImpl(input).reconcile();

    expect(alerts.posted).toHaveLength(1);
  });

  it('pages again once the re-page window has elapsed, so a standing exposure does not go quiet', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const alerts = recordingUnrecordedAlertsFor();
    const clock = movableClock(NOW);
    const input = { ...makeInput(store, broker, undefined, undefined, alerts), clock };

    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(UNRECORDED_VENUE_POSITION_REPAGE_EVERY_MS);
    await new ExecutionImpl(input).reconcile();

    expect(alerts.posted).toHaveLength(2);
  });

  it('pages each unrecorded instrument on its own schedule', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const alerts = recordingUnrecordedAlertsFor();
    const clock = movableClock(NOW);
    const input = { ...makeInput(store, broker, undefined, undefined, alerts), clock };

    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(1_000);
    broker.venuePositions = [
      { instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null },
      { instrument: 'SOL-USD', qty: 10, side: 'buy', avg_entry_price: null },
    ];
    await new ExecutionImpl(input).reconcile();

    expect(alerts.posted.map((alert) => alert.instrument)).toEqual(['ETH-USD', 'SOL-USD']);
  });

  it('never pages the venue-read failure, and does not end a standing episode on it', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const alerts = recordingUnrecordedAlertsFor();
    const clock = movableClock(NOW);
    const input = { ...makeInput(store, broker, undefined, undefined, alerts), clock };

    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(1_000);
    broker.failPositions = 'venue positions unreachable';
    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(1_000);
    broker.failPositions = null;
    await new ExecutionImpl(input).reconcile();

    expect(alerts.posted).toHaveLength(1);
  });

  it('re-pages immediately for an instrument that cleared and came back', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const alerts = recordingUnrecordedAlertsFor();
    const clock = movableClock(NOW);
    const input = { ...makeInput(store, broker, undefined, undefined, alerts), clock };

    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(1_000);
    broker.venuePositions = [];
    await new ExecutionImpl(input).reconcile();
    clock.advanceBy(1_000);
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    await new ExecutionImpl(input).reconcile();

    expect(alerts.posted).toHaveLength(2);
  });

  it('survives a channel that throws, still reports the divergence, and logs a fixed line', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'ETH-USD', qty: 3, side: 'buy', avg_entry_price: null }];
    const logger = recordingLogger();

    const report = await new ExecutionImpl(
      makeInput(store, broker, undefined, logger, {
        postUnrecordedVenuePositionAlert: async () => {
          throw new Error('telegram 502 https://api.telegram.org/botSECRET/sendMessage');
        },
      }),
    ).reconcile();

    expect(report.divergences.map((d) => d.action)).toEqual(['unrecorded']);
    const failure = logger.entries.find(
      (entry) => entry.event === 'unrecorded_venue_position_alert_send_failed',
    );
    expect(failure?.level).toBe('error');
    expect(JSON.stringify(failure)).not.toContain('SECRET');
  });
});

describe('reconcile — the last open lot, closed by a flatten (#1550)', () => {
  it('ingestFills never reaches the fill feed with no open lots, so nothing invents a floor', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.fetchNewFills = async () => {
      throw new Error('fetchNewFills must not be called with no open lots');
    };
    broker.venuePositions = [{ instrument: 'AAPL', qty: 10, side: 'buy', avg_entry_price: 100 }];

    await expect(
      new ExecutionImpl(makeInput(store, broker)).ingestFills(),
    ).resolves.toBeUndefined();
    expect(await store.countAllPositions()).toBe(0);
  });

  it('one reconcile pass surfaces and pages the exposure the venue is left holding', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    broker.venuePositions = [{ instrument: 'AAPL', qty: -4, side: 'sell', avg_entry_price: 100 }];
    const alerts = recordingUnrecordedAlertsFor();

    const report = await new ExecutionImpl(
      makeInput(store, broker, undefined, undefined, alerts),
    ).reconcile();

    expect(report.divergences).toMatchObject([
      { instrument: 'AAPL', action: 'unrecorded', kind: 'unrecorded' },
    ]);
    expect(alerts.posted).toMatchObject([{ instrument: 'AAPL', qty: -4, side: 'sell' }]);
  });

  it('says nothing when the store still holds SOME lot on the instrument, however short', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const known = (await store.getOpenPositions())[0];
    const broker = makeBroker();
    broker.venuePositions = [
      { instrument: known?.instrument ?? '', qty: 999, side: 'buy', avg_entry_price: 100 },
    ];
    const alerts = recordingUnrecordedAlertsFor();

    const report = await new ExecutionImpl(
      makeInput(store, broker, undefined, undefined, alerts),
    ).reconcile();

    expect(report.divergences.filter((d) => d.action === 'unrecorded')).toEqual([]);
    expect(alerts.posted).toEqual([]);
  });
});

function recordingUnrecordedAlertsFor(): UnrecordedVenuePositionAlertChannel & {
  posted: UnrecordedVenuePositionAlert[];
} {
  const posted: UnrecordedVenuePositionAlert[] = [];
  return {
    posted,
    postUnrecordedVenuePositionAlert: async (alert) => {
      posted.push(alert);
    },
  };
}

describe('reconcile — the wedged-zero-fill sweep (#1186)', () => {
  it('a restart finds an already-wedged lot with no adapter memory of it, and retires it to a bookkeeping terminal state', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        order_state: 'filled',
        filled_size: 0,
        opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1),
      }),
    );

    const broker = makeBroker();
    const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();

    const settled = await store.getPosition(KEY);
    expect(settled?.order_state).toBe('abandoned');
    expect(settled?.abandon_reason).toBeDefined();

    expect(await store.getOpenPositions()).toEqual([]);

    const divergence = report.divergences.find((entry) => entry.idempotency_key === KEY);
    expect(divergence).toMatchObject({
      store_state: 'filled',
      broker_state: null,
      action: 'adopted',
      kind: 'sweep',
    });
    expect(report.checked).toBeGreaterThanOrEqual(1);
    expect(report.corrected).toBeGreaterThanOrEqual(1);

    expect(broker.submits).toHaveLength(0);
  });

  it('leaves a lot still inside the bounded window open across a restart — not yet a wedge, not a decision to make', async () => {
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(
      pendingPosition({
        order_state: 'partially_filled',
        filled_size: 0,
        opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS + 1),
      }),
    );

    const broker = makeBroker();
    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect((await store.getPosition(KEY))?.order_state).toBe('partially_filled');
    expect(await store.getOpenPositions()).toHaveLength(1);
  });

  it('does not let the #1088 terminal-row sweep delete the abandon_reason it just wrote', async () => {
    const { store } = openTestExecutionStore();
    const oldTimestamp = new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1);
    await store.writeAheadPosition(
      pendingPosition({
        order_state: 'filled',
        filled_size: 0,
        opened_at: oldTimestamp,
        decision_timestamp: oldTimestamp,
      }),
    );

    await new ExecutionImpl(makeInput(store, makeBroker())).reconcile();

    const settled = await store.getPosition(KEY);
    expect(settled?.order_state).toBe('abandoned');
    expect(settled?.abandon_reason).toBeDefined();
  });
});
