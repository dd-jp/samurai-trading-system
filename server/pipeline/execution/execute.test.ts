import type { MarketDataService, MarkRead } from '../../providers/market-data-service/index.js';
import type { Clock, Fill, OpenPosition, OrderIntent } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { CostModel } from '../../tools/backtest/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { sanitizeBrokerError } from './broker-error.js';

/**
 * A value `describeThrown` cannot render on its own: circular (defeats
 * `JSON.stringify`) with a throwing `Symbol.toPrimitive` (defeats the
 * `String()` fallback too) — #1262's hostile-throw fixture
 */
function hostileThrownValue(): Record<string, unknown> {
  const hostile: Record<string, unknown> = {
    [Symbol.toPrimitive]: () => {
      throw new Error('render boom');
    },
  };
  hostile.self = hostile;
  return hostile;
}

import type { TradingCalendar } from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import type { AssetClass } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { ExecutionImpl } from './execute.js';
import { FilledZeroSizeThrottle } from './filled-zero-size-throttle.js';
import { UNRESOLVABLE_FLATTEN_MAX_AGE_MS } from './reconcile.js';
import { SimulatedBrokerAdapter } from './simulated-adapter.js';
import { openTestExecutionStore, TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  FlattenOverfillAlertChannel,
  FlattenOverfillWarning,
  FlattenReconcileAlertChannel,
  NativeBracketRequest,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
} from './types.js';
import { UnrecordedVenuePositionThrottle } from './unrecorded-venue-position-throttle.js';

/**
 * #1214: `ExecutionInput.sessionCalendars`. An open venue for both classes —
 * `execute()` never reads it (only the ingest/sweep paths do), so this is
 * composition, not a knob any test here turns.
 */
const OPEN_SESSION_CALENDARS: Record<AssetClass, TradingCalendar> = {
  crypto: new AlwaysOpenCalendar(),
  stocks: new AlwaysOpenCalendar(),
};

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

/** One `submitFlatten` call, recorded verbatim for assertion */
interface FlattenCall {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;
  clientOrderId: string;
}

/** One `cancel` call, recorded verbatim for assertion */
interface CancelCall {
  clientOrderId: string;
  instrument: string;
}

/** One `rearmProtectiveLegs` call, recorded verbatim for assertion (#525) */
interface RearmCall {
  clientOrderId: string;
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  stop: number;
  target: number;
}

/** Accepts everything and records what it was handed */
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
  /** Every submitBracket/submitFlatten/cancel call, in call order — the PR #516 review's ordering property (cancel-before-flatten) is otherwise unobservable from the three arrays alone */
  callSequence: string[];
} {
  const calls: NativeBracketRequest[] = [];
  // Kept separate from `calls` (NativeBracketRequest[]): several existing
  // tests assert `broker.calls` has length 0 to mean "no bracket submitted",
  // and a flatten is not a bracket — folding it in would make those
  // assertions pass for the wrong reason
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
    // interface (#83) without behaviour these tests exercise
    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },
    async resizeProtectiveLegs(): Promise<void> {},
    // Throws rather than returning null: the port documents null as
    // "AUTHORITATIVELY never placed", which `reconcile` acts on by marking the
    // lot `rejected`. A stub that answered null would make this double lie in
    // exactly the direction that buries a live position. `execute()` never
    // calls it, so reaching this is itself the bug
    async getOrder(): Promise<never> {
      throw new Error('makeBroker.getOrder: execute() does not reconcile');
    },
    // #508's exit path: recorded like `submitBracket`, mirroring its ack shape
    // (client_order_id + broker_order_ids + order_state) rather than throwing,
    // since `execute()` now genuinely reaches for this on an `exit` intent
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
    // idempotent-cancel contract (types/broker.ts)
    async cancel(clientOrderId: string, instrument: string): Promise<void> {
      const call = { clientOrderId, instrument };
      cancelCalls.push(call);
      callSequence.push(`cancel:${clientOrderId}`);
      await onCancel?.(call);
    },
    // #525's re-arm path: recorded like `cancel`, resolving by default
    // (a successful re-arm) unless `onRearm` throws
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
    // #519/#526's reconcile-only surface — execute() never calls it
    async resumeFlatten(): Promise<never> {
      throw new Error('makeBroker.resumeFlatten: execute() does not reconcile');
    },
  };
}

/** Records every alert posted (#525) — never posted for a SUCCESSFUL re-arm */
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

/** Records every warning posted (#527) — never posted for a clean split */
function makeFlattenOverfillAlerts(): FlattenOverfillAlertChannel & {
  warnings: FlattenOverfillWarning[];
} {
  const warnings: FlattenOverfillWarning[] = [];
  return {
    warnings,
    async postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void> {
      warnings.push(warning);
    },
  };
}

