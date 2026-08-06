/**
 * `reconcile()` — crash-restart + broker reconciliation (ticket #86).
 *
 * A "restart" here is a NEW `ExecutionImpl` built over a store that survived
 * (it is the durable one) and the SAME broker instance (the venue is external
 * and does not crash with us). That is the whole shape of the scenario: the
 * process forgets, the store and the venue do not.
 */
import type { CostModel } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../shared/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ExecutionImpl } from './execute.js';
import { openTestExecutionStore, type TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from './types.js';

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
} {
  return {
    book: new Map<string, NormalizedOrder>(),
    submits: [] as NativeBracketRequest[],
    failLookup: null as string | null,

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

    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },

    async resizeProtectiveLegs(): Promise<void> {},

    // #429. `venuePositions` is what the venue holds; `failPositions` makes the
    // positions endpoint unreachable, the case that must degrade to a report
    // rather than lose the store-side pass that already ran.
    venuePositions: [] as NormalizedPosition[],
    failPositions: null as string | null,
    async getOpenPositions(): Promise<NormalizedPosition[]> {
      if (this.failPositions !== null) throw new Error(this.failPositions);
      return this.venuePositions;
    },

    async submitFlatten(): Promise<never> {
      throw new Error('makeBroker.submitFlatten: reconcile() does not flatten');
    },
    async cancel(): Promise<never> {
      throw new Error('makeBroker.cancel: reconcile() does not cancel');
    },
  };
}

function makeInput(store: TestExecutionStore, broker: BrokerAdapter): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
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
    mode: 'live',
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
