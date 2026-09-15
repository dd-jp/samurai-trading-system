/**
 * `reconcile()` — crash-restart + broker reconciliation (ticket #86).
 *
 * A "restart" here is a NEW `ExecutionImpl` built over a store that survived
 * (it is the durable one) and the SAME broker instance (the venue is external
 * and does not crash with us). That is the whole shape of the scenario: the
 * process forgets, the store and the venue do not.
 */
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
import { WEDGED_ZERO_FILL_ABANDON_AFTER_MS } from './wedged-zero-fill-sweep.js';

/**
 * #1214: `ExecutionInput.sessionCalendars`. An open venue for both classes —
 * nothing in this file turns on the residual re-flatten's session gate, and a
 * shut venue would stand that path down for a reason none of these tests are
 * about.
 */
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

/** The lot as `execute()`'s write-ahead leaves it, before any broker ack. */
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

/**
 * The venue. Its `book` is what it will admit to having — seeding it is how a
 * test says "the submit landed" vs "it never did".
 */
function makeBroker(): BrokerAdapter & {
  book: Map<string, NormalizedOrder>;
  submits: NativeBracketRequest[];
  failLookup: string | null;
  venuePositions: NormalizedPosition[];
  failPositions: string | null;
  /** #519/#526: what `resumeFlatten` answers, keyed the same way `book` is for `getOrder`. */
  flattenBook: Map<string, NormalizedOrder>;
  /**
   * Ignorance, not absence, for `resumeFlatten` — mirrors `failLookup`. It
   * leaves `cancel` working, and that is a real adapter shape rather than a
   * convenience of this double: both production adapters reach an order for
   * cancellation without the lookup `resumeFlatten` uses, each pinned by its
   * own adapter test (`cancel() when the by-client-order-id lookup is the
   * thing that is broken` / `cancels a flatten whose activity-trail lookup is
   * failing`).
   */
  failFlattenLookup: string | null;
  /** Every `resumeFlatten` call, in order — so a test can assert it ran (or didn't). */
  resumeFlattenCalls: string[];
  /** Every `cancel` call, in order, with the args it was given. */
  cancelCalls: Array<{ client_order_id: string; instrument: string }>;
  /** A venue that refuses the cancel — the case that must leave the row blocking. */
  failCancel: string | null;
  /** Fires inside `cancel`, so a test can move the venue's book while it is in flight. */
  onCancel: (() => void) | null;
  /** How many times the venue's position book was read — what the #1500 throttles bound. */
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
      // Ignorance, not absence — the contract says throw rather than null.
      if (this.failLookup !== null) throw new Error(this.failLookup);
      return this.book.get(clientOrderId) ?? null;
    },

    // #519/#526's flatten-sweep counterpart of `getOrder`, over its OWN book
    // — a flatten's client_order_id never collides with a bracket's, but
    // keeping the maps separate mirrors the production adapters' own
    // `brackets`/`flattens` split (alpaca-adapter.ts) rather than assuming
    // it away.
    async resumeFlatten(clientOrderId: string): Promise<NormalizedOrder | null> {
      this.resumeFlattenCalls.push(clientOrderId);
      if (this.failFlattenLookup !== null) throw new Error(this.failFlattenLookup);
      return this.flattenBook.get(clientOrderId) ?? null;
    },

    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },

    async resizeProtectiveLegs(): Promise<void> {},

    // #525. `reconcile()` does not drive the fill lifecycle either.
    async rearmProtectiveLegs(): Promise<void> {},

    // #429. `venuePositions` is what the venue holds; `failPositions` makes the
    // positions endpoint unreachable, the case that must degrade to a report
    // rather than lose the store-side pass that already ran.
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
    /** A venue whose book moves while the cancel is in flight. */
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
    // Reconciliation touches neither: it reads the venue's order book, not
    // modelled fills or market context.
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    sessionCalendars: OPEN_SESSION_CALENDARS,
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
    logger,
  };
}

