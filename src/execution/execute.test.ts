import type { CostModel } from '../cost-model-backtest/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, Fill, OpenPosition, OrderIntent } from '../shared/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { ExecutionImpl } from './execute.js';
import { SimulatedBrokerAdapter } from './simulated-adapter.js';
import { openTestExecutionStore, TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  NativeBracketRequest,
  NormalizedFill,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
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

/** One `rearmProtectiveLegs` call, recorded verbatim for assertion (#525). */
interface RearmCall {
  clientOrderId: string;
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  stop: number;
  target: number;
}

/** Accepts everything and records what it was handed. */
function makeBroker(
  onSubmit?: (order: NativeBracketRequest) => void | Promise<void>,
  onFlatten?: (call: FlattenCall) => void | Promise<void>,
  onCancel?: (call: CancelCall) => void | Promise<void>,
  onRearm?: (call: RearmCall) => void | Promise<void>,
): BrokerAdapter & {
  calls: NativeBracketRequest[];
  flattenCalls: FlattenCall[];
  cancelCalls: CancelCall[];
  rearmCalls: RearmCall[];
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
  const rearmCalls: RearmCall[] = [];
  const callSequence: string[] = [];
  return {
    calls,
    flattenCalls,
    cancelCalls,
    rearmCalls,
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
    // #525's re-arm path: recorded like `cancel`, resolving by default
    // (a successful re-arm) unless `onRearm` throws.
    async rearmProtectiveLegs(
      clientOrderId: string,
      instrument: string,
      side: 'buy' | 'sell',
      qty: number,
      stop: number,
      target: number,
    ): Promise<void> {
      const call = { clientOrderId, instrument, side, qty, stop, target };
      rearmCalls.push(call);
      callSequence.push(`rearm:${clientOrderId}`);
      await onRearm?.(call);
    },
    async getOpenPositions(): Promise<never> {
      throw new Error('makeBroker.getOpenPositions: execute() does not reconcile');
    },
  };
}

/** Records every alert posted (#525) — never posted for a SUCCESSFUL re-arm. */
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
    residualExposureAlerts: makeResidualExposureAlerts(),
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
      rearmProtectiveLegs: vi
        .fn()
        .mockRejectedValue(new Error('rearmProtectiveLegs: not part of execute()')),
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

    // #517: does a flatten-closed lot emit a correct `ClosedTrade` at all?
    // Unlike every test above, this one carries the lot through `ingestFills()`
    // too — `seedHeldLot` writes an `OpenPosition` row directly with no `Fill`
    // rows behind it, which is enough for `execute()`'s own cross-check but
    // NOT enough for `ingestFills()`: `advanceLot` (ingest-fills.ts) requires
    // an actual entry `Fill` row to size a lot before it can close one ("An
    // exit fill cannot precede the entry fill that created the lot"). So a
    // flatten-attribution test needs a lot that was actually FILLED through
    // this same pipeline, not a seeded position — which is exactly the gap
    // that let this issue go unnoticed: every prior exit test stopped at
    // `execute()`'s submission ack and never called `ingestFills()` at all.
    describe('flatten fill attribution (#517)', () => {
      function makeMarketData(): MarketDataService {
        return {
          getBars: vi.fn(),
          getMark: vi.fn().mockResolvedValue({
            price: 100,
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
      }

      const SIMULATED_CONFIG = {
        volatility_indicator: {
          indicator: 'atr' as const,
          params: { period: 14 },
          timeframe: '1h' as const,
          lookback: 15,
        },
        adv_window: { timeframe: '1d' as const, lookback: 20 },
      };

      const zeroCosts = () => ({ spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 });

      // AC #1's finding, established by running the FIRST assertion block of
      // the test below against pre-fix `ingest-fills.ts`/`execute.ts`: a
      // flatten-closed lot's `ClosedTrade` was `[]` (not wrong — ABSENT), the
      // lot stayed `filled` (never `closed`), and `getOpenPositions()` kept
      // reporting it forever. The flatten's fill DID land — the Simulated
      // adapter modelled it and `broker.fetchNewFills` reported it — but
      // `ingestFills()` only ever looked a fill up by matching
      // `client_order_id` against a LOT's own `idempotency_key`, and a
      // flatten submits under its own fresh key, so the fill was silently
      // dropped every poll, forever. See the PR body for the verbatim
      // pre-fix run. The test below now asserts the FIXED behaviour.
      it('attributes the flatten fill to the lot it closed and emits a correct ClosedTrade', async () => {
        const { store } = openTestExecutionStore();
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({
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
        const marketData = makeMarketData();
        const broker = new SimulatedBrokerAdapter({
          clock: fixedClock,
          costModel,
          marketData,
          config: SIMULATED_CONFIG,
        });
        const execution = new ExecutionImpl(
          makeInput({ store, broker, costModel, marketData, clock: fixedClock }),
        );

        await execution.execute(
          makeGo({
            idempotency_key: 'key-aapl-entry-1',
            size: 40,
            entry: 95,
            stop: 90,
            target: 110,
          }),
        );
        await execution.ingestFills();

        const exitResult = await execution.execute(makeExitGo({ size: 40 }));
        expect(exitResult.status).toBe('submitted');
        await execution.ingestFills();

        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(1);
        expect(closedTrades[0]).toMatchObject({
          // The LOT's own key, not the flatten's — the attribution this
          // ticket exists to fix.
          idempotency_key: 'key-aapl-entry-1',
          debate_id: 'debate-abc123',
          instrument: 'AAPL',
          side: 'buy',
          filled_size: 40,
          // The Simulated adapter's own raw fill is tagged `leg: 'entry'`
          // (it models a flatten as just another priced fill at submit
          // time) — `close_reason` reading 'exit' here, not 'entry', proves
          // `ingestFills()` overrode that tag rather than trusting it.
          close_reason: 'exit',
        });
        // gross = (99.5 - 95) * 40 = 180; fees = 0 (entry) + 0.2 (flatten commission).
        expect(closedTrades[0].realized_pnl_net).toBeCloseTo(180 - 0.2, 6);
        expect(closedTrades[0].fees_total).toBeCloseTo(0.2, 6);

        expect((await store.getPosition('key-aapl-entry-1'))?.order_state).toBe('closed');
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

      it('is idempotent across repeated polls of the same flatten fill', async () => {
        const { store } = openTestExecutionStore();
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({
              fill_price: 99.5,
              filled_size: 40,
              cost_breakdown: zeroCosts(),
            }),
        };
        const marketData = makeMarketData();
        const broker = new SimulatedBrokerAdapter({
          clock: fixedClock,
          costModel,
          marketData,
          config: SIMULATED_CONFIG,
        });
        const execution = new ExecutionImpl(
          makeInput({ store, broker, costModel, marketData, clock: fixedClock }),
        );

        await execution.execute(
          makeGo({
            idempotency_key: 'key-aapl-entry-1',
            size: 40,
            entry: 95,
            stop: 90,
            target: 110,
          }),
        );
        await execution.ingestFills();
        await execution.execute(makeExitGo({ size: 40 }));

        await execution.ingestFills();
        // A second poll re-offers the SAME flatten fill (the Simulated
        // adapter's `fetchNewFills` is inclusive of `since`, by contract) —
        // it must dedupe, not close the same lot twice or double-count PnL.
        await execution.ingestFills();

        expect(await store.getClosedTrades()).toHaveLength(1);
        expect(closedTradesRealizedPnl(await store.getClosedTrades())).toBeCloseTo(
          (99.5 - 95) * 40,
          6,
        );
      });

      it('FIFO-allocates a single flatten fill across two lots on the same instrument, closing the oldest first', async () => {
        const { store } = openTestExecutionStore();
        let now = NOW;
        const steppingClock: Clock = { now: () => now };
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() }) // lot 1 entry
            .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() }) // lot 2 entry
            .mockReturnValueOnce({ fill_price: 100, filled_size: 25, cost_breakdown: zeroCosts() }), // flatten, covers both
        };
        const marketData = makeMarketData();
        const broker = new SimulatedBrokerAdapter({
          clock: steppingClock,
          costModel,
          marketData,
          config: SIMULATED_CONFIG,
        });
        const execution = new ExecutionImpl(
          makeInput({ store, broker, costModel, marketData, clock: steppingClock }),
        );

        await execution.execute(
          makeGo({ idempotency_key: 'key-lot-1', size: 10, entry: 90, stop: 85, target: 110 }),
        );
        await execution.ingestFills();
        now = new Date(now.getTime() + 60_000); // lot 2 opens a minute after lot 1.
        await execution.execute(
          makeGo({
            idempotency_key: 'key-lot-2',
            intent_type: 'scale_in',
            size: 15,
            entry: 92,
            stop: 85,
            target: 110,
          }),
        );
        await execution.ingestFills();
        now = new Date(now.getTime() + 60_000);

        const exitResult = await execution.execute(makeExitGo({ size: 25 }));
        expect(exitResult.status).toBe('submitted');
        await execution.ingestFills();

        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(2);
        const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));
        expect(byKey.get('key-lot-1')).toMatchObject({ filled_size: 10, close_reason: 'exit' });
        expect(byKey.get('key-lot-2')).toMatchObject({ filled_size: 15, close_reason: 'exit' });
        // Each lot's PnL against its OWN entry price, not a blended average —
        // proof the FIFO split, not a pro-rata one, drove the allocation.
        expect(byKey.get('key-lot-1')?.realized_pnl_net).toBeCloseTo((100 - 90) * 10, 6);
        expect(byKey.get('key-lot-2')?.realized_pnl_net).toBeCloseTo((100 - 92) * 15, 6);
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

      // Guards the fix's own correctness, not just its intent: an EARLIER
      // version of `redistributeFlattenFills` seeded each lot's share from
      // its PRIOR EXIT fills and filtered to lots still open in the CURRENT
      // poll's `positions` — both of which change between polls as fills get
      // persisted and lots go terminal. That made the split for a
      // still-partial lot drift poll to poll, and because `hasFill` dedupes
      // on `broker_fill_id` alone, a SECOND, differently-sized attempt under
      // the same derived id did not correct the first — it silently vanished
      // behind it, stranding the lot's true remainder forever. The fix seeds
      // from persisted ENTRY fills (fixed once filling stops) and never
      // filters by "still open", so the split is identical every poll and
      // dedupes cleanly instead.
      it('gives a partially-filled multi-lot flatten a stable split across repeated polls, closing what it can and leaving the rest genuinely open', async () => {
        const { store } = openTestExecutionStore();
        let now = NOW;
        const steppingClock: Clock = { now: () => now };
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() }) // lot 1 entry
            .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() }) // lot 2 entry
            // The flatten asked for 25 (10 + 15) but the IOC only fills 20 —
            // a thin book taking part of the order and cancelling the rest.
            .mockReturnValueOnce({ fill_price: 100, filled_size: 20, cost_breakdown: zeroCosts() }),
        };
        const marketData = makeMarketData();
        const broker = new SimulatedBrokerAdapter({
          clock: steppingClock,
          costModel,
          marketData,
          config: SIMULATED_CONFIG,
        });
        const execution = new ExecutionImpl(
          makeInput({ store, broker, costModel, marketData, clock: steppingClock }),
        );

        await execution.execute(
          makeGo({ idempotency_key: 'key-lot-1', size: 10, entry: 90, stop: 85, target: 110 }),
        );
        await execution.ingestFills();
        now = new Date(now.getTime() + 60_000);
        await execution.execute(
          makeGo({
            idempotency_key: 'key-lot-2',
            intent_type: 'scale_in',
            size: 15,
            entry: 92,
            stop: 85,
            target: 110,
          }),
        );
        await execution.ingestFills();
        now = new Date(now.getTime() + 60_000);

        await execution.execute(makeExitGo({ size: 25 }));
        // Polled three times: the Simulated adapter's `fetchNewFills` is
        // unconditional (re-offers the same historical fill every call), so
        // this exercises exactly the repeat-poll path the fix above targets.
        await execution.ingestFills();
        await execution.ingestFills();
        await execution.ingestFills();

        // Lot 1's full 10-share is covered by the 20 that filled — closes.
        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(1);
        expect(closedTrades[0]).toMatchObject({ idempotency_key: 'key-lot-1', filled_size: 10 });

        // Lot 2 gets its FIFO remainder of the 20 (10, after lot 1's 10) —
        // 5 short of its own 15 need, so it stays open, not silently
        // dropped and not double-counted by the repeat polls above.
        const lot2 = await store.getPosition('key-lot-2');
        expect(lot2?.order_state).toBe('filled'); // entry complete; exit is not
        const lot2ExitQty = (await store.getFills('key-lot-2'))
          .filter((fill) => fill.leg === 'exit')
          .reduce((sum, fill) => sum + fill.qty, 0);
        expect(lot2ExitQty).toBe(10);
        expect(await store.getOpenPositions()).toHaveLength(1);
      });

      describe('residual re-arm on a partial flatten (#525)', () => {
        it('re-arms the residual through the real cancel-then-flatten path', async () => {
          const { store } = openTestExecutionStore();
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
              // The flatten asks for 40 but a thin book only fills 25 — a
              // naked residual of 15 if nothing re-arms it.
              .mockReturnValueOnce({
                fill_price: 99,
                filled_size: 25,
                cost_breakdown: zeroCosts(),
              }),
          };
          const marketData = makeMarketData();
          const broker = new SimulatedBrokerAdapter({
            clock: fixedClock,
            costModel,
            marketData,
            config: SIMULATED_CONFIG,
          });
          const residualExposureAlerts = makeResidualExposureAlerts();
          const execution = new ExecutionImpl(
            makeInput({
              store,
              broker,
              costModel,
              marketData,
              clock: fixedClock,
              residualExposureAlerts,
            }),
          );

          await execution.execute(
            makeGo({
              idempotency_key: 'key-aapl-entry-1',
              size: 40,
              entry: 95,
              stop: 90,
              target: 110,
            }),
          );
          await execution.ingestFills();
          // Legs armed at entry-fill time, before any flatten — `cancel()`
          // (inside `executeExit`, below) is what removes them.
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(40);

          const exitResult = await execution.execute(makeExitGo({ size: 40 }));
          expect(exitResult.status).toBe('submitted');
          await execution.ingestFills();

          // The lot is genuinely still open — not closed, not silently
          // dropped — and its remaining 15 (40 - 25) carries fresh protection
          // at the SAME stop/target the original bracket used (95's stop is
          // 90, target 110 — `makeGo`'s own fixture above).
          expect(await store.getOpenPositions()).toHaveLength(1);
          expect(await store.getClosedTrades()).toHaveLength(0);
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(15);
          // No alert on a SUCCESSFUL re-arm — the decision comment on #525
          // is explicit that the alert is the fallback, not the primary
          // mechanism.
          expect(residualExposureAlerts.alerts).toEqual([]);
        });

        it('re-arms a sibling lot that got ZERO share of a partial flatten fill', async () => {
          // The flatten names two lots (FIFO order: lot 1 then lot 2), but the
          // venue fills LESS than lot 1's own share — lot 2 gets no new Fill
          // row at all this poll, yet its legs were cancelled by the SAME
          // `executeExit` call that cancelled lot 1's. `redistributeFlattenFills`'
          // returned lot-key set (#525) is what makes this lot's re-arm run
          // despite it having no new fill to trigger the ordinary path.
          const { store } = openTestExecutionStore();
          let now = NOW;
          const steppingClock: Clock = { now: () => now };
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() }) // lot 1 entry
              .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() }) // lot 2 entry
              // The flatten asks for 25 (10 + 15) but only 7 fills — less
              // than even lot 1's own 10-share, so lot 2 gets nothing.
              .mockReturnValueOnce({
                fill_price: 100,
                filled_size: 7,
                cost_breakdown: zeroCosts(),
              }),
          };
          const marketData = makeMarketData();
          const broker = new SimulatedBrokerAdapter({
            clock: steppingClock,
            costModel,
            marketData,
            config: SIMULATED_CONFIG,
          });
          const residualExposureAlerts = makeResidualExposureAlerts();
          const execution = new ExecutionImpl(
            makeInput({
              store,
              broker,
              costModel,
              marketData,
              clock: steppingClock,
              residualExposureAlerts,
            }),
          );

          await execution.execute(
            makeGo({ idempotency_key: 'key-lot-1', size: 10, entry: 90, stop: 85, target: 110 }),
          );
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);
          await execution.execute(
            makeGo({
              idempotency_key: 'key-lot-2',
              intent_type: 'scale_in',
              size: 15,
              entry: 92,
              stop: 85,
              target: 110,
            }),
          );
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);

          await execution.execute(makeExitGo({ size: 25 }));
          await execution.ingestFills();

          // Lot 1: 7 of its 10-share filled, 3 left — re-armed to 3.
          expect(broker.getProtectedQty('key-lot-1')).toBe(3);
          // Lot 2: ZERO share this poll — re-armed to its FULL original 15,
          // not left at `null` (unprotected) the way `cancel()` alone would
          // leave it.
          expect(broker.getProtectedQty('key-lot-2')).toBe(15);
          expect(await store.getOpenPositions()).toHaveLength(2);
          expect(await store.getClosedTrades()).toHaveLength(0);
          // Both re-arms succeeded — no alert.
          expect(residualExposureAlerts.alerts).toEqual([]);
        });

        it(
          "one lot's re-arm store-read failure alerts for that lot alone and does not abort " +
            'ingestion for the OTHER lots in the same poll (#569)',
          async () => {
            // `maybeRearmResidual`'s doc claims "Never throws" — but on the
            // zero-new-fill/`known === undefined` path (a flatten-named
            // sibling that got ZERO share of this poll's fill), the store
            // read that recomputes `filledSize`/`exitQty` sat OUTSIDE any
            // `try`. A rejection there propagated out of `advanceLot` and
            // out of `ingestFills`'s per-position loop, aborting every OTHER
            // lot the same poll had yet to reach — reproduced here with a
            // THIRD lot (`key-lot-3`) that has a genuine new entry fill
            // waiting in the SAME poll, positioned after the flaky one in
            // `getOpenPositions()`'s `opened_at` order.
            class FlakyGetFillsStore extends TestExecutionStore {
              /** Only throws once armed — lot 2's OWN entry-fill poll must still succeed. */
              armed = false;
              override async getFills(idempotency_key: string): Promise<Fill[]> {
                if (this.armed && idempotency_key === 'key-lot-2') {
                  throw new Error('simulated store outage on getFills');
                }
                return super.getFills(idempotency_key);
              }
            }

            const { db } = openTestExecutionStore();
            const store = new FlakyGetFillsStore(db);
            let now = NOW;
            const steppingClock: Clock = { now: () => now };
            const costModel: CostModel = {
              fill: vi
                .fn()
                .mockReturnValueOnce({
                  fill_price: 90,
                  filled_size: 10,
                  cost_breakdown: zeroCosts(),
                }) // lot 1 entry
                .mockReturnValueOnce({
                  fill_price: 92,
                  filled_size: 15,
                  cost_breakdown: zeroCosts(),
                }) // lot 2 entry
                .mockReturnValueOnce({
                  fill_price: 94,
                  filled_size: 8,
                  cost_breakdown: zeroCosts(),
                }) // lot 3 entry
                // Same shape as the ZERO-share-sibling test above: less than
                // even lot 1's own 10-share, so lot 2 gets nothing.
                .mockReturnValueOnce({
                  fill_price: 100,
                  filled_size: 7,
                  cost_breakdown: zeroCosts(),
                }),
            };
            const marketData = makeMarketData();
            const broker = new SimulatedBrokerAdapter({
              clock: steppingClock,
              costModel,
              marketData,
              config: SIMULATED_CONFIG,
            });
            const residualExposureAlerts = makeResidualExposureAlerts();
            const execution = new ExecutionImpl(
              makeInput({
                store,
                broker,
                costModel,
                marketData,
                clock: steppingClock,
                residualExposureAlerts,
              }),
            );

            await execution.execute(
              makeGo({ idempotency_key: 'key-lot-1', size: 10, entry: 90, stop: 85, target: 110 }),
            );
            await execution.ingestFills();
            now = new Date(now.getTime() + 60_000);
            await execution.execute(
              makeGo({
                idempotency_key: 'key-lot-2',
                intent_type: 'scale_in',
                size: 15,
                entry: 92,
                stop: 85,
                target: 110,
              }),
            );
            await execution.ingestFills();
            now = new Date(now.getTime() + 60_000);
            await execution.execute(
              makeGo({
                idempotency_key: 'key-lot-3',
                intent_type: 'scale_in',
                size: 8,
                entry: 94,
                stop: 85,
                target: 110,
              }),
            );
            // Deliberately NOT ingested yet — lot 3's entry fill stays fresh
            // for the SAME poll the flatten resolves in, below.
            now = new Date(now.getTime() + 60_000);

            await execution.execute(makeExitGo({ size: 25 }));
            store.armed = true;

            await expect(execution.ingestFills()).resolves.toBeUndefined();

            // Lot 1, iterated BEFORE the flaky lot: unaffected either way —
            // re-armed to its 3 residual exactly as the zero-share-sibling
            // test above.
            expect(broker.getProtectedQty('key-lot-1')).toBe(3);

            // Lot 2: the store read failed, so there is no residual figure to
            // re-arm with — never armed, and the fallback alert fires with
            // its full requested size (15) as a conservative upper bound,
            // not a guess at the true, unknowable residual.
            expect(broker.getProtectedQty('key-lot-2')).toBeNull();
            expect(residualExposureAlerts.alerts).toEqual([
              {
                idempotency_key: 'key-lot-2',
                instrument: 'AAPL',
                side: 'buy',
                residual_qty: 15,
                stop: 85,
                target: 110,
                observed_at: now,
              },
            ]);

            // Lot 3, iterated AFTER the flaky lot: THIS is the regression the
            // unguarded read caused — its entry fill must still be ingested
            // in the SAME poll despite lot 2's read failing first.
            const lot3 = await store.getPosition('key-lot-3');
            expect(lot3?.filled_size).toBe(8);
            expect(lot3?.order_state).toBe('filled');
          },
        );
      });
    });
  });
});

function closedTradesRealizedPnl(trades: readonly { realized_pnl_net: number }[]): number {
  return trades.reduce((sum, trade) => sum + trade.realized_pnl_net, 0);
}
