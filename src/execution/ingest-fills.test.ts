/**
 * `ingestFills()` — the second surface (ticket #83). Driven by a scripted
 * stub adapter (execution-spec.md "What Makes a Good Test"): the stub returns
 * the exact fill sequence a scenario needs, so the state machine, protective
 * resize, and `ClosedTrade` emission are asserted in isolation from any real
 * venue's timing.
 */
import type { CostModel } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, OpenPosition } from '../shared/index.js';
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
} from './types.js';

const NOW = new Date('2026-07-20T16:00:00Z');
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

/**
 * Writes a position straight into the store at `submitted` (past `execute()`'s
 * write-ahead), because `ingestFills()` never write-aheads itself.
 */
async function seedPosition(
  store: TestExecutionStore,
  overrides: Partial<OpenPosition> = {},
): Promise<OpenPosition> {
  const position: OpenPosition = {
    idempotency_key: 'key-1',
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
    order_state: 'submitted',
    broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
  await store.writeAheadPosition(position);
  return position;
}

/**
 * A scripted broker: `fetchNewFills` replays a fixed list (filtered by
 * `since`, as every real adapter does), and `resizeProtectiveLegs` records
 * the quantity it was asked to protect so the resize is observable.
 */
class ScriptedBroker implements BrokerAdapter {
  readonly resizeCalls: Array<{ clientOrderId: string; filledQty: number }> = [];

  constructor(private readonly scriptedFills: NormalizedFill[]) {}

  async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
    return {
      client_order_id: order.client_order_id,
      broker_order_ids: [order.client_order_id],
      order_state: 'submitted',
    };
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void> {
    this.resizeCalls.push({ clientOrderId, filledQty });
  }
  /** #86's surface. `ingestFills()` never reconciles, so it is never called. */
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  /** #429's intervention path — likewise untouched by the fill loop. */
  async submitFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.submitFlatten: ingestFills() does not flatten');
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedBroker.cancel: ingestFills() does not cancel');
  }
  async getOpenPositions(): Promise<never> {
    throw new Error('ScriptedBroker.getOpenPositions: ingestFills() does not reconcile');
  }
}

function fill(overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    client_order_id: 'key-1',
    broker_fill_id: 'fill-1',
    leg: 'entry',
    price: 100,
    qty: 5,
    fee: 1,
    timestamp: new Date('2026-07-20T15:00:00Z'),
    ...overrides,
  };
}

function makeInput(broker: BrokerAdapter, store: TestExecutionStore): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  };
  const clock: Clock = { now: () => NOW };
  return {
    trace_id: 'trace-1',
    clock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'backtest',
  };
}

