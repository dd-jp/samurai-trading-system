import type { CostModel } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../shared/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ExecutionImpl } from './execute.js';
import { SimulatedBrokerAdapter } from './simulated-adapter.js';
import { openTestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
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

/** One `submitFlatten` call, recorded verbatim for assertion. */
interface FlattenCall {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;
  clientOrderId: string;
}

/** Accepts everything and records what it was handed. */
function makeBroker(
  onSubmit?: (order: NativeBracketRequest) => void | Promise<void>,
  onFlatten?: (call: FlattenCall) => void | Promise<void>,
): BrokerAdapter & { calls: NativeBracketRequest[]; flattenCalls: FlattenCall[] } {
  const calls: NativeBracketRequest[] = [];
  // Kept separate from `calls` (NativeBracketRequest[]): several existing
  // tests assert `broker.calls` has length 0 to mean "no bracket submitted",
  // and a flatten is not a bracket — folding it in would make those
  // assertions pass for the wrong reason.
  const flattenCalls: FlattenCall[] = [];
  return {
    calls,
    flattenCalls,
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
    // Throws rather than returning null: the port documents null as
    // "AUTHORITATIVELY never placed", which `reconcile` acts on by marking the
    // lot `rejected`. A stub that answered null would make this double lie in
    // exactly the direction that buries a live position. `execute()` never
    // calls it, so reaching this is itself the bug.
    async getOrder(): Promise<never> {
      throw new Error('makeBroker.getOrder: execute() does not reconcile');
    },
    // #508's exit path: recorded like `submitBracket`, mirroring its ack shape
    // (client_order_id + broker_order_ids + order_state) rather than throwing,
    // since `execute()` now genuinely reaches for this on an `exit` intent.
    async submitFlatten(
      instrument: string,
      side: 'buy' | 'sell',
      size: number,
      clientOrderId: string,
    ): Promise<BrokerAck> {
      const call = { instrument, side, size, clientOrderId };
      flattenCalls.push(call);
      await onFlatten?.(call);
      return {
        client_order_id: clientOrderId,
        broker_order_ids: [`${clientOrderId}:flatten`],
        order_state: 'submitted',
      };
    },
    async cancel(): Promise<never> {
      throw new Error('makeBroker.cancel: execute() does not cancel');
    },
    async getOpenPositions(): Promise<never> {
      throw new Error('makeBroker.getOpenPositions: execute() does not reconcile');
    },
  };
}

function makeInput(overrides: Partial<ExecutionInput> = {}): ExecutionInput {
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
    trace_id: 'trace-1',
    clock: fixedClock,
    broker: makeBroker(),
    store: openTestExecutionStore().store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'backtest',
    ...overrides,
  };
}