/** Records every alert posted (#519) — never posted for a clean settle */
function makeFlattenReconcileAlerts(): FlattenReconcileAlertChannel {
  return {
    async postFlattenReconcileAlert(): Promise<void> {},
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
    sessionCalendars: OPEN_SESSION_CALENDARS,
    residualExposureAlerts: makeResidualExposureAlerts(),
    flattenOverfillAlerts: makeFlattenOverfillAlerts(),
    flattenReconcileAlerts: makeFlattenReconcileAlerts(),
    unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    // #573: `execute()` routes every failure it observes into the
    // `ExecutionResult` it returns rather than a log line, so a no-op is
    // enough for almost every test here. The exceptions pass their own
    // `recordingLogger()`: the #1001 snapshot-budget warn, and #1214 review
    // round 2's `flatten_refused_in_flight`, which is an outcome a caller
    // cannot tell from an ordinary dedup by status alone
    logger: { log: () => {} },
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
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
      // Dedup layer 2: the venue rejects a duplicate of this id
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
  // afterwards
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
    // it
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
      // Nothing has filled at `pending`, so the lot carries no exposure yet
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
      // #1001: always populated, no I/O — `order.entry` from `makeIntent()`
      // The quote/modelled-cost-breakdown fields stay absent here because
      // this test's `makeInput` default `marketData`/`costModel` are `{}`,
      // so both of `captureSubmitSnapshot`'s independent reads throw and
      // degrade to null (see the dedicated #1001 describe block below)
      decision_price: 100,
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
  // the PK race must come back `deduped`, not throw
  it('returns deduped when a concurrent execute() wins the write-ahead race', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    // Simulate the interleaving: findByKey says "free" the first time, then a
    // rival's write-ahead lands before ours does
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
  // nothing was persisted and nothing was sent (PR #290 review, deepseek)
  it('rethrows a non-constraint write-ahead failure instead of reporting deduped', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    const failingStore: typeof store = Object.create(store);
    failingStore.writeAheadPosition = async () => {
      throw new Error('database or disk is full');
    };
    // Free at the gate, present by the time the catch re-checks — the shape
    // the old row-existence-only catch would have swallowed as `deduped`
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
    // state of its own to report
    expect(second.order_state).toBeNull();
    expect(broker.calls).toHaveLength(1);
  });

  // The `findByKey` gate is check-then-act: two concurrent calls both read
  // "absent" before either writes, so the primary key — not the gate — is what
  // decides the race. The loser must land on `deduped`, not on an unhandled
  // constraint violation escaping execute()
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
    // silently stopping short of the branch it exists to cover
    expect(store.writeLog.filter((entry) => entry.startsWith('write-ahead')).length).toBe(2);
    const deduped = first?.status === 'deduped' ? first : second;
    expect(deduped?.reason).toBe('an order or fill already exists for this idempotency_key');
    expect(deduped?.broker_order_ids).toBeNull();
    // The whole point: the race cost the venue nothing and the store one row
    expect(broker.calls).toHaveLength(1);
    expect(await store.countAllPositions()).toBe(1);
  });

  it('rethrows a write-ahead failure that is not a duplicate key', async () => {
    // A store that could not write has NOT written; reporting that as dedup
    // would claim a durable record that does not exist, and the lot would
    // reach the broker with nothing behind it to reconcile
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
  // possible downstream
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
      // See `makeBroker`: never null, and never reached on this path
      getOrder: vi.fn().mockRejectedValue(new Error('getOrder: not part of execute()')),
      submitFlatten: vi.fn().mockRejectedValue(new Error('submitFlatten: not part of execute()')),
      cancel: vi.fn().mockRejectedValue(new Error('cancel: not part of execute()')),
      getOpenPositions: vi
        .fn()
        .mockRejectedValue(new Error('getOpenPositions: not part of execute()')),
      resumeFlatten: vi.fn().mockRejectedValue(new Error('resumeFlatten: not part of execute()')),
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(result.status).toBe('error');
    expect(result.reason).toBe('connection reset');
    expect(result.broker_order_ids).toBeNull();
    // Whether the bracket landed is unknowable here — only the broker can
    // settle it, so the record stays `pending` for #86 to reconcile rather
    // than being guessed terminal
    expect(result.order_state).toBe('pending');
    expect((await store.getPosition('key-aapl-1355'))?.order_state).toBe('pending');
  });

  it('still reports the pending record when the broker rejects with an unrenderable value (#1262)', async () => {
    const { store } = openTestExecutionStore();
    const broker: BrokerAdapter = {
      submitBracket: vi.fn().mockRejectedValue(hostileThrownValue()),
      fetchNewFills: vi.fn().mockResolvedValue([]),
      resizeProtectiveLegs: vi.fn().mockResolvedValue(undefined),
      rearmProtectiveLegs: vi
        .fn()
        .mockRejectedValue(new Error('rearmProtectiveLegs: not part of execute()')),
      getOrder: vi.fn().mockRejectedValue(new Error('getOrder: not part of execute()')),
      submitFlatten: vi.fn().mockRejectedValue(new Error('submitFlatten: not part of execute()')),
      cancel: vi.fn().mockRejectedValue(new Error('cancel: not part of execute()')),
      getOpenPositions: vi
        .fn()
        .mockRejectedValue(new Error('getOpenPositions: not part of execute()')),
      resumeFlatten: vi.fn().mockRejectedValue(new Error('resumeFlatten: not part of execute()')),
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    // The `pending` row is the whole point: it is what #86's reconcile adopts
    // broker truth against. Rendering the rejection unguarded threw out of
    // `execute()` before this result existed, so the caller saw a raw throw
    // and the ambiguity was never reported as one
    expect(result.status).toBe('error');
    expect(result.reason).toBe('[unrenderable error]');
    expect(result.order_state).toBe('pending');
    expect((await store.getPosition('key-aapl-1355'))?.order_state).toBe('pending');
  });

  // #1003: a rejected order used to leave only the generic
  // "alpaca submitBracket failed (status 422)" behind — sanitizeBrokerError
  // discarded the venue's own diagnostic text on the credential-safety
  // boundary, so the only durable trace of WHY a whole-share short 422'd was
  // a bare HTTP status. The venue's `code`/`message` fields are curated,
  // non-credentialed diagnostics (see broker-error.ts's `readVenueCode`/
  // `readVenueMessage`), so they now ride through into `ExecutionResult.reason`
  // — the same field this suite already pins to `error.message` verbatim
  // (see the 'connection reset' case above)
  it('surfaces the venue diagnostic detail, not just the HTTP status, when a rejected order is caught', async () => {
    const { store } = openTestExecutionStore();
    const brokerError = sanitizeBrokerError('alpaca', 'submitBracket', {
      status: 422,
      code: 42210000,
      venueMessage:
        'invalid take_profit.limit_price 746.96416125. sub-penny increment does not fulfill ' +
        'minimum pricing criteria',
    });
    const broker: BrokerAdapter = {
      submitBracket: vi.fn().mockRejectedValue(brokerError),
      fetchNewFills: vi.fn().mockResolvedValue([]),
      resizeProtectiveLegs: vi.fn().mockResolvedValue(undefined),
      rearmProtectiveLegs: vi
        .fn()
        .mockRejectedValue(new Error('rearmProtectiveLegs: not part of execute()')),
      getOrder: vi.fn().mockRejectedValue(new Error('getOrder: not part of execute()')),
      submitFlatten: vi.fn().mockRejectedValue(new Error('submitFlatten: not part of execute()')),
      cancel: vi.fn().mockRejectedValue(new Error('cancel: not part of execute()')),
      getOpenPositions: vi
        .fn()
        .mockRejectedValue(new Error('getOpenPositions: not part of execute()')),
      resumeFlatten: vi.fn().mockRejectedValue(new Error('resumeFlatten: not part of execute()')),
    };

    const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

    expect(result.status).toBe('error');
    // Not just the generic status string — the venue's own diagnostic text
    // must be present too
    expect(result.reason).toContain('status 422');
    expect(result.reason).toContain('code 42210000');
    expect(result.reason).toContain('sub-penny increment does not fulfill minimum pricing');
    expect(result.reason).not.toBe('alpaca submitBracket failed (status 422)');
  });

  it('does not act on a no_go', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const noGo: VerdictDecision = {
      status: 'no_go',
      order: null,
      no_go_reason: 'drift',
      no_go_detail: null,
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
    /** A closing sell of the held quantity — `buildExitIntent` (trader/decide.ts) shape */
    function makeExitGo(overrides: Partial<OrderIntent> = {}): VerdictDecision {
      return makeGo({
        intent_type: 'exit',
        side: 'sell',
        size: 40,
        // An exit's stop/target are degenerate (equal to entry) — #83's
        // flatten lifecycle does not consult them (decide.ts comment above
        // `buildExitIntent`)
        entry: 100,
        stop: 100,
        target: 100,
        // #793: every exit intent carries `metadata.exit_reason`
        // (`buildFlattenExit` requires the argument) — `executeExit` now
        // refuses to write ahead without one
        metadata: { ...makeIntent().metadata, exit_reason: 'flatten' },
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
      // now-flat position
      expect(broker.cancelCalls).toEqual([
        { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
      ]);
      expect(broker.flattenCalls).toEqual([
        {
          instrument: 'AAPL',
          // The CLOSING side, carried straight through — `side` on the
          // exit intent is already the closing side (decide.ts's
          // `buildExitIntent`), so this must not be inverted here
          side: 'sell',
          // The HELD quantity, not a risk-fraction size: `order.size` is
          // already `buildExitIntent`'s sum of filled_size across the
          // instrument's open lots, so execute() passes it through as-is
          size: 40,
          clientOrderId: 'key-aapl-1355',
        },
      ]);
      expect(broker.callSequence).toEqual([
        'cancel:key-aapl-entry-1',
        'submitFlatten:key-aapl-1355',
      ]);
      // No bracket path touched
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
    // `flatten_submissions` (review comments 2+4)
    it('writes no OpenPosition row for the flatten — only the flatten_submissions journal', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      // Exactly the one seeded lot — the exit added no second position row
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
    // silently reversed
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
        // (`seedHeldLot` uses only the first)
        'write-ahead:key-aapl-entry-1',
        'write-ahead-flatten:key-aapl-1355',
        'resolve-flatten:key-aapl-1355:submitted',
      ]);
    });

    // Mirrors the bracket path's "leaves the pending record intact when the
    // broker call throws" — but the ambiguity here is genuine (the venue
    // MAY have seen the flatten before the response was lost), so the row
    // is left at 'submitting' for #86's reconcile, exactly as the bracket
    // path leaves its `pending` record on a `submitBracket` failure
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
      expect(await store.countAllPositions()).toBe(1);
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('submitting');
      expect(row?.reason).toBeNull();
    });

    it('leaves the journal row at submitting when submitFlatten rejects with an unrenderable value (#1262)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, () => {
        throw hostileThrownValue();
      });
      await seedHeldLot(store);

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      // 'submitting' is the ambiguous-order-state record #86's reconcile
      // resolves against. Rendering the rejection unguarded threw out of
      // `execute()` before this result existed, so the caller got a raw throw
      // instead of the row's genuine ambiguity
      expect(result.status).toBe('error');
      expect(result.reason).toBe('[unrenderable error]');
      expect(result.order_state).toBeNull();
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('submitting');
      expect(row?.reason).toBeNull();
    });

    // Review comment 1's cancel-failure path — distinct from the case
    // above: this is NOT ambiguous (the flatten provably never reached the
    // broker), so the journal resolves to 'error' immediately, and
    // `submitFlatten` must never be called while it is unknown whether the
    // held lot's legs are actually gone
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

      // #867: the lot whose OWN cancel threw is NOT marked unprotected. Its
      // legs may still be working at the venue (the adapter's `cancel()` is
      // ordered so a throw usually means nothing was cancelled), and the
      // #549 sweep would re-arm an OCO over a live bracket — double
      // protection, which over-closes into a reverse position
      expect(await store.getUnprotectedResidualLots()).toEqual([]);
    });

    // #867, the multi-lot half of the same defect: lot 1's cancel RETURNED,
    // so its stop and target are provably gone, and then the flatten was
    // refused — leaving it open with no protection and (before this change)
    // nothing but a `flatten_submissions` row to say so. `sweepResidualProtection`
    // only ever retries lots carrying #549's marker, so without this write it
    // would never look at lot 1 at all
    it('marks every already-cancelled lot unprotected when a later cancel fails, so the #549 sweep re-arms it (#867)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, undefined, ({ clientOrderId }) => {
        if (clientOrderId === 'key-aapl-entry-2') throw new Error('venue timeout on cancel');
      });
      await seedHeldLot(store);
      await seedHeldLot(store, { idempotency_key: 'key-aapl-entry-2' });

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
        makeExitGo({ size: 80 }),
      );

      expect(result.status).toBe('error');
      expect(broker.flattenCalls).toHaveLength(0);
      expect((await store.getFlattenSubmission('key-aapl-1355'))?.status).toBe('error');

      // Lot 1 only: confirmed naked. Lot 2's cancel threw, so its state is
      // unknown and it is deliberately left alone (see the test above)
      const marked = await store.getUnprotectedResidualLots();
      expect(marked.map((lot) => lot.position.idempotency_key)).toEqual(['key-aapl-entry-1']);
    });

    it('still marks the already-cancelled lots and resolves the journal row when a cancel rejects with an unrenderable value (#1262)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, undefined, ({ clientOrderId }) => {
        if (clientOrderId === 'key-aapl-entry-2') throw hostileThrownValue();
      });
      await seedHeldLot(store);
      await seedHeldLot(store, { idempotency_key: 'key-aapl-entry-2' });

      const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
        makeExitGo({ size: 80 }),
      );

      // THE DAMAGE THIS PINS: the reason string is built BEFORE
      // `markLotsUnprotected` and `resolveFlattenError`, so rendering the
      // rejection unguarded skipped both — lot 1 was left cancelled (stop and
      // target provably gone) with no #549 marker for the sweep to find, and
      // the journal row was left unresolved
      const marked = await store.getUnprotectedResidualLots();
      expect(marked.map((lot) => lot.position.idempotency_key)).toEqual(['key-aapl-entry-1']);
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('error');
      expect(row?.reason).toContain('[unrenderable error]');
      expect(result.status).toBe('error');
      expect(result.reason).toContain('[unrenderable error]');
      expect(broker.flattenCalls).toHaveLength(0);
    });

    // The marker above is only worth writing if something CONSUMES it — this
    // repo's dominant defect class is a tested mechanism nothing calls. The
    // consumer is `sweepResidualProtection`, which the fill-sync loop runs on
    // cadence (`startFillSync` -> `execution.sweepResidualProtection()`,
    // production.ts). Driven here through the SAME `Execution` surface that
    // loop holds, so the assertion is that the naked lot really does get its
    // stop and target back rather than merely a database column set
    it('the #549 sweep then re-arms the lot this path marked, at its full held size (#867)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, undefined, ({ clientOrderId }) => {
        if (clientOrderId === 'key-aapl-entry-2') throw new Error('venue timeout on cancel');
      });
      await seedHeldLot(store);
      await seedHeldLot(store, { idempotency_key: 'key-aapl-entry-2' });
      // `seedHeldLot` writes the position row only. The sweep recomputes the
      // residual from the FILL record (`getFills`), not from `filled_size`,
      // so lot 1 needs the entry fill a real lot would already have — without
      // it the sweep reads "entry not filled yet, nothing to protect"
      await store.applyLotAdvance({
        idempotency_key: 'key-aapl-entry-1',
        fills: [
          {
            idempotency_key: 'key-aapl-entry-1',
            broker_fill_id: toBrokerFillId('fill-entry-lot-1'),
            leg: 'entry',
            price: 95,
            qty: 40,
            fee: 0.1,
            timestamp: NOW,
          },
        ],
      });
      const execution = new ExecutionImpl(makeInput({ store, broker }));

      await execution.execute(makeExitGo({ size: 80 }));
      await execution.sweepResidualProtection();

      // No exit fill ever landed, so the residual IS the whole lot — 40, the
      // seeded `filled_size`, at the lot's own stop/target
      expect(broker.rearmCalls).toEqual([
        {
          clientOrderId: 'key-aapl-entry-1',
          instrument: 'AAPL',
          side: 'buy',
          qty: 40,
          stop: 90,
          target: 110,
        },
      ]);
      // Re-armed, so the marker is cleared and the sweep stops retrying it
      expect(await store.getUnprotectedResidualLots()).toEqual([]);
    });

    // Review comment 2, exercised for real rather than via a stubbed gate:
    // the SAME exit decision replayed (crash-restart, retry) now dedupes
    // exactly like an entry does — `findByKey` sees the `flatten_submissions`
    // row the first call journalled, so the second call never reaches
    // `cancel` or `submitFlatten` at all
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

    /**
     * #1214's review, findings 1 and 3, against the REAL store — the guard
     * being proven lives in `SqliteExecutionStore.writeAheadFlatten`, so a
     * fake store would prove nothing about it.
     *
     * Finding 1: `executeExit` sizes purely from `getOpenPositions()` minus
     * `getExitFillSizes`, and an in-flight flatten whose fills have not landed
     * moves neither. So it could not see a residual re-flatten
     * (`reflattenResidual`) already working on the same lot, and would submit a
     * SECOND market order on it at the next flatten-window tick.
     *
     * Finding 3: with that guard in place, a re-flatten nothing could resolve
     * would no longer merely wedge the re-flatten mechanism — it would wedge
     * the mandatory flat-by-close. The second test is that pair together.
     */
    describe('one flatten per instrument (#1214 review)', () => {
      const REFLATTEN_KEY = 'key-aapl-entry-1:residual-reflatten-1';

      /** A live residual re-flatten on the held lot: journalled, acked by the venue, no fills swept */
      async function seedLiveReflatten(
        store: ReturnType<typeof openTestExecutionStore>['store'],
        submittedAt: Date = NOW,
      ): Promise<void> {
        await store.writeAheadFlatten({
          idempotency_key: REFLATTEN_KEY,
          instrument: 'AAPL',
          asset_class: 'stocks',
          side: 'sell',
          size: 6,
          submitted_at: submittedAt,
          lot_held_quantities: [{ idempotency_key: 'key-aapl-entry-1', held: 6 }],
          exit_reason: 'flatten',
          decision_price: null,
          quote_bid: null,
          quote_ask: null,
          quote_mid: null,
          quote_observed_at: null,
          modelled_cost_breakdown: null,
        });
        await store.resolveFlattenSubmitted(
          REFLATTEN_KEY,
          { order_state: 'submitted', broker_order_ids: [`${REFLATTEN_KEY}:flatten`] },
          submittedAt,
        );
      }

      it('refuses the flatten while a residual re-flatten is still working the same lot', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        const logger = recordingLogger();
        await seedHeldLot(store);
        await seedLiveReflatten(store);

        const result = await new ExecutionImpl(makeInput({ store, broker, logger })).execute(
          makeExitGo(),
        );

        expect(broker.flattenCalls).toEqual([]);
        // 'deduped', not 'error': the instrument IS being closed, by the other
        // submitter's order
        expect(result.status).toBe('deduped');
        /**
         * #1214 review round 2, finding 4. THE MUTATION THIS KILLS: delete the
         * `safeLog` call in `executeExit`'s `UnresolvedFlattenForInstrumentError`
         * catch. Without it a refused MANDATORY flat-by-close is byte-identical
         * in every operator-visible surface to the ordinary "already flat"
         * dedup — same status, same shape — and the one case where the lot is
         * still held becomes invisible.
         */
        expect(logger.entries).toContainEqual(
          expect.objectContaining({
            level: 'warn',
            event: 'flatten_refused_in_flight',
            payload: expect.objectContaining({
              instrument: 'AAPL',
              blocking_key: REFLATTEN_KEY,
            }),
          }),
        );
        // The refusal happens at the write-ahead, ABOVE the cancel loop, so the
        // lot keeps the protective legs it still has. A guard placed after the
        // cancel loop would have stripped them and then refused
        expect(broker.cancelCalls).toEqual([]);
        expect(await store.getFlattenSubmission('key-aapl-1355')).toBeNull();
      });

      it('proceeds again once reconcile settles a re-flatten the venue refused without filling', async () => {
        const { store } = openTestExecutionStore();
        await seedHeldLot(store);
        await seedLiveReflatten(store);

        // The venue's answer for that re-flatten: terminal, and it closed
        // NOTHING. Nothing else can resolve such a row — only `ingestFills()`
        // sets `fills_swept_at`, and only for a flatten that produced fills —
        // so before this fix the row stayed unresolved forever and the refusal
        // above became permanent, across restarts
        const reconcilingBroker = {
          ...makeBroker(),
          async resumeFlatten(): Promise<NormalizedOrder> {
            return {
              client_order_id: REFLATTEN_KEY,
              broker_order_ids: [`${REFLATTEN_KEY}:flatten`],
              order_state: 'rejected',
              filled_qty: 0,
            };
          },
          async getOpenPositions(): Promise<NormalizedPosition[]> {
            return [];
          },
        };
        await new ExecutionImpl(makeInput({ store, broker: reconcilingBroker })).reconcile();

        expect(await store.getUnresolvedFlattens()).toEqual([]);

        const broker = makeBroker();
        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

        expect(result.status).toBe('submitted');
        expect(broker.flattenCalls).toEqual([
          { instrument: 'AAPL', side: 'sell', size: 40, clientOrderId: 'key-aapl-1355' },
        ]);
      });

      /**
       * #1214 review round 2, finding 1 — the failure mode round 1 CREATED.
       *
       * Round 1's guard made an unresolved row refuse every later flatten on
       * the instrument, including `executeExit`'s mandatory flat-by-close. But
       * `reconcileFlatten` had a shape it never resolved: an already-acked
       * (`'submitted'`) row the venue afterwards denies all knowledge of. It
       * was "left untouched and escalated" on every pass, forever — no fills
       * to sweep, no terminal order state to observe, nothing else that can
       * retire a `'submitted'` row. The instrument became un-flattenable for
       * the life of the database, across restarts and trading days, with no
       * operator path short of editing SQLite by hand.
       *
       * The pair below is the proof the bound closed it. Both run the SAME
       * venue answer (null on a row it acked) against the REAL store; the only
       * difference is how long the row has been blocking.
       *
       * THE MUTATION THIS KILLS: delete the `age >= UNRESOLVABLE_FLATTEN_MAX_AGE_MS`
       * branch in `reconcileFlatten`, or raise the constant to a value no
       * trading session reaches. The first test still passes (the refusal is
       * the safe direction and stays); the second fails, which is the point —
       * "fails safe" is not the property under test, "can eventually flatten
       * again" is.
       */
      describe('an unresolvable acked flatten is bounded, not permanent', () => {
        /** The venue denies all knowledge of a flatten it acked — forever */
        const deniesEverything = {
          ...makeBroker(),
          async resumeFlatten(): Promise<NormalizedOrder | null> {
            return null;
          },
          async getOpenPositions(): Promise<NormalizedPosition[]> {
            return [];
          },
        };

        it('still refuses while the row is inside the bound — the safe direction is unchanged', async () => {
          const { store } = openTestExecutionStore();
          await seedHeldLot(store);
          await seedLiveReflatten(store, new Date(NOW.getTime() - 60_000));

          await new ExecutionImpl(makeInput({ store, broker: deniesEverything })).reconcile();

          expect((await store.getUnresolvedFlattens()).map((row) => row.idempotency_key)).toEqual([
            REFLATTEN_KEY,
          ]);
          const broker = makeBroker();
          const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
            makeExitGo(),
          );
          expect(result.status).toBe('deduped');
          expect(broker.flattenCalls).toEqual([]);
        });

        it('forces the row terminal past the bound, and the instrument flattens again', async () => {
          const { store } = openTestExecutionStore();
          await seedHeldLot(store);
          await seedLiveReflatten(
            store,
            new Date(NOW.getTime() - UNRESOLVABLE_FLATTEN_MAX_AGE_MS - 1),
          );

          const report = await new ExecutionImpl(
            makeInput({ store, broker: deniesEverything }),
          ).reconcile();

          expect(report.divergences).toContainEqual(
            expect.objectContaining({
              idempotency_key: REFLATTEN_KEY,
              action: 'rejected',
              kind: 'flatten',
            }),
          );
          // The reason must not claim proof the venue never gave, NOR an
          // observation history that was never gathered — the bound fires on
          // one answer past an age, not on a run of denials
          const row = await store.getFlattenSubmission(REFLATTEN_KEY);
          expect(row?.status).toBe('error');
          expect(row?.reason).toContain(
            'DECISION on one unanswered check against a row that old, not proof',
          );
          expect(row?.reason).toContain('not a record of repeated denial');
          expect(await store.getUnresolvedFlattens()).toEqual([]);

          // The whole point: the mandatory flat-by-close goes out, for the
          // instrument's FULL held quantity
          const broker = makeBroker();
          const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
            makeExitGo(),
          );
          expect(result.status).toBe('submitted');
          expect(broker.flattenCalls).toEqual([
            { instrument: 'AAPL', side: 'sell', size: 40, clientOrderId: 'key-aapl-1355' },
          ]);
        });
      });
    });

    // #921: closing gap #1 in the issue's remaining "resilience gaps" list
    // Once a `flatten_submissions` row exists under a key, EVERY replay used
    // to dedupe forever — including the case where the row's own status
    // (`'error'`) PROVES the flatten never reached the broker. A mandatory
    // flatten cannot be allowed to stall like that: the next tick's retry of
    // the same exit decision must get a fresh key and a fresh attempt
    describe('fresh idempotency key on flatten retry (#921)', () => {
      it('retries under a :retry-1 key when the cancel loop failed (row resolved to error), and the retry row is distinct from the original', async () => {
        const { store } = openTestExecutionStore();
        let failCancel = true;
        const broker = makeBroker(undefined, undefined, () => {
          if (failCancel) throw new Error('venue timeout on cancel');
        });
        await seedHeldLot(store);
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        const first = await execution.execute(makeExitGo());
        expect(first.status).toBe('error');
        expect((await store.getFlattenSubmission('key-aapl-1355'))?.status).toBe('error');

        // The next tick: the cancel loop now succeeds (the transient venue
        // issue cleared), so the retry should actually flatten
        failCancel = false;
        const second = await execution.execute(makeExitGo());

        expect(second.status).toBe('submitted');
        expect(second.idempotency_key).toBe('key-aapl-1355:retry-1');
        expect(broker.flattenCalls).toEqual([
          {
            instrument: 'AAPL',
            side: 'sell',
            size: 40,
            clientOrderId: 'key-aapl-1355:retry-1',
          },
        ]);
        // The retry re-ran the FULL cancel loop rather than assuming the
        // first attempt's (failed) cancel still holds — this is the
        // `sweepResidualProtection`-may-have-re-armed-in-between guarantee
        expect(broker.cancelCalls).toEqual([
          { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
          { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
        ]);

        // The original row is untouched, and a DISTINCT row now exists for
        // the retry key — two separate flatten_submissions rows, not one
        // overwritten in place
        const original = await store.getFlattenSubmission('key-aapl-1355');
        expect(original?.status).toBe('error');
        const retry = await store.getFlattenSubmission('key-aapl-1355:retry-1');
        expect(retry?.status).toBe('submitted');
        expect(await store.countAllFlattenSubmissions()).toBe(2);
      });

      it('still dedupes (does not retry) when the prior attempt is stuck at submitting — a lost ack is genuinely ambiguous', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker(undefined, () => {
          // submitFlatten itself throws: ambiguous, row stays 'submitting'
          throw new Error('response lost');
        });
        await seedHeldLot(store);
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        const first = await execution.execute(makeExitGo());
        expect(first.status).toBe('error');
        expect((await store.getFlattenSubmission('key-aapl-1355'))?.status).toBe('submitting');

        const second = await execution.execute(makeExitGo());

        expect(second.status).toBe('deduped');
        expect(second.idempotency_key).toBe('key-aapl-1355');
        // No second cancel/flatten attempt of any kind — both call counts are
        // exactly what the FIRST (ambiguous) attempt left behind
        expect(broker.cancelCalls).toHaveLength(1);
        expect(broker.flattenCalls).toHaveLength(1);
        expect(await store.countAllFlattenSubmissions()).toBe(1);
      });

      it('still dedupes (does not retry) when the prior attempt already succeeded', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store);
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        const first = await execution.execute(makeExitGo());
        expect(first.status).toBe('submitted');
        expect((await store.getFlattenSubmission('key-aapl-1355'))?.status).toBe('submitted');

        const second = await execution.execute(makeExitGo());

        expect(second.status).toBe('deduped');
        expect(second.idempotency_key).toBe('key-aapl-1355');
        expect(broker.cancelCalls).toHaveLength(1);
        expect(broker.flattenCalls).toHaveLength(1);
        expect(await store.countAllFlattenSubmissions()).toBe(1);
      });

      // Entry/scale_in must not gain any retry behaviour — a replayed entry
      // decision always means "this was already acted on", never "the prior
      // attempt provably failed and should be retried under a new id"
      it('never applies retry treatment to entry/scale_in intents — same key always dedupes unconditionally', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        const first = await execution.execute(makeGo());
        const second = await execution.execute(makeGo());

        expect(first.status).toBe('submitted');
        expect(second.status).toBe('deduped');
        expect(second.idempotency_key).toBe('key-aapl-1355');
        expect(broker.calls).toHaveLength(1);
        // isRetryableFlattenError is never even consulted for a bracket path
        // key — there is no flatten_submissions row to find
        expect(await store.isRetryableFlattenError('key-aapl-1355')).toBe(false);
      });

      it('caps retries at MAX_EXIT_RETRY_ATTEMPTS: after that many consecutive retryable errors, the next call dedupes instead of retrying forever', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker(undefined, undefined, () => {
          throw new Error('venue timeout on cancel');
        });
        await seedHeldLot(store);
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        // Every attempt's cancel loop fails, so every row resolves to
        // 'error' — a persistently failing venue, never a lost ack
        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push(await execution.execute(makeExitGo()));
        }

        // base key + :retry-1 + :retry-2 + :retry-3 all attempt-and-fail
        // (each is a genuine attempt, each ends in 'error'); the 5th call has
        // exhausted MAX_EXIT_RETRY_ATTEMPTS (3) and falls back to 'deduped'
        // rather than minting a 5th key
        expect(results.map((r) => r.status)).toEqual([
          'error',
          'error',
          'error',
          'error',
          'deduped',
        ]);
        expect(results.map((r) => r.idempotency_key)).toEqual([
          'key-aapl-1355',
          'key-aapl-1355:retry-1',
          'key-aapl-1355:retry-2',
          'key-aapl-1355:retry-3',
          'key-aapl-1355',
        ]);
        expect(await store.countAllFlattenSubmissions()).toBe(4);
      });
    });

    describe('store cross-check (review comment 3)', () => {
      it('refuses when the store holds no open lot for the instrument to close', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        // No seed: the store has nothing open for AAPL

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
        await seedHeldLot(store);

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

      /**
       * #568: a lot partially closed by an earlier flatten stays OPEN (only
       * terminal states leave `getOpenPositions()`) and keeps its ORIGINAL
       * `filled_size` — that field is the entry total, and no exit fill
       * reduces it. Held quantity is therefore `filled_size` minus the
       * exit-leg fills on record; these tests seed exactly that state by
       * persisting the earlier flatten's own exit fill, the same row
       * `ingestFills()` writes.
       */
      async function recordExitFill(
        store: ReturnType<typeof openTestExecutionStore>['store'],
        qty: number,
      ): Promise<void> {
        await store.applyLotAdvance({
          idempotency_key: 'key-aapl-entry-1',
          fills: [
            {
              idempotency_key: 'key-aapl-entry-1',
              broker_fill_id: toBrokerFillId(`fill-partial-flatten-${qty}`),
              leg: 'exit',
              price: 99,
              qty,
              fee: 0.1,
              timestamp: NOW,
            },
          ],
        });
      }

      it('sizes the held quantity to what the venue still holds after a partial flatten, not the lot original size', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store, { requested_size: 10, filled_size: 10 });
        await recordExitFill(store, 4);

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ size: 6 }),
        );

        expect(result.status).toBe('submitted');
        expect(broker.flattenCalls).toEqual([
          { instrument: 'AAPL', side: 'sell', size: 6, clientOrderId: 'key-aapl-1355' },
        ]);
      });

      it('refuses an exit sized to the lot original filled_size once part of it is already closed', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store, { requested_size: 10, filled_size: 10 });
        await recordExitFill(store, 4);

        // What a pre-#568 `buildExitIntent` produced: the entry total, 10,
        // against a venue holding 6. Submitted, that is a market sell of 10
        // into 6 — 4 SHORT, with the re-armed OCO cancelled first, i.e. a
        // reverse position with no lot, no bracket and no protective leg
        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ size: 10 }),
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain('10');
        expect(result.reason).toContain('6');
        // Refused BEFORE the cancel loop: a protective leg the flatten never
        // replaced must not be taken off the venue on the way to a refusal
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      it('refuses, naming the lot, when the fill record shows more closed than the lot ever opened', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store, { requested_size: 10, filled_size: 10 });
        await recordExitFill(store, 12);

        // Any size at all: the divergence is refused before the size is
        // compared, because a negative lot would otherwise net against a
        // sibling into a total that looks plausible and is not
        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ size: 6 }),
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain('key-aapl-entry-1');
        expect(result.reason).toContain('more closed quantity');
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      it('refuses an exit whose side does not match the closing side implied by the held lot', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store);

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ side: 'buy' }),
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain("'buy'");
        expect(result.reason).toContain("'sell'");
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      describe('per-lot cross-check against the recorded held quantities (#1497)', () => {
        /**
         * Two lots, 20 held each, so the TOTAL (40) matches `makeExitGo`'s
         * default `size: 40` either way — the compensating swap below only
         * shows up per lot, never in the sum. Distinct `opened_at` (not both
         * `NOW`): `getOpenPositions()` is `ORDER BY opened_at` with no
         * tiebreak, and the test below asserts which lot's key the refusal
         * names — a tie would leave that assertion's ordering unspecified.
         */
        async function seedTwoHeldLots(
          store: ReturnType<typeof openTestExecutionStore>['store'],
        ): Promise<void> {
          await seedHeldLot(store, { requested_size: 20, filled_size: 20 });
          await seedHeldLot(store, {
            idempotency_key: 'key-aapl-entry-2',
            requested_size: 20,
            filled_size: 20,
            opened_at: new Date(NOW.getTime() + 1000),
            broker_order_ids: ['seed:entry-2', 'seed:stop-2', 'seed:target-2'],
          });
        }

        it('refuses a compensating swap between two lots even though the total is unchanged', async () => {
          const { store } = openTestExecutionStore();
          const broker = makeBroker();
          await seedTwoHeldLots(store);

          // What the Trader recorded at decide-time: one lot up, the other
          // down by the same amount. 25 + 15 === 20 + 20 === order.size (40),
          // so the total-only guard above stays silent on this — it is only
          // visible per lot
          const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
            makeExitGo({
              metadata: {
                ...makeIntent().metadata,
                exit_reason: 'flatten',
                lot_held_quantities: [
                  { idempotency_key: 'key-aapl-entry-1', held: 25 },
                  { idempotency_key: 'key-aapl-entry-2', held: 15 },
                ],
              },
            }),
          );

          expect(result.status).toBe('error');
          expect(result.reason).toContain('key-aapl-entry-1');
          expect(result.reason).toContain('diverged');
          expect(broker.cancelCalls).toHaveLength(0);
          expect(broker.flattenCalls).toHaveLength(0);
          expect(await store.countAllFlattenSubmissions()).toBe(0);
        });

        it('submits when the recorded per-lot held quantities match the store exactly', async () => {
          const { store } = openTestExecutionStore();
          const broker = makeBroker();
          await seedTwoHeldLots(store);

          const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
            makeExitGo({
              metadata: {
                ...makeIntent().metadata,
                exit_reason: 'flatten',
                lot_held_quantities: [
                  { idempotency_key: 'key-aapl-entry-1', held: 20 },
                  { idempotency_key: 'key-aapl-entry-2', held: 20 },
                ],
              },
            }),
          );

          expect(result.status).toBe('submitted');
          expect(broker.flattenCalls).toHaveLength(1);
        });

        it('does not refuse when the intent carries no per-lot snapshot at all', async () => {
          const { store } = openTestExecutionStore();
          const broker = makeBroker();
          await seedHeldLot(store);

          const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
            makeExitGo(),
          );

          expect(result.status).toBe('submitted');
        });
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
    // (simulated-adapter.ts) — so the flatten still acks
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
      // never consults the venue's book either
      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(result.broker_order_ids).toEqual(['key-aapl-1355:flatten']);
      expect(await store.countAllPositions()).toBe(1);
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
    // `execute()`'s submission ack and never called `ingestFills()` at all
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
          // ticket exists to fix
          idempotency_key: 'key-aapl-entry-1',
          debate_id: 'debate-abc123',
          instrument: 'AAPL',
          side: 'buy',
          filled_size: 40,
          // The Simulated adapter's own raw fill is tagged `leg: 'entry'`
          // (it models a flatten as just another priced fill at submit
          // time) — `close_reason` reading the flatten's journalled
          // `exit_reason` ('flatten', `makeExitGo`'s default), not 'entry',
          // proves `ingestFills()` overrode the adapter's tag AND threaded
          // the real reason through, rather than trusting either (#793)
          close_reason: 'flatten',
        });
        // gross = (99.5 - 95) * 40 = 180; fees = 0 (entry) + 0.2 (flatten commission)
        expect(closedTrades[0].realized_pnl_net).toBeCloseTo(180 - 0.2, 6);
        expect(closedTrades[0].fees_total).toBeCloseTo(0.2, 6);

        expect((await store.getPosition('key-aapl-entry-1'))?.order_state).toBe('closed');
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

      // #793 AC: `closed_trades.close_reason` must distinguish a flatten
      // (broker-visible, time-based) from an early release
      // (`signal_decay`) — two DIFFERENT in-process reasons a lot can be
      // exited for, both submitted through the same `intent_type: 'exit'`
      // path. Before this ticket both collapsed to the single `leg: 'exit'`
      // tag; this test pins that they now read distinct `close_reason`
      // values off the exit's own `metadata.exit_reason`
      it('gives a signal-decay release and a flatten different close_reason values on their closed-trade rows', async () => {
        const { store } = openTestExecutionStore();
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 92, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 95, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 96, filled_size: 10, cost_breakdown: zeroCosts() }),
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

        // Two DIFFERENT instruments, each with exactly one open lot, so
        // each exit below is a full flatten of that instrument's only
        // held quantity — `executeExit` sizes an exit against the total
        // held for the instrument (see `heldSize`/`totalHeldQuantity`
        // above), not against an individual lot, so sharing one
        // instrument between the two lots would make a size-10 exit an
        // (refused) partial rather than the full flatten this test needs
        await execution.execute(
          makeGo({
            idempotency_key: 'key-lot-a',
            instrument: 'AAPL',
            size: 10,
            entry: 90,
            stop: 85,
            target: 110,
          }),
        );
        await execution.ingestFills();
        await execution.execute(
          makeGo({
            idempotency_key: 'key-lot-b',
            instrument: 'MSFT',
            size: 10,
            entry: 92,
            stop: 85,
            target: 110,
          }),
        );
        await execution.ingestFills();

        await execution.execute(
          makeExitGo({
            idempotency_key: 'key-exit-a',
            instrument: 'AAPL',
            size: 10,
            metadata: { ...makeIntent().metadata, exit_reason: 'signal_decay' },
          }),
        );
        await execution.ingestFills();
        await execution.execute(
          makeExitGo({
            idempotency_key: 'key-exit-b',
            instrument: 'MSFT',
            size: 10,
            metadata: { ...makeIntent().metadata, exit_reason: 'flatten' },
          }),
        );
        await execution.ingestFills();

        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(2);
        const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));
        expect(byKey.get('key-lot-a')?.close_reason).toBe('signal_decay');
        expect(byKey.get('key-lot-b')?.close_reason).toBe('flatten');
        expect(byKey.get('key-lot-a')?.close_reason).not.toBe(byKey.get('key-lot-b')?.close_reason);
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
        // it must dedupe, not close the same lot twice or double-count PnL
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
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 100, filled_size: 25, cost_breakdown: zeroCosts() }),
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

        const exitResult = await execution.execute(makeExitGo({ size: 25 }));
        expect(exitResult.status).toBe('submitted');
        await execution.ingestFills();

        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(2);
        const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));
        expect(byKey.get('key-lot-1')).toMatchObject({ filled_size: 10, close_reason: 'flatten' });
        expect(byKey.get('key-lot-2')).toMatchObject({ filled_size: 15, close_reason: 'flatten' });
        // Each lot's PnL against its OWN entry price, not a blended average —
        // proof the FIFO split, not a pro-rata one, drove the allocation
        expect(byKey.get('key-lot-1')?.realized_pnl_net).toBeCloseTo((100 - 90) * 10, 6);
        expect(byKey.get('key-lot-2')?.realized_pnl_net).toBeCloseTo((100 - 92) * 15, 6);
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

      // The split must be identical on every poll: `hasFill` dedupes on the
      // full `(idempotency_key, broker_fill_id)` pair (#1320), and this
      // lot's key is fixed across polls, so a SECOND, differently-sized
      // attempt under the same derived id does not correct the first — it
      // silently vanishes behind it, stranding the lot's true remainder
      // forever. A share seeded
      // from anything that moves as fills persist (each lot's prior EXIT
      // fills, or a filter to lots still open in the CURRENT poll's
      // `positions`) drifts exactly that way. The journalled held quantity
      // the split reads is fixed at the flatten's write-ahead, so it does not
      //
      // Neither lot here has prior exits, so this pins the property for the
      // simple case; the #571 suite below pins it for a lot that does
      it('gives a partially-filled multi-lot flatten a stable split across repeated polls, closing what it can and leaving the rest genuinely open', async () => {
        const { store } = openTestExecutionStore();
        let now = NOW;
        const steppingClock: Clock = { now: () => now };
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() })
            // The flatten asked for 25 (10 + 15) but the IOC only fills 20 —
            // a thin book taking part of the order and cancelling the rest
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
        // this exercises exactly the repeat-poll path the fix above targets
        await execution.ingestFills();
        await execution.ingestFills();
        await execution.ingestFills();

        // Lot 1's full 10-share is covered by the 20 that filled — closes
        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(1);
        expect(closedTrades[0]).toMatchObject({ idempotency_key: 'key-lot-1', filled_size: 10 });

        // Lot 2 gets its FIFO remainder of the 20 (10, after lot 1's 10) —
        // 5 short of its own 15 need, so it stays open, not silently
        // dropped and not double-counted by the repeat polls above
        const lot2 = await store.getPosition('key-lot-2');
        expect(lot2?.order_state).toBe('filled');
        const lot2ExitQty = (await store.getFills('key-lot-2'))
          .filter((fill) => fill.leg === 'exit')
          .reduce((sum, fill) => sum + fill.qty, 0);
        expect(lot2ExitQty).toBe(10);
        expect(await store.getOpenPositions()).toHaveLength(1);
      });

      // #571. The split above allocated against each lot's ENTRY total, which
      // is stable but blind to exits already recorded — and since #568 the
      // flatten's SIZE is the venue-true HELD quantity. The two disagree the
      // moment an older named lot has prior exit fills, which is reachable by
      // design: `decide.ts`'s `scale_in` opens additional same-side lots on
      // one instrument, and any partial flatten leaves one of them
      // part-closed
      //
      // The repro, run end to end below: lot 1 entry 10 with 4 already closed
      // (holds 6), lot 2 entry 5 with none closed (holds 5). The exit sizes
      // 11 and fills 11. Against ENTRY totals lot 1 took `min(10, 11)` = 10 —
      // an exit total of 14 against an entry of 10, so its `ClosedTrade`
      // reported `filled_size` 10 with an exit price weighted over 14 units
      // (realized PnL 97.14 instead of 96 here) — while lot 2 took 1 of its 5
      // and stayed open forever on quantity the venue no longer held, with
      // `maybeRearmResidual` arming protective legs over the missing 4: a
      // resting order that fires into nothing and OPENS A REVERSE POSITION,
      // #516's hazard. Against the HELD quantities the flatten journalled at
      // write-ahead, lot 1 takes exactly its own 6 and lot 2 its own 5
      describe('multi-lot split by journalled held quantity (#571)', () => {
        /**
         * Lot 1 (entry 10 @ 90) and lot 2 (entry 5 @ 92, `scale_in`), then a
         * first flatten of the full 15 that only partially fills — leaving
         * lot 1 with prior exit fills and lot 2 untouched, the precondition
         * the split used to get wrong.
         *
         * `firstFlattenQty` is deliberately smaller than lot 1's own share, so
         * every unit of it lands on lot 1 under either split — the divergence
         * this suite is about begins at the SECOND flatten.
         */
        async function seedTwoLotsWithPriorExit(
          store: TestExecutionStore,
          firstFlattenQty: number,
          secondFlattenQty: number,
        ): Promise<{ execution: ExecutionImpl; broker: SimulatedBrokerAdapter }> {
          let now = NOW;
          const steppingClock: Clock = { now: () => now };
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({ fill_price: 92, filled_size: 5, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({
                fill_price: 99,
                filled_size: firstFlattenQty,
                cost_breakdown: zeroCosts(),
              })
              .mockReturnValueOnce({
                fill_price: 100,
                filled_size: secondFlattenQty,
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
              size: 5,
              entry: 92,
              stop: 85,
              target: 110,
            }),
          );
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);

          const first = await execution.execute(
            makeExitGo({ idempotency_key: 'key-exit-1', size: 15 }),
          );
          expect(first.status).toBe('submitted');
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);

          // The precondition, asserted rather than assumed: lot 1 holds 6 of
          // its 10, lot 2 still holds all 5, and both are open
          expect((await store.getExitFillSizes(['key-lot-1', 'key-lot-2'])).get('key-lot-1')).toBe(
            firstFlattenQty,
          );
          expect(await store.getOpenPositions()).toHaveLength(2);

          const second = await execution.execute(
            makeExitGo({ idempotency_key: 'key-exit-2', size: 11 }),
          );
          // The guard passes on 6 + 5 — this is a correctly sized exit, which
          // is what made the mis-split so quiet
          expect(second.status).toBe('submitted');

          return { execution, broker };
        }

        it('journals what each lot HELD, not what its entry filled', async () => {
          const { store } = openTestExecutionStore();

          await seedTwoLotsWithPriorExit(store, 4, 11);

          const journal = await store.getFlattenSubmission('key-exit-2');
          expect(JSON.parse(journal?.lot_idempotency_keys ?? 'null')).toEqual([
            'key-lot-1',
            'key-lot-2',
          ]);
          // 6, not lot 1's entry total of 10 — and the pair sums to the
          // flatten's own size, which `executeExit` already checked equals the
          // exit intent's
          expect(JSON.parse(journal?.lot_held_quantities ?? 'null')).toEqual([6, 5]);
          expect(journal?.size).toBe(11);
        });

        it('covers each lot with exactly its own held quantity, closing both and leaving no phantom', async () => {
          const { store } = openTestExecutionStore();

          const { execution, broker } = await seedTwoLotsWithPriorExit(store, 4, 11);
          await execution.ingestFills();
          // Re-polled: the split must land identically the second time or the
          // difference vanishes behind `hasFill`'s dedup on the full
          // `(idempotency_key, broker_fill_id)` pair (#1320)
          await execution.ingestFills();

          const closedTrades = await store.getClosedTrades();
          expect(closedTrades).toHaveLength(2);
          const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));

          // Lot 1's exit price is weighted over its OWN ten units — 4 at 99
          // from the first flatten plus 6 at 100 from this one, i.e. 99.6.
          // The entry-total split weighted it over fourteen (4 + 10) and
          // reported 97.14 here
          expect(byKey.get('key-lot-1')).toMatchObject({ filled_size: 10 });
          expect(byKey.get('key-lot-1')?.realized_pnl_net).toBeCloseTo((99.6 - 90) * 10, 6);
          expect(byKey.get('key-lot-2')).toMatchObject({ filled_size: 5 });
          expect(byKey.get('key-lot-2')?.realized_pnl_net).toBeCloseTo((100 - 92) * 5, 6);

          // No phantom: the venue sold all of lot 2, so lot 2 is closed, not
          // left open holding 4 units that do not exist
          expect(await store.getOpenPositions()).toEqual([]);
          expect((await store.getPosition('key-lot-2'))?.order_state).toBe('closed');
          // And nothing re-armed protection over that phantom. `executeExit`
          // cancelled both lots' legs before the flatten (#525); lot 2 is flat
          // afterwards, so `advanceLot` must leave them cancelled rather than
          // arm a resting order that would fire into nothing and open a
          // REVERSE position (#516)
          expect(broker.getProtectedQty('key-lot-2')).toBeNull();
          expect(broker.getProtectedQty('key-lot-1')).toBeNull();
        });

        // The stability property the entry-total split was chosen for, now
        // proven for a lot that HAS prior exits — the case that made the
        // entry total the wrong number. A PARTIAL fill is what exercises it:
        // the shares must not move as this very flatten's own fills persist
        it('splits a PARTIAL fill identically across repeated polls when a lot has prior exits', async () => {
          const { store } = openTestExecutionStore();

          // 8 of the 11 asked for: lot 1's whole 6-share, then 2 of lot 2's 5
          const { execution, broker } = await seedTwoLotsWithPriorExit(store, 4, 8);
          await execution.ingestFills();
          await execution.ingestFills();
          await execution.ingestFills();

          // Lot 1 is genuinely flat — 4 + 6 against an entry of 10 — and its
          // realized record is the same as the full-fill case above, because
          // its share never depended on how much of lot 2's share filled
          const closedTrades = await store.getClosedTrades();
          expect(closedTrades).toHaveLength(1);
          expect(closedTrades[0]).toMatchObject({ idempotency_key: 'key-lot-1', filled_size: 10 });
          expect(closedTrades[0]?.realized_pnl_net).toBeCloseTo((99.6 - 90) * 10, 6);

          // Lot 2 took the remaining 2 — once, not once per poll — and its
          // genuine residual of 3 carries fresh protection. The entry-total
          // split gave it ZERO here (lot 1 absorbed all 8 of its 10-share),
          // leaving it protected at a stale 5
          const lot2ExitQty = (await store.getFills('key-lot-2'))
            .filter((lotFill) => lotFill.leg === 'exit')
            .reduce((sum, lotFill) => sum + lotFill.qty, 0);
          expect(lot2ExitQty).toBe(2);
          expect(await store.getOpenPositions()).toHaveLength(1);
          expect(broker.getProtectedQty('key-lot-2')).toBe(3);
        });

        // Migration 0021's backward compatibility, end to end: a flatten
        // journalled before the column existed has NULL there and must keep
        // the pre-#571 entry-total split rather than fail. Only reachable for
        // a flatten submitted before this code shipped whose fill had not been
        // ingested yet
        it('falls back to the entry-total split for a flatten journalled before migration 0021', async () => {
          const { store } = openTestExecutionStore();
          let now = NOW;
          const steppingClock: Clock = { now: () => now };
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({ fill_price: 92, filled_size: 5, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({
                fill_price: 100,
                filled_size: 15,
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
              size: 5,
              entry: 92,
              stop: 85,
              target: 110,
            }),
          );
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);

          await execution.execute(makeExitGo({ idempotency_key: 'key-exit-1', size: 15 }));
          // Ages the journal row back to its pre-0021 shape, BEFORE the fill
          // is ingested — the only window in which such a row can be read
          store.ageFlattenHeldQuantities('key-exit-1');

          await execution.ingestFills();

          // Neither lot has prior exits, so the entry totals ARE the held
          // quantities and the old split is still correct here — the point is
          // that it runs at all instead of throwing on a NULL column
          const closedTrades = await store.getClosedTrades();
          expect(closedTrades).toHaveLength(2);
          const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));
          expect(byKey.get('key-lot-1')).toMatchObject({ filled_size: 10 });
          expect(byKey.get('key-lot-2')).toMatchObject({ filled_size: 5 });
          expect(await store.getOpenPositions()).toEqual([]);
        });
      });

      describe('residual re-arm on a partial flatten (#525)', () => {
        it('re-arms the residual through the real cancel-then-flatten path', async () => {
          const { store } = openTestExecutionStore();
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
              // The flatten asks for 40 but a thin book only fills 25 — a
              // naked residual of 15 if nothing re-arms it
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
          // (inside `executeExit`, below) is what removes them
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(40);

          const exitResult = await execution.execute(makeExitGo({ size: 40 }));
          expect(exitResult.status).toBe('submitted');
          await execution.ingestFills();

          // The lot is genuinely still open — not closed, not silently
          // dropped — and its remaining 15 (40 - 25) carries fresh protection
          // at the SAME stop/target the original bracket used (95's stop is
          // 90, target 110 — `makeGo`'s own fixture above)
          expect(await store.getOpenPositions()).toHaveLength(1);
          expect(await store.getClosedTrades()).toHaveLength(0);
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(15);
          // No alert on a SUCCESSFUL re-arm — the decision comment on #525
          // is explicit that the alert is the fallback, not the primary
          // mechanism
          expect(residualExposureAlerts.alerts).toEqual([]);
        });

        // #568, the whole scenario through the real cancel-then-flatten
        // path: the residual #525 re-armed is a steady state the system keeps
        // trading against, so the NEXT exit verdict has to size to it. Before
        // this fix the lot reported its original 40 to both halves of the
        // exit path, they agreed, and the guard passed — a market sell of 40
        // into a venue holding 15, i.e. 25 SHORT with the re-armed OCO
        // cancelled first: a reverse position with no lot, no bracket and no
        // protective leg
        it('sizes and accepts a SECOND exit at the residual, and refuses one sized to the original lot', async () => {
          const { store } = openTestExecutionStore();
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
              // First flatten: asks 40, fills 25 — residual 15
              .mockReturnValueOnce({ fill_price: 99, filled_size: 25, cost_breakdown: zeroCosts() })
              // Second flatten: the residual, in full
              .mockReturnValueOnce({
                fill_price: 98,
                filled_size: 15,
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
            makeGo({ idempotency_key: 'key-aapl-entry-1', size: 40, entry: 95 }),
          );
          await execution.ingestFills();
          await execution.execute(makeExitGo({ size: 40 }));
          await execution.ingestFills();

          // Mid-scenario: 25 of 40 closed. The lot is NOT genuinely flat, so
          // no ClosedTrade may exist for it — a realized record here would be
          // a round-trip the position never made
          expect(await store.getClosedTrades()).toHaveLength(0);
          const openLot = (await store.getOpenPositions())[0];
          // Still carrying the ENTRY total, which is why held quantity cannot
          // be read off it directly
          expect(openLot?.filled_size).toBe(40);
          expect((await store.getExitFillSizes(['key-aapl-entry-1'])).get('key-aapl-entry-1')).toBe(
            25,
          );

          // The pre-#568 exit: the lot's original size, refused without
          // touching the broker — the re-armed protective legs stay on
          const oversized = await execution.execute(
            makeExitGo({ idempotency_key: 'key-aapl-1400', size: 40 }),
          );
          expect(oversized.status).toBe('error');
          expect(oversized.reason).toContain('does not match the held quantity 15');
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(15);

          // The residual, which is what `buildExitIntent` now sizes
          const residualExit = await execution.execute(
            makeExitGo({ idempotency_key: 'key-aapl-1405', size: 15 }),
          );
          expect(residualExit.status).toBe('submitted');
          await execution.ingestFills();

          // Genuinely flat now — one ClosedTrade for the whole 40, and
          // nothing left open
          expect(await store.getOpenPositions()).toEqual([]);
          const closed = await store.getClosedTrades();
          expect(closed).toHaveLength(1);
          expect(closed[0]).toMatchObject({ idempotency_key: 'key-aapl-entry-1', filled_size: 40 });
        });

        it('re-arms a sibling lot that got ZERO share of a partial flatten fill', async () => {
          // The flatten names two lots (FIFO order: lot 1 then lot 2), but the
          // venue fills LESS than lot 1's own share — lot 2 gets no new Fill
          // row at all this poll, yet its legs were cancelled by the SAME
          // `executeExit` call that cancelled lot 1's. `redistributeFlattenFills`'
          // returned lot-key set (#525) is what makes this lot's re-arm run
          // despite it having no new fill to trigger the ordinary path
          const { store } = openTestExecutionStore();
          let now = NOW;
          const steppingClock: Clock = { now: () => now };
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() })
              // The flatten asks for 25 (10 + 15) but only 7 fills — less
              // than even lot 1's own 10-share, so lot 2 gets nothing
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

          // Lot 1: 7 of its 10-share filled, 3 left — re-armed to 3
          expect(broker.getProtectedQty('key-lot-1')).toBe(3);
          // Lot 2: ZERO share this poll — re-armed to its FULL original 15,
          // not left at `null` (unprotected) the way `cancel()` alone would
          // leave it
          expect(broker.getProtectedQty('key-lot-2')).toBe(15);
          expect(await store.getOpenPositions()).toHaveLength(2);
          expect(await store.getClosedTrades()).toHaveLength(0);
          // Both re-arms succeeded — no alert
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
            // `getOpenPositions()`'s `opened_at` order
            class FlakyGetFillsStore extends TestExecutionStore {
              /** Only throws once armed — lot 2's OWN entry-fill poll must still succeed */
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
                })
                .mockReturnValueOnce({
                  fill_price: 92,
                  filled_size: 15,
                  cost_breakdown: zeroCosts(),
                })
                .mockReturnValueOnce({
                  fill_price: 94,
                  filled_size: 8,
                  cost_breakdown: zeroCosts(),
                })
                // Same shape as the ZERO-share-sibling test above: less than
                // even lot 1's own 10-share, so lot 2 gets nothing
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
            // for the SAME poll the flatten resolves in, below
            now = new Date(now.getTime() + 60_000);

            await execution.execute(makeExitGo({ size: 25 }));
            store.armed = true;

            await expect(execution.ingestFills()).resolves.toBeUndefined();

            // Lot 1, iterated BEFORE the flaky lot: unaffected either way —
            // re-armed to its 3 residual exactly as the zero-share-sibling
            // test above
            expect(broker.getProtectedQty('key-lot-1')).toBe(3);

            // Lot 2: the store read failed, so there is no residual figure to
            // re-arm with — never armed, and the fallback alert fires with
            // its full requested size (15) as a conservative upper bound,
            // not a guess at the true, unknowable residual
            expect(broker.getProtectedQty('key-lot-2')).toBeNull();
            expect(residualExposureAlerts.alerts).toEqual([
              {
                trace_id: 'trace-1',
                idempotency_key: 'key-lot-2',
                instrument: 'AAPL',
                side: 'buy',
                residual_qty: 15,
                // The fill read failed, so this is the lot's whole requested
                // size, not the exact residual — and the alert says so
                residual_qty_is_upper_bound: true,
                // No re-arm was attempted at all, so nothing proves the
                // venue could not do one (#1214)
                rearm_unsupported: false,
                stop: 85,
                target: 110,
                observed_at: now,
              },
            ]);

            // Lot 3, iterated AFTER the flaky lot: THIS is the regression the
            // unguarded read caused — its entry fill must still be ingested
            // in the SAME poll despite lot 2's read failing first
            const lot3 = await store.getPosition('key-lot-3');
            expect(lot3?.filled_size).toBe(8);
            expect(lot3?.order_state).toBe('filled');
          },
        );

        it(
          'contains an UNATTRIBUTABLE flatten to itself: the unrelated lot still advances, the ' +
            'flatten-named lots take none of its fill, and the poll names the offending row (#575)',
          async () => {
            // The third instance of the blast-radius shape #524 and #569 each
            // fixed once: `redistributeFlattenFills` was awaited UNGUARDED
            // above `ingestFills`' per-lot loop, so a corrupt
            // `flatten_submissions` row aborted the whole poll before a single
            // lot advanced — and, being a DURABLE row, aborted every
            // subsequent poll identically. During a 14-day unattended soak
            // (#238) that is a permanent halt to fill persistence, not a
            // transient error
            //
            // Driven through the REAL sqlite store with a genuinely
            // unparseable `lot_held_quantities` — the column PR #574 added,
            // which is what widened this call site from two throw paths to
            // five — rather than a fake store that rejects, so the actual
            // `JSON.parse` path is the thing being contained
            const { store } = openTestExecutionStore();
            let now = NOW;
            const steppingClock: Clock = { now: () => now };
            const costModel: CostModel = {
              fill: vi
                .fn()
                .mockReturnValueOnce({
                  fill_price: 90,
                  filled_size: 10,
                  cost_breakdown: zeroCosts(),
                })
                .mockReturnValueOnce({
                  fill_price: 92,
                  filled_size: 15,
                  cost_breakdown: zeroCosts(),
                })
                .mockReturnValueOnce({
                  fill_price: 94,
                  filled_size: 8,
                  cost_breakdown: zeroCosts(),
                })
                .mockReturnValueOnce({
                  fill_price: 100,
                  filled_size: 25,
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
            // Deliberately NOT ingested yet — lot 3's entry fill is the
            // UNRELATED work that must still land in the SAME poll the corrupt
            // flatten row is read in. It is also why the exit below is sized
            // to 25 and not 33: lot 3 holds nothing yet
            now = new Date(now.getTime() + 60_000);

            // Writes the journal row (naming lots 1 and 2) and submits the
            // flatten under its own fresh key
            await execution.execute(makeExitGo({ size: 25 }));
            // Corrupted AFTER the write-ahead, before the fill is read back —
            // the only window in which this row is ever consulted
            store.ageFlattenHeldQuantities('key-aapl-1355', '{not json');

            // Fail-CLOSED and VISIBLE, not silent: the poll still reports the
            // failure, and the message names the offending row's own
            // idempotency key (never the raw column content — the
            // `getFlattenAttribution` rule, since an uncaught throw here is
            // durably recorded to `audit_log` by #507)
            await expect(execution.ingestFills()).rejects.toThrow('key-aapl-1355');

            // THE FIX: lot 3 is untouched by the corrupt flatten and advances
            // in the very same poll. Before #575 this assertion failed —
            // `ingestFills` threw before its per-lot loop began
            const lot3 = await store.getPosition('key-lot-3');
            expect(lot3?.filled_size).toBe(8);
            expect(lot3?.order_state).toBe('filled');

            // The flatten's own named lots: NOTHING of its fill is attributed
            // to them. Guessing a split off a corrupt row would mis-assign
            // quantity on the money path, which is worse than not advancing
            const exitSizes = await store.getExitFillSizes(['key-lot-1', 'key-lot-2']);
            expect(exitSizes.get('key-lot-1')).toBeUndefined();
            expect(exitSizes.get('key-lot-2')).toBeUndefined();
            expect((await store.getPosition('key-lot-1'))?.order_state).toBe('filled');
            expect((await store.getPosition('key-lot-2'))?.order_state).toBe('filled');
            expect(await store.getClosedTrades()).toEqual([]);

            // And they are not re-armed either: the throw happens inside
            // `getFlattenAttribution`, so which lots this flatten named is
            // itself unknown. Pinned so the naked residual this leaves is a
            // recorded consequence of the containment, not a surprise
            expect(broker.getProtectedQty('key-lot-1')).toBeNull();
            expect(broker.getProtectedQty('key-lot-2')).toBeNull();
            expect(residualExposureAlerts.alerts).toEqual([]);
          },
        );
      });
    });
  });
});

