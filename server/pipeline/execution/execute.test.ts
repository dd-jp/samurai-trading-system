import type { MarketDataService, MarkRead } from '../../providers/market-data-service/index.js';
import type { Clock, Fill, OpenPosition, OrderIntent } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import type { CostModel } from '../../tools/backtest/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { sanitizeBrokerError } from './broker-error.js';

function hostileThrownValue(): Record<string, unknown> {
  const hostile: Record<string, unknown> = {
    [Symbol.toPrimitive]: () => {
      throw new Error('render boom');
    },
  };
  hostile.self = hostile;
  return hostile;
}

function invariant(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
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

interface FlattenCall {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;
  clientOrderId: string;
}

interface CancelCall {
  clientOrderId: string;
  instrument: string;
}

interface RearmCall {
  clientOrderId: string;
  instrument: string;
  side: 'buy' | 'sell';
  qty: number;
  stop: number;
  target: number;
}

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
  callSequence: string[];
} {
  const calls: NativeBracketRequest[] = [];
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
    async fetchNewFills(): Promise<NormalizedFill[]> {
      return [];
    },
    async resizeProtectiveLegs(): Promise<void> {},
    async getOrder(): Promise<never> {
      throw new Error('makeBroker.getOrder: execute() does not reconcile');
    },
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
    async cancel(clientOrderId: string, instrument: string): Promise<void> {
      const call = { clientOrderId, instrument };
      cancelCalls.push(call);
      callSequence.push(`cancel:${clientOrderId}`);
      await onCancel?.(call);
    },
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
    async resumeFlatten(): Promise<never> {
      throw new Error('makeBroker.resumeFlatten: execute() does not reconcile');
    },
  };
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

  it('persists the pending record BEFORE calling the broker', async () => {
    const { store } = openTestExecutionStore();
    let stateAtSubmit: OpenPosition | null = null;
    const broker = makeBroker(async () => {
      stateAtSubmit = await store.getPosition('key-aapl-1355');
    });

    await new ExecutionImpl(makeInput({ store, broker })).execute(makeGo());

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

  it('returns deduped when a concurrent execute() wins the write-ahead race', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

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

  it('rethrows a non-constraint write-ahead failure instead of reporting deduped', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();

    const failingStore: typeof store = Object.create(store);
    failingStore.writeAheadPosition = async () => {
      throw new Error('database or disk is full');
    };
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
    expect(second.order_state).toBeNull();
    expect(broker.calls).toHaveLength(1);
  });

  it('dedupes the loser of a concurrent race on the same key', async () => {
    const { store } = openTestExecutionStore();
    const broker = makeBroker();
    const execution = new ExecutionImpl(makeInput({ store, broker }));

    const [first, second] = await Promise.all([
      execution.execute(makeGo()),
      execution.execute(makeGo()),
    ]);

    expect([first?.status, second?.status].sort()).toEqual(['deduped', 'submitted']);
    expect(store.writeLog.filter((entry) => entry.startsWith('write-ahead')).length).toBe(2);
    const deduped = first?.status === 'deduped' ? first : second;
    expect(deduped?.reason).toBe('an order or fill already exists for this idempotency_key');
    expect(deduped?.broker_order_ids).toBeNull();
    expect(broker.calls).toHaveLength(1);
    expect(await store.countAllPositions()).toBe(1);
  });

  it('rethrows a write-ahead failure that is not a duplicate key', async () => {
    const { store } = openTestExecutionStore();
    vi.spyOn(store, 'writeAheadPosition').mockRejectedValue(new Error('disk full'));
    const broker = makeBroker();

    await expect(new ExecutionImpl(makeInput({ store, broker })).execute(makeGo())).rejects.toThrow(
      'disk full',
    );
    expect(broker.calls).toHaveLength(0);
  });

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

    expect(result.status).toBe('error');
    expect(result.reason).toBe('[unrenderable error]');
    expect(result.order_state).toBe('pending');
    expect((await store.getPosition('key-aapl-1355'))?.order_state).toBe('pending');
  });

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
    function makeExitGo(overrides: Partial<OrderIntent> = {}): VerdictDecision {
      return makeGo({
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

      expect(broker.cancelCalls).toEqual([
        { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
      ]);
      expect(broker.flattenCalls).toEqual([
        {
          instrument: 'AAPL',
          side: 'sell',
          size: 40,
          clientOrderId: 'key-aapl-1355',
        },
      ]);
      expect(broker.callSequence).toEqual([
        'cancel:key-aapl-entry-1',
        'submitFlatten:key-aapl-1355',
      ]);
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

    it('writes no OpenPosition row for the flatten — only the flatten_submissions journal', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker();
      await seedHeldLot(store);

      await new ExecutionImpl(makeInput({ store, broker })).execute(makeExitGo());

      expect(await store.countAllPositions()).toBe(1);
      expect(store.writeLog).not.toContain('write-ahead:key-aapl-1355');
      expect(await store.countAllFlattenSubmissions()).toBe(1);
    });

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
        'write-ahead:key-aapl-entry-1',
        'write-ahead-flatten:key-aapl-1355',
        'resolve-flatten:key-aapl-1355:submitted',
      ]);
    });

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

      expect(result.status).toBe('error');
      expect(result.reason).toBe('[unrenderable error]');
      expect(result.order_state).toBeNull();
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('submitting');
      expect(row?.reason).toBeNull();
    });

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

      expect(await store.getUnprotectedResidualLots()).toEqual([]);
    });

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

      const marked = await store.getUnprotectedResidualLots();
      expect(marked.map((lot) => lot.position.idempotency_key)).toEqual(['key-aapl-entry-1']);
      const row = await store.getFlattenSubmission('key-aapl-1355');
      expect(row?.status).toBe('error');
      expect(row?.reason).toContain('[unrenderable error]');
      expect(result.status).toBe('error');
      expect(result.reason).toContain('[unrenderable error]');
      expect(broker.flattenCalls).toHaveLength(0);
    });

    it('the #549 sweep then re-arms the lot this path marked, at its full held size (#867)', async () => {
      const { store } = openTestExecutionStore();
      const broker = makeBroker(undefined, undefined, ({ clientOrderId }) => {
        if (clientOrderId === 'key-aapl-entry-2') throw new Error('venue timeout on cancel');
      });
      await seedHeldLot(store);
      await seedHeldLot(store, { idempotency_key: 'key-aapl-entry-2' });
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
      expect(await store.getUnprotectedResidualLots()).toEqual([]);
    });

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

    describe('one flatten per instrument (#1214 review)', () => {
      const REFLATTEN_KEY = 'key-aapl-entry-1:residual-reflatten-1';

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
        expect(result.status).toBe('deduped');
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
        expect(broker.cancelCalls).toEqual([]);
        expect(await store.getFlattenSubmission('key-aapl-1355')).toBeNull();
      });

      it('proceeds again once reconcile settles a re-flatten the venue refused without filling', async () => {
        const { store } = openTestExecutionStore();
        await seedHeldLot(store);
        await seedLiveReflatten(store);

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

      describe('an unresolvable acked flatten is bounded, not permanent', () => {
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
          const row = await store.getFlattenSubmission(REFLATTEN_KEY);
          expect(row?.status).toBe('error');
          expect(row?.reason).toContain(
            'DECISION on one unanswered check against a row that old, not proof',
          );
          expect(row?.reason).toContain('not a record of repeated denial');
          expect(await store.getUnresolvedFlattens()).toEqual([]);

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
        expect(broker.cancelCalls).toEqual([
          { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
          { clientOrderId: 'key-aapl-entry-1', instrument: 'AAPL' },
        ]);

        const original = await store.getFlattenSubmission('key-aapl-1355');
        expect(original?.status).toBe('error');
        const retry = await store.getFlattenSubmission('key-aapl-1355:retry-1');
        expect(retry?.status).toBe('submitted');
        expect(await store.countAllFlattenSubmissions()).toBe(2);
      });

      it('still dedupes (does not retry) when the prior attempt is stuck at submitting — a lost ack is genuinely ambiguous', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker(undefined, () => {
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
        expect(await store.isRetryableFlattenError('key-aapl-1355')).toBe(false);
      });

      it('caps retries at MAX_EXIT_RETRY_ATTEMPTS: after that many consecutive retryable errors, the next call dedupes instead of retrying forever', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker(undefined, undefined, () => {
          throw new Error('venue timeout on cancel');
        });
        await seedHeldLot(store);
        const execution = new ExecutionImpl(makeInput({ store, broker }));

        const results = [];
        for (let i = 0; i < 5; i++) {
          results.push(await execution.execute(makeExitGo()));
        }

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

        const result = await new ExecutionImpl(makeInput({ store, broker })).execute(
          makeExitGo({ size: 10 }),
        );

        expect(result.status).toBe('error');
        expect(result.reason).toContain('10');
        expect(result.reason).toContain('6');
        expect(broker.cancelCalls).toHaveLength(0);
        expect(broker.flattenCalls).toHaveLength(0);
        expect(await store.countAllFlattenSubmissions()).toBe(0);
      });

      it('refuses, naming the lot, when the fill record shows more closed than the lot ever opened', async () => {
        const { store } = openTestExecutionStore();
        const broker = makeBroker();
        await seedHeldLot(store, { requested_size: 10, filled_size: 10 });
        await recordExitFill(store, 12);

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

      const result = await new ExecutionImpl(
        makeInput({ store, broker, costModel, marketData }),
      ).execute(makeExitGo());

      expect(result.status).toBe('submitted');
      expect(result.broker_order_ids).toEqual(['key-aapl-1355:flatten']);
      expect(await store.countAllPositions()).toBe(1);
    });

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
          idempotency_key: 'key-aapl-entry-1',
          debate_id: 'debate-abc123',
          instrument: 'AAPL',
          side: 'buy',
          filled_size: 40,
          close_reason: 'flatten',
        });
        expect(closedTrades[0].realized_pnl_net).toBeCloseTo(180 - 0.2, 6);
        expect(closedTrades[0].fees_total).toBeCloseTo(0.2, 6);

        expect((await store.getPosition('key-aapl-entry-1'))?.order_state).toBe('closed');
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

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
        expect(byKey.get('key-lot-1')?.realized_pnl_net).toBeCloseTo((100 - 90) * 10, 6);
        expect(byKey.get('key-lot-2')?.realized_pnl_net).toBeCloseTo((100 - 92) * 15, 6);
        expect(await store.getOpenPositions()).toHaveLength(0);
      });

      it('gives a partially-filled multi-lot flatten a stable split across repeated polls, closing what it can and leaving the rest genuinely open', async () => {
        const { store } = openTestExecutionStore();
        let now = NOW;
        const steppingClock: Clock = { now: () => now };
        const costModel: CostModel = {
          fill: vi
            .fn()
            .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
            .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() })
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
        await execution.ingestFills();
        await execution.ingestFills();
        await execution.ingestFills();

        const closedTrades = await store.getClosedTrades();
        expect(closedTrades).toHaveLength(1);
        expect(closedTrades[0]).toMatchObject({ idempotency_key: 'key-lot-1', filled_size: 10 });

        const lot2 = await store.getPosition('key-lot-2');
        expect(lot2?.order_state).toBe('filled');
        const lot2ExitQty = (await store.getFills('key-lot-2'))
          .filter((fill) => fill.leg === 'exit')
          .reduce((sum, fill) => sum + fill.qty, 0);
        expect(lot2ExitQty).toBe(10);
        expect(await store.getOpenPositions()).toHaveLength(1);
      });

      describe('multi-lot split by journalled held quantity (#571)', () => {
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
          invariant(
            first.status === 'submitted',
            `expected the first exit to submit, got ${first.status}`,
          );
          await execution.ingestFills();
          now = new Date(now.getTime() + 60_000);

          const lot1ExitFillSize = (await store.getExitFillSizes(['key-lot-1', 'key-lot-2'])).get(
            'key-lot-1',
          );
          invariant(
            lot1ExitFillSize === firstFlattenQty,
            `expected key-lot-1's exit fill size to be ${firstFlattenQty}, got ${lot1ExitFillSize}`,
          );
          const openPositions = await store.getOpenPositions();
          invariant(
            openPositions.length === 2,
            `expected 2 open positions, got ${openPositions.length}`,
          );

          const second = await execution.execute(
            makeExitGo({ idempotency_key: 'key-exit-2', size: 11 }),
          );
          invariant(
            second.status === 'submitted',
            `expected the second exit to submit, got ${second.status}`,
          );

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
          expect(JSON.parse(journal?.lot_held_quantities ?? 'null')).toEqual([6, 5]);
          expect(journal?.size).toBe(11);
        });

        it('covers each lot with exactly its own held quantity, closing both and leaving no phantom', async () => {
          const { store } = openTestExecutionStore();

          const { execution, broker } = await seedTwoLotsWithPriorExit(store, 4, 11);
          await execution.ingestFills();
          await execution.ingestFills();

          const closedTrades = await store.getClosedTrades();
          expect(closedTrades).toHaveLength(2);
          const byKey = new Map(closedTrades.map((trade) => [trade.idempotency_key, trade]));

          expect(byKey.get('key-lot-1')).toMatchObject({ filled_size: 10 });
          expect(byKey.get('key-lot-1')?.realized_pnl_net).toBeCloseTo((99.6 - 90) * 10, 6);
          expect(byKey.get('key-lot-2')).toMatchObject({ filled_size: 5 });
          expect(byKey.get('key-lot-2')?.realized_pnl_net).toBeCloseTo((100 - 92) * 5, 6);

          expect(await store.getOpenPositions()).toEqual([]);
          expect((await store.getPosition('key-lot-2'))?.order_state).toBe('closed');
          expect(broker.getProtectedQty('key-lot-2')).toBeNull();
          expect(broker.getProtectedQty('key-lot-1')).toBeNull();
        });

        it('splits a PARTIAL fill identically across repeated polls when a lot has prior exits', async () => {
          const { store } = openTestExecutionStore();

          const { execution, broker } = await seedTwoLotsWithPriorExit(store, 4, 8);
          await execution.ingestFills();
          await execution.ingestFills();
          await execution.ingestFills();

          const closedTrades = await store.getClosedTrades();
          expect(closedTrades).toHaveLength(1);
          expect(closedTrades[0]).toMatchObject({ idempotency_key: 'key-lot-1', filled_size: 10 });
          expect(closedTrades[0]?.realized_pnl_net).toBeCloseTo((99.6 - 90) * 10, 6);

          const lot2ExitQty = (await store.getFills('key-lot-2'))
            .filter((lotFill) => lotFill.leg === 'exit')
            .reduce((sum, lotFill) => sum + lotFill.qty, 0);
          expect(lot2ExitQty).toBe(2);
          expect(await store.getOpenPositions()).toHaveLength(1);
          expect(broker.getProtectedQty('key-lot-2')).toBe(3);
        });

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
          store.ageFlattenHeldQuantities('key-exit-1');

          await execution.ingestFills();

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
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(40);

          const exitResult = await execution.execute(makeExitGo({ size: 40 }));
          expect(exitResult.status).toBe('submitted');
          await execution.ingestFills();

          expect(await store.getOpenPositions()).toHaveLength(1);
          expect(await store.getClosedTrades()).toHaveLength(0);
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(15);
          expect(residualExposureAlerts.alerts).toEqual([]);
        });

        it('sizes and accepts a SECOND exit at the residual, and refuses one sized to the original lot', async () => {
          const { store } = openTestExecutionStore();
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 95, filled_size: 40, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({ fill_price: 99, filled_size: 25, cost_breakdown: zeroCosts() })
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

          expect(await store.getClosedTrades()).toHaveLength(0);
          const openLot = (await store.getOpenPositions())[0];
          expect(openLot?.filled_size).toBe(40);
          expect((await store.getExitFillSizes(['key-aapl-entry-1'])).get('key-aapl-entry-1')).toBe(
            25,
          );

          const oversized = await execution.execute(
            makeExitGo({ idempotency_key: 'key-aapl-1400', size: 40 }),
          );
          expect(oversized.status).toBe('error');
          expect(oversized.reason).toContain('does not match the held quantity 15');
          expect(broker.getProtectedQty('key-aapl-entry-1')).toBe(15);

          const residualExit = await execution.execute(
            makeExitGo({ idempotency_key: 'key-aapl-1405', size: 15 }),
          );
          expect(residualExit.status).toBe('submitted');
          await execution.ingestFills();

          expect(await store.getOpenPositions()).toEqual([]);
          const closed = await store.getClosedTrades();
          expect(closed).toHaveLength(1);
          expect(closed[0]).toMatchObject({ idempotency_key: 'key-aapl-entry-1', filled_size: 40 });
        });

        it('re-arms a sibling lot that got ZERO share of a partial flatten fill', async () => {
          const { store } = openTestExecutionStore();
          let now = NOW;
          const steppingClock: Clock = { now: () => now };
          const costModel: CostModel = {
            fill: vi
              .fn()
              .mockReturnValueOnce({ fill_price: 90, filled_size: 10, cost_breakdown: zeroCosts() })
              .mockReturnValueOnce({ fill_price: 92, filled_size: 15, cost_breakdown: zeroCosts() })
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

          expect(broker.getProtectedQty('key-lot-1')).toBe(3);
          expect(broker.getProtectedQty('key-lot-2')).toBe(15);
          expect(await store.getOpenPositions()).toHaveLength(2);
          expect(await store.getClosedTrades()).toHaveLength(0);
          expect(residualExposureAlerts.alerts).toEqual([]);
        });

        it(
          "one lot's re-arm store-read failure alerts for that lot alone and does not abort " +
            'ingestion for the OTHER lots in the same poll (#569)',
          async () => {
            class FlakyGetFillsStore extends TestExecutionStore {
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
            now = new Date(now.getTime() + 60_000);

            await execution.execute(makeExitGo({ size: 25 }));
            store.armed = true;

            await expect(execution.ingestFills()).resolves.toBeUndefined();

            expect(broker.getProtectedQty('key-lot-1')).toBe(3);

            expect(broker.getProtectedQty('key-lot-2')).toBeNull();
            expect(residualExposureAlerts.alerts).toEqual([
              {
                trace_id: 'trace-1',
                idempotency_key: 'key-lot-2',
                instrument: 'AAPL',
                side: 'buy',
                residual_qty: 15,
                residual_qty_is_upper_bound: true,
                rearm_unsupported: false,
                stop: 85,
                target: 110,
                observed_at: now,
              },
            ]);

            const lot3 = await store.getPosition('key-lot-3');
            expect(lot3?.filled_size).toBe(8);
            expect(lot3?.order_state).toBe('filled');
          },
        );

        it(
          'contains an UNATTRIBUTABLE flatten to itself: the unrelated lot still advances, the ' +
            'flatten-named lots take none of its fill, and the poll names the offending row (#575)',
          async () => {
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
            now = new Date(now.getTime() + 60_000);

            await execution.execute(makeExitGo({ size: 25 }));
            store.ageFlattenHeldQuantities('key-aapl-1355', '{not json');

            await expect(execution.ingestFills()).rejects.toThrow('key-aapl-1355');

            const lot3 = await store.getPosition('key-lot-3');
            expect(lot3?.filled_size).toBe(8);
            expect(lot3?.order_state).toBe('filled');

            const exitSizes = await store.getExitFillSizes(['key-lot-1', 'key-lot-2']);
            expect(exitSizes.get('key-lot-1')).toBeUndefined();
            expect(exitSizes.get('key-lot-2')).toBeUndefined();
            expect((await store.getPosition('key-lot-1'))?.order_state).toBe('filled');
            expect((await store.getPosition('key-lot-2'))?.order_state).toBe('filled');
            expect(await store.getClosedTrades()).toEqual([]);

            expect(broker.getProtectedQty('key-lot-1')).toBeNull();
            expect(broker.getProtectedQty('key-lot-2')).toBeNull();
            expect(residualExposureAlerts.alerts).toEqual([]);
          },
        );
      });
    });
  });
});