describe('reconcile — crash between write-ahead and broker ack', () => {
  it('marks the lot rejected when the venue never received the order, and the replay does not double-submit', async () => {
    // The crash: write-ahead is durable, the broker call never landed.
    const { store } = openTestExecutionStore();
    await store.writeAheadPosition(pendingPosition());
    const broker = makeBroker();

    // Restart: a brand-new Execution over the surviving store + live venue.
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

    // Nothing was resubmitted by reconcile itself.
    expect(broker.submits).toHaveLength(0);

    // AC: exactly one order exists — the write-ahead record, now settled.
    expect(await store.countAllPositions()).toBe(1);

    // And the decision replaying (the same bar re-processed after restart)
    // still cannot reach the venue: the surviving record dedupes it.
    const replay = await restarted.execute(makeGo());
    expect(replay.status).toBe('deduped');
    expect(broker.submits).toHaveLength(0);
    expect(await store.countAllPositions()).toBe(1);
  });

  it('adopts the broker state when the order did land, and the replay still does not double-submit', async () => {
    // The other side of the same crash: the bracket reached the venue, the
    // ack never reached us.
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
    // The venue's leg ids are adopted too — without them there is nothing to
    // cancel the bracket by.
    expect(settled?.broker_order_ids).toEqual([`${KEY}:entry`, `${KEY}:stop`]);

    expect(await store.countAllPositions()).toBe(1);
    expect(broker.submits).toHaveLength(0);

    const replay = await restarted.execute(makeGo());
    expect(replay.status).toBe('deduped');
    expect(broker.submits).toHaveLength(0);
  });

  it('recovers a real crash mid-submit: the same decision, executed twice across a restart, reaches the venue once', async () => {
    // End-to-end version of the AC, driving execute() rather than seeding the
    // store by hand. The broker accepts the bracket, then the process "dies"
    // before the ack is persisted.
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const crashing = {
      ...broker,
      async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
        await broker.submitBracket(order);
        // The venue has it; we never learn so.
        throw new Error('connection lost before ack');
      },
    };

    const before = new ExecutionImpl(makeInput(store, crashing));
    const crashed = await before.execute(makeGo());
    expect(crashed.status).toBe('error');
    // The write-ahead survives the failed submit — that is what makes this
    // recoverable rather than an invisible order.
    expect((await store.getPosition(KEY))?.order_state).toBe('pending');
    expect(broker.submits).toHaveLength(1);

    // Restart, reconcile, then replay the decision.
    const after = new ExecutionImpl(makeInput(store, broker));
    await after.reconcile();
    expect((await store.getPosition(KEY))?.order_state).toBe('submitted');

    const replay = await after.execute(makeGo());
    expect(replay.status).toBe('deduped');

    // Exactly one order at the venue, exactly one record in the store.
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
    // The venue filled it while we were down.
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

    // Adopting the state must not invent a quantity: ingestFills() rebuilds
    // filled_size from the persisted Fill rows, and reconcile writing it here
    // would fight that reconstruction.
    expect((await store.getPosition(KEY))?.filled_size).toBe(0);
    // Still non-terminal, so it stays visible to ingestFills().
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

    // Ignorance is not evidence: marking this rejected would bury a position
    // that may well be live and filled.
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
    // The fill-driven states are untouched — their filled_size/avg price are
    // reconstructed from Fill rows, not from a venue order summary.
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

/**
 * The terminal-row sweep (#1088) — `sweepTerminalPositions`, called
 * unconditionally at the end of every `reconcile()` pass. `NOW` is fixed at
 * '2026-07-15T14:00:00Z'; `TERMINAL_SWEEP_AGE_MS` is 24h, so a
 * `decision_timestamp` of '2026-07-14T13:59:59Z' or earlier is old enough
 * and one of '2026-07-14T14:00:01Z' or later is not.
 */
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

  it.each([
    'rejected',
    'cancelled',
    'expired',
  ] as const)('sweeps an old enough %s row with filled_size = 0', async (order_state) => {
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
  });

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
    // Matches the store row exactly (`agrees()`), so reconcileLot writes
    // nothing and the row stays `pending` — never terminal, so the sweep
    // was never going to touch it either way; this asserts that directly.
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
      // Two live lots the recovery path must still see afterward.
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
      // Terminal rows: some sweepable, some not (per the rules above).
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
      // Matches the store row exactly, so this lot agrees and is untouched
      // by the in-flight reconciliation — it must stay live through the
      // SAME pass that runs the sweep, not just survive a later one.
      broker.book.set('key-live-1', {
        client_order_id: 'key-live-1',
        broker_order_ids: [],
        order_state: 'submitted',
        filled_qty: 0,
      });

      // Recovery BEFORE the sweep-bearing reconcile pass runs.
      const before = await store.getOpenPositions();

      const report = await new ExecutionImpl(makeInput(store, broker)).reconcile();
      expect(report.swept).toBe(1); // only key-term-old-rejected

      // Recovery AFTER — same live set, by key and by order_state.
      const after = await store.getOpenPositions();
      expect(after.map((p) => p.idempotency_key).sort()).toEqual(
        before.map((p) => p.idempotency_key).sort(),
      );
      expect(after.map((p) => p.idempotency_key).sort()).toEqual(['key-live-1', 'key-live-2']);

      // The non-swept terminal rows are still present (just not "open").
      expect(await store.getPosition('key-term-recent-cancelled')).not.toBeNull();
      expect(await store.getPosition('key-term-old-closed')).not.toBeNull();
      // The swept one is gone.
      expect(await store.getPosition('key-term-old-rejected')).toBeNull();
    },
  );
});

