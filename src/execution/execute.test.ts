import { describe, expect, it, vi } from 'vitest';
import type { CostModel } from '../cost-model-backtest/types.js';
import type { MarketDataService } from '../market-data-service/types.js';
import type { Clock } from '../shared/clock.js';
import type { Fill, OpenPosition, OrderIntent, OrderState } from '../shared/types.js';
import type { VerdictDecision } from '../verdict/types.js';
import { ExecutionImpl } from './execute.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
  SharedStore,
} from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const fixedClock: Clock = { now: () => NOW };

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'key-aapl-1355',
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

/**
 * Minimal in-memory stand-in for the shared SQLite store. Records writes in
 * order so tests can assert what was durable at each point, not just the
 * end state.
 */
class InMemoryStore implements SharedStore {
  readonly positions = new Map<string, OpenPosition>();
  readonly writeLog: string[] = [];

  async findByKey(idempotency_key: string): Promise<boolean> {
    return this.positions.has(idempotency_key);
  }

  async writeAheadPosition(position: OpenPosition): Promise<void> {
    this.writeLog.push(`write-ahead:${position.idempotency_key}`);
    this.positions.set(position.idempotency_key, { ...position });
  }

  async updatePositionState(
    idempotency_key: string,
    update: { order_state: OrderState; broker_order_ids: string[] },
  ): Promise<void> {
    const existing = this.positions.get(idempotency_key);
    if (!existing) {
      throw new Error(`updatePositionState: no write-ahead record for ${idempotency_key}`);
    }
    this.writeLog.push(`update:${idempotency_key}:${update.order_state}`);
    this.positions.set(idempotency_key, { ...existing, ...update });
  }

  // Fill-lifecycle surface (#83). execute() never calls these; they exist so
  // this store still satisfies the widened SharedStore.
  async getOpenPositions(): Promise<OpenPosition[]> {
    return [...this.positions.values()];
  }

  async hasFill(): Promise<boolean> {
    return false;
  }

  async writeFill(): Promise<void> {}

  async getFills(): Promise<Fill[]> {
    return [];
  }

  async updatePositionFill(
    idempotency_key: string,
    update: { filled_size: number; avg_entry_price: number; order_state: OrderState },
  ): Promise<void> {
    const existing = this.positions.get(idempotency_key);
    if (!existing) return;
    this.positions.set(idempotency_key, { ...existing, ...update });
  }

  async writeClosedTrade(): Promise<void> {}
}

/** Accepts everything and records what it was handed. */
function makeBroker(
  onSubmit?: (order: NativeBracketRequest) => void | Promise<void>,
): BrokerAdapter & { calls: NativeBracketRequest[] } {
  const calls: NativeBracketRequest[] = [];
  return {
    calls,
    async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
      calls.push(order);
      await onSubmit?.(order);
      return {
        client_order_id: order.client_order_id,
        broker_order_ids: [`${order.client_order_id}:entry`, `${order.client_order_id}:stop`],
        order_state: 'submitted',
      };
    },
    // execute() never drives the fill lifecycle; these satisfy the widened
    // interface (#83) without behaviour these tests exercise.
    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },
    async resizeProtectiveLegs(): Promise<void> {},
  };
}

function makeInput(overrides: Partial<ExecutionInput> = {}): ExecutionInput {
  const config: ExecutionConfig = {
    simulated: {
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 14 },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  };
  return {
    trace_id: 'trace-1',
    clock: fixedClock,
    broker: makeBroker(),
    store: new InMemoryStore(),
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'backtest',
    ...overrides,
  };
}