describe('ExecutionImpl.execute', () => {
  it('expands the bracket, write-aheads, submits, and returns submitted', async () => {
    const { store } = openTestExecutionStore();
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
    const { store } = openTestExecutionStore();
    let stateAtSubmit: OpenPosition | null = null;
    const broker = makeBroker(async () => {
      stateAtSubmit = await store.getPosition('key-aapl-1355');
    });

    await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    // Re-widened deliberately. `stateAtSubmit` is only ever assigned inside
    // the broker callback, which the compiler cannot order relative to this
    // read, so its control-flow analysis still holds the initialiser's `null`
    // and `stateAtSubmit?.order_state` narrows to `never`. The runtime value
    // is the position captured mid-submit; the assertion below is what proves
    // it.
    const captured = stateAtSubmit as OpenPosition | null;

    expect(captured).not.toBeNull();
    expect(captured?.order_state).toBe('pending');
    expect(store.writeLog).toEqual(['write-ahead:key-aapl-1355', 'update:key-aapl-1355:submitted']);
  });

  it('write-aheads the lot with the fields downstream binds', async () => {
    const { store } = openTestExecutionStore();
    let stateAtSubmit: OpenPosition | null = null;
    const broker = makeBroker(async () => {
      stateAtSubmit = await store.getPosition('key-aapl-1355');
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
      conviction: 0.72,
      converged: true,
    });
  });

  it('persists the broker ack state after submit', async () => {
    const { store } = openTestExecutionStore();
    await new ExecutionImpl(makeInput({ store })).execute(makeGo());

    expect(await store.getPosition('key-aapl-1355')).toMatchObject({
      order_state: 'submitted',
      broker_order_ids: ['key-aapl-1355:entry', 'key-aapl-1355:stop'],
    });
  });

  // TOCTOU tail of the findByKey gate: a concurrent execute() for the same
  // key can pass the gate before this one's write-ahead lands. The loser of
  // the PK race must come back `deduped`, not throw.
  it('returns deduped when a concurrent execute() wins the write-ahead race', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    // Simulate the interleaving: findByKey says "free" the first time, then a
    // rival's write-ahead lands before ours does.
    let firstCheck = true;
    const racingStore: typeof store = Object.create(store);
    racingStore.findByKey = async (key: string) => {
      if (firstCheck) {
        firstCheck = false;
        await store.writeAheadPosition({
          ...makeIntent(),
          idempotency_key: key,
          debate_id: 'debate-abc123',
          requested_size: 100,
          filled_size: 0,
          avg_entry_price: 0,
          order_state: 'pending',
          broker_order_ids: [],
          opened_at: NOW,
          conviction: 0.72,
          converged: true,
          intent_type: 'entry',
        } as OpenPosition);
        return false;
      }
      return store.findByKey(key);
    };

    const result = await new ExecutionImpl(makeInput({ store: racingStore, broker })).execute(
      makeGo(),
    );

    expect(result.status).toBe('deduped');
    expect(result.reason).toContain('already exists for this idempotency_key');
    expect(broker.calls).toHaveLength(0);
  });

  // Only a constraint collision means "a rival got there first". A write that
  // failed for any other reason (disk full, SQLITE_BUSY) must surface — a
  // `deduped` there would tell the caller an order is already live when
  // nothing was persisted and nothing was sent (PR #290 review, deepseek).
  it('rethrows a non-constraint write-ahead failure instead of reporting deduped', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    const failingStore: typeof store = Object.create(store);
    failingStore.writeAheadPosition = async () => {
      throw new Error('database or disk is full');
    };
    // Free at the gate, present by the time the catch re-checks — the shape
    // the old row-existence-only catch would have swallowed as `deduped`.
    let firstCheck = true;
    failingStore.findByKey = async () => {
      if (firstCheck) {
        firstCheck = false;
        return false;
      }
      return true;
    };

    await expect(
      new ExecutionImpl(makeInput({ store: failingStore, broker })).execute(makeGo()),
    ).rejects.toThrow('database or disk is full');
    expect(broker.calls).toHaveLength(0);
  });

  // AC: "Duplicate execute() calls with the same idempotency_key produce
  // exactly one submission."
  it('dedupes a repeat of the same key without touching the broker', async () => {
    const { store } = openTestExecutionStore();
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

  // The `findByKey` gate is check-then-act: two concurrent calls both read
  // "absent" before either writes, so the primary key — not the gate — is what
  // decides the race. The loser must land on `deduped`, not on an unhandled
  // constraint violation escaping execute().
  it('dedupes the loser of a concurrent race on the same key', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    const [first, second] = await Promise.all([
      execution.execute(makeGo()),
      execution.execute(makeGo()),
    ]);

    expect([first?.status, second?.status].sort()).toEqual(['deduped', 'submitted']);
    // Pins WHICH layer deduped: two write-ahead attempts means both calls got
    // past `findByKey` and the primary key settled it. Without this the test
    // would pass just as happily if the gate had caught the second call,
    // silently stopping short of the branch it exists to cover.
    expect(store.writeLog.filter((entry) => entry.startsWith('write-ahead')).length).toBe(2);
    const deduped = first?.status === 'deduped' ? first : second;
    expect(deduped?.reason).toBe('an order or fill already exists for this idempotency_key');
    expect(deduped?.broker_order_ids).toBeNull();
    // The whole point: the race cost the venue nothing and the store one row.
    expect(broker.calls).toHaveLength(1);
    expect(await store.countAllPositions()).toBe(1);
  });

  it('rethrows a write-ahead failure that is not a duplicate key', async () => {
    // A store that could not write has NOT written; reporting that as dedup
    // would claim a durable record that does not exist, and the lot would
    // reach the broker with nothing behind it to reconcile.
    const { store } = openTestExecutionStore();
    vi.spyOn(store, 'writeAheadPosition').mockRejectedValue(new Error('disk full'));
    const broker = makeBroker();

    await expect(new ExecutionImpl(makeInput({ store, broker })).execute(makeGo())).rejects.toThrow(
      'disk full',
    );
    expect(broker.calls).toHaveLength(0);
  });

  // AC: "submit-N-times yields exactly one fill" — at this seam, exactly one
  // submission reaches the broker, which is what makes exactly one fill
  // possible downstream.
  it('submits exactly once across N replays of the same decision', async () => {
    const { store } = openTestExecutionStore();
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
    expect(await store.countAllPositions()).toBe(1);
  });

  it('treats a different instrument/bar as a separate decision', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    await execution.execute(makeGo());
    const other = await execution.execute(
      makeGo({ idempotency_key: 'key-btc-1400', instrument: 'BTC-USD', asset_class: 'crypto' }),
    );

    expect(other.status).toBe('submitted');
    expect(broker.calls).toHaveLength(2);
    expect(await store.countAllPositions()).toBe(2);
  });

  it('leaves the pending record intact when the broker call throws', async () => {
    const { store } = openTestExecutionStore();
    const broker: BrokerAdapter = {
      submitBracket: vi.fn().mockRejectedValue(new Error('connection reset')),
      fetchNewFills: vi.fn().mockResolvedValue([]),
      resizeProtectiveLegs: vi.fn().mockResolvedValue(undefined),
      // See `makeBroker`: never null, and never reached on this path.
      getOrder: vi.fn().mockRejectedValue(new Error('getOrder: not part of execute()')),
      submitFlatten: vi.fn().mockRejectedValue(new Error('submitFlatten: not part of execute()')),
      cancel: vi.fn().mockRejectedValue(new Error('cancel: not part of execute()')),
      getOpenPositions: vi
        .fn()
        .mockRejectedValue(new Error('getOpenPositions: not part of execute()')),
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(result.status).toBe('error');
    expect(result.reason).toBe('connection reset');
    expect(result.broker_order_ids).toBeNull();
    // Whether the bracket landed is unknowable here — only the broker can
    // settle it, so the record stays `pending` for #86 to reconcile rather
    // than being guessed terminal.
    expect(result.order_state).toBe('pending');
    expect((await store.getPosition('key-aapl-1355'))?.order_state).toBe('pending');
  });

  it('does not act on a no_go', async () => {
    const { store } = openTestExecutionStore();
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
    expect(await store.countAllPositions()).toBe(0);
  });

  it('routes scale_in through the bracket path as its own lot', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
      makeGo({ intent_type: 'scale_in' }),
    );

    expect(result.status).toBe('submitted');
    expect((await store.getPosition('key-aapl-1355'))?.intent_type).toBe('scale_in');
  });

  describe('exit intent (#508)', () => {
    /** A closing sell of the held quantity — `buildExitIntent` (trader/decide.ts) shape. */
    function makeExitGo(overrides: Partial<OrderIntent> = {}): VerdictDecision {
      return makeGo({
        intent_type: 'exit',
        side: 'sell',
        size: 40,
        // An exit's stop/target are degenerate (equal to entry) — #83's
        // flatten lifecycle does not consult them (decide.ts comment above
        // `buildExitIntent`).
        entry: 100,
        stop: 100,
        target: 100,
        ...overrides,
      });
    }

    it('routes to submitFlatten with the instrument, closing side, held size and idempotency key', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(broker.flattenCalls).toEqual([
        {
          instrument: 'AAPL',
          // The CLOSING side, carried straight through — `side` on the
          // exit intent is already the closing side (decide.ts's
          // `buildExitIntent`), so this must not be inverted here.
          side: 'sell',
          // The HELD quantity, not a risk-fraction size: `order.size` is
          // already `buildExitIntent`'s sum of filled_size across the
          // instrument's open lots, so execute() passes it through as-is.
          size: 40,
          clientOrderId: 'key-aapl-1355',
        },
      ]);
      // No bracket path touched.
      expect(broker.calls).toHaveLength(0);
    });

    it('returns a submission ack, not an error', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(result.idempotency_key).toBe('key-aapl-1355');
      expect(result.broker_order_ids).toEqual(['key-aapl-1355:flatten']);
      expect(result.order_state).toBe('submitted');
      expect(result.reason).toBeNull();
    });

    // AC: "No half-written bracket state for a flatten." An exit closes an
    // existing lot; `OpenPosition.intent_type` deliberately excludes 'exit'
    // (shared/types/records.ts: "exits close a lot; they never create one"),
    // so execute() must reach the broker without ever calling
    // `writeAheadPosition`.
    it('writes no OpenPosition row for the flatten — there is no bracket to journal', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(await store.countAllPositions()).toBe(0);
      expect(store.writeLog).toEqual([]);
    });

    // Mirrors the bracket path's "leaves the pending record intact when the
    // broker call throws" — but an exit has no pending record to leave
    // behind, so the honest report is `order_state: null`, not a fabricated
    // 'pending'.
    it('reports an error with no order_state when submitFlatten throws', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, () => {
        throw new Error('venue rejected the flatten');
      });

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(result.status).toBe('error');
      expect(result.reason).toBe('venue rejected the flatten');
      expect(result.order_state).toBeNull();
      expect(result.broker_order_ids).toBeNull();
      expect(await store.countAllPositions()).toBe(0);
    });

    // The `findByKey` gate (dedup layer 1) sits ahead of the intent_type
    // branch, so an exit is checked by the SAME gate an entry/scale_in is —
    // this proves the gate is shared and ordered ahead of the branch, NOT
    // that a real exit replay trips it: production never writes a store row
    // under an exit's idempotency_key, so nothing populates this gate for a
    // genuine replay. See the `intent_type === 'exit'` branch in execute.ts
    // for what backstops a real replay instead (dedup layer 2).
    it('shares dedup layer 1 with the bracket path: a hit before the broker skips submitFlatten', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      const keyPresentStore: typeof store = Object.create(store);
      keyPresentStore.findByKey = async () => true;

      const result = await new ExecutionImpl(makeInput({ store: keyPresentStore, broker })).execute(
        makeExitGo(),
      );

      expect(result.status).toBe('deduped');
      expect(broker.flattenCalls).toHaveLength(0);
    });

    // AC: "Exit submissions are covered against the simulated adapter,
    // including the case where the venue holds no matching position." The
    // Simulated adapter's `submitFlatten` never inspects a position book —
    // it prices and fills unconditionally (simulated-adapter.ts) — so an
    // exit with nothing held still gets a submission ack, exactly like a
    // live venue's plain market order would.
    it('submits through the real SimulatedBrokerAdapter with no matching position held', async () => {
      const { store } = openTestExecutionStore();
      const costModel: CostModel = {
        fill: vi.fn().mockReturnValue({
          fill_price: 99.5,
          filled_size: 40,
          cost_breakdown: {
            spread_cost: 0.1,
            commission: 0.2,
            slippage: 0.05,
            market_impact: 0.01,
          },
        }),
      };
      const marketData: MarketDataService = {
        getBars: vi.fn(),
        getMark: vi.fn().mockResolvedValue({
          price: 99.5,
          observed_at: NOW,
          source: 'fixture',
          asset_class: 'stocks',
        }),
        getIndicator: vi
          .fn()
          .mockResolvedValue({ indicator: 'atr', value: 2, as_of_bar_close: NOW }),
        getSpreadEstimate: vi.fn().mockResolvedValue(0.04),
        getADV: vi.fn().mockResolvedValue(1_000_000),
      } as unknown as MarketDataService;
      const broker = new SimulatedBrokerAdapter({
        clock: fixedClock,
        costModel,
        marketData,
        config: {
          volatility_indicator: {
            indicator: 'atr',
            params: { period: 14 },
            timeframe: '1h',
            lookback: 15,
          },
          adv_window: { timeframe: '1d', lookback: 20 },
        },
      });

      // Nothing was ever submitted through this broker — no matching
      // position exists at the venue — yet the flatten still acks.
      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(result.broker_order_ids).toEqual(['key-aapl-1355:flatten']);
      expect(await store.countAllPositions()).toBe(0);
    });
  });
});