/**
 * The flatten-journal sweep (#519, #526) — `reconcile()`'s second worklist,
 * over `flatten_submissions` rather than `open_positions`. Mirrors the
 * bracket-side describe blocks above in shape (crash between write-ahead and
 * ack, store-vs-broker divergence, scope/safety) rather than duplicating
 * their setup verbatim.
 */
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
      // #1001 — every write-ahead call site provides a value (possibly null,
      // never omitted; see `FlattenSubmissionWriteAhead`'s own doc).
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
    // `flattenBook` left empty: `resumeFlatten` answers null, same as `getOrder`.

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
    // Acked once already — mirrors what `executeExit` itself does on a clean
    // submit, so this row starts at 'submitted' with real broker_order_ids.
    await store.resolveFlattenSubmitted(
      FLATTEN_KEY,
      { order_state: 'submitted', broker_order_ids: [`${FLATTEN_KEY}:order`] },
      NOW,
    );
    const broker = makeBroker();
    // `flattenBook` left empty: the venue now answers null for an order it
    // definitely acked before — ignorance, not proof it never landed.
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
    // Not a correction — the record was left exactly as it was.
    expect(report.corrected).toBe(0);

    const row = await store.getFlattenSubmission(FLATTEN_KEY);
    expect(row?.status).toBe('submitted');
    expect(row?.order_state).toBe('submitted');
    expect(row?.broker_order_ids).toBe(JSON.stringify([`${FLATTEN_KEY}:order`]));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.idempotency_key).toBe(FLATTEN_KEY);
    expect(alerts[0]?.reason).toContain('previously acked');
  });

  /**
   * An acked flatten the venue keeps reporting WORKING may never be released
   * on age — that is the #516/#1389 over-sell. The way out is to cancel it at
   * the venue so one of the ordinary resolution paths can retire the row.
   */
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
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.idempotency_key).toBe(FLATTEN_KEY);

    // The row itself is NOT released here — only the venue turning the order
    // terminal AND its fills being swept may do that.
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

    await new ExecutionImpl(makeInput(store, broker)).reconcile();

    expect(broker.cancelCalls).toEqual([]);
  });

  it('does NOT cancel a row the venue already reports terminal — there is nothing working to cancel', async () => {
    const { store } = openTestExecutionStore();
    await ackedFlatten(store, new Date(NOW.getTime() - (UNRESOLVABLE_FLATTEN_MAX_AGE_MS + 1)));
    const broker = makeBroker();
    // Cancelled with a PARTIAL fill: terminal, so no cancel is owed, and
    // `filled_qty > 0` keeps `reconcileFlatten` from resolving the row —
    // it stays blocking until `ingestFills()` sweeps the partial.
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

  /**
   * The NEVER-CONFIRMED row (#1500). `writeAheadFlatten`
   * committed, `submitFlatten` may well have landed at the venue (the ack is
   * exactly what was lost), and `resumeFlatten` throws on every pass since —
   * so `order_state` stays null forever and no later pass can turn the row
   * terminal. Age alone must not release it: the order may be working, and a
   * venue can serve order placement while its order-details endpoint fails.
   *
   * THE MUTATION THESE KILL: releasing such a row on age (or on a delivered
   * cancel alone). `cancel()` resolves for an order that already FILLED on
   * both production adapters, so the venue's own position is the only
   * evidence that separates "nothing filled" from "we just cancelled a fill".
   */
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

  /**
   * A surplus is not coverage either: an unbooked exit fill hides inside it, so
   * both release paths share the refusal, not just the terminal-unswept one.
   */
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

  /** A venue book on the OTHER side of the store's is the #516/#1389 over-sell, not coverage. */
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

  /**
   * The evidence must be read AFTER the cancel resolves. A fill can land while
   * the cancel is in flight — and the sweep spends real time before it,
   * `resumeFlatten` timeouts and other rows' cancels — so a book read earlier
   * answers for a venue that no longer exists, and releasing on it is the
   * #516/#1389 over-sell. Here the venue holds the whole lot right up to the
   * cancel and less immediately after: only a post-cancel read can see that.
   */
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

  /**
   * A venue reports ONE netted position per instrument, so it cannot speak for
   * store lots held on both sides at once: netting them first turns an exactly
   * offsetting pair into `0` held against `0` at the venue, which reads as
   * coverage on no evidence at all. `heldQuantitiesFor` refuses to pre-sum for
   * this reason; so does this check.
   */
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
    // The two lots net to nothing at the venue, which is exactly the book a
    // venue holding NEITHER of them would report.
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

    expect(
      report.divergences.find((divergence) => divergence.idempotency_key === FLATTEN_KEY)?.reason,
    ).toContain('cancel FAILED');
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

  /**
   * The TERMINAL row whose fills were never swept. `fills_swept_at` is the
   * only thing that retires it and only `ingestFills()` writes it, as the last
   * step of a poll that must first attribute the flatten's fills and advance
   * every lot they name. Any failure before that step leaves the row unswept,
   * and the fills then age past the poll's `since` floor so the flatten key is
   * never iterated again — the row blocks its instrument's mandatory
   * flat-by-close for as long as the store exists, across restarts, with no
   * operator path but hand-editing SQLite.
   *
   * THE MUTATION THESE KILL: releasing such a row on age, or on the venue's
   * order state alone. What separates "the fills were applied and only the
   * mark was lost" from "the fills are real and unbooked" is the venue's own
   * book, and only the second shape may keep blocking. Plus what the window
   * is measured from, and what looking costs: the clock starts when the row is
   * first SEEN terminal (never at submission — see the constant), and every
   * look costs one venue read and at most one page per window.
   */
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

  /** Entry 10 then a booked exit of 4: what a partially-filled flatten leaves once ingestFills HAS applied it. */
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
    // Retiring the row is not enough: the remainder the venue still holds has
    // to be flattenable again, and only `status='error'` lets
    // `resolveExitRetryKey` walk to a fresh key. Retiring it any other way
    // (e.g. `markFlattenFillsSwept`) leaves `execute()` on `deduped` and the
    // remainder never exits. Safe here precisely because the release is gated
    // on the venue covering everything the store still holds.
    expect(await store.isRetryableFlattenError(FLATTEN_KEY)).toBe(true);
  });

  it('keeps a terminal unswept flatten blocking when the venue holds LESS than the store has booked', async () => {
    const { store } = openTestExecutionStore();
    // Nothing booked: the attribution-side wedge, where the fills are real,
    // unbooked, and no venue number can say which lot each belongs to.
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
    // Submitted six hours ago and terminal only now: measured from
    // `submitted_at` this row would be judged on the very poll that observed
    // the fill, against a venue book that may not have caught up with it yet.
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

    // Nothing looked at, nothing paged — and the row still blocks. The venue
    // read this pass made is `findUnrecordedVenuePositions`', not the
    // coverage check's.
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

    // Two passes, ONE verdict: the second is inside the window the first
    // re-armed. Three reads, not four — one per pass for
    // `findUnrecordedVenuePositions`, plus the one coverage check.
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
    // A surplus the store has no lot for. It covers the 6 the store holds, but
    // an unbooked exit fill up to its size hides inside that sum, so this book
    // cannot corroborate the store — no over-sell either way, but a release
    // here would leave real fills out of the journal.
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
    // The row was submitted 6h ago but LAST examined a window ago, and the
    // alert must say the second — the column is re-armed, so it cannot speak
    // for the age of the wedge.
    expect(alerts[0]?.reason).toContain('1800s after this sweep last examined it');
    expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
      FLATTEN_KEY,
    ]);
  });

  it('writes the venue state it released on — a submitting row is acked before any release', async () => {
    const { store } = openTestExecutionStore();
    await bookedPartialExit(store);
    const broker = makeBroker();
    // Never acked in-process: `resolveFlattenSubmitted` has never run, so
    // `broker_order_ids` and `resolved_at` are still unwritten on this row.
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

  /**
   * The cancel and its page are throttled against the DURABLE
   * `cancel_attempted_at`, not re-issued on every fill-sync poll.
   */
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

  /**
   * The OTHER "left untouched and escalated" branch (#1214), and the case for
   * NOT giving it the age bound the null-on-acked branch got.
   *
   * A `resumeFlatten` that throws is ignorance, not evidence: nothing observed
   * the venue's answer, so forcing the row terminal on age would write a
   * finding into the journal that nobody made. Its resolution path is the next
   * pass on which the adapter CAN answer, and that path terminates, which is
   * what this proves. A row whose lookup NEVER answers is not left to it —
   * `cancelNeverConfirmedFlatten` (#1500) takes that shape past the bound, on
   * venue evidence rather than on age.
   *
   * THE MUTATION THIS KILLS: extend the age bound to cover the catch branch
   * too. This test still passes (the row resolves either way), so it is paired
   * with the assertion below that the row is still `'submitting'` after the
   * unreachable pass however old it is — an age-bounded catch would have
   * forced it to `'error'` there and the replacement flatten would then have
   * gone out while the ORIGINAL was, for all anyone knows, still working.
   */
  it('resolves a row whose lookup kept throwing as soon as the adapter can answer again — ignorance is not age-bounded', async () => {
    const { store } = openTestExecutionStore();
    // Far older than `UNRESOLVABLE_FLATTEN_MAX_AGE_MS`: age alone must not
    // settle a row nothing has observed.
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

    // The venue comes back and names the order, terminally and with no fill —
    // the same answer the terminal-non-fill path already resolves on.
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

  // #573: before this ticket, a failure of the fallback alert ITSELF (as
  // opposed to the flatten it reports on) vanished with no trace at all —
  // the store row is correctly left untouched either way, but nothing said
  // the alert never reached anyone.
  it('logs a fixed, self-authored message (never the channel error) when the fallback alert itself fails to deliver', async () => {
    const { store } = openTestExecutionStore();
    await writeAheadFlatten(store);
    const broker = makeBroker();
    broker.failFlattenLookup = 'venue unreachable';
    // A Telegram transport failure quotes the request it failed on,
    // which can carry a bot token — this text must never reach the log.
    const failingFlattenReconcileAlerts: FlattenReconcileAlertChannel = {
      postFlattenReconcileAlert: async () => {
        throw new Error('Bearer super-secret-transport-token rejected the request');
      },
    };
    const logger = recordingLogger();

    const report = await new ExecutionImpl(
      makeInput(store, broker, failingFlattenReconcileAlerts, logger),
    ).reconcile();

    // The row-level outcome is unaffected by the alert's own delivery
    // failure — same as the adapter-unreachable case above.
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

    // Both passes see it: `fills_swept_at` is only set by `ingestFills()`
    // (ingest-fills.ts), which this test never calls — reconcile() alone
    // cannot close its own worklist entry, by design (see
    // `SharedStore.markFlattenFillsSwept`'s doc for why).
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

    // 1 in-flight lot + 1 unresolved flatten.
    expect(report.checked).toBe(2);
  });
});

/**
 * #429 — the other direction. Everything above walks the STORE's lots and asks
 * the venue about each, which can only find what the store already knows.
 * execution-spec.md's requirement is symmetric ("store shows a position the
 * broker doesn't, **or vice-versa**") and the second half had no surface at all
 * until `BrokerAdapter.getOpenPositions` existed. A lot the venue holds and the
 * store never recorded is invisible to Risk's exposure caps indefinitely.
 */
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
    // Not a correction: nothing was written. Adopting would mean inventing the
    // bracket, stop and debate_id the venue position has none of.
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

    // The store-side lot was still settled — losing real work because a
    // positions endpoint was down would be the worse outcome.
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

describe('reconcile — the wedged-zero-fill sweep (#1186)', () => {
  it('a restart finds an already-wedged lot with no adapter memory of it, and retires it to a bookkeeping terminal state', async () => {
    // The exact position a restart leaves the system in (#1186's AC): the
    // row is durable, but nothing in a fresh process remembers this lot —
    // `makeBroker()`'s `book` starts empty, same as a process that never
    // submitted anything this run.
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

    // Terminal: gone from the live read every caller (Trader, Risk, the
    // dashboard) trusts.
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

    // #1215's rule: no venue order is cancelled or re-placed. This lot's
    // bracket-pass never even reached the broker — `filled` is not
    // `IN_FLIGHT_ORDER_STATES` — so nothing was submitted or looked up for it.
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
    // A real wedge's `decision_timestamp` sits near its (old) `opened_at`,
    // not near `now` — unlike this file's `pendingPosition()` default (5
    // minutes before NOW), which would hide this exact defect: this test's
    // `decision_timestamp` clears `TERMINAL_SWEEP_AGE_MS`'s cutoff too, so
    // `sweepTerminalPositions` runs against this row in the SAME reconcile()
    // pass that just abandoned it (see reconcile.ts's call order). If
    // `'abandoned'` were ever re-added to `SWEEPABLE_TERMINAL_STATES`
    // (sqlite-shared-store.ts), this row — `abandon_reason` and all — would
    // be hard-deleted here instead of surviving as the durable record #1186
    // exists to keep.
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