/**
 * #1087 review, pass 2 (kimi): `simulated-adapter.test.ts`'s stale-mark
 * regression test drives `SimulatedBrokerAdapter` directly — it never calls
 * `execute()` (so no `OpenPosition.opened_at` is ever written) and never
 * calls `ingestFills()` (so the global `since` floor `ingestFills()` itself
 * computes from `getOpenPositions()` is never exercised; the adapter test
 * hands `fetchNewFills` a hand-picked `NOW`, standing in for what it ASSUMES
 * `since` would be). This block closes that gap: `execute()` writes the real
 * `opened_at`, `SimulatedBrokerAdapter` prices against a genuinely laggy
 * mark, and `ingestFills()` computes `since` off the real store — the exact
 * end-to-end path the 2026-09-03 paper-soak incident (META) went through.
 */
describe('ExecutionImpl.execute() → ingestFills() — the stale-mark case end-to-end (#1087 review, pass 2)', () => {
  it('never excludes its own entry fill via the since floor, even when the priced mark is laggy', async () => {
    const { store } = openTestExecutionStore();
    // A mark `observed_at` 5 minutes STALE relative to `fixedClock` — the
    // exact shape that pre-#1087 stamped the fill early enough to predate
    // the lot's own `opened_at` when this lot is the store's SOLE open
    // position (making its own `opened_at` the poll's `since` floor)
    const laggyObservedAt = new Date(NOW.getTime() - 5 * 60_000);
    const marketData: MarketDataService = {
      getBars: vi.fn(),
      getMark: vi.fn().mockResolvedValue({
        price: 100,
        observed_at: laggyObservedAt,
        source: 'fixture',
        asset_class: 'stocks',
      }),
      getIndicator: vi.fn().mockResolvedValue({ indicator: 'atr', value: 2, as_of_bar_close: NOW }),
      getSpreadEstimate: vi.fn().mockResolvedValue(0.04),
      getADV: vi.fn().mockResolvedValue(1_000_000),
    } as unknown as MarketDataService;
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.1, commission: 0.2, slippage: 0.05, market_impact: 0.01 },
      }),
    };
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
    const execution = new ExecutionImpl(
      makeInput({ store, broker, costModel, marketData, clock: fixedClock }),
    );

    const result = await execution.execute(makeGo());
    expect(result.status).toBe('submitted');
    // `execute()`'s own write-ahead — `opened_at` is `fixedClock.now()`,
    // read strictly BEFORE `broker.submitBracket` is ever called (execute.ts)
    expect((await store.getPosition('key-aapl-1355'))?.opened_at).toEqual(NOW);
    expect((await store.getPosition('key-aapl-1355'))?.filled_size).toBe(0);

    await execution.ingestFills();

    // The self-referential trap this closes: `since` is this lot's own
    // `opened_at` (the SOLE open position), yet its fill — priced against a
    // mark whose OWN `observed_at` is 5 minutes earlier than that — still
    // lands, because `SimulatedBrokerAdapter` stamps the fill at submit
    // time, never at the mark's (possibly stale) observation time
    const position = await store.getPosition('key-aapl-1355');
    expect(position?.filled_size).toBe(100);
    expect(position?.order_state).toBe('filled');
    expect(await store.getFills('key-aapl-1355')).toHaveLength(1);
  });

  it('#1087 review, pass 3 (T3): the since floor is inclusive of a same-millisecond tie between opened_at and the fill', async () => {
    // Not the laggy-mark case above (an EARLIER fill) — this pins the
    // boundary itself. `fixedClock` returns the identical `NOW` on every
    // call, so this lot's `opened_at` (the SOLE open position, hence the
    // poll's `since` floor) and the fill `SimulatedBrokerAdapter` stamps at
    // submit time are the exact same instant, not merely close — the tie a
    // ms-resolution real clock could also produce if `execute()`'s
    // `opened_at` read and the adapter's own `now` read land in the same
    // millisecond. Confirms both floor comparisons keep a tie rather than
    // drop it: `SimulatedBrokerAdapter.fetchNewFills`'s `>= since`
    // (simulated-adapter.ts) and Alpaca's `collectFill`'s `filledAt < since`
    // guard, which drops only when STRICTLY earlier
    // (alpaca-order-normalization.ts) — so a tie sails through both
    const { store } = openTestExecutionStore();
    const marketData: MarketDataService = {
      getBars: vi.fn(),
      getMark: vi.fn().mockResolvedValue({
        price: 100,
        observed_at: NOW,
        source: 'fixture',
        asset_class: 'stocks',
      }),
      getIndicator: vi.fn().mockResolvedValue({ indicator: 'atr', value: 2, as_of_bar_close: NOW }),
      getSpreadEstimate: vi.fn().mockResolvedValue(0.04),
      getADV: vi.fn().mockResolvedValue(1_000_000),
    } as unknown as MarketDataService;
    const costModel: CostModel = {
      fill: vi.fn().mockReturnValue({
        fill_price: 100,
        filled_size: 100,
        cost_breakdown: { spread_cost: 0.1, commission: 0.2, slippage: 0.05, market_impact: 0.01 },
      }),
    };
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
    const execution = new ExecutionImpl(
      makeInput({ store, broker, costModel, marketData, clock: fixedClock }),
    );

    await execution.execute(makeGo());
    const opened = await store.getPosition('key-aapl-1355');
    expect(opened?.opened_at).toEqual(NOW);

    await execution.ingestFills();

    const position = await store.getPosition('key-aapl-1355');
    expect(position?.filled_size).toBe(100);
    const fills = await store.getFills('key-aapl-1355');
    expect(fills).toHaveLength(1);
    // The actual tie, not just "not excluded": the booked fill's timestamp
    // equals `opened_at` exactly
    expect(fills[0]?.timestamp.getTime()).toBe(opened?.opened_at.getTime());
  });
});