describe('ExecutionImpl.execute() → ingestFills() — the stale-mark case end-to-end (#1087 review, pass 2)', () => {
  it('never excludes its own entry fill via the since floor, even when the priced mark is laggy', async () => {
    const { store } = openTestExecutionStore();
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
    expect((await store.getPosition('key-aapl-1355'))?.opened_at).toEqual(NOW);
    expect((await store.getPosition('key-aapl-1355'))?.filled_size).toBe(0);

    await execution.ingestFills();

    const position = await store.getPosition('key-aapl-1355');
    expect(position?.filled_size).toBe(100);
    expect(position?.order_state).toBe('filled');
    expect(await store.getFills('key-aapl-1355')).toHaveLength(1);
  });

  it('#1087 review, pass 3 (T3): the since floor is inclusive of a same-millisecond tie between opened_at and the fill', async () => {
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
    expect(fills[0]?.timestamp.getTime()).toBe(opened?.opened_at.getTime());
  });
});

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
      expect(costModel.fill).toHaveBeenCalledTimes(2);
      const position = await store.getPosition('key-aapl-1355');
      expect(position?.modelled_cost_breakdown).toEqual(modelledCostBreakdown);
    });

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
      expect(position?.quote_bid).toBe(100.1);
      expect(position?.modelled_cost_breakdown).toBeUndefined();
      expect(position?.modelled_protective_exit_cost_breakdown).toBeUndefined();
    });

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
      type FillCall = Parameters<CostModel['fill']>;
      const [[entryRequest, entryState], [protectiveRequest, protectiveState]] = vi.mocked(
        costModel.fill,
      ).mock.calls as unknown as [FillCall, FillCall];
      expect(entryRequest.side).toBe('buy');
      expect(protectiveRequest.side).toBe('sell');
      expect(protectiveRequest.order_type).toBe('market');
      expect(protectiveRequest.limit_price).toBeUndefined();
      expect(protectiveRequest.size).toBe(entryRequest.size);
      expect(protectiveState).toBe(entryState);

      expect(await store.getPosition('key-aapl-1355')).toMatchObject({
        modelled_cost_breakdown: modelledCostBreakdown,
        modelled_protective_exit_cost_breakdown: protectiveBreakdown,
      });
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

        await vi.advanceTimersByTimeAsync(2_000);
        expect(broker.flattenCalls).toHaveLength(1);

        const result = await pending;
        expect(result.status).toBe('submitted');

        const row = await store.getFlattenSubmission('key-aapl-1355');
        expect(row?.decision_price).toBe(100);
        expect(row?.quote_bid).toBeNull();
        expect(row?.quote_ask).toBeNull();
        expect(row?.quote_mid).toBeNull();
        expect(row?.modelled_cost_breakdown_json).toBeNull();

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