describe('ExecutionImpl.execute', () => {
  it('expands the bracket, write-aheads, submits, and returns submitted', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    const result = await execution.execute(makeGo());

    expect(result.status).toBe('submitted');
    expect(result.idempotency_key).toBe('key-aapl-1355');
    expect(result.order_state).toBe('submitted');
    expect(result.broker_order_ids).toEqual(['key-aapl-1355:entry', 'key-aapl-1355:stop']);
    expect(result.reason).toBeNull();
    expect(result.timestamp).toEqual(NOW);
  });

  it('hands the adapter the abstract bracket with the idempotency key as client order id', async () => {
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ broker }));

    await execution.execute(makeGo());

    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]).toEqual({
      // Dedup layer 2: the venue rejects a duplicate of this id.
      client_order_id: 'key-aapl-1355',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      size: 100,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'day',
    });
  });

  // AC: "Write-ahead record exists before the simulated broker call." This is
  // an ordering claim, so it is observed from inside the broker call itself —
  // asserting after execute() returns would pass even if the write happened
  // afterwards.
  it('persists the pending record BEFORE calling the broker', async () => {
    const store = new InMemoryStore();
    let stateAtSubmit: OpenPosition | undefined;
    const broker = makeBroker(() => {
      stateAtSubmit = store.positions.get('key-aapl-1355');
    });

    await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(stateAtSubmit).toBeDefined();
    expect(stateAtSubmit?.order_state).toBe('pending');
    expect(store.writeLog).toEqual(['write-ahead:key-aapl-1355', 'update:key-aapl-1355:submitted']);
  });

  it('write-aheads the lot with the fields downstream binds', async () => {
    const store = new InMemoryStore();
    let stateAtSubmit: OpenPosition | undefined;
    const broker = makeBroker(() => {
      stateAtSubmit = store.positions.get('key-aapl-1355');
    });

    await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(stateAtSubmit).toEqual({
      idempotency_key: 'key-aapl-1355',
      debate_id: 'debate-abc123',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 100,
      // Nothing has filled at `pending`, so the lot carries no exposure yet.
      filled_size: 0,
      avg_entry_price: 0,
      stop: 95,
      target: 110,
      order_state: 'pending',
      broker_order_ids: [],
      opened_at: NOW,
      decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    });
  });

  it('persists the broker ack state after submit', async () => {
    const store = new InMemoryStore();
    await new ExecutionImpl(makeInput({ store })).execute(makeGo());

    expect(store.positions.get('key-aapl-1355')).toMatchObject({
      order_state: 'submitted',
      broker_order_ids: ['key-aapl-1355:entry', 'key-aapl-1355:stop'],
    });
  });

  // AC: "Duplicate execute() calls with the same idempotency_key produce
  // exactly one submission."
  it('dedupes a repeat of the same key without touching the broker', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    const first = await execution.execute(makeGo());
    const second = await execution.execute(makeGo());

    expect(first.status).toBe('submitted');
    expect(second.status).toBe('deduped');
    expect(second.reason).toBe('an order or fill already exists for this idempotency_key');
    expect(second.broker_order_ids).toBeNull();
    // The first call owns the lot; this one wrote nothing and so has no
    // state of its own to report.
    expect(second.order_state).toBeNull();
    expect(broker.calls).toHaveLength(1);
  });

  // AC: "submit-N-times yields exactly one fill" — at this seam, exactly one
  // submission reaches the broker, which is what makes exactly one fill
  // possible downstream.
  it('submits exactly once across N replays of the same decision', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await execution.execute(makeGo()));
    }

    expect(broker.calls).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual([
      'submitted',
      'deduped',
      'deduped',
      'deduped',
      'deduped',
    ]);
    expect(store.positions.size).toBe(1);
  });

  it('treats a different instrument/bar as a separate decision', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    await execution.execute(makeGo());
    const other = await execution.execute(
      makeGo({ idempotency_key: 'key-btc-1400', instrument: 'BTC-USD', asset_class: 'crypto' }),
    );

    expect(other.status).toBe('submitted');
    expect(broker.calls).toHaveLength(2);
    expect(store.positions.size).toBe(2);
  });

  it('leaves the pending record intact when the broker call throws', async () => {
    const store = new InMemoryStore();
    const broker: BrokerAdapter = {
      submitBracket: vi.fn().mockRejectedValue(new Error('connection reset')),
      fetchNewFills: vi.fn().mockResolvedValue([]),
      resizeProtectiveLegs: vi.fn().mockResolvedValue(undefined),
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(result.status).toBe('error');
    expect(result.reason).toBe('connection reset');
    expect(result.broker_order_ids).toBeNull();
    // Whether the bracket landed is unknowable here — only the broker can
    // settle it, so the record stays `pending` for #86 to reconcile rather
    // than being guessed terminal.
    expect(result.order_state).toBe('pending');
    expect(store.positions.get('key-aapl-1355')?.order_state).toBe('pending');
  });

  it('does not act on a no_go', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();
    const noGo: VerdictDecision = {
      status: 'no_go',
      order: null,
      no_go_reason: 'drift',
      approval_path: 'automated',
      would_require_approval: false,
      idempotency_key: 'key-aapl-1355',
      timestamp: NOW,
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(noGo);

    expect(result.status).toBe('error');
    expect(result.order_state).toBeNull();
    expect(broker.calls).toHaveLength(0);
    expect(store.positions.size).toBe(0);
  });

  it('routes scale_in through the bracket path as its own lot', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
      makeGo({ intent_type: 'scale_in' }),
    );

    expect(result.status).toBe('submitted');
    expect(store.positions.get('key-aapl-1355')?.intent_type).toBe('scale_in');
  });

  // The flatten path (submitFlatten -> ClosedTrade on round-trip-to-flat) is
  // #83's; #82 refuses it explicitly rather than silently bracketing an exit.
  it('refuses an exit intent, which has no bracket to expand', async () => {
    const store = new InMemoryStore();
    const broker = makeBroker();

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
      makeGo({ intent_type: 'exit' }),
    );

    expect(result.status).toBe('error');
    expect(result.reason).toContain('#83');
    expect(result.order_state).toBeNull();
    expect(broker.calls).toHaveLength(0);
    expect(store.positions.size).toBe(0);
  });
});