describe('ExecutionImpl.ingestFills', () => {
  it('resizes the protective legs to cumulative filled qty and persists requested + filled size', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 4, price: 100 }),
      fill({
        broker_fill_id: 'e2',
        leg: 'entry',
        qty: 6,
        price: 101,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const position = await store.getPosition('key-1');
    // Both persisted: requested untouched, filled advanced to the cumulative.
    expect(position?.requested_size).toBe(10);
    expect(position?.filled_size).toBe(10);
    expect(position?.order_state).toBe('filled');
    // Resized to the cumulative filled quantity, not the requested size.
    expect(broker.resizeCalls.at(-1)).toEqual({ clientOrderId: 'key-1', filledQty: 10 });
  });

  it('emits exactly one correct ClosedTrade for a two-part partial fill then a stop-out', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, side: 'buy', stop: 95 });
    const broker = new ScriptedBroker([
      // Entry fills in two tranches: 4 @ 100, then 6 @ 101 → avg 100.6.
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 4, price: 100, fee: 1 }),
      fill({
        broker_fill_id: 'e2',
        leg: 'entry',
        qty: 6,
        price: 101,
        fee: 1,
        timestamp: new Date('2026-07-20T15:15:00Z'),
      }),
      // Stop-out takes the whole 10 flat @ 95.
      fill({
        broker_fill_id: 's1',
        leg: 'stop',
        qty: 10,
        price: 95,
        fee: 2,
        timestamp: new Date('2026-07-20T15:45:00Z'),
      }),
    ]);

    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();
    // Poll again: a re-poll must ingest nothing new and emit no second close.
    await execution.ingestFills();

    expect(await store.getClosedTrades()).toHaveLength(1);
    const closed = (await store.getClosedTrades())[0];
    expect(closed).toMatchObject({
      idempotency_key: 'key-1',
      debate_id: 'debate-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      filled_size: 10,
      stop: 95,
      close_reason: 'stop',
      opened_at: OPENED_AT,
    });
    // avg entry = (4*100 + 6*101)/10 = 100.6
    expect(closed.entry).toBeCloseTo(100.6, 6);
    // gross = (95 - 100.6) * 10 = -56; fees = 1+1+2 = 4 → net -60
    expect(closed.realized_pnl_net).toBeCloseTo(-60, 6);
    expect(closed.fees_total).toBeCloseTo(4, 6);
    expect(closed.closed_at).toEqual(new Date('2026-07-20T15:45:00Z'));
    // The lot is terminal, so it no longer surfaces for ingestion.
    expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
    expect((await store.getOpenPositions()).length).toBe(0);
  });

  it('signs realized PnL by side — a short earns the fall', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, side: 'sell', stop: 105 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100, fee: 0 }),
      fill({
        broker_fill_id: 't1',
        leg: 'target',
        qty: 10,
        price: 90,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const closed = (await store.getClosedTrades())[0];
    // Short entered at 100, covered at 90 → +10/unit × 10 = +100.
    expect(closed.realized_pnl_net).toBeCloseTo(100, 6);
    expect(closed.close_reason).toBe('target');
  });

  it('tracks a scale-in as its own lot with its own ClosedTrade', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      idempotency_key: 'key-1',
      debate_id: 'debate-1',
      requested_size: 10,
    });
    await seedPosition(store, {
      idempotency_key: 'key-2',
      debate_id: 'debate-2',
      intent_type: 'scale_in',
      requested_size: 5,
    });
    const broker = new ScriptedBroker([
      fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100 }),
      fill({
        client_order_id: 'key-1',
        broker_fill_id: 's1',
        leg: 'stop',
        qty: 10,
        price: 95,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
      fill({ client_order_id: 'key-2', broker_fill_id: 'e2', leg: 'entry', qty: 5, price: 100 }),
      fill({
        client_order_id: 'key-2',
        broker_fill_id: 't2',
        leg: 'target',
        qty: 5,
        price: 110,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    // Two distinct lots → two distinct ClosedTrades, each with its own
    // debate_id and its own R inputs.
    expect(await store.getClosedTrades()).toHaveLength(2);
    const byKey = new Map(
      (await store.getClosedTrades()).map((trade) => [trade.idempotency_key, trade]),
    );
    expect(byKey.get('key-1')).toMatchObject({ debate_id: 'debate-1', close_reason: 'stop' });
    expect(byKey.get('key-2')).toMatchObject({ debate_id: 'debate-2', close_reason: 'target' });
  });

  it('holds a still-open lot at partially_filled and does not close it', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 4, price: 100 }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect((await store.getPosition('key-1'))?.order_state).toBe('partially_filled');
    expect((await store.getPosition('key-1'))?.filled_size).toBe(4);
    expect(await store.getClosedTrades()).toHaveLength(0);
    expect(broker.resizeCalls.at(-1)).toEqual({ clientOrderId: 'key-1', filledQty: 4 });
  });

  it('does not ingest a fill dated after the clock (no lookahead)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: 'e1', leg: 'entry', qty: 4, price: 100 }),
      // Dated one hour past NOW — the simulated future has not happened yet.
      fill({
        broker_fill_id: 'e2',
        leg: 'entry',
        qty: 6,
        price: 101,
        timestamp: new Date('2026-07-20T17:00:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    // Only the in-the-past tranche landed.
    expect((await store.getPosition('key-1'))?.filled_size).toBe(4);
    expect(await store.getFills('key-1')).toHaveLength(1);
  });
});