/**
 * #1001: the submit-time snapshot `captureSubmitSnapshot` (execute.ts)
 * attaches to every write-ahead — `decision_price` (always, from
 * `order.entry`, no I/O), a best-effort quote (`MarketDataService.getQuote`)
 * and a best-effort modelled cost breakdown (`CostModel.fill` over the same
 * `MarketState` shape `SimulatedBrokerAdapter.buildMarketState` assembles).
 * Covers both the bracket path (`open_positions`) and the exit path
 * (`flatten_submissions`), the null-quote and read-failure degradations, and
 * the #826 `unpriced_exit` skip that must not touch the market-data port at
 * all.
 */
describe('#1001: submit-time quote and decision price', () => {
  function makeSnapshotMarketData(overrides: Partial<MarketDataService> = {}): MarketDataService {
    const service: MarketDataService = {
      getBars: vi.fn(),
      getMark: vi.fn().mockResolvedValue({
        price: 100.2,
        observed_at: NOW,
        source: 'fixture',
        asset_class: 'stocks',
      }),
      getIndicator: vi.fn().mockResolvedValue({ indicator: 'atr', value: 2, as_of_bar_close: NOW }),
      getSpreadEstimate: vi.fn().mockResolvedValue(0.04),
      getADV: vi.fn().mockResolvedValue(1_000_000),
      getQuote: vi.fn().mockResolvedValue({ bid: 100.1, ask: 100.3, observed_at: NOW }),
      // Required on the port, so it is implemented rather than cast away: the
      // batch read is the single read, per distinct instrument, wrapped in
      // `MarkRead`'s ok/error envelope exactly as the real service does. Reads
      // `service.getMark` (not the literal above) so an `overrides.getMark`
      // stub is honoured here too
      getMarks: async (instruments, asOf) => {
        const marks = new Map<string, MarkRead>();
        for (const instrument of new Set(instruments)) {
          try {
            marks.set(instrument, { ok: true, mark: await service.getMark(instrument, asOf) });
          } catch (error) {
            marks.set(instrument, { ok: false, error });
          }
        }
        return marks;
      },
      ...overrides,
    };
    return service;
  }

  const modelledCostBreakdown = {
    spread_cost: 0.1,
    commission: 0.2,
    slippage: 0.05,
    market_impact: 0.01,
  };

  function makeSnapshotCostModel(overrides: Partial<CostModel> = {}): CostModel {
    return {
      fill: vi.fn().mockReturnValue({
        fill_price: 100,
        filled_size: 100,
        cost_breakdown: modelledCostBreakdown,
      }),
      ...overrides,
    };
  }

  // Hoisted to this describe's scope by #1014's review fix — the
  // Simulated-adapter block below exercises the SAME flatten these two build,
  // and duplicating them per sub-describe would let the two copies drift
  function makeExitGo(overrides: Partial<OrderIntent> = {}): VerdictDecision {
    return makeGo({
      idempotency_key: 'key-aapl-1355',
      intent_type: 'exit',
      side: 'sell',
      size: 40,
      entry: 100,
      stop: 100,
      target: 100,
      metadata: { ...makeIntent().metadata, exit_reason: 'flatten' },
      ...overrides,
    });
  }

  async function seedHeldLot(
    store: ReturnType<typeof openTestExecutionStore>['store'],
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
    });
  }

  /**
   * #1014 review, finding 1. Before this fix `CostModel.fill` ran TWICE per
   * order on the Simulated-adapter path — once in `captureSubmitSnapshot`,
   * once inside `SimulatedBrokerAdapter.submitBracket`/`submitFlatten`
   * pricing the actual fill. The tell was in this very file: every
   * pre-existing simulated-adapter test had to double its
   * `mockReturnValueOnce` chain to keep passing, which is a test bending
   * around a defect rather than pinning a behaviour.
   *
   * The defect is not the wasted call. It is that the two calls are
   * INDEPENDENT: any non-determinism in the cost model (a random slippage
   * draw, a clock-sensitive market state) makes the stored snapshot and the
   * fill's own `cost_breakdown` two different prices of two different draws,
   * and #1001's whole acceptance query is "diff the modelled estimate against
   * the realised fill". A divergence the instrumentation invented is worse
   * than no instrumentation.
   *
   * These tests pin the single call on both simulated paths. Nothing is lost
   * by skipping: the adapter's own breakdown lands on the fill verbatim
   * (`toFill` / `redistributeOneFlatten` only substitute the snapshot when
   * `fill.cost_breakdown === undefined`, which a simulated fill never is), so
   * the acceptance query is answered from the fill row exactly as before.
   */
  describe('Simulated-adapter path — CostModel.fill runs exactly once (#1014 review, finding 1)', () => {
    const SIM_CONFIG = {
      volatility_indicator: {
        indicator: 'atr' as const,
        params: { period: 14 },
        timeframe: '1h' as const,
        lookback: 15,
      },
      adv_window: { timeframe: '1d' as const, lookback: 20 },
    };

    it('prices a bracket entry once — the adapter’s call, not the snapshot’s', async () => {
      const { store } = openTestExecutionStore();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();
      const broker = new SimulatedBrokerAdapter({
        clock: fixedClock,
        costModel,
        marketData,
        config: SIM_CONFIG,
      });

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      expect(costModel.fill).toHaveBeenCalledTimes(1);

      // The snapshot's OTHER fields are unaffected — only the cost-model half
      // is skipped, and the quote read (which has no second writer to
      // disagree with) still runs
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.decision_price).toBe(100);
      expect(position?.quote_bid).toBe(100.1);
      expect(position?.quote_ask).toBe(100.3);
      expect(position?.modelled_cost_breakdown).toBeUndefined();
    });

    it('prices a flatten once, and the adapter’s breakdown still reaches the fill', async () => {
      const { store } = openTestExecutionStore();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();
      const broker = new SimulatedBrokerAdapter({
        clock: fixedClock,
        costModel,
        marketData,
        config: SIM_CONFIG,
      });
      await seedHeldLot(store);

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(costModel.fill).toHaveBeenCalledTimes(1);

      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.decision_price).toBe(100);
      expect(row?.modelled_cost_breakdown_json).toBeNull();

      // The pricing that DID happen is the adapter's, and it carries the full
      // breakdown onto the fill — so nothing #1001 needs is lost by skipping
      // the snapshot's own call
      const fills = await broker.fetchNewFills(new Date(NOW.getTime() - 1));
      expect(fills[0]?.cost_breakdown).toEqual(modelledCostBreakdown);
    });

    it('still prices the snapshot itself when the broker is NOT the Simulated adapter — the skip is not a blanket disable', async () => {
      const { store } = openTestExecutionStore();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();

      const result = await new ExecutionImpl(
        makeInput({ store, broker: makeBroker(), costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      // Two: the entry and, since #1301, the protective exit the same bracket
      // arms — one `MarketState`, two priced events
      expect(costModel.fill).toHaveBeenCalledTimes(2);
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
    });

    // #1032 item 2: the snapshot is the second builder of `MarketState` on
    // the real path (the Simulated adapter is the first); a venue configured
    // on `executionConfig.simulated` must reach the model from here too
    it('stamps MarketState.venue from executionConfig.simulated on the snapshot pricing', async () => {
      const { store } = openTestExecutionStore();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();
      const base = makeInput({ store, broker: makeBroker(), costModel, marketData });

      await new ExecutionImpl({
        ...base,
        config: { simulated: { ...base.config.simulated, venue: 'saxo' } },
      }).execute(makeGo());

      const marketState = vi.mocked(costModel.fill).mock.calls[0]?.[1];
      expect(marketState?.venue).toBe('saxo');
    });
  });

  describe('bracket (entry) path — open_positions', () => {
    it('captures decision_price, the quote bid/ask/mid/observed_at, and the modelled cost breakdown', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      const position = await store.getPosition('key-aapl-1355');
      // order.entry, unrounded — the pre-tick-rounding decision price, never
      // the wire price a real broker may round differently
      expect(position?.decision_price).toBe(100);
      expect(position?.quote_bid).toBe(100.1);
      expect(position?.quote_ask).toBe(100.3);
      expect(position?.quote_mid).toBeCloseTo(100.2, 5);
      expect(position?.quote_observed_at).toEqual(NOW);
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
      expect(marketData.getQuote).toHaveBeenCalledWith('AAPL', NOW);
    });

    it('leaves the quote fields absent but still populates decision_price when getQuote resolves null', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData({ getQuote: vi.fn().mockResolvedValue(null) });

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.decision_price).toBe(100);
      expect(position?.quote_bid).toBeUndefined();
      expect(position?.quote_ask).toBeUndefined();
      expect(position?.quote_mid).toBeUndefined();
      expect(position?.quote_observed_at).toBeUndefined();
      // The cost-model read is independent of the quote read — it still ran
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
    });

    it('never blocks submission when getQuote throws — logs and leaves the quote fields absent', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData({
        getQuote: vi.fn().mockRejectedValue(new Error('quote feed down')),
      });

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.decision_price).toBe(100);
      expect(position?.quote_bid).toBeUndefined();
      // The independent cost-model try/catch is unaffected by the quote one
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
    });

    it('never blocks submission when the cost-model MarketState assembly throws — modelled_cost_breakdown left absent', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData({
        getMark: vi.fn().mockRejectedValue(new Error('mark feed down')),
      });

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.decision_price).toBe(100);
      // The independent quote try/catch is unaffected by the cost-model one
      expect(position?.quote_bid).toBe(100.1);
      expect(position?.modelled_cost_breakdown).toBeUndefined();
      // #1301: priced in the same try/catch, so it is absent with it
      expect(position?.modelled_protective_exit_cost_breakdown).toBeUndefined();
    });

    /**
     * #1301: the bracket arms stop/target legs at submit time, so their cost is
     * modelled at submit time too — off the SAME `MarketState`, in the same
     * pass, keeping this one derivation per priced event (#1121 AC6) rather
     * than a second one at ingest
     */
    it('prices the protective exit alongside the entry, closing side and market order, on one MarketState', async () => {
      const { store } = openTestExecutionStore();
      const protectiveBreakdown = {
        spread_cost: 9,
        commission: 8,
        slippage: 7,
        market_impact: 6,
      };
      const costModel: CostModel = {
        fill: vi
          .fn()
          .mockReturnValueOnce({
            fill_price: 100,
            filled_size: 100,
            cost_breakdown: modelledCostBreakdown,
          })
          .mockReturnValueOnce({
            fill_price: 95,
            filled_size: 100,
            cost_breakdown: protectiveBreakdown,
          }),
      };

      const result = await new ExecutionImpl(
        makeInput({ store, broker: makeBroker(), costModel, marketData: makeSnapshotMarketData() }),
      ).execute(makeGo());

      expect(result.status).toBe('submitted');
      const calls = vi.mocked(costModel.fill).mock.calls;
      const entryRequest = calls[0]?.[0];
      const protectiveRequest = calls[1]?.[0];
      expect(entryRequest?.side).toBe('buy');
      expect(protectiveRequest?.side).toBe('sell');
      expect(protectiveRequest?.order_type).toBe('market');
      expect(protectiveRequest?.limit_price).toBeUndefined();
      expect(protectiveRequest?.size).toBe(entryRequest?.size);
      // The same assembled market state, not a second read of the feed
      expect(calls[1]?.[1]).toBe(calls[0]?.[1]);

      const position = await store.getPosition('key-aapl-1355');
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
      expect(position?.modelled_protective_exit_cost_breakdown).toEqual(protectiveBreakdown);
    });
  });

  describe('exit (flatten) path — flatten_submissions', () => {
    it('captures decision_price, the quote, and the modelled cost breakdown on a normal flatten', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.decision_price).toBe(100);
      expect(row?.quote_bid).toBe(100.1);
      expect(row?.quote_ask).toBe(100.3);
      expect(row?.quote_mid).toBeCloseTo(100.2, 5);
      expect(row?.quote_observed_at).not.toBeNull();
      expect(
        row === null || row.modelled_cost_breakdown_json === null
          ? null
          : JSON.parse(row.modelled_cost_breakdown_json),
      ).toEqual(modelledCostBreakdown);
      // #826: an exit's cost-model FillRequest prices a market order, not a
      // limit — `order_type: 'market'`, no `limit_price` key at all — since a
      // flatten's `entry`/`stop`/`target` are degenerate placeholders, never
      // a real limit
      const fillRequestArg = (costModel.fill as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        order_type: string;
        limit_price?: number;
      };
      expect(fillRequestArg.order_type).toBe('market');
      expect(fillRequestArg).not.toHaveProperty('limit_price');
    });

    it('skips every market-data read for an unpriced exit (#826) AND nulls decision_price rather than persisting the 0 placeholder', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);
      const costModel = makeSnapshotCostModel();
      const marketData = makeSnapshotMarketData();

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(
        makeExitGo({
          metadata: {
            ...makeIntent().metadata,
            exit_reason: 'flatten',
            unpriced_exit: true,
          },
        }),
      );

      expect(result.status).toBe('submitted');
      expect(marketData.getQuote).not.toHaveBeenCalled();
      expect(marketData.getMark).not.toHaveBeenCalled();
      expect(marketData.getIndicator).not.toHaveBeenCalled();
      expect(marketData.getSpreadEstimate).not.toHaveBeenCalled();
      expect(marketData.getADV).not.toHaveBeenCalled();
      expect(costModel.fill).not.toHaveBeenCalled();

      const row = await store.getFlattenSubmission('key-aapl-1355');
      // #1014 review, finding 2. This assertion read `.toBe(100)` before that
      // review, and 100 was a FICTION: an unpriced flatten's `order.entry` is
      // `readExitPrice`'s `price: 0` sentinel (decide.ts) — the feed was dark,
      // so no price was known — and the 100 only appeared because
      // `makeExitGo` overrides the metadata without touching `makeIntent`'s
      // entry. In production this column would have carried the 0, and the
      // Feedback Loop's live-vs-modelled divergence check would have read a
      // ~100% divergence for every dark-feed flatten. `null` says the one
      // true thing: no decision price existed for this order
      expect(row?.decision_price).toBeNull();
      expect(row?.quote_bid).toBeNull();
      expect(row?.quote_ask).toBeNull();
      expect(row?.quote_mid).toBeNull();
      expect(row?.quote_observed_at).toBeNull();
      expect(row?.modelled_cost_breakdown_json).toBeNull();
    });

    it('keeps the last known mark as decision_price on a PRICED flatten — the placeholder concern is the unpriced case alone (#1014 review, finding 2)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

      // `decide.ts` sets an exit's `entry`/`stop`/`target` all three to
      // `readExitPrice`'s mark. Degenerate as a BRACKET — nothing consults
      // them, `executeExit` submits a market flatten — but the VALUE is the
      // real mark read when the exit was decided, which is exactly the "last
      // known mark" #1014's review offers as the honest substitute. So it is
      // kept, not nulled: nulling it too would throw away the only reference
      // price an exit fill has to be diffed against (#1001's whole point)
      const result = await new ExecutionImpl(
        makeInput({
          store,
          broker,
          costModel: makeSnapshotCostModel(),
          marketData: makeSnapshotMarketData(),
        }),
      ).execute(makeExitGo({ entry: 123.45, stop: 123.45, target: 123.45 }));

      expect(result.status).toBe('submitted');
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.decision_price).toBe(123.45);
    });

    /**
     * The #826 latency property, and the reason `captureSubmitSnapshot` takes
     * a `budget_ms` at all. Every read it makes routes through
     * `fetchWithTimeout` (10s) under `withRetry` (3 attempts), so a stalled
     * feed costs ~30s per read group — and this is the mandatory
     * flat-by-close path, where verdict/index.ts already refuses to pay ONE
     * such budget. Unbounded, the snapshot would pay two before the flatten
     * order was even submitted.
     *
     * Driven on fake timers so the stall is 30s of MODEL time: advancing only
     * the 2s budget and asserting the flatten has already reached the broker
     * is exactly the claim — the exit does not wait for the feed. Against the
     * unbounded version this fails on `flattenCalls` being empty at that
     * point, rather than hanging the suite.
     */
    it('submits the flatten within its 2s snapshot budget even when the feed stalls for 30s (#826)', async () => {
      vi.useFakeTimers();
      try {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store);
        const costModel = makeSnapshotCostModel();
        const stalled = <T>(value: T): Promise<T> =>
          new Promise<T>((resolve) => setTimeout(() => resolve(value), 30_000));
        const marketData = makeSnapshotMarketData({
          getQuote: vi
            .fn()
            .mockImplementation(() => stalled({ bid: 100.1, ask: 100.3, observed_at: NOW })),
          getMark: vi.fn().mockImplementation(() =>
            stalled({
              price: 100.2,
              observed_at: NOW,
              source: 'fixture',
              asset_class: 'stocks' as const,
            }),
          ),
        });

        const pending = new ExecutionImpl(
          makeInput({ store, broker, costModel, marketData }),
        ).execute(makeExitGo());

        // The whole budget, and not one tick of the 30s stall beyond it
        await vi.advanceTimersByTimeAsync(2_000);
        expect(broker.flattenCalls).toHaveLength(1);

        const result = await pending;
        expect(result.status).toBe('submitted');

        // The acceptance criterion (#1001) still holds for the field that
        // needs no I/O; the sample the stall costs is the quote and the
        // modelled breakdown, which is the trade #826 already makes
        const row = await store.getFlattenSubmission('key-aapl-1355');
        expect(row?.decision_price).toBe(100);
        expect(row?.quote_bid).toBeNull();
        expect(row?.quote_ask).toBeNull();
        expect(row?.quote_mid).toBeNull();
        expect(row?.modelled_cost_breakdown_json).toBeNull();

        // Let the abandoned reads settle so no timer outlives the test
        await vi.advanceTimersByTimeAsync(30_000);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

function closedTradesRealizedPnl(trades: readonly { realized_pnl_net: number }[]): number {
  return trades.reduce((sum, trade) => sum + trade.realized_pnl_net, 0);
}
