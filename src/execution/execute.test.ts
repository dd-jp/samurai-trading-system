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

/** One `cancel` call, recorded verbatim for assertion. */
interface CancelCall {
  clientOrderId: string;
  instrument: string;
}

/** Accepts everything and records what it was handed. */
function makeBroker(
  onSubmit?: (order: NativeBracketRequest) => void | Promise<void>,
  onFlatten?: (call: FlattenCall) => void | Promise<void>,
  onCancel?: (call: CancelCall) => void | Promise<void>,
): BrokerAdapter & {
  calls: NativeBracketRequest[];
  flattenCalls: FlattenCall[];
  cancelCalls: CancelCall[];
  /** Every submitBracket/submitFlatten/cancel call, in call order — the PR #516 review's ordering property (cancel-before-flatten) is otherwise unobservable from the three arrays alone. */
  callSequence: string[];
} {
  const calls: NativeBracketRequest[] = [];
  // Kept separate from `calls` (NativeBracketRequest[]): several existing
  // tests assert `broker.calls` has length 0 to mean "no bracket submitted",
  // and a flatten is not a bracket — folding it in would make those
  // assertions pass for the wrong reason.
  const flattenCalls: FlattenCall[] = [];
  const cancelCalls: CancelCall[] = [];
  const callSequence: string[] = [];
  return {
    calls,
    flattenCalls,
    cancelCalls,
    callSequence,
    async submitBracket(order: NativeBracketRequest): Promise<BrokerAck> {
      calls.push(order);
      callSequence.push(`submitBracket:${order.client_order_id}`);
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
      callSequence.push(`submitFlatten:${clientOrderId}`);
      await onFlatten?.(call);
      return {
        client_order_id: clientOrderId,
        broker_order_ids: [`${clientOrderId}:flatten`],
        order_state: 'submitted',
      };
    },
    // PR #516 review (comment 1): the exit path now genuinely calls this,
    // to clear a held lot's stop/target legs before flattening — resolves
    // rather than throwing, mirroring the production adapters' own
    // idempotent-cancel contract (types/broker.ts).
    async cancel(clientOrderId: string, instrument: string): Promise<void> {
      const call = { clientOrderId, instrument };
      cancelCalls.push(call);
      callSequence.push(`cancel:${clientOrderId}`);
      await onCancel?.(call);
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

  describe('exit intent (#508, hardened by PR #516 review)', () => {
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

    /**
     * Seeds a filled entry lot the exit above closes — `executeExit`'s store
     * cross-check (review comment 3) refuses an exit with nothing to
     * validate against, so every test that expects the flatten to actually
     * be attempted needs one of these first. Side `'buy'`, `filled_size 40`,
     * matching `makeExitGo`'s default `side: 'sell'`/`size: 40`.
     */
    async function seedHeldLot(
      store: ReturnType<typeof openTestExecutionStore>['store'],
      overrides: Partial<OpenPosition> = {},
    ): Promise<void> {
      await store.writeAheadPosition({
        idempotency_key: 'key-aapl-entry-1',
        debate_id: 'debate-abc123',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'buy',
        intent_type: 'entry',
        requested_size: 40,
        filled_size: 40,
        avg_entry_price: 95,
        stop: 90,
        target: 110,
        order_state: 'filled',
        broker_order_ids: ['seed:entry', 'seed:stop', 'seed:target'],
        opened_at: NOW,
        decision_timestamp: NOW,
        conviction: 0.7,
        converged: true,
        ...overrides,
      });
    }

    it('cancels the held lot, then routes to submitFlatten with the instrument, closing side, held size and idempotency key', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      // Review comment 1: the held lot's bracket is cancelled BEFORE the
      // flatten, so a resting stop/target leg cannot fire into the
      // now-flat position.
      expect(broker.cancelCalls).toEqual([
        { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
      ]);
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
      expect(broker.callSequence).toEqual([
        'cancel:key-aapl-entry-1',
        'submitFlatten:key-aapl-1355',
      ]);
      // No bracket path touched.
      expect(broker.calls).toHaveLength(0);
    });

    it('returns a submission ack, not an error', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

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
    // so execute() must never write a NEW `open_positions` row for the
    // flatten itself — only the seeded lot (unwritten-to by the exit) may
    // be there. The flatten gets its OWN durable record instead, in
    // `flatten_submissions` (review comments 2+4).
    it('writes no OpenPosition row for the flatten — only the flatten_submissions journal', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      // Exactly the one seeded lot — the exit added no second position row.
      expect(await store.countAllPositions()).toBe(1);
      expect(store.writeLog).not.toContain('write-ahead:key-aapl-1355');
      expect(await store.countAllFlattenSubmissions()).toBe(1);
    });

    // Review comments 2+4: the flatten is journalled BEFORE any broker call
    // (write-ahead, same shape as the bracket path's `writeAheadPosition`),
    // and resolved to 'submitted' once the venue acks — observed from
    // INSIDE the `submitFlatten` call itself, the same technique the
    // bracket path's "persists the pending record BEFORE calling the
    // broker" test above uses, so this fails if the ordering is ever
    // silently reversed.
    it('journals the flatten to flatten_submissions before calling the broker, and resolves it after the ack', async () => {
      const { store } = openTestExecutionStore();
      let stateAtFlattenCall: Awaited<ReturnType<typeof store.getFlattenSubmission>> = null;
      const broker = makeBroker(undefined, async () => {
        stateAtFlattenCall = await store.getFlattenSubmission('key-aapl-1355');
      });
      await seedHeldLot(store);

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      const captured = stateAtFlattenCall as Awaited<ReturnType<typeof store.getFlattenSubmission>>;
      expect(captured).not.toBeNull();
      expect(captured?.status).toBe('submitting');
      expect(captured?.instrument).toBe('AAPL');
      expect(captured?.side).toBe('sell');
      expect(captured?.size).toBe(40);

      const resolved = await store.getFlattenSubmission('key-aapl-1355');
      expect(resolved?.status).toBe('submitted');
      expect(resolved?.order_state).toBe('submitted');
      expect(resolved?.broker_order_ids).toBe(JSON.stringify(['key-aapl-1355:flatten']));

      expect(store.writeLog).toEqual([
        // The seed itself, from `writeAheadPosition`/`updatePositionState`
        // (`seedHeldLot` uses only the first).
        'write-ahead:key-aapl-entry-1',
        'write-ahead-flatten:key-aapl-1355',
        'resolve-flatten:key-aapl-1355:submitted',
      ]);
    });

    // Mirrors the bracket path's "leaves the pending record intact when the
    // broker call throws" — but the ambiguity here is genuine (the venue
    // MAY have seen the flatten before the response was lost), so the row
    // is left at 'submitting' for #86's reconcile, exactly as the bracket
    // path leaves its `pending` record on a `submitBracket` failure.
    it('reports an error with no order_state when submitFlatten throws, leaving the journal row at submitting', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, () => {
        throw new Error('venue rejected the flatten');
      });
      await seedHeldLot(store);

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(result.status).toBe('error');
      expect(result.reason).toBe('venue rejected the flatten');
      expect(result.order_state).toBeNull();
      expect(result.broker_order_ids).toBeNull();
      expect(await store.countAllPositions()).toBe(1); // just the seed
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('submitting');
      expect(row?.reason).toBeNull();
    });

    // Review comment 1's cancel-failure path — distinct from the case
    // above: this is NOT ambiguous (the flatten provably never reached the
    // broker), so the journal resolves to 'error' immediately, and
    // `submitFlatten` must never be called while it is unknown whether the
    // held lot's legs are actually gone.
    it('refuses without ever calling submitFlatten when cancelling the held lot fails, and resolves the journal row to error', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, undefined, () => {
        throw new Error('venue timeout on cancel');
      });
      await seedHeldLot(store);

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(result.status).toBe('error');
      expect(result.reason).toContain('key-aapl-entry-1');
      expect(result.reason).toContain('venue timeout on cancel');
      expect(broker.flattenCalls).toHaveLength(0);
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('error');
      expect(row?.reason).toContain('venue timeout on cancel');
    });

    // Review comment 2, exercised for real rather than via a stubbed gate:
    // the SAME exit decision replayed (crash-restart, retry) now dedupes
    // exactly like an entry does — `findByKey` sees the `flatten_submissions`
    // row the first call journalled, so the second call never reaches
    // `cancel` or `submitFlatten` at all.
    it('dedupes a replayed exit without touching the broker a second time', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);
      const execution = new ExecutionImpl(makeInput({ store, broker }));

      const first = await execution.execute(makeExitGo());
      const second = await execution.execute(makeExitGo());

      expect(first.status).toBe('submitted');
      expect(second.status).toBe('deduped');
      expect(second.reason).toBe('an order or fill already exists for this idempotency_key');
      expect(broker.cancelCalls).toHaveLength(1);
      expect(broker.flattenCalls).toHaveLength(1);
    });

    describe('store cross-check (review comment 3)', () => {
      it('refuses when the store holds no open lot for the instrument to close', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        // No seed: the store has nothing open for AAPL.

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

        expect(result.status).toBe('error');
        expect(result.reason).toContain('AAPL');
        expect(result.reason).toContain('no open lot');
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      it('refuses an exit sized differently than the held quantity, without clamping it', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store); // filled_size 40

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ size: 999 }),
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain('999');
        expect(result.reason).toContain('40');
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      it('refuses an exit whose side does not match the closing side implied by the held lot', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store); // side 'buy' -> closing side should be 'sell'

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ side: 'buy' }), // wrong: should be 'sell'
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain("'buy'");
        expect(result.reason).toContain("'sell'");
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });
    });

    // AC: "Exit submissions are covered against the simulated adapter,
    // including the case where the venue holds no matching position." This
    // is a VENUE-side condition, distinct from the store-side cross-check
    // above: the store is seeded realistically (as production always has
    // one, per the cross-check), but the Simulated adapter instance itself
    // has never seen a `submitBracket` call for this key, so its own
    // `accepted` book has no matching entry. `submitFlatten` never inspects
    // a position book — it prices and fills unconditionally
    // (simulated-adapter.ts) — so the flatten still acks.
    it('submits through the real SimulatedBrokerAdapter when the VENUE holds no matching position', async () => {
      const { store } = openTestExecutionStore();
      await seedHeldLot(store);
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

      // Nothing was ever submitted through THIS broker instance — no
      // matching position exists at the venue — yet the flatten still
      // acks, because `cancel()` on an unknown id resolves quietly
      // (idempotent by contract, types/broker.ts) and `submitFlatten`
      // never consults the venue's book either.
      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(result.broker_order_ids).toEqual(['key-aapl-1355:flatten']);
      expect(await store.countAllPositions()).toBe(1); // just the seed
    });
  });
});
