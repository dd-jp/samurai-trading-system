/**
 * The #1186 wedged-zero-fill sweep, unit-level: `sweepWedgedZeroFillLots`
 * called directly rather than through `reconcile()` (that integration —
 * "a restart finds an already-wedged lot with no adapter memory of it" — is
 * `reconcile.test.ts`'s "the wedged-zero-fill sweep (#1186)" describe block).
 */
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { Clock, Logger, OpenPosition } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import type { CostModel } from '../../tools/backtest/index.js';
import { FilledZeroSizeThrottle } from './filled-zero-size-throttle.js';
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
import {
  sweepWedgedZeroFillLots,
  WEDGED_ZERO_FILL_ABANDON_AFTER_MS,
} from './wedged-zero-fill-sweep.js';

const NOW = new Date('2026-09-09T12:00:00Z');
const KEY = 'key-meta-1';

/**
 * Throws on every method — a strong assertion that the sweep is genuinely
 * store-evidence-only, per this file's own doc and #1215's rule (no venue
 * order is cancelled or re-placed without audit evidence). If the sweep ever
 * starts consulting the broker, every test below fails loudly instead of
 * happening to pass because a stub returned something harmless.
 */
class NoCallBroker implements BrokerAdapter {
  async submitBracket(_order: NativeBracketRequest): Promise<BrokerAck> {
    throw new Error('NoCallBroker.submitBracket: the #1186 sweep must never call the broker');
  }
  async fetchNewFills(_since: Date): Promise<NormalizedFill[]> {
    throw new Error('NoCallBroker.fetchNewFills: the #1186 sweep must never call the broker');
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error(
      'NoCallBroker.resizeProtectiveLegs: the #1186 sweep must never call the broker',
    );
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('NoCallBroker.rearmProtectiveLegs: the #1186 sweep must never call the broker');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    throw new Error('NoCallBroker.getOrder: the #1186 sweep must never call the broker');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error('NoCallBroker.resumeFlatten: the #1186 sweep must never call the broker');
  }
  async submitFlatten(): Promise<never> {
    throw new Error('NoCallBroker.submitFlatten: the #1186 sweep must never call the broker');
  }
  async cancel(): Promise<void> {
    throw new Error('NoCallBroker.cancel: the #1186 sweep must never call the broker');
  }
  async getOpenPositions(): ReturnType<BrokerAdapter['getOpenPositions']> {
    throw new Error('NoCallBroker.getOpenPositions: the #1186 sweep must never call the broker');
  }
}

async function seedWedgedPosition(
  store: TestExecutionStore,
  overrides: Partial<OpenPosition> = {},
): Promise<OpenPosition> {
  const position: OpenPosition = {
    idempotency_key: KEY,
    debate_id: 'debate-1',
    instrument: 'META',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 8,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 0,
    target: 0,
    order_state: 'filled',
    broker_order_ids: [`${KEY}:entry`],
    opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1),
    decision_timestamp: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS - 1),
    conviction: 0.7,
    converged: true,
    ...overrides,
  };
  await store.writeAheadPosition(position);
  return position;
}

function makeInput(store: TestExecutionStore, logger: Logger = recordingLogger()): ExecutionInput {
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
  const clock: Clock = { now: () => NOW };
  return {
    trace_id: 'trace-1186',
    clock,
    broker: new NoCallBroker(),
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'paper',
    residualExposureAlerts: { postResidualExposureAlert: async () => {} },
    flattenOverfillAlerts: { postFlattenOverfillWarning: async () => {} },
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    logger,
    filledZeroSizeThrottle: new FilledZeroSizeThrottle(),
  };
}

describe('sweepWedgedZeroFillLots (#1186)', () => {
  it('abandons a lot wedged past the bounded window, on store evidence alone', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(1);
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toMatchObject({
      idempotency_key: KEY,
      instrument: 'META',
      store_state: 'filled',
      broker_state: null,
      action: 'adopted',
      kind: 'sweep',
    });

    const settled = await store.getPosition(KEY);
    expect(settled?.order_state).toBe('abandoned');
    expect(settled?.abandon_reason).toBeDefined();
    expect(settled?.abandon_reason).toContain('#1186');

    // Terminal: excluded from the live read every other reader trusts.
    expect(await store.getOpenPositions()).toEqual([]);
  });

  it('leaves a lot inside the bounded window untouched — propagation lag is not a wedge', async () => {
    const { store } = openTestExecutionStore();
    const position = await seedWedgedPosition(store, {
      opened_at: new Date(NOW.getTime() - WEDGED_ZERO_FILL_ABANDON_AFTER_MS + 1),
    });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect(result.divergences).toEqual([]);
    expect((await store.getPosition(KEY))?.order_state).toBe(position.order_state);
    expect(await store.getOpenPositions()).toHaveLength(1);
  });

  it('leaves a lot with a nonzero filled_size untouched, however long it has been open', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store, { filled_size: 3, avg_entry_price: 400 });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect((await store.getPosition(KEY))?.order_state).toBe('filled');
  });

  it("leaves a pending/submitted lot untouched — that is reconcileLot's IN_FLIGHT scope, not this sweep's", async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store, { order_state: 'submitted' });

    const result = await sweepWedgedZeroFillLots(makeInput(store));

    expect(result.checked).toBe(0);
    expect((await store.getPosition(KEY))?.order_state).toBe('submitted');
  });

  it('does not overwrite a lot that un-wedged itself between the worklist read and the write (race safety)', async () => {
    const { store } = openTestExecutionStore();
    await seedWedgedPosition(store);

    // Not a fill-lands race specifically — that shape isn't driven here. This
    // calls `abandonWedgedZeroFillLot` directly, twice, to exercise the
    // WHERE-guard's own idempotent-no-op case: whatever un-wedges a lot
    // between the sweep's worklist read and this write (a fill landing is
    // the motivating example, but the guard doesn't care which), the second
    // call must not overwrite it. Only the `order_state IN ('filled',
    // 'partially_filled')` half of the guard is exercised this way — the
    // row here still has `filled_size = 0` on the second call too, so that
    // half of the WHERE clause is untested by this case.
    const abandoned = await store.abandonWedgedZeroFillLot(KEY, 'test-forced');
    expect(abandoned).toBe(true);
    // A second call against the now-'abandoned' row is the guard's own
    // no-op case — the row no longer matches `order_state IN ('filled',
    // 'partially_filled')`.
    const secondCall = await store.abandonWedgedZeroFillLot(KEY, 'test-forced-again');
    expect(secondCall).toBe(false);
    expect((await store.getPosition(KEY))?.abandon_reason).toBe('test-forced');
  });
});
