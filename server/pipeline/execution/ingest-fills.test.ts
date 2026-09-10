/**
 * `ingestFills()` — the second surface (ticket #83). Driven by a scripted
 * stub adapter (execution-spec.md "What Makes a Good Test"): the stub returns
 * the exact fill sequence a scenario needs, so the state machine, protective
 * resize, and `ClosedTrade` emission are asserted in isolation from any real
 * venue's timing.
 */
import type { MarketDataService } from '../../providers/market-data-service/index.js';
import type { BrokerFillId, Clock, Logger, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { CostConfig, CostModel, MarketState } from '../../tools/backtest/index.js';
import { CostModelImpl, SAXO_COMMISSION_RATE } from '../../tools/backtest/index.js';
import { buildArmComparison } from '../control-arm/arm-comparison.js';
import { SqliteArmComparisonSource } from '../control-arm/sqlite-arm-comparison-source.js';
import { ExecutionImpl } from './execute.js';
import {
  FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS,
  FilledZeroSizeThrottle,
} from './filled-zero-size-throttle.js';
import {
  FEE_CURRENCY_NOT_BOOK_CURRENCY,
  FILLED_WITH_ZERO_SIZE,
  FILLED_ZERO_SIZE_CLEARED,
} from './ingest-fills.js';
import { ProtectiveRearmUnsupportedError } from './protective-rearm-unsupported.js';
import { openTestExecutionStore, TestExecutionStore } from './sqlite-store-harness.js';
import type {
  BrokerAck,
  BrokerAdapter,
  ExecutionConfig,
  ExecutionInput,
  FlattenOverfillAlertChannel,
  FlattenOverfillWarning,
  LotAdvance,
  NativeBracketRequest,
  NonSterlingFeeAlert,
  NonSterlingFeeAlertChannel,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
  SharedStore,
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
  readonly rearmCalls: Array<{
    clientOrderId: string;
    instrument: string;
    side: 'buy' | 'sell';
    qty: number;
    stop: number;
    target: number;
  }> = [];
  /** When set, `rearmProtectiveLegs` rejects with this — the #525 failure path. */
  rearmFailure: Error | undefined;

  constructor(private scriptedFills: NormalizedFill[]) {}

  /**
   * Swaps the script between polls — what a CUMULATIVE feed (#842) does in
   * reality: the SAME order id comes back, at a larger `filled_qty`, on the
   * next poll. A fixed list cannot express that, because the second
   * observation is not an extra fill, it is a REVISION of the first.
   */
  replaceFills(scriptedFills: NormalizedFill[]): void {
    this.scriptedFills = scriptedFills;
  }

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
  async rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void> {
    this.rearmCalls.push({ clientOrderId, instrument, side, qty, stop, target });
    if (this.rearmFailure !== undefined) throw this.rearmFailure;
  }
  /**
   * #86's surface. `ingestFills()` itself never calls this — `reconcile()`
   * does. Settable (#1087) so a test can drive `reconcile()` then
   * `ingestFills()` back to back, the same order `fill-sync.ts`'s `runPoll`
   * uses, and check the two stay coherent.
   */
  scriptedOrder: NormalizedOrder | null = null;
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.scriptedOrder;
  }
  /** #519/#526's reconcile-only surface — likewise untouched by the fill loop. */
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.resumeFlatten: ingestFills() does not reconcile');
  }
  /** #429's intervention path — likewise untouched by the fill loop. */
  async submitFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.submitFlatten: ingestFills() does not flatten');
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedBroker.cancel: ingestFills() does not cancel');
  }
  /**
   * `reconcile()`'s `findUnrecordedVenuePositions` surface (#1087: some tests
   * in this file now drive `reconcile()` immediately before `ingestFills()`,
   * `fill-sync.ts`'s own poll order). Empty — no venue position the store
   * does not already know about — rather than throwing: every fill this
   * broker can report is scripted up front, so there is nothing unrecorded
   * for it to find.
   */
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

function fill(overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    client_order_id: 'key-1',
    broker_fill_id: toBrokerFillId('fill-1'),
    leg: 'entry',
    price: 100,
    qty: 5,
    fee: 1,
    timestamp: new Date('2026-07-20T15:00:00Z'),
    ...overrides,
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

/** Records every warning posted (#527) — never posted for a clean flatten split. */
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

/** Records every non-sterling-fee alert posted (#1465) — never posted for a book-currency fee. */
function makeNonSterlingFeeAlerts(): NonSterlingFeeAlertChannel & {
  alerts: NonSterlingFeeAlert[];
} {
  const alerts: NonSterlingFeeAlert[] = [];
  return {
    alerts,
    async postNonSterlingFeeAlert(alert: NonSterlingFeeAlert): Promise<void> {
      alerts.push(alert);
    },
  };
}

function makeInput(
  broker: BrokerAdapter,
  store: TestExecutionStore,
  residualExposureAlerts: ResidualExposureAlertChannel = makeResidualExposureAlerts(),
  flattenOverfillAlerts: FlattenOverfillAlertChannel = makeFlattenOverfillAlerts(),
  logger: Logger = recordingLogger(),
  // Overridable (#1087 review, pass 2) so a test can hold its own reference
  // and probe `observe()` directly — the throttle's public API, same as
  // `advanceLot` itself calls — to read a consecutive count that never
  // crosses a warn boundary and so never appears in `logger.entries`.
  throttle: FilledZeroSizeThrottle = new FilledZeroSizeThrottle(),
  // #1348: overridable so a test can prove the two alert producers thread
  // THIS value rather than a literal they picked themselves.
  traceId = 'trace-1',
  // #1383: overridable so a test can advance wall-clock time across polls
  // and prove `FilledZeroSizeThrottle`'s time-based info reannounce — the
  // default fixed clock never advances, so every other test's "no further
  // announcement" assertions hold exactly as before.
  clock: Clock = { now: () => NOW },
  // #1465: absent by default (undefined) — most scenarios never touch a
  // non-sterling fee, and `ExecutionInput.nonSterlingFeeAlerts` is OPTIONAL
  // precisely so a caller (production or test) need not supply one.
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel,
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
    trace_id: traceId,
    clock,
    broker,
    store,
    costModel: {} as CostModel,
    marketData: {} as MarketDataService,
    config,
    mode: 'backtest',
    residualExposureAlerts,
    flattenOverfillAlerts,
    ...(nonSterlingFeeAlerts === undefined ? {} : { nonSterlingFeeAlerts }),
    // #519: `ingestFills()` never reconciles, so this is never posted to.
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    logger,
    // Fresh per call by default — matches production's one-throttle-per-
    // composition-root lifetime, since `makeInput()` itself is called once
    // per test/scenario and its returned `ExecutionInput` (and this throttle
    // within it) is what every `ingestFills()` call in that test shares.
    filledZeroSizeThrottle: throttle,
  };
}

describe('ExecutionImpl.ingestFills', () => {
  it('resizes the protective legs to cumulative filled qty and persists requested + filled size', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100 }),
      fill({
        broker_fill_id: toBrokerFillId('e2'),
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
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100, fee: 1 }),
      fill({
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 6,
        price: 101,
        fee: 1,
        timestamp: new Date('2026-07-20T15:15:00Z'),
      }),
      // Stop-out takes the whole 10 flat @ 95.
      fill({
        broker_fill_id: toBrokerFillId('s1'),
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
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
      fill({
        broker_fill_id: toBrokerFillId('t1'),
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
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
      }),
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('s1'),
        leg: 'stop',
        qty: 10,
        price: 95,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
      fill({
        client_order_id: 'key-2',
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 5,
        price: 100,
      }),
      fill({
        client_order_id: 'key-2',
        broker_fill_id: toBrokerFillId('t2'),
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
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100 }),
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
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100 }),
      // Dated one hour past NOW — the simulated future has not happened yet.
      fill({
        broker_fill_id: toBrokerFillId('e2'),
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

  describe('residual re-arm on a partial flatten (#525)', () => {
    it("re-arms protective legs, sized to the residual, at the lot's own stop/target", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        // A partial exit fill — 4 of the 10 held closed, 6 left naked. This
        // file bypasses the flatten-routing layer (`redistributeFlattenFills`)
        // by scripting the fill directly under the lot's own key; the
        // routing itself is covered end-to-end in execute.test.ts's
        // "flatten fill attribution" suite, via the real
        // `SimulatedBrokerAdapter`.
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);

      const residualExposureAlerts = makeResidualExposureAlerts();

      await new ExecutionImpl(makeInput(broker, store, residualExposureAlerts)).ingestFills();

      expect(broker.rearmCalls).toEqual([
        { clientOrderId: 'key-1', instrument: 'AAPL', side: 'buy', qty: 6, stop: 95, target: 110 },
      ]);
      // No alert on a SUCCESSFUL re-arm — the decision comment on #525 is
      // explicit that the alert is the FALLBACK, not the primary mechanism,
      // and that noise on every handled partial flatten during a 14-day
      // soak trains the operator to stop reading it.
      expect(residualExposureAlerts.alerts).toEqual([]);
      // Both fills landed regardless of the re-arm (sanity: the new surface
      // did not disturb the existing fill-persistence path).
      expect(await store.getFills('key-1')).toHaveLength(2);
      expect(await store.getClosedTrades()).toHaveLength(0);
    });

    it('does not re-arm a lot the exit fill took fully flat', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 10,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);

      await new ExecutionImpl(makeInput(broker, store)).ingestFills();

      expect(broker.rearmCalls).toEqual([]);
      expect(await store.getClosedTrades()).toHaveLength(1);
    });

    it('alerts, and still persists the fills, when the re-arm itself fails', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      broker.rearmFailure = new Error('venue rejected the OCO order');
      const residualExposureAlerts = makeResidualExposureAlerts();
      const logger = recordingLogger();

      await new ExecutionImpl(
        makeInput(broker, store, residualExposureAlerts, undefined, logger),
      ).ingestFills();

      expect(residualExposureAlerts.alerts).toEqual([
        {
          trace_id: 'trace-1',
          idempotency_key: 'key-1',
          instrument: 'AAPL',
          side: 'buy',
          residual_qty: 6,
          // The re-arm failed, not the fill read — so 6 is the measured
          // residual, not an upper bound.
          residual_qty_is_upper_bound: false,
          // An ordinary venue failure, so the #549 sweep's retries may still
          // clear it (#1214) — unlike Saxo's permanent refusal.
          rearm_unsupported: false,
          stop: 95,
          target: 110,
          observed_at: NOW,
        },
      ]);
      // The re-arm failure must not cost the fill rows or the recomputed lot
      // state — `maybeRearmResidual` runs before `applyLotAdvance` but never
      // throws, precisely so a broker/alert failure cannot prevent it.
      expect((await store.getPosition('key-1'))?.filled_size).toBe(10);
      expect(await store.getFills('key-1')).toHaveLength(2);
      // #573: the broker's own error text — safe to surface locally (#297's
      // H1) — is now a diagnosable local trace, distinct from the alert
      // above, which never carries it (CREDENTIALS).
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('broker.rearmProtectiveLegs failed'),
          payload: expect.objectContaining({
            idempotency_key: 'key-1',
            residual_qty: 6,
            error: 'venue rejected the OCO order',
          }),
        }),
      );
    });

    it('names a venue that can never re-arm as a permanent gap, not a failed attempt (#1214)', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      // Saxo's refusal: `IsOcoOrderSupported` is false on every LSE pool
      // line (doc 43), so the call never reaches the venue and no later poll
      // can change the answer.
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false on every pool line',
      );
      const residualExposureAlerts = makeResidualExposureAlerts();
      const logger = recordingLogger();

      await new ExecutionImpl(
        makeInput(broker, store, residualExposureAlerts, undefined, logger),
      ).ingestFills();

      expect(residualExposureAlerts.alerts[0]).toMatchObject({
        idempotency_key: 'key-1',
        residual_qty: 6,
        rearm_unsupported: true,
      });
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'residual_rearm_unsupported',
          message: expect.stringContaining('cannot arm protective legs at all'),
        }),
      );
      // Unchanged by the diagnosis: the residual is real, the marker stays
      // for the #549 sweep, and the fills still persisted.
      expect((await store.getResidualProtectionMarker('key-1'))?.unprotected_since).not.toBeNull();
      expect(await store.getFills('key-1')).toHaveLength(2);
    });

    it('survives a throwing logger on the re-arm-failure path — the alert is still posted and the fills still persist', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      broker.rearmFailure = new Error('venue rejected the OCO order');
      const residualExposureAlerts = makeResidualExposureAlerts();
      // A real `Logger` can throw — `JsonLogger` throws once no sink is left
      // that could record the failure (#714, orchestrator/logger.ts), and an
      // injected one can throw for any reason. `maybeRearmResidual`'s whole contract
      // is "never throws"; a logging call inside it must not be the thing
      // that breaks that.
      const throwingLogger: Logger = {
        log: () => {
          throw new Error('EPIPE');
        },
      };

      await expect(
        new ExecutionImpl(
          makeInput(broker, store, residualExposureAlerts, undefined, throwingLogger),
        ).ingestFills(),
      ).resolves.toBeUndefined();

      expect(residualExposureAlerts.alerts).toHaveLength(1);
      expect(await store.getFills('key-1')).toHaveLength(2);
    });
  });

  // #573: `maybeRearmResidual`'s store-read catch, exercised through the
  // `known === undefined` path — a lot a flatten named but handed ZERO share
  // of this poll's raw fill, so `advanceLot` reaches `maybeRearmResidual`
  // with no fresher record in hand and has to read the store itself. Before
  // this ticket the read's own failure was discarded with no message and no
  // stack; this pins that it now leaves a local trace alongside the existing
  // upper-bound alert (#569).
  describe('store-read failure in the zero-new-fill re-arm path (#573)', () => {
    it('logs the sanitized store error and the lot key when the store read fails, alongside the upper-bound alert', async () => {
      const { db } = openTestExecutionStore();
      // Throws ONLY for 'key-2', and only once ARMED — the first poll below
      // has to persist key-2's own entry fill through this SAME `getFills`
      // method (`advanceLot`'s main path, `newFills.length > 0`) before the
      // scenario under test even exists, so the flakiness is armed only
      // after that poll completes. 'key-1' (the sibling that absorbs the
      // whole partial fill below) and every other store call stay
      // unaffected throughout, so the failure is isolated to the exact read
      // under test — key-2's `maybeRearmResidual` call on the SECOND poll.
      class FlakyGetFillsForKey2 extends TestExecutionStore {
        armed = false;
        override async getFills(idempotencyKey: string) {
          if (this.armed && idempotencyKey === 'key-2') {
            throw new Error('SQLITE_BUSY: database is locked');
          }
          return super.getFills(idempotencyKey);
        }
      }
      const store = new FlakyGetFillsForKey2(db);

      // key-1 opens first (held 6), key-2 opens second (held 4) — the SAME
      // "earlier-opened sibling absorbs the whole partial fill" shape
      // `redistributeOneFlatten`'s own doc describes.
      await seedPosition(store, {
        idempotency_key: 'key-1',
        requested_size: 6,
        opened_at: OPENED_AT,
      });
      await seedPosition(store, {
        idempotency_key: 'key-2',
        requested_size: 4,
        opened_at: new Date(OPENED_AT.getTime() + 1_000),
      });
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 6,
        }),
        fill({
          client_order_id: 'key-2',
          broker_fill_id: toBrokerFillId('e2'),
          leg: 'entry',
          qty: 4,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();
      store.armed = true;

      // Journalled in opened_at order — the split loop allocates a raw fill
      // to `lotKeys` in this order, oldest lot first.
      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 6,
        submitted_at: OPENED_AT,
        lot_held_quantities: [
          { idempotency_key: 'key-1', held: 6 },
          { idempotency_key: 'key-2', held: 4 },
        ],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // The raw fill (qty 6) exactly covers key-1's own share, leaving
      // key-2 with ZERO — named by the flatten, but with no new fill of its
      // own this poll, which is what routes it through
      // `maybeRearmResidual`'s `known === undefined` branch.
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 6,
        }),
        fill({
          client_order_id: 'key-2',
          broker_fill_id: toBrokerFillId('e2'),
          leg: 'entry',
          qty: 4,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 6,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const residualExposureAlerts = makeResidualExposureAlerts();
      const logger = recordingLogger();

      await new ExecutionImpl(
        makeInput(withFlatten, store, residualExposureAlerts, undefined, logger),
      ).ingestFills();

      // The existing #569 behaviour is unchanged: an upper-bound alert for
      // key-2, sized off its own `requested_size` since the exact residual
      // was unreadable.
      expect(residualExposureAlerts.alerts).toContainEqual(
        expect.objectContaining({
          idempotency_key: 'key-2',
          residual_qty: 4,
          residual_qty_is_upper_bound: true,
        }),
      );
      // NEW (#573): a local trace naming WHY — absent before this ticket.
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('store read failed'),
          payload: expect.objectContaining({
            idempotency_key: 'key-2',
            error: 'SQLITE_BUSY: database is locked',
          }),
        }),
      );
      // key-1's own advance is unaffected by key-2's store failure — the
      // per-lot containment this file's #575 section pins holds here too.
      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
    });

    it('survives a throwing logger on the store-read-failure path — the upper-bound alert is still posted', async () => {
      const { db } = openTestExecutionStore();
      class FlakyGetFillsForKey2 extends TestExecutionStore {
        armed = false;
        override async getFills(idempotencyKey: string) {
          if (this.armed && idempotencyKey === 'key-2') {
            throw new Error('SQLITE_BUSY: database is locked');
          }
          return super.getFills(idempotencyKey);
        }
      }
      const store = new FlakyGetFillsForKey2(db);

      await seedPosition(store, {
        idempotency_key: 'key-1',
        requested_size: 6,
        opened_at: OPENED_AT,
      });
      await seedPosition(store, {
        idempotency_key: 'key-2',
        requested_size: 4,
        opened_at: new Date(OPENED_AT.getTime() + 1_000),
      });
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 6,
        }),
        fill({
          client_order_id: 'key-2',
          broker_fill_id: toBrokerFillId('e2'),
          leg: 'entry',
          qty: 4,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();
      store.armed = true;

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 6,
        submitted_at: OPENED_AT,
        lot_held_quantities: [
          { idempotency_key: 'key-1', held: 6 },
          { idempotency_key: 'key-2', held: 4 },
        ],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 6,
        }),
        fill({
          client_order_id: 'key-2',
          broker_fill_id: toBrokerFillId('e2'),
          leg: 'entry',
          qty: 4,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 6,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const residualExposureAlerts = makeResidualExposureAlerts();
      const throwingLogger: Logger = {
        log: () => {
          throw new Error('EPIPE');
        },
      };

      await expect(
        new ExecutionImpl(
          makeInput(withFlatten, store, residualExposureAlerts, undefined, throwingLogger),
        ).ingestFills(),
      ).resolves.toBeUndefined();

      expect(residualExposureAlerts.alerts).toContainEqual(
        expect.objectContaining({ idempotency_key: 'key-2', residual_qty_is_upper_bound: true }),
      );
    });
  });

  // The other half of #575's containment boundary. #524 (an unpriced fill
  // aborting the venue sweep, in adapters/alpaca-adapter.ts), #569 (an
  // unguarded store read) and #575 (an unattributable flatten) were three
  // instances of ONE shape — a failure confined to one unit of work aborting
  // every other unit in the same poll — and this loop was the fourth,
  // latent: `advanceLot` was awaited unguarded per position, so any store or
  // broker failure on ONE lot dropped every lot after it in
  // `getOpenPositions()` order. Contained per lot rather than point-fixed at
  // each throw site, because there is no reason to believe #575 is the last
  // throw path anyone adds.
  describe('per-lot containment (#575)', () => {
    it("advances the other lots when one lot's advance fails, and names the failed lot", async () => {
      /** Fails the atomic advance for one lot only, leaving the rest healthy. */
      class FlakyAdvanceStore extends TestExecutionStore {
        override async applyLotAdvance(advance: LotAdvance): Promise<void> {
          if (advance.idempotency_key === 'key-flaky') {
            throw new Error('simulated store outage on applyLotAdvance');
          }
          return super.applyLotAdvance(advance);
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyAdvanceStore(db);
      // `getOpenPositions()` returns these in `opened_at` order, so the flaky
      // lot is reached BEFORE the healthy one — which is the only ordering
      // under which the old code could lose the healthy lot's work.
      await seedPosition(store, { idempotency_key: 'key-flaky', requested_size: 10 });
      await seedPosition(store, {
        idempotency_key: 'key-healthy',
        requested_size: 10,
        opened_at: new Date(OPENED_AT.getTime() + 60_000),
        broker_order_ids: ['key-healthy:entry'],
      });
      const broker = new ScriptedBroker([
        fill({
          client_order_id: 'key-flaky',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'key-healthy',
          broker_fill_id: toBrokerFillId('e2'),
          leg: 'entry',
          qty: 10,
        }),
      ]);

      // Visible, not swallowed: the poll still reports that it did not fully
      // succeed, and the message names the lot that failed.
      await expect(new ExecutionImpl(makeInput(broker, store)).ingestFills()).rejects.toThrow(
        'key-flaky',
      );

      // The failed lot really did fail closed — nothing half-written.
      expect((await store.getPosition('key-flaky'))?.filled_size).toBe(0);
      // The healthy lot, iterated after it, still advanced.
      expect((await store.getPosition('key-healthy'))?.filled_size).toBe(10);
      expect((await store.getPosition('key-healthy'))?.order_state).toBe('filled');
    });

    // The money-path half of the same boundary. A contained flatten must not
    // leave its named lots in `flattenTargetedLots`: `advanceLot` would then
    // re-arm protective legs sized off `getFills` — a record this very
    // containment refused to complete — arming the venue for quantity it may
    // already have sold, so a triggered leg sells what the lot does not hold.
    // Reachable only where the throw comes AFTER the lot keys are read, which
    // is why the set is per-bucket and merged on success rather than written
    // through and rolled back.
    it('does not re-arm a lot named by a flatten whose redistribution failed', async () => {
      /** A pre-0021 flatten row's fallback read, failing. */
      class FlakyEntrySizesStore extends TestExecutionStore {
        override async getEntryFillSizes(): Promise<Map<string, number>> {
          throw new Error('simulated store outage on getEntryFillSizes');
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyEntrySizesStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      // Poll 1 persists the lot's entry fill, so it has a residual to re-arm.
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // NULLed to a pre-migration-0021 row, which is the one shape that still
      // routes the split through `getEntryFillSizes` — the only `await`
      // between reading the lot keys and the (pure, unthrowable) split.
      store.ageFlattenHeldQuantities('flatten-1');

      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 4,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const residualExposureAlerts = makeResidualExposureAlerts();

      await expect(
        new ExecutionImpl(makeInput(withFlatten, store, residualExposureAlerts)).ingestFills(),
      ).rejects.toThrow('flatten-1');

      // Not re-armed at ANY size — the only honest answer while the flatten's
      // 4 is deliberately unattributed. The lot is naked and the poll says so.
      expect(withFlatten.rearmCalls).toEqual([]);
      expect(residualExposureAlerts.alerts).toEqual([]);
      // And the flatten's fill really was not attributed: the lot is still
      // whole, with only its entry fill on record.
      expect(await store.getFills('key-1')).toHaveLength(1);
    });
  });

  // #1126 (#1096 follow-up): the tests above assert `.rejects.toThrow` with a
  // bare substring (e.g. 'key-flaky'), which still passes if the
  // `(instrument) [ReasonClass]` suffix `throwContainedFailures` appends is
  // dropped, reordered, reshaped, or grown (`.toThrow(string)` is a substring
  // match, so it cannot see anything ADDED after the pinned text either) —
  // none of them can see a suffix-format regression. These tests pin the
  // exact shape instead: end-anchored, so nothing can be appended, and both
  // branches of `instrument` (present, and the `null`-for-a-flatten-key case
  // that renders as no parens at all).
  describe('throwContainedFailures suffix format (#1126)', () => {
    it('names a lot-advance failure as scope, key, "(instrument)", then "[ReasonClass]" — instrument present', async () => {
      class FlakyAdvanceStore extends TestExecutionStore {
        override async applyLotAdvance(advance: LotAdvance): Promise<void> {
          if (advance.idempotency_key === 'key-flaky') {
            throw new TypeError('simulated store outage on applyLotAdvance');
          }
          return super.applyLotAdvance(advance);
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyAdvanceStore(db);
      await seedPosition(store, {
        idempotency_key: 'key-flaky',
        instrument: 'MSFT',
        requested_size: 10,
      });
      const broker = new ScriptedBroker([
        fill({
          client_order_id: 'key-flaky',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);

      // `TypeError`, not the `Error` the other containment tests throw, so a
      // passing match proves `reason` reads the failure's actual
      // `constructor.name` rather than a hardcoded literal. `$`-anchored so
      // nothing can be appended after the suffix without failing this.
      await expect(new ExecutionImpl(makeInput(broker, store)).ingestFills()).rejects.toThrow(
        /unresolved: lot-advance 'key-flaky' \(MSFT\) \[TypeError\]$/,
      );
    });

    it('names a flatten-attribution failure with no parens at all — instrument is null for a flatten-keyed scope', async () => {
      /** Same repro as "does not re-arm a lot named by a flatten…" above, isolated to the message shape alone. */
      class FlakyEntrySizesStore extends TestExecutionStore {
        override async getEntryFillSizes(): Promise<Map<string, number>> {
          throw new Error('simulated store outage on getEntryFillSizes');
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyEntrySizesStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // NULLed to a pre-migration-0021 row — the one shape that routes the
      // split through `getEntryFillSizes`, the only `await` between reading
      // the lot keys and the (pure, unthrowable) split.
      store.ageFlattenHeldQuantities('flatten-1');

      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 4,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);

      // No `(instrument)` segment at all — not `()`, not a stray space —
      // between the quoted key and `[Error]`. `$`-anchored for the same
      // reason as the lot-advance case above.
      await expect(new ExecutionImpl(makeInput(withFlatten, store)).ingestFills()).rejects.toThrow(
        /unresolved: flatten-attribution 'flatten-1' \[Error\]$/,
      );
    });
  });

  // #519/#526: bounds `reconcile()`'s flatten-journal rescan (migration 0023) —
  // see `SharedStore.markFlattenFillsSwept`'s doc for why the mark may only
  // fire once every named lot has durably advanced, never merely once a raw
  // fill was observed.
  describe('markFlattenFillsSwept gating (#519, #526)', () => {
    it('marks a flatten swept once its named lot durably advances', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      store.writeLog.length = 0;

      await new ExecutionImpl(makeInput(withFlatten, store)).ingestFills();

      expect(store.writeLog).toContain('mark-flatten-fills-swept:flatten-1');
      expect(await store.getClosedTrades()).toHaveLength(1);
    });

    it('does NOT mark a flatten swept when a lot it named fails to advance this poll', async () => {
      class FlakyAdvanceStore extends TestExecutionStore {
        override async applyLotAdvance(advance: LotAdvance): Promise<void> {
          if (advance.idempotency_key === 'key-1') {
            throw new Error('simulated store outage on applyLotAdvance');
          }
          return super.applyLotAdvance(advance);
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyAdvanceStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      // `FlakyAdvanceStore.applyLotAdvance` throws for EVERY advance to
      // 'key-1', including the entry fill's own — so the entry has to be
      // seeded through a separate, healthy `TestExecutionStore` over the
      // SAME underlying db first, then the flaky one takes over for the
      // flatten poll below.
      const seedStore = new TestExecutionStore(db);
      await new ExecutionImpl(makeInput(entryOnly, seedStore)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      store.writeLog.length = 0;

      await expect(new ExecutionImpl(makeInput(withFlatten, store)).ingestFills()).rejects.toThrow(
        'key-1',
      );

      // Not marked swept — the lot's own advance failed, so the next
      // reconcile() pass must still be able to find this row and re-attempt
      // the sweep (self-healing, see the store method's own doc).
      expect(store.writeLog).not.toContain('mark-flatten-fills-swept:flatten-1');
      expect(await store.getFlattenSubmission('flatten-1')).toMatchObject({
        idempotency_key: 'flatten-1',
      });
    });

    it('does NOT mark a flatten swept when its own redistribution fails (attribution corrupt)', async () => {
      class FlakyEntrySizesStore extends TestExecutionStore {
        override async getEntryFillSizes(): Promise<Map<string, number>> {
          throw new Error('simulated store outage on getEntryFillSizes');
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyEntrySizesStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // NULLed to a pre-migration-0021 row, routing the split through the
      // now-flaky `getEntryFillSizes` fallback — same technique the existing
      // #575 containment test above uses.
      store.ageFlattenHeldQuantities('flatten-1');
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      store.writeLog.length = 0;

      await expect(new ExecutionImpl(makeInput(withFlatten, store)).ingestFills()).rejects.toThrow(
        'flatten-1',
      );

      expect(store.writeLog).not.toContain('mark-flatten-fills-swept:flatten-1');
    });

    // PR #603 review (deepseek): does `redistributeOneFlatten`'s unconditional
    // `namedLots.add(lotKey)` (for every key the JOURNAL names, regardless of
    // whether that lot is STILL OPEN) leave `targetedByThisFlatten` empty when
    // every named lot already closed by the time this poll's `positions`
    // snapshot was taken — and if not empty, what actually happens to the
    // fill? Traced by construction below rather than by reading alone: the
    // set is NOT empty (the existing #525 line populates it straight from the
    // journal's `lot_idempotency_keys`, unconditionally), so the flatten DOES
    // reach `flattenNamedLots` and IS marked swept — but `advanceLot` is never
    // called for the closed lot (it is absent from `positions`, the loop's
    // only source of work), so the fill sitting in `byLot` for it is silently
    // discarded rather than durably applied.
    it('marks a flatten swept (and silently drops its fill) when its named lot is ALREADY closed at redistribution time', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      // A SECOND, unrelated lot that stays open throughout — without it,
      // `ingestFills()`'s own "no open positions, return early" guard would
      // short-circuit the whole poll the moment key-1 closes, proving
      // nothing about redistribution either way (the same reason
      // alpaca-adapter.test.ts's pruning test keeps a second lot alive).
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
      // Close key-1 through the ORDINARY (non-flatten) path first, so it is
      // genuinely terminal — excluded from `getOpenPositions()` — before the
      // contrived flatten row below ever exists.
      const closeDirectly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      await new ExecutionImpl(makeInput(closeDirectly, store)).ingestFills();
      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');

      // A flatten journalled AFTER the lot it names is already closed — not a
      // reachable state through `executeExit`'s own guards (a flatten's
      // `heldSize` check refuses to journal against a lot with nothing left
      // to hold), constructed directly here to exercise the redistribution
      // code path on its own terms, independent of whether real callers can
      // reach it.
      await store.writeAheadFlatten({
        idempotency_key: 'flatten-orphan',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // Acked, as `executeExit` always resolves it synchronously right after
      // `submitFlatten` returns, before any poll ever runs — a row still at
      // 'submitting' when its fill lands is a DIFFERENT anomaly (reconcile.ts's
      // own sweep), not the one under test here.
      await store.resolveFlattenSubmitted(
        'flatten-orphan',
        { order_state: 'submitted', broker_order_ids: ['flatten-orphan:order'] },
        OPENED_AT,
      );
      const withOrphanFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'flatten-orphan',
          broker_fill_id: toBrokerFillId('fo1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T16:00:00Z'),
        }),
      ]);
      store.writeLog.length = 0;

      // Does not throw: no lot-advance was ever attempted for key-1 (it is
      // not in `positions`), so there is no failure to report either.
      await new ExecutionImpl(makeInput(withOrphanFlatten, store)).ingestFills();

      // Marked swept — `flattenNamedLots` is non-empty (namedLots is
      // populated unconditionally from the journal), and no 'lot-advance'
      // failure was ever recorded for key-1 to gate the mark on.
      expect(store.writeLog).toContain('mark-flatten-fills-swept:flatten-orphan');
      // Bounded, not leaked: a later reconcile() sweep will not find this row
      // again (`fills_swept_at` is set), so it does not haunt every future
      // pass — the "noisy but safe rescan forever" the review comment
      // hypothesized does not happen either.
      expect(await store.getUnresolvedFlattens()).toEqual([]);
      // The fill itself was never applied anywhere: key-1's own fill record
      // is unchanged (still just its original two fills), and no OTHER lot
      // exists to have received it. This is the actual behaviour — silently
      // dropped, not silently leaked — and is not a NEW defect: the fill
      // would have been dropped exactly the same way before this PR, since
      // `advanceLot` was never reachable for a closed lot either way. This
      // PR's `markFlattenFillsSwept` only recognises that nothing more will
      // ever happen to it and stops rescanning — it does not change whether
      // the fill gets applied.
      expect(await store.getFills('key-1')).toHaveLength(2);
    });

    // PR #603 review (deepseek): `markFlattenFillsSwept` throwing was
    // reaching `throwContainedFailures` unconditionally — the SAME path a
    // genuinely correctness-critical 'flatten-attribution'/'lot-advance'
    // failure takes — contradicting this file's own "NOT correctness-critical"
    // comment on that catch. Fixed so a 'flatten-sweep-mark' failure ALONE no
    // longer rejects the poll's promise.
    it('does not fail the poll when only markFlattenFillsSwept throws — the row stays rescannable for next poll', async () => {
      class FlakyMarkSweptStore extends TestExecutionStore {
        override async markFlattenFillsSwept(): Promise<void> {
          throw new Error('simulated store outage on markFlattenFillsSwept');
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FlakyMarkSweptStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      // Acked, as `executeExit` always resolves it synchronously right after
      // `submitFlatten` returns, before any poll ever runs.
      await store.resolveFlattenSubmitted(
        'flatten-1',
        { order_state: 'submitted', broker_order_ids: ['flatten-1:order'] },
        OPENED_AT,
      );
      const broker = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);

      const logger = recordingLogger();

      // Resolves, not rejects: every lot-relevant piece of work this poll
      // could do, it did — only the best-effort sweep-mark bookkeeping
      // failed, and that alone must not read as a failed poll.
      await expect(
        new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger)).ingestFills(),
      ).resolves.toBeUndefined();

      // The money-relevant work still landed: the lot closed and its
      // ClosedTrade was still emitted, unaffected by the mark failure.
      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
      expect(await store.getClosedTrades()).toHaveLength(1);

      // The row's own designed recovery: still unswept, so still found by a
      // future reconcile() pass — "rescanned next poll", not leaked.
      expect(await store.getUnresolvedFlattens()).toEqual([
        { idempotency_key: 'flatten-1', instrument: 'AAPL', status: 'submitted' },
      ]);
      // #573: before this ticket this failure "resolved quietly" — no local
      // trace at all when it was the ONLY failure this poll (the comment on
      // this catch, ingest-fills.ts, used to say so explicitly: "this module
      // carries no Logger of its own"). Now it does.
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('markFlattenFillsSwept failed'),
          payload: expect.objectContaining({
            flatten_key: 'flatten-1',
            error: 'simulated store outage on markFlattenFillsSwept',
          }),
        }),
      );
    });
  });

  describe('flatten over-fill warning (#527)', () => {
    it('warns naming the flatten and the unattributed qty, and still drops the excess', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      // Poll 1 persists the lot's entry fill.
      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      // Journalled as HELD 6 — but the venue's raw fill below reports 10, a
      // genuine over-fill past what `executeExit`'s `heldSize` guard should
      // ever allow through.
      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 6,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 6 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });

      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const residualExposureAlerts = makeResidualExposureAlerts();
      const flattenOverfillAlerts = makeFlattenOverfillAlerts();

      // Does NOT throw: a successful redistribution with an over-fill is not
      // a contained failure — see `redistributeOneFlatten`'s doc.
      await new ExecutionImpl(
        makeInput(withFlatten, store, residualExposureAlerts, flattenOverfillAlerts),
      ).ingestFills();

      expect(flattenOverfillAlerts.warnings).toEqual([
        {
          trace_id: 'trace-1',
          idempotency_key: 'flatten-1',
          unattributed_qty: 4,
          observed_at: NOW,
        },
      ]);

      // The excess (4) was dropped, not guessed onto the lot: only the
      // journalled 6 reached `key-1`'s own exit fills.
      const fills = await store.getFills('key-1');
      const exitQty = fills
        .filter((persisted) => persisted.leg !== 'entry')
        .reduce((sum, persisted) => sum + persisted.qty, 0);
      expect(exitQty).toBe(6);
    });

    it('warns only once across repeated polls for the same re-offered over-filled fill', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 6,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 6 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });

      // A single scripted broker, polled TWICE: `fetchNewFills` re-offers the
      // same fills every call (filtered only by `since`), the same shape the
      // Simulated adapter takes in production (unlike Alpaca's flatten sweep,
      // which prunes after one poll) — the exact re-offer this test exists to
      // pin `ingestFills()` against.
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const flattenOverfillAlerts = makeFlattenOverfillAlerts();
      const execution = new ExecutionImpl(
        makeInput(withFlatten, store, undefined, flattenOverfillAlerts),
      );

      await execution.ingestFills();
      await execution.ingestFills();

      // Warned once, on the poll that actually persisted the split — not
      // again on the re-poll that re-offers the identical already-ingested
      // fill.
      expect(flattenOverfillAlerts.warnings).toEqual([
        {
          trace_id: 'trace-1',
          idempotency_key: 'flatten-1',
          unattributed_qty: 4,
          observed_at: NOW,
        },
      ]);
    });

    it("emits no warning when a flatten fills exactly its named lots' held share", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 10,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });

      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      const flattenOverfillAlerts = makeFlattenOverfillAlerts();

      await new ExecutionImpl(
        makeInput(withFlatten, store, undefined, flattenOverfillAlerts),
      ).ingestFills();

      expect(flattenOverfillAlerts.warnings).toEqual([]);
    });

    it('logs a fixed, self-authored message (never the channel error) when overfill alert delivery itself fails', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      const entryOnly = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
      ]);
      await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

      await store.writeAheadFlatten({
        idempotency_key: 'flatten-1',
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: 6,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held: 6 }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        quote_observed_at: null,
        modelled_cost_breakdown: null,
      });
      const withFlatten = new ScriptedBroker([
        fill({
          client_order_id: 'key-1',
          broker_fill_id: toBrokerFillId('e1'),
          leg: 'entry',
          qty: 10,
        }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: toBrokerFillId('f1'),
          leg: 'exit',
          qty: 10,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      // A Telegram transport failure quotes the request it failed
      // on, which can carry a bot token (`escalateAgedUnpricedFills`'s
      // precedent, alpaca-adapter.ts) — this error's text must never reach
      // the log.
      const failingFlattenOverfillAlerts: FlattenOverfillAlertChannel = {
        postFlattenOverfillWarning: async () => {
          throw new Error('Bearer super-secret-transport-token rejected the request');
        },
      };
      const logger = recordingLogger();

      // Does not throw: the redistribution itself still completes — see
      // `redistributeOneFlatten`'s doc.
      await expect(
        new ExecutionImpl(
          makeInput(withFlatten, store, undefined, failingFlattenOverfillAlerts, logger),
        ).ingestFills(),
      ).resolves.toBeUndefined();

      const entry = logger.entries.find((e) => e.message.includes('overfill alert delivery'));
      expect(entry).toMatchObject({
        level: 'warn',
        payload: { flatten_client_order_id: 'flatten-1', unattributed_qty: 4 },
      });
      // The channel's own error text — which could carry a credential — must
      // never appear anywhere in the logged entry.
      expect(JSON.stringify(entry)).not.toContain('super-secret-transport-token');
    });
  });

  // #573: the LAST channel in the residual-exposure fallback chain failing —
  // the most severe blind spot in this file before this ticket, since a
  // residual is both unprotected AND nobody, not even a local log reader,
  // was told.
  describe('residual-exposure alert delivery itself failing (#573)', () => {
    it('logs a fixed, self-authored message (never the channel error) when the fallback alert cannot be delivered', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      broker.rearmFailure = new Error('venue rejected the OCO order');
      const failingResidualExposureAlerts: ResidualExposureAlertChannel = {
        postResidualExposureAlert: async () => {
          throw new Error('Bearer super-secret-transport-token rejected the request');
        },
      };
      const logger = recordingLogger();

      // Does not throw: `maybeRearmResidual`'s whole contract is "never
      // throws" — a failed fallback must not cost the fills or lot state
      // either.
      await expect(
        new ExecutionImpl(
          makeInput(broker, store, failingResidualExposureAlerts, undefined, logger),
        ).ingestFills(),
      ).resolves.toBeUndefined();

      expect((await store.getPosition('key-1'))?.filled_size).toBe(10);

      const entry = logger.entries.find((e) =>
        e.message.includes('postResidualExposureAlert delivery failed'),
      );
      expect(entry).toMatchObject({
        level: 'error',
        payload: { idempotency_key: 'key-1', residual_qty: 6, residual_qty_is_upper_bound: false },
      });
      expect(JSON.stringify(entry)).not.toContain('super-secret-transport-token');
    });
  });
});

/**
 * #842 — Alpaca reports a RUNNING `filled_qty` per order under one order id,
 * not one event per partial fill. Before this ticket the second observation
 * of the same order at a larger cumulative was discarded by the `hasFill`
 * dedup gate, so the increment never reached `fills`: the lot's `filled_size`
 * froze at the first observation and `resizeProtectiveLegs` — which sets an
 * ABSOLUTE quantity — armed protection for the stale, smaller figure, leaving
 * the rest of the lot naked, invisible to the exposure caps, and un-exited by
 * flat-by-close (ADR-0014, which sizes the exit off `filled_size`).
 *
 * THE INVARIANT: our persisted `filled_size` for a lot equals the venue's
 * cumulative `filled_qty` for its entry order.
 */
describe('ExecutionImpl.ingestFills — cumulative partial fills (#842)', () => {
  /** The venue's account of one entry order at one moment in time. */
  function cumulativeEntry(cumQty: number, cumAvgPrice: number, at: string): NormalizedFill {
    return fill({
      // ONE id for every observation — the ORDER id. That is the whole
      // problem: the id has no room to say "and now 50 more".
      broker_fill_id: toBrokerFillId('alpaca-entry-1'),
      leg: 'entry',
      qty: cumQty,
      price: cumAvgPrice,
      fee: 0,
      timestamp: new Date(at),
      qty_is_cumulative: true,
    });
  }

  it('books the increment when the same entry order is re-observed at a larger cumulative', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    // Poll 1: the venue has filled 50 of 100, averaging 100.
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);

    // Poll 2: SAME order id, now 100 filled at a cumulative average of 101 —
    // i.e. the second 50 went off at 102.
    broker.replaceFills([cumulativeEntry(100, 101, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    // The invariant: persisted filled_size == the venue's cumulative.
    expect(position?.filled_size).toBe(100);
    // And the increment was priced so the rebuilt weighted average
    // reproduces the venue's own cumulative average rather than drifting to
    // whichever tranche happened to be larger.
    expect(position?.avg_entry_price).toBeCloseTo(101, 10);

    const fills = await store.getFills('key-1');
    expect(fills).toHaveLength(2);
    expect(fills[1]?.qty).toBe(50);
    expect(fills[1]?.price).toBeCloseTo(102, 10);
    // The base id is UNCHANGED — nothing already persisted is re-keyed, which
    // is what lets this ship without a migration and without re-booking any
    // lot already in flight across the deploy boundary.
    expect(fills[0]?.broker_fill_id).toBe('alpaca-entry-1');
    expect(fills[1]?.broker_fill_id).toBe('alpaca-entry-1#100');
  });

  it('resizes the protective legs to the TRUE cumulative, not the stale first observation', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();
    expect(broker.resizeCalls).toEqual([{ clientOrderId: 'key-1', filledQty: 50 }]);

    broker.replaceFills([cumulativeEntry(100, 101, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    // The money assertion. Booking the increment but not re-arming would move
    // the defect one layer down rather than fixing it: `filled_size` correct
    // in the store, the venue's stop still covering 50.
    expect(broker.resizeCalls).toEqual([
      { clientOrderId: 'key-1', filledQty: 50 },
      { clientOrderId: 'key-1', filledQty: 100 },
    ]);
  });

  it('re-offers the SAME cumulative without booking a second row or resizing again', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();
    // Idempotent by arithmetic: the re-offer computes a zero delta.
    await execution.ingestFills();
    await execution.ingestFills();

    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);
    expect(broker.resizeCalls).toHaveLength(1);
  });

  it('books the last increment of an order that terminates partially filled (cancelled/expired)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    // The venue cancels the rest — the order goes terminal at 80 filled. That
    // last 30 is the window this defect opened: it is the FINAL word on the
    // order, so nothing later ever offers it again. `collectFill` reads no
    // `status`, and `nextState` is driven by filled quantity rather than the
    // venue's status string, so the increment is booked on its own terms.
    broker.replaceFills([cumulativeEntry(80, 100.75, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    expect(position?.filled_size).toBe(80);
    // Under-filled against the request, so still 'partially_filled' — and
    // therefore still protected, which is exactly what has to be re-sized.
    expect(position?.order_state).toBe('partially_filled');
    expect(broker.resizeCalls.at(-1)).toEqual({ clientOrderId: 'key-1', filledQty: 80 });
  });

  it('ignores a cumulative that SHRINKS rather than un-booking a persisted fill', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    // Venue/store divergence, not a lost increment: protection would be
    // OVER-sized, which is not the direction that leaves shares naked, and
    // fill rows are append-only. `reconcile()` owns divergence.
    broker.replaceFills([cumulativeEntry(30, 100, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);
    expect(broker.resizeCalls).toHaveLength(1);
  });

  it('leaves a non-cumulative feed alone — a re-offered id is still a duplicate', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    // No `qty_is_cumulative`: the Simulated adapter (and every backtest) emits
    // one row per fill EVENT, so "same id, bigger qty" would be a bug in the
    // feed, not an increment to book.
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('sim-1'), leg: 'entry', qty: 50, price: 100, fee: 0 }),
    ]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();
    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('sim-1'),
        leg: 'entry',
        qty: 100,
        price: 100,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);
    await execution.ingestFills();

    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);
  });

  it('carries a cumulative STOP leg to flat instead of stranding the lot part-closed', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(100, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    // The stop leg fills in two tranches under ITS own single order id. The
    // same loss applies on the closing side, where it strands a lot reading
    // half-open forever and never emits its ClosedTrade.
    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('alpaca-stop-1'),
        leg: 'stop',
        qty: 40,
        price: 95,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    await execution.ingestFills();
    expect((await store.getPosition('key-1'))?.order_state).not.toBe('closed');

    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('alpaca-stop-1'),
        leg: 'stop',
        qty: 100,
        price: 95,
        fee: 0,
        timestamp: new Date('2026-07-20T15:45:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    await execution.ingestFills();

    expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
    expect(await store.getClosedTrades()).toHaveLength(1);
  });
});

/**
 * #1001: `cost_breakdown_json` on real-broker fills. The Simulated adapter
 * always prices its own fills through `CostModel.fill` directly, so
 * `NormalizedFill.cost_breakdown` is already set on that path — these tests
 * are all about the OTHER path, where the broker reports no breakdown of its
 * own (`fill.cost_breakdown === undefined`, always true for a real broker)
 * and `toFill()` falls back to the submit-time modelled snapshot instead:
 * `OpenPosition.modelled_cost_breakdown` for an `'entry'` leg,
 * `FlattenAttribution.modelled_cost_breakdown` for a flatten's `'exit'` leg
 * — each prorated by this fill's share of the size the snapshot was modelled
 * against. Scoped to entry + flatten-exit only, deliberately: the Simulated
 * adapter itself never models `'stop'`/`'target'` fills either
 * (`simulated-adapter.ts`), so there is no fallback for those.
 */
describe('ExecutionImpl.ingestFills — real-broker cost_breakdown fallback (#1001)', () => {
  const modelledCostBreakdown = {
    spread_cost: 0.5,
    commission: 1,
    slippage: 0.25,
    market_impact: 0.1,
  };

  /** Float-tolerant equality — `prorateCostBreakdown` multiplies by a share, so exact decimal equality is not guaranteed. */
  function expectCostBreakdownCloseTo(
    actual:
      | { spread_cost: number; commission: number; slippage: number; market_impact: number }
      | undefined,
    expected: { spread_cost: number; commission: number; slippage: number; market_impact: number },
  ): void {
    expect(actual).toBeDefined();
    expect(actual?.spread_cost).toBeCloseTo(expected.spread_cost, 9);
    expect(actual?.commission).toBeCloseTo(expected.commission, 9);
    expect(actual?.slippage).toBeCloseTo(expected.slippage, 9);
    expect(actual?.market_impact).toBeCloseTo(expected.market_impact, 9);
  }

  it('prorates the modelled entry cost breakdown across two partial entry fills, by each fill share of requested_size', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100 }),
      fill({
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 6,
        price: 101,
        timestamp: new Date('2026-07-20T15:15:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    const e1 = fills.find((row) => row.broker_fill_id === 'e1');
    const e2 = fills.find((row) => row.broker_fill_id === 'e2');
    // share = 4/10 and 6/10 of the modelled breakdown, linearly.
    expectCostBreakdownCloseTo(e1?.cost_breakdown, {
      spread_cost: 0.2,
      commission: 0.4,
      slippage: 0.1,
      market_impact: 0.04,
    });
    expectCostBreakdownCloseTo(e2?.cost_breakdown, {
      spread_cost: 0.3,
      commission: 0.6,
      slippage: 0.15,
      market_impact: 0.06,
    });
  });

  it('leaves cost_breakdown unset on an entry fill when the lot carries no modelled snapshot', async () => {
    const { store } = openTestExecutionStore();
    // No `modelled_cost_breakdown` override — a pre-migration-0037 row, or a
    // submit-time capture that failed.
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10 }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills[0]?.cost_breakdown).toBeUndefined();
  });

  it('prefers the broker fill own cost_breakdown over the modelled fallback when both are present', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const ownBreakdown = { spread_cost: 9, commission: 9, slippage: 9, market_impact: 9 };
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        cost_breakdown: ownBreakdown,
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills[0]?.cost_breakdown).toEqual(ownBreakdown);
  });

  it('never falls back for a stop/target leg fill, even when the lot carries a modelled entry snapshot', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      stop: 95,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10 }),
      fill({
        broker_fill_id: toBrokerFillId('s1'),
        leg: 'stop',
        qty: 10,
        price: 95,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    const stopFill = fills.find((row) => row.broker_fill_id === 's1');
    expect(stopFill?.cost_breakdown).toBeUndefined();
  });

  it('prorates the flatten own modelled cost breakdown across a FIFO split exit fill, by each lot share of the raw fill', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      idempotency_key: 'key-1',
      requested_size: 6,
      opened_at: OPENED_AT,
    });
    await seedPosition(store, {
      idempotency_key: 'key-2',
      requested_size: 4,
      opened_at: new Date(OPENED_AT.getTime() + 1_000),
    });
    const entryOnly = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 6,
      }),
      fill({
        client_order_id: 'key-2',
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 4,
      }),
    ]);
    await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [
        { idempotency_key: 'key-1', held: 6 },
        { idempotency_key: 'key-2', held: 4 },
      ],
      exit_reason: 'flatten',
      decision_price: 100,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });

    const withFlatten = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 6,
      }),
      fill({
        client_order_id: 'key-2',
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 4,
      }),
      // A single raw exit fill covering the whole 10 — FIFO-allocates 6 to
      // key-1 and 4 to key-2 (`redistributeOneFlatten`).
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(withFlatten, store)).ingestFills();

    const key1Fills = await store.getFills('key-1');
    const key2Fills = await store.getFills('key-2');
    const key1Exit = key1Fills.find((row) => row.leg === 'exit');
    const key2Exit = key2Fills.find((row) => row.leg === 'exit');
    // share = 6/10 and 4/10 of the flatten's modelled breakdown.
    expectCostBreakdownCloseTo(key1Exit?.cost_breakdown, {
      spread_cost: 0.3,
      commission: 0.6,
      slippage: 0.15,
      market_impact: 0.06,
    });
    expectCostBreakdownCloseTo(key2Exit?.cost_breakdown, {
      spread_cost: 0.2,
      commission: 0.4,
      slippage: 0.1,
      market_impact: 0.04,
    });
    // #1001: both split rows carry the FLATTEN's own key, not the lot's own
    // (already `idempotency_key` on these rows) — the join back to
    // `flatten_submissions` this column exists for.
    expect(key1Exit?.flatten_idempotency_key).toBe('flatten-1');
    expect(key2Exit?.flatten_idempotency_key).toBe('flatten-1');
  });

  /**
   * #1014 review, finding 3 — the proration BASIS, red-checked against the
   * pre-fix code: this test failed with every component exactly DOUBLE the
   * snapshot before `redistributeOneFlatten` switched its denominator from
   * `rawFill.qty` to `attribution.size`.
   *
   * `share` (`take / rawFill.qty`) sums to 1.0 PER RAW FILL, which is right
   * for `fee` — the venue reports a fee per raw fill — and wrong for
   * `modelled_cost_breakdown`, which was priced ONCE against the whole
   * submitted size. So a flatten the venue splits into two partial raw fills
   * distributed the entire snapshot twice, and the summed modelled cost over
   * the flatten's fills came to a multiple of the single estimate it exists
   * to reconstruct — silently overstating modelled cost in exactly the query
   * #1001 was built to answer.
   *
   * One lot and two raw fills, deliberately: it isolates the SUBMISSION-level
   * basis from the lot-level split the test above already covers.
   */
  it('sums to exactly ONE snapshot across two partial raw fills of the same flatten, not one per raw fill', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10 });
    const entryOnly = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      }),
    ]);
    await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 100,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });

    const withFlatten = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      }),
      // ONE flatten submission for 10, filled by the venue in two partial raw
      // fills of 5. Each is its own `rawFill`, so each ran its own
      // 100%-of-the-snapshot allocation under the old basis.
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 5,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f2'),
        leg: 'exit',
        qty: 5,
        timestamp: new Date('2026-07-20T15:31:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(withFlatten, store)).ingestFills();

    const exits = (await store.getFills('key-1')).filter((row) => row.leg === 'exit');
    expect(exits).toHaveLength(2);
    // Each raw fill is 5 of the submitted 10, so each carries HALF.
    for (const row of exits) {
      expectCostBreakdownCloseTo(row.cost_breakdown, {
        spread_cost: modelledCostBreakdown.spread_cost / 2,
        commission: modelledCostBreakdown.commission / 2,
        slippage: modelledCostBreakdown.slippage / 2,
        market_impact: modelledCostBreakdown.market_impact / 2,
      });
    }
    // The property the review actually asked for: SUMMED, the modelled cost
    // across the flatten's fills EQUALS the one snapshot — never exceeds it.
    const summed = exits.reduce(
      (total, row) => ({
        spread_cost: total.spread_cost + (row.cost_breakdown?.spread_cost ?? 0),
        commission: total.commission + (row.cost_breakdown?.commission ?? 0),
        slippage: total.slippage + (row.cost_breakdown?.slippage ?? 0),
        market_impact: total.market_impact + (row.cost_breakdown?.market_impact ?? 0),
      }),
      { spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 },
    );
    expectCostBreakdownCloseTo(summed, modelledCostBreakdown);
  });

  it('leaves flatten_idempotency_key unset on entry/stop/target fills — only a flatten-produced exit fill carries one', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, side: 'buy', stop: 95 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10 }),
      fill({
        broker_fill_id: toBrokerFillId('s1'),
        leg: 'stop',
        qty: 10,
        price: 95,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    for (const row of fills) {
      expect(row.flatten_idempotency_key).toBeUndefined();
    }
  });
});

/**
 * #1121: the control arm (`SimulatedBrokerAdapter`) has always charged
 * `cost_breakdown.commission` as `fee` — it prices its own fills through the
 * injected `CostModel` and stamps the result straight on
 * (`simulated-adapter.ts`'s `submitBracket`/`submitFlatten`). A real-broker
 * fill (Alpaca paper, commission-free) instead arrived with `fee: 0` and the
 * SAME modelled `cost_breakdown` sitting beside it, UNUSED for accounting —
 * #1001's submit-time snapshot already prices every real-broker entry/exit
 * through the identical `CostModel` + venue config the control arm uses
 * (`execute.ts`'s `readSubmitSnapshot`, keyed on `config.simulated.venue`),
 * so the number these tests need already existed; it just was never spent on
 * `fee`.
 *
 * Read the fixtures' `fee` field first. An Alpaca-shaped `fee: 0` cannot tell
 * "add the modelled commission" apart from "top up to it", which is how the
 * round-1 review's double-charge (finding 1) hid behind a green suite —
 * `SAXO_COST_CONFIG` below exists so at least one fixture reports a venue fee
 * that is nonzero AND the same commission the model estimates.
 *
 * `docs/research/12-edge-hypothesis-critique.md` D4 and #636 require the two
 * arms to be a MATCHED control — comparable on the SAME cost basis, not just
 * on the same window. A live arm charged nothing while the control paid a
 * modelled commission is not matched: it manufactures a return gap that
 * measures fee asymmetry, not the debate layer. #1000 owns the cost model's
 * calibration; this ticket does not introduce a second one — it charges the
 * live arm exactly the commission #1000's model already computes for it.
 */
describe('ExecutionImpl.ingestFills — arm cost symmetry (#1121)', () => {
  const modelledCostBreakdown = {
    spread_cost: 0.5,
    commission: 1,
    slippage: 0.25,
    market_impact: 0.1,
  };

  /**
   * The live venue's own config, not a stand-in: `paper-profile.ts` builds the
   * same `venues.saxo.commissionRate` off the same constant `saxo-adapter.ts`
   * computes its reported `fee` from. A fixture that did not share that
   * constant could not show the double-charge the round-1 review found.
   */
  const SAXO_COST_CONFIG: CostConfig = {
    stocks: {
      spreadVolatilityCoefficient: 0.5,
      commissionRate: 0,
      slippageCoefficient: 0.1,
      impactK: 0.1,
    },
    crypto: {
      spreadVolatilityCoefficient: 0.5,
      commissionRate: 0,
      slippageCoefficient: 0.1,
      impactK: 0.1,
    },
    venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
  };

  const saxoMarketState = (mid: number): MarketState => ({
    mid,
    spread: 0.1,
    adv: 1_000_000,
    volatility: 0.02,
    asset_class: 'stocks',
    venue: 'saxo',
    timestamp: NOW,
  });

  it('charges a real-broker entry fill the modelled commission, topping up the venue-reported (zero) fee', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    // Alpaca-shaped: commission-free, fee always 0 on the wire.
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    // Charged fee = the venue-reported 0 topped up to the modelled commission
    // (1) — the same
    // figure `SimulatedBrokerAdapter` would have stamped as `fee` directly
    // for an identical order (see the `SAXO_COMMISSION_RATE`-driven test
    // below for the literal two-adapter comparison).
    expect(fills[0]?.fee).toBeCloseTo(1, 9);
    // AC2: the venue's OWN report stays recoverable — `cost_breakdown` is
    // untouched (still the modelled estimate GAP-F's divergence check reads),
    // so `fee - cost_breakdown.commission` reconstructs exactly what the
    // venue reported, here 0.
    expect((fills[0]?.fee ?? 0) - (fills[0]?.cost_breakdown?.commission ?? 0)).toBeCloseTo(0, 9);
  });

  it('leaves a real-broker fee untouched when the lot carries no modelled snapshot (unchanged pre-#1121 behaviour)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills[0]?.fee).toBe(0);
  });

  it('does NOT double-charge a Simulated-adapter fill that already carries its own cost_breakdown', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      // Even if a lot somehow carried a modelled snapshot too, the fill's
      // OWN cost_breakdown must win — this is the control arm's own path,
      // which self-prices and must never have a second commission added.
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const ownBreakdown = { spread_cost: 9, commission: 9, slippage: 9, market_impact: 9 };
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        fee: 9,
        cost_breakdown: ownBreakdown,
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills[0]?.fee).toBe(9);
  });

  it('charges the flatten exit fill the modelled commission, topping up the venue-reported (zero) fee', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10 });
    const entryOnly = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        fee: 0,
      }),
    ]);
    await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 100,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });

    const withFlatten = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        fee: 0,
      }),
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(withFlatten, store)).ingestFills();

    const exit = (await store.getFills('key-1')).find((row) => row.leg === 'exit');
    expect(exit?.fee).toBeCloseTo(modelledCostBreakdown.commission, 9);
    expect((exit?.fee ?? 0) - (exit?.cost_breakdown?.commission ?? 0)).toBeCloseTo(0, 9);
  });

  it('carries the modelled commission through to closedTrade().fees_total / realized_pnl_net for a full round trip', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const entryOnly = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);
    await new ExecutionImpl(makeInput(entryOnly, store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const withFlatten = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        price: 110,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(withFlatten, store)).ingestFills();

    const closed = (await store.getClosedTrades())[0];
    // gross = (110 - 100) * 10 = 100; fees = 1 (entry commission) + 1 (exit
    // commission) = 2 → net 98. Before #1121 this was 100/0 — the exact
    // "live arm pays nothing" shape #1121 exists to close.
    expect(closed.fees_total).toBeCloseTo(2, 9);
    expect(closed.realized_pnl_net).toBeCloseTo(98, 9);
  });

  it('does not double- or under-charge the modelled commission across a cumulative (#842) two-part entry fill', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 100,
      filled_size: 0,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('alpaca-entry-1'),
        leg: 'entry',
        qty: 50,
        price: 100,
        fee: 0,
        timestamp: new Date('2026-07-20T15:00:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('alpaca-entry-1'),
        leg: 'entry',
        qty: 100,
        price: 101,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    await execution.ingestFills();

    const fills = await store.getFills('key-1');
    const totalFee = fills.reduce((sum, row) => sum + row.fee, 0);
    // Summed across both increments, the charged fee equals exactly ONE
    // modelled commission (1) — not two (double-counted against the
    // cumulative venue total) and not zero (swallowed by the `Math.max(0, …)`
    // clamp `cumulativeTopUp` applies to the RAW venue delta).
    expect(totalFee).toBeCloseTo(modelledCostBreakdown.commission, 9);
  });

  it('charges the live arm exactly what SimulatedBrokerAdapter charges the control arm for an identical order (AC1)', async () => {
    const costModel = new CostModelImpl(SAXO_COST_CONFIG);
    const marketState = saxoMarketState(100);
    const fillRequest = {
      instrument: 'AAPL',
      side: 'buy' as const,
      size: 10,
      order_type: 'limit' as const,
      limit_price: 100,
      idempotency_key: 'shared',
    };

    // What the control arm's `SimulatedBrokerAdapter.submitBracket` stamps as
    // `fee` for this exact order, verbatim — the same `costModel.fill()` call
    // `readSubmitSnapshot` (execute.ts) makes for the live arm's submit-time
    // snapshot.
    const controlResult = costModel.fill(fillRequest, marketState);

    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: controlResult.cost_breakdown,
    });
    // Live arm: same instrument/size/price, Alpaca-shaped zero fee.
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const liveFee = (await store.getFills('key-1'))[0]?.fee;
    expect(liveFee).toBeCloseTo(controlResult.cost_breakdown.commission, 9);
    // Not a vacuous check — Saxo's 8bps is not zero.
    expect(controlResult.cost_breakdown.commission).toBeGreaterThan(0);
  });

  /**
   * AC3, at the layer the acceptance criterion actually names: not "two fills
   * agree" (the test above) but "`ArmComparison`'s `return_pct` for both arms
   * computed on the same cost basis". Runs a REAL round trip through
   * `ingestFills()` for BOTH arms, on ONE shared `closed_trades` table (same
   * `db`, a 'live' `TestExecutionStore` and a 'control' one — #1121's harness
   * addition), reads them back through the actual `SqliteArmComparisonSource`
   * (so this also re-proves migration 0049's column does not gut a correctly-
   * charged row), and feeds the result into `buildArmComparison`. If either
   * arm's fee treatment ever regresses back to asymmetric, this fails on
   * `return_pct`, not merely on a `fee` field nobody downstream reads.
   */
  it('produces equal ArmComparison.return_pct for both arms on an identical round trip (AC3)', async () => {
    const costModel = new CostModelImpl(SAXO_COST_CONFIG);
    const entryCost = costModel.fill(
      {
        instrument: 'AAPL',
        side: 'buy',
        size: 10,
        order_type: 'limit',
        limit_price: 100,
        idempotency_key: 'entry',
      },
      saxoMarketState(100),
    );
    const exitCost = costModel.fill(
      {
        instrument: 'AAPL',
        side: 'sell',
        size: 10,
        order_type: 'limit',
        limit_price: 110,
        idempotency_key: 'exit',
      },
      saxoMarketState(110),
    );

    const db = openSharedStore(':memory:');
    const liveStore = new TestExecutionStore(db);
    const controlStore = new TestExecutionStore(db, 'control');

    // Live arm: Alpaca-shaped (fee 0 on the wire), the modelled snapshot
    // (#1001) fed in as `modelled_cost_breakdown` — exactly what
    // `readSubmitSnapshot` would have captured at submit time.
    await seedPosition(liveStore, {
      idempotency_key: 'live-key',
      requested_size: 10,
      modelled_cost_breakdown: entryCost.cost_breakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            client_order_id: 'live-key',
            broker_fill_id: toBrokerFillId('live-e1'),
            leg: 'entry',
            qty: 10,
            price: 100,
            fee: 0,
          }),
        ]),
        liveStore,
      ),
    ).ingestFills();
    await liveStore.writeAheadFlatten({
      idempotency_key: 'live-flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'live-key', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: exitCost.cost_breakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            client_order_id: 'live-key',
            broker_fill_id: toBrokerFillId('live-e1'),
            leg: 'entry',
            qty: 10,
            price: 100,
            fee: 0,
          }),
          fill({
            client_order_id: 'live-flatten-1',
            broker_fill_id: toBrokerFillId('live-f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        liveStore,
      ),
    ).ingestFills();

    // Control arm: `SimulatedBrokerAdapter`-shaped — self-prices, `fee` and
    // `cost_breakdown` come straight off the SAME `costModel.fill()` calls
    // above, exactly as `submitBracket`/`submitFlatten` do.
    await seedPosition(controlStore, { idempotency_key: 'control-key', requested_size: 10 });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            client_order_id: 'control-key',
            broker_fill_id: toBrokerFillId('control-e1'),
            leg: 'entry',
            qty: 10,
            price: 100,
            fee: entryCost.cost_breakdown.commission,
            cost_breakdown: entryCost.cost_breakdown,
          }),
        ]),
        controlStore,
      ),
    ).ingestFills();
    await controlStore.writeAheadFlatten({
      idempotency_key: 'control-flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'control-key', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            client_order_id: 'control-key',
            broker_fill_id: toBrokerFillId('control-e1'),
            leg: 'entry',
            qty: 10,
            price: 100,
            fee: entryCost.cost_breakdown.commission,
            cost_breakdown: entryCost.cost_breakdown,
          }),
          fill({
            client_order_id: 'control-flatten-1',
            broker_fill_id: toBrokerFillId('control-f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: exitCost.cost_breakdown.commission,
            cost_breakdown: exitCost.cost_breakdown,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        controlStore,
      ),
    ).ingestFills();

    const from = new Date('2026-07-20T00:00:00Z');
    const to = new Date('2026-07-21T00:00:00Z');
    const trades = new SqliteArmComparisonSource(db).getClosedTradesBetween(from, to);
    expect(trades.map((t) => t.idempotency_key).sort()).toEqual(['control-key', 'live-key']);

    const comparison = buildArmComparison({
      trades,
      refused_passes: { live: 0, control: 0 },
      from,
      to,
      basis: 1000,
    });

    // Same gross (100 → 110, size 10) and — the property #1121 exists to
    // establish — the same modelled commission on both legs, so the two
    // arms' realized_pnl_net, and therefore return_pct, must match exactly.
    // Before #1121 the live arm's fees_total would have been 0 here instead
    // of `entryCost.commission + exitCost.commission`, and this assertion
    // would fail.
    expect(comparison.live.realized_pnl_net).toBeCloseTo(comparison.control.realized_pnl_net, 9);
    expect(comparison.live.return_pct).toBeCloseTo(comparison.control.return_pct, 9);
    expect(comparison.live.trade_count).toBe(1);
    expect(comparison.control.trade_count).toBe(1);
  });

  /**
   * ROUND-1 REVIEW, finding 1. Every other test in this describe feeds an
   * Alpaca-shaped `fee: 0`, where "add the modelled commission" and "top up to
   * it" are the same number — so the whole of the Saxo cutover was invisible.
   * `saxo-adapter.ts` reports `price * qty * SAXO_COMMISSION_RATE` and
   * `paper-profile.ts` prices the modelled snapshot off the SAME constant, so
   * on the day Saxo becomes the adapter the venue's fee and the model's
   * estimate are the same commission. Under the shipped addition that charged
   * exactly 2x (reviewer's repro: `venueFee 0.8 chargedFee 1.6`); under
   * `chargeTopUpTo` it is charged once.
   */
  it('charges a Saxo-shaped entry fill ONE commission, not the venue fee plus the modelled one', async () => {
    const costModel = new CostModelImpl(SAXO_COST_CONFIG);
    const snapshot = costModel.fill(
      {
        instrument: 'AAPL',
        side: 'buy',
        size: 10,
        order_type: 'limit',
        limit_price: 100,
        idempotency_key: 'key-1',
      },
      saxoMarketState(100),
    );
    // Exactly what `saxo-adapter.ts` puts on the wire for this fill.
    const venueFee = 100 * 10 * SAXO_COMMISSION_RATE;

    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: snapshot.cost_breakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            qty: 10,
            price: 100,
            fee: venueFee,
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const charged = (await store.getFills('key-1'))[0]?.fee ?? 0;
    const modelled = snapshot.cost_breakdown.commission;
    // Not a vacuous fixture: the venue really did report a fee, and it really
    // is the same 8bps the model charges.
    expect(venueFee).toBeGreaterThan(0);
    expect(venueFee).toBeCloseTo(modelled, 9);
    expect(charged).toBeCloseTo(Math.max(venueFee, modelled), 9);
    expect(charged).toBeLessThan(venueFee + modelled);
  });

  it('charges the venue-reported fee when it EXCEEDS the modelled estimate, still exactly once', async () => {
    const costModel = new CostModelImpl(SAXO_COST_CONFIG);
    // Snapshot priced at submit-time mid 100; the venue fills at 110, so its
    // own 8bps is larger than the estimate. The charge is the venue's actual,
    // never the estimate stacked on top of it.
    const snapshot = costModel.fill(
      {
        instrument: 'AAPL',
        side: 'buy',
        size: 10,
        order_type: 'limit',
        limit_price: 100,
        idempotency_key: 'key-1',
      },
      saxoMarketState(100),
    );
    const venueFee = 110 * 10 * SAXO_COMMISSION_RATE;

    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: snapshot.cost_breakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({
            broker_fill_id: toBrokerFillId('e1'),
            leg: 'entry',
            qty: 10,
            price: 110,
            fee: venueFee,
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const charged = (await store.getFills('key-1'))[0]?.fee ?? 0;
    expect(venueFee).toBeGreaterThan(snapshot.cost_breakdown.commission);
    expect(charged).toBeCloseTo(venueFee, 9);
  });

  it('charges a Saxo-shaped FLATTEN exit fill one commission, not two (redistributeOneFlatten)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10 });
    const entryFill = fill({
      client_order_id: 'key-1',
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      fee: 0,
    });
    await new ExecutionImpl(makeInput(new ScriptedBroker([entryFill]), store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 100,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });

    // The venue reports the same commission the snapshot models — the Saxo
    // shape, at this fixture's scale.
    const venueFee = modelledCostBreakdown.commission;
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          entryFill,
          fill({
            client_order_id: 'flatten-1',
            broker_fill_id: toBrokerFillId('f1'),
            leg: 'exit',
            qty: 10,
            fee: venueFee,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const exit = (await store.getFills('key-1')).find((row) => row.leg === 'exit');
    expect(exit?.fee).toBeCloseTo(venueFee, 9);
    expect(exit?.fee ?? 0).toBeLessThan(venueFee + modelledCostBreakdown.commission);
  });

  /**
   * ROUND-1 REVIEW, finding 4. SYNTHETIC by construction, and said so rather
   * than dressed up as a live path: `qty_is_cumulative` is set only by
   * `alpaca-order-normalization.ts`, and Alpaca always reports `fee: 0`, so no
   * venue in the system today is both cumulative AND fee-reporting. It pins the
   * function's contract, which is otherwise unreachable — and it is the test
   * that showed the shipped `venueReportedFee(row)` subtraction to be wrong
   * under a top-up charge (that subtraction leaves 1.3 total here, against a
   * venue that reported 0.8 and a model that estimates 1.0).
   */
  it('charges one modelled commission total across a cumulative entry whose venue fee is also cumulative', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 100,
      filled_size: 0,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('cumulative-1'),
        leg: 'entry',
        qty: 50,
        price: 100,
        fee: 0.4,
        timestamp: new Date('2026-07-20T15:00:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('cumulative-1'),
        leg: 'entry',
        qty: 100,
        price: 100,
        fee: 0.8,
        timestamp: new Date('2026-07-20T15:30:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    await execution.ingestFills();

    const fills = await store.getFills('key-1');
    const totalFee = fills.reduce((sum, row) => sum + row.fee, 0);
    // One modelled commission (1) — the model out-charges the venue's 0.8, so
    // the model's figure is what the lot pays, once.
    expect(totalFee).toBeCloseTo(modelledCostBreakdown.commission, 9);
  });

  /**
   * ROUND-1 REVIEW, finding 2. `modelled_cost_charged` must state what
   * HAPPENED, not that the code path was entered. A live lot with no
   * submit-time snapshot (`captureSubmitSnapshot` is best-effort, and two of
   * the three live lots in the soak DB carried none, per the #1121 round-1
   * review) goes through exactly the same `toFill` call and is charged
   * nothing by it.
   */
  it('records modelled_cost_charged = false on a live round trip whose lot carries no modelled snapshot', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, side: 'buy' });
    const entryFill = fill({
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      price: 100,
      fee: 0,
    });
    await new ExecutionImpl(makeInput(new ScriptedBroker([entryFill]), store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          entryFill,
          fill({
            client_order_id: 'flatten-1',
            broker_fill_id: toBrokerFillId('f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const closed = (await store.getClosedTrades())[0];
    expect(closed.fees_total).toBe(0);
    expect(closed.modelled_cost_charged).toBe(false);
  });

  it('records modelled_cost_charged = true when every covered leg was charged', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const entryFill = fill({
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      price: 100,
      fee: 0,
    });
    await new ExecutionImpl(makeInput(new ScriptedBroker([entryFill]), store)).ingestFills();

    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          entryFill,
          fill({
            client_order_id: 'flatten-1',
            broker_fill_id: toBrokerFillId('f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const closed = (await store.getClosedTrades())[0];
    expect(closed.modelled_cost_charged).toBe(true);
  });

  /**
   * ROUND-2 REVIEW, finding 3. The predicate is `.every(…)` over the covered
   * legs, and only the ALL-uncharged case was pinned: mutating it to `.some(…)`
   * left the whole execution and control-arm suites green. The distinguishing
   * case is a MIXED lot — entry charged, flatten not — which is not a corner
   * case but the live regime `modelledCostCharged`'s doc in
   * `sqlite-arm-comparison-source.ts` describes as ongoing, and which the soak
   * DB already holds rows for (one live lot carries an exit breakdown and no
   * entry one).
   *
   * `false` is the answer that matters: the flag certifies the whole round
   * trip's cost basis, so a lot charged on one covered leg and not the other
   * is NOT on the control arm's basis and must not be admitted to the
   * comparison. `.some(…)` would admit it.
   */
  it('records modelled_cost_charged = false when only some covered legs were charged', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    const entryFill = fill({
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      price: 100,
      fee: 0,
    });
    await new ExecutionImpl(makeInput(new ScriptedBroker([entryFill]), store)).ingestFills();

    // The flatten carries NO snapshot, so its exit leg closes uncharged while
    // the entry leg above was charged the modelled commission.
    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 10,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 10 }],
      exit_reason: 'flatten',
      decision_price: 110,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          entryFill,
          fill({
            client_order_id: 'flatten-1',
            broker_fill_id: toBrokerFillId('f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const fills = await store.getFills('key-1');
    // Mixed by construction: the assertion above is only meaningful if the two
    // covered legs really disagree.
    expect(fills.find((row) => row.leg === 'entry')?.cost_breakdown).toBeDefined();
    expect(fills.find((row) => row.leg === 'exit')?.cost_breakdown).toBeUndefined();

    const closed = (await store.getClosedTrades())[0];
    expect(closed.modelled_cost_charged).toBe(false);
  });

  /**
   * ROUND-1 REVIEW, finding 3 — the residual, PINNED rather than fixed
   * (#1301). No MODELLED estimate exists for a protective leg on either arm,
   * so the live lot is charged whatever its adapter reports on that leg and
   * `chargeTopUpTo` has nothing to top it up to.
   *
   * Round 5, finding 1: what that costs is ADAPTER-DEPENDENT, and this
   * fixture pins one adapter, not the mechanism. The `fee: 0` below is the
   * Alpaca shape (`alpaca-order-normalization.ts`), where the exit commission
   * goes unpaid entirely. `saxo-adapter.ts` reports
   * `price * qty * SAXO_COMMISSION_RATE` on EVERY leg, so under Saxo the leg
   * does pay and the residual is a price-basis difference instead — see
   * `toFill`'s "What this still does not cover" for both readings. Do not
   * read "uncharged" in this test's name as a venue-independent property.
   *
   * The flag stays `true`: vetoing on it would drop live trades BECAUSE they
   * exited on a stop, which selects on outcome (stops are the losers). This
   * test exists so the residual cannot be quietly forgotten — it fails the
   * moment bracket legs start being charged, which is where #1301 has to
   * update it.
   */
  it('leaves a live protective-leg (stop) exit uncharged — the known residual, #1301', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
    });
    await new ExecutionImpl(
      makeInput(
        new ScriptedBroker([
          fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
          fill({
            broker_fill_id: toBrokerFillId('s1'),
            leg: 'stop',
            qty: 10,
            price: 95,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          }),
        ]),
        store,
      ),
    ).ingestFills();

    const stop = (await store.getFills('key-1')).find((row) => row.leg === 'stop');
    expect(stop?.fee).toBe(0);
    expect(stop?.cost_breakdown).toBeUndefined();
    const closed = (await store.getClosedTrades())[0];
    // Entry commission only: the round trip is charged one leg where the
    // control arm's equivalent flatten close is charged two.
    expect(closed.fees_total).toBeCloseTo(modelledCostBreakdown.commission, 9);
    expect(closed.modelled_cost_charged).toBe(true);
  });
});

/**
 * #1087: `fill-sync.ts`'s `runPoll` calls `reconcile()` then `ingestFills()`
 * back to back, every poll — the same order these tests drive `ExecutionImpl`
 * in. `reconcile()` adopts the broker's `order_state` without ever touching
 * `filled_size` (its own doc); only `ingestFills()` writes that. The two
 * calls must never leave a position `filled`/`partially_filled` with a
 * `filled_size` of zero — that combination is not a valid state for any
 * venue to report, and it is exactly the anomaly the 2026-09-03 paper soak
 * measured (issue #1087: a control-arm META lot, `order_state: 'filled'`,
 * `filled_size: 0.0`, permanently, after reconcile adopted it at 14:04Z).
 */
describe('ExecutionImpl.reconcile() then ingestFills() — the adopted-from-reconcile path', () => {
  it('produces a coherent position record: filled_size matches once ingestFills runs', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      // Respects the invariant `ingestFills()`'s global `since` floor relies
      // on (ingest-fills.ts's #838 comment): dated at/after the lot's own
      // `opened_at`, which every real adapter and the fixed Simulated one
      // (#1087) both guarantee.
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100 }),
    ]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger));

    const report = await execution.reconcile();
    expect(report.divergences).toEqual([
      expect.objectContaining({
        idempotency_key: 'key-1',
        action: 'adopted',
        broker_state: 'filled',
      }),
    ]);
    // Reconcile alone leaves this — by design (reconcile.ts's own doc,
    // "filled_size stays at whatever the Fill rows say"). If ingestFills
    // never ran, or its own fill were excluded, THIS is where the record
    // would freeze — the exact META shape.
    expect((await store.getPosition('key-1'))?.filled_size).toBe(0);

    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(10);
    expect(position?.avg_entry_price).toBe(100);
    // The anomaly detector must not fire on the coherent path.
    expect(logger.entries.some((e) => e.message === FILLED_WITH_ZERO_SIZE)).toBe(false);
  });

  it('warns exactly once for a permanently wedged lot, never re-reporting while it stays wedged (#1383)', async () => {
    // The shape a broker that VIOLATES the invariant produces (what
    // `SimulatedBrokerAdapter` did before #1087): a fill dated earlier than
    // its own lot's `opened_at`. `ScriptedBroker.fetchNewFills` filters by
    // `since` exactly like every real adapter, so — with this lot the SOLE
    // open position, making its own `opened_at` the poll's floor — the fill
    // is excluded on every poll, forever.
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        timestamp: new Date(OPENED_AT.getTime() - 1),
      }),
    ]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger));

    await execution.reconcile();
    // Throttled (#1087 review, `FilledZeroSizeThrottle`, rebuilt #1383 to
    // warn-once/low-cadence-info): quiet for the first two consecutive
    // wedged polls (`ALERT_AFTER_CONSECUTIVE_ZERO_SIZE=3` — review pass 2's
    // fix for the documented benign "once or twice" Alpaca propagation
    // lag), warns once on the 3rd, then silent for as long as the lot stays
    // wedged AND the fixed test clock never advances (`makeInput`'s default
    // clock — the info reannounce is time-based, see
    // `filled-zero-size-throttle.ts`, so a clock that never moves can never
    // cross the reannounce interval; the advancing-clock case is covered
    // separately below). 40 polls — many multiples of the old
    // every-8th-repeat cadence — proves the silence holds, not just that it
    // starts.
    for (let poll = 0; poll < 40; poll += 1) {
      await execution.ingestFills();
    }

    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(0);
    expect(await store.getFills('key-1')).toHaveLength(0);

    const warnings = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(warnings).toHaveLength(1);
    // AC3 (#1383): the FIRST occurrence must announce at `warn`, not `info`
    // — a mutation flipping this level to 'info' passes every other
    // assertion in this suite and must fail here.
    expect(warnings[0]?.level).toBe('warn');
    expect(warnings[0]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 3,
    });
    // Never cleared (the lot never advances), so no cleared transition either.
    expect(logger.entries.some((e) => e.message === FILLED_ZERO_SIZE_CLEARED)).toBe(false);
  });

  it('re-announces a permanently wedged lot at info level, at most once per reannounce interval, never at warn again (#1383)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        timestamp: new Date(OPENED_AT.getTime() - 1),
      }),
    ]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    // A clock that advances one reannounce interval PLUS a poll's worth per
    // `ingestFills()` call — the wedge stays observable, with growing
    // `stuck_ms`, on a cadence a coordinator-ruled pure transition-only
    // design could not provide.
    let currentTime = NOW;
    const clock: Clock = { now: () => currentTime };
    const execution = new ExecutionImpl(
      makeInput(broker, store, undefined, undefined, logger, undefined, 'trace-1', clock),
    );

    await execution.reconcile();
    await execution.ingestFills(); // consecutive 1, quiet
    await execution.ingestFills(); // consecutive 2, quiet
    await execution.ingestFills(); // consecutive 3, warn

    currentTime = new Date(currentTime.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1);
    await execution.ingestFills(); // past the reannounce interval: info

    currentTime = new Date(currentTime.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1);
    await execution.ingestFills(); // past it again: another info

    const announcements = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(announcements.map((e) => e.level)).toEqual(['warn', 'info', 'info']);
    // The wedge's age (`stuck_ms`) grows across the announcements — the
    // property #1128's `ExitSkipWriteThrottle` docblock relies on this
    // channel to provide.
    const stuckMs = announcements.map((e) => (e.payload as { stuck_ms: number }).stuck_ms);
    expect(stuckMs[1]).toBeGreaterThan(stuckMs[0] ?? 0);
    expect(stuckMs[2]).toBeGreaterThan(stuckMs[1] ?? 0);
  });

  it('warns again when a wedged lot clears and later re-enters the condition (#1383)', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const entryFill = fill({
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      price: 100,
      timestamp: new Date(OPENED_AT.getTime() - 1),
    });
    const broker = new ScriptedBroker([entryFill]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger));

    await execution.reconcile();
    // Wedged for 3 polls: warns once, at consecutive: 3.
    await execution.ingestFills();
    await execution.ingestFills();
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);

    // The entry fill finally lands within the `since` floor — the lot
    // advances past zero, clearing the episode. The clear is announced
    // because this episode DID warn (`FilledZeroSizeThrottle.clear()`'s
    // `hadWarned`, unit-tested directly in filled-zero-size-throttle.test.ts;
    // per-lot/per-episode independence — a different lot warning on its own,
    // and a cleared-then-rewedged lot warning again — is pinned there too,
    // where the state machine actually lives).
    broker.replaceFills([{ ...entryFill, timestamp: new Date('2026-07-20T15:00:00Z') }]);
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_ZERO_SIZE_CLEARED)).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(10);
  });

  it('a lot resolved by rejection, not by advancing, never reports cleared — the leaked episode is inert (#1383)', async () => {
    // `FilledZeroSizeThrottle.clear()` runs from exactly one call site
    // (`advanceLot`'s `filledSize > 0` branch). Once a lot is adopted
    // `filled`/`partially_filled`, `reconcile()` never revisits it —
    // `reconcileLot` only runs for `IN_FLIGHT` (`pending`/`submitted`)
    // positions (reconcile.ts), so its own `rejected`/`adopted` branches
    // cannot fire on an already-wedged lot either. The only way a wedged
    // lot leaves `filled`/zero-size without going through `advanceLot` is
    // an out-of-band store write — the shape #1186 (the named repair for
    // the incident's wedged META lot) takes: an operator updates
    // `open_positions` directly, bypassing `reconcile()`/`ingestFills()`
    // entirely. Modelled here with the same store primitive `reconcileLot`
    // itself uses (`updatePositionState`), called directly rather than
    // through `reconcile()`, since `reconcile()` has no path back to an
    // already-adopted position at all. Leaves that episode's Map entry,
    // permanently `warned`, for the rest of the process's life —
    // pre-existing, not introduced by #1383: the pre-#1383 throttle called
    // `clear()` from this exact same single site. What matters is that the
    // leak stays inert — no false "cleared" (the lot never advanced, it was
    // abandoned) and no further warning (the lot has left
    // `getOpenPositions()` for good, so `observe()` is never called for it
    // again).
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        timestamp: new Date(OPENED_AT.getTime() - 1),
      }),
    ]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger));

    await execution.reconcile();
    await execution.ingestFills();
    await execution.ingestFills();
    await execution.ingestFills(); // consecutive 3: warns once
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);

    await store.updatePositionState('key-1', { order_state: 'rejected', broker_order_ids: [] });
    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('rejected');
    expect(await store.getOpenPositions()).toHaveLength(0);

    // Further polls see no open positions at all, so the throttle is never
    // consulted again for this key — the leaked episode neither re-warns
    // nor fabricates a "cleared" transition for a lot that was actually
    // abandoned, not advanced.
    await execution.ingestFills();
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);
    expect(logger.entries.some((e) => e.message === FILLED_ZERO_SIZE_CLEARED)).toBe(false);
  });

  it('does not reset the wedge streak when a non-entry fill lands on a still-wedged lot (#1087 review, pass 2)', async () => {
    // `advanceLot` unconditionally cleared the throttle as soon as
    // `newFills.length > 0` — but a non-entry fill (e.g. a stray stop/target
    // report) can arrive for a lot whose OWN entry fill is still excluded by
    // the `since` floor, so the recomputed `filledSize` is still 0 after that
    // poll. Clearing there restarts the streak at `consecutive: 1` on the
    // very next wedged poll instead of continuing it — this test drives
    // exactly that shape and proves the streak survives.
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const entryFill = fill({
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
      price: 100,
      // Same permanent-exclusion shape as the test above: dated before the
      // lot's own `opened_at`, so `ScriptedBroker.fetchNewFills` (mirroring
      // every real adapter) filters it out on every single poll.
      timestamp: new Date(OPENED_AT.getTime() - 1),
    });
    const broker = new ScriptedBroker([entryFill]);
    broker.scriptedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const logger = recordingLogger();
    const throttle = new FilledZeroSizeThrottle();
    const execution = new ExecutionImpl(
      makeInput(broker, store, undefined, undefined, logger, throttle),
    );

    await execution.reconcile();
    // Two wedged polls: consecutive 1, then 2 — both quiet
    // (`ALERT_AFTER_CONSECUTIVE_ZERO_SIZE=3`, review pass 2's fix; the first
    // boundary is the 3rd consecutive poll, not the 1st).
    await execution.ingestFills();
    await execution.ingestFills();

    // A non-entry fill arrives this poll. The lot's OWN entry fill (`e1`) is
    // still excluded — `filledSize` recomputes to 0 again, so this is the
    // exact "new fill, but the lot is still wedged at zero" shape the review
    // named, not a genuine advance.
    const stopFill = fill({
      broker_fill_id: toBrokerFillId('s1'),
      leg: 'stop',
      qty: 10,
      price: 95,
      timestamp: new Date('2026-07-20T15:00:00Z'),
    });
    broker.replaceFills([entryFill, stopFill]);
    await execution.ingestFills();

    // The stop fill WAS persisted — this branch stores new rows before
    // returning, it just must not treat the lot as no-longer-wedged.
    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(0);

    // No warning fired anywhere yet: polls 1-2 are below threshold
    // (`ALERT_AFTER_CONSECUTIVE_ZERO_SIZE=3`) and the interruption poll skips
    // the wedge-detector branch entirely (`newFills.length > 0`), fixed or
    // buggy.
    const warningsSoFar = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(warningsSoFar).toHaveLength(0);

    // THE ASSERTION: probe the throttle directly for what the NEXT wedged
    // poll would observe. Fixed: the streak continued through the
    // interruption (1, 2, [interruption, no observe], 3) — this call lands
    // exactly on `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE` and reports
    // `{ announce: 'warn', consecutive: 3 }`. Bugged (`clear()` ran on the
    // interruption poll): the streak restarted, and this call would report
    // `{ announce: null, consecutive: 1 }` instead — silently missing the
    // alert a genuinely wedged lot is due, not merely mis-numbering it.
    expect(throttle.observe('key-1', NOW)).toEqual({ announce: 'warn', consecutive: 3 });
  });
});

// #1348: `ResidualExposureAlert.trace_id`/`FlattenOverfillWarning.trace_id`
// must carry the EXECUTION SURFACE's own id, not a literal either producer
// picked itself — the property that lets a shared, arm-agnostic channel
// instance (console-channels.ts) tell a control-arm alert from a live one.
// These two tests vary only `trace_id` between two otherwise-identical runs
// and assert the alert follows it — a mutation that hardcodes either
// producer's `trace_id:` field stays green under every OTHER test in this
// file (they all use the same default `'trace-1'`) but fails here.
describe('trace_id threading onto alerts (#1348)', () => {
  it("alertResidualExposure carries the pass's own trace_id, not a fixed one", async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, stop: 95, target: 110 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10 }),
      fill({
        broker_fill_id: toBrokerFillId('x1'),
        leg: 'exit',
        qty: 4,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);
    broker.rearmFailure = new Error('venue rejected the OCO order');
    const residualExposureAlerts = makeResidualExposureAlerts();

    await new ExecutionImpl(
      makeInput(
        broker,
        store,
        residualExposureAlerts,
        undefined,
        undefined,
        undefined,
        'control-arm-fill-sync',
      ),
    ).ingestFills();

    expect(residualExposureAlerts.alerts.map((alert) => alert.trace_id)).toEqual([
      'control-arm-fill-sync',
    ]);
  });

  it("redistributeOneFlatten carries the pass's own trace_id, not a fixed one", async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
    await store.writeAheadFlatten({
      idempotency_key: 'flatten-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 6,
      submitted_at: OPENED_AT,
      lot_held_quantities: [{ idempotency_key: 'key-1', held: 6 }],
      exit_reason: 'flatten',
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });
    const withFlatten = new ScriptedBroker([
      fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      }),
      fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);
    const flattenOverfillAlerts = makeFlattenOverfillAlerts();

    await new ExecutionImpl(
      makeInput(
        withFlatten,
        store,
        undefined,
        flattenOverfillAlerts,
        undefined,
        undefined,
        'control-arm-fill-sync',
      ),
    ).ingestFills();

    expect(flattenOverfillAlerts.warnings.map((warning) => warning.trace_id)).toEqual([
      'control-arm-fill-sync',
    ]);
  });
});

/**
 * #1334: `broker_fill_id` is branded so a MISLABELED `hasFill` argument (both
 * fields swapped under their correct key names) fails to compile, closing the
 * gap #1328's single-object form left open — that change stopped a
 * POSITIONAL swap but left two same-shaped `string` fields swappable by name.
 * The `@ts-expect-error` and `expectTypeOf` lines are the assertions; the
 * store calls exist only to give them a real call site. This block is the
 * only guard against the store re-widening its parameter to `string`:
 * `implements SharedStore` checks method parameters bivariantly and would
 * not catch it.
 */
describe('hasFill argument branding (#1334)', () => {
  it('pins the hasFill argument shape so a rename or widening fails loudly instead of leaving the @ts-expect-error below unused for the wrong reason', () => {
    expectTypeOf<Parameters<SharedStore['hasFill']>[0]>().toEqualTypeOf<{
      idempotency_key: string;
      broker_fill_id: BrokerFillId;
    }>();
  });

  it('rejects a mislabeled hasFill argument at compile time', () => {
    const { store } = openTestExecutionStore();
    const idempotency_key = 'lot-1';
    const broker_fill_id = toBrokerFillId('venue-fill-1');

    // Swapped under their own correct-looking key names. Both source values
    // are `string`-typed before branding, so without the brand this object
    // would satisfy `hasFill`'s parameter type and the swap would ship
    // silently — exactly the hazard this ticket closes.
    // @ts-expect-error — `broker_fill_id` must be a `BrokerFillId`, not the raw idempotency key.
    void store.hasFill({ idempotency_key: broker_fill_id, broker_fill_id: idempotency_key });
  });

  it('accepts the correctly labeled argument', async () => {
    const { store } = openTestExecutionStore();

    await expect(
      store.hasFill({ idempotency_key: 'lot-1', broker_fill_id: toBrokerFillId('venue-fill-1') }),
    ).resolves.toBe(false);
  });
});

// #1220 (David's ruling, 2026-09-08). `fee` is summed into
// `closed_trades.fees_total` as book currency; before this the adapter's
// `fee_currency` was dropped at `toFill`, so a USD commission was booked as
// GBP with nothing said. Sterling-only makes a foreign fee a CONTRADICTION —
// the tradeable universe excludes every non-sterling line, so one arriving
// means an instrument was traded that selection should have refused.
describe('a non-sterling fee is a loud contradiction, not a silent GBP sum (#1220)', () => {
  it('persists the currency and raises it at error level, naming the fill and the lot', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);
    const logger = recordingLogger();

    await new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger)).ingestFills();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: FEE_CURRENCY_NOT_BOOK_CURRENCY,
        payload: expect.objectContaining({
          idempotency_key: 'key-1',
          instrument: 'AAPL',
          broker_fill_id: 'usd-1',
          fee: 0.8,
          fee_currency: 'USD',
        }),
      }),
    );
  });

  it('still persists the fill — refusing it would strand a fill that already happened at the venue', async () => {
    // CONTEXT.md invariant 4 (every fill logged, append-only): the venue has
    // already traded by the time this is read, so refusing the row would
    // leave a real open position unrecorded — a silent halt with money
    // exposed. Alert, do not refuse.
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const [persisted] = await store.getFills('key-1');
    expect(persisted?.fee_currency).toBe('USD');
    expect(persisted?.fee).toBe(0.8);
  });

  it('says nothing for GBP, for GBX pence, or for an adapter that reports no currency', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 6 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('gbp-1'), qty: 2, fee: 0.1, fee_currency: 'GBP' }),
      fill({ broker_fill_id: toBrokerFillId('gbx-1'), qty: 2, fee: 0.1, fee_currency: 'GBX' }),
      fill({ broker_fill_id: toBrokerFillId('none-1'), qty: 2, fee: 0.1 }),
    ]);
    const logger = recordingLogger();

    await new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger)).ingestFills();

    expect(
      logger.entries.filter((entry) => entry.message === FEE_CURRENCY_NOT_BOOK_CURRENCY),
    ).toEqual([]);
  });

  it('raises it once per fill, not once per poll — the check sits behind the hasFill dedup gate', async () => {
    // `fetchNewFills` is inclusive of `since`, so every adapter re-offers the
    // same fill forever. A check above the dedup gate would announce this
    // contradiction on every poll for the life of the lot.
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);
    const logger = recordingLogger();
    const execution = new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger));

    await execution.ingestFills();
    await execution.ingestFills();

    expect(
      logger.entries.filter((entry) => entry.message === FEE_CURRENCY_NOT_BOOK_CURRENCY),
    ).toHaveLength(1);
  });
});

// #1465: #1220 recorded the fee and raised it at `error`, but wired no
// channel — the only sink was `ExecutionInput.logger`, a rotating file
// nobody escalates. This closes the other half.
describe('a non-sterling fee pages an operator, not just a log line (#1465)', () => {
  it('posts to nonSterlingFeeAlerts, beside the existing safeLog line, for a fill on the direct advanceLot path', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);
    const logger = recordingLogger();
    const nonSterlingFeeAlerts = makeNonSterlingFeeAlerts();

    await new ExecutionImpl(
      makeInput(
        broker,
        store,
        undefined,
        undefined,
        logger,
        undefined,
        undefined,
        undefined,
        nonSterlingFeeAlerts,
      ),
    ).ingestFills();

    expect(nonSterlingFeeAlerts.alerts).toEqual([
      {
        trace_id: 'trace-1',
        idempotency_key: 'key-1',
        instrument: 'AAPL',
        broker_fill_id: 'usd-1',
        fee: 0.8,
        fee_currency: 'USD',
        book_currency: 'GBP',
      },
    ]);
    // The channel post is IN ADDITION TO the log line, not instead of it —
    // matching ResidualExposureAlert's posture (#525): the durable trace and
    // the page are both present.
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', message: FEE_CURRENCY_NOT_BOOK_CURRENCY }),
    );
  });

  it('is silent when nonSterlingFeeAlerts is not supplied — optional, no default channel', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);

    await expect(new ExecutionImpl(makeInput(broker, store)).ingestFills()).resolves.not.toThrow();
  });

  it("posts for the increment booked through cumulativeTopUp, not just advanceLot's direct path (#842 seam)", async () => {
    // THE GAP #1465 closes: `advanceLot`'s per-fill loop called
    // `warnOnNonSterlingFee` beside its `toFill` push, but `cumulativeTopUp`
    // (the OTHER call site into `toFill`, reached when a cumulative feed
    // re-offers a bigger running total under the same order id) had no such
    // call at all. First poll's fee currency is GBP (books cleanly, no
    // alert); the SECOND poll reports the same order's fee in USD — a
    // currency the increment now carries and only cumulativeTopUp's own
    // guard can catch.
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('cumulative-1'),
        leg: 'entry',
        qty: 50,
        price: 100,
        fee: 0.4,
        fee_currency: 'GBP',
        timestamp: new Date('2026-07-20T15:00:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    const logger = recordingLogger();
    const nonSterlingFeeAlerts = makeNonSterlingFeeAlerts();
    const execution = new ExecutionImpl(
      makeInput(
        broker,
        store,
        undefined,
        undefined,
        logger,
        undefined,
        undefined,
        undefined,
        nonSterlingFeeAlerts,
      ),
    );
    await execution.ingestFills();

    expect(nonSterlingFeeAlerts.alerts).toEqual([]);

    broker.replaceFills([
      fill({
        broker_fill_id: toBrokerFillId('cumulative-1'),
        leg: 'entry',
        qty: 100,
        price: 100,
        fee: 0.8,
        fee_currency: 'USD',
        timestamp: new Date('2026-07-20T15:30:00Z'),
        qty_is_cumulative: true,
      }),
    ]);
    await execution.ingestFills();

    expect(nonSterlingFeeAlerts.alerts).toEqual([
      expect.objectContaining({
        idempotency_key: 'key-1',
        broker_fill_id: 'cumulative-1',
        fee_currency: 'USD',
      }),
    ]);
    expect(
      logger.entries.filter((entry) => entry.message === FEE_CURRENCY_NOT_BOOK_CURRENCY),
    ).toHaveLength(1);

    // A re-poll at the SAME cumulative must not re-page: `cumulativeTopUp`
    // returns null on a zero delta before `warnOnNonSterlingFee` is reached.
    await execution.ingestFills();
    expect(nonSterlingFeeAlerts.alerts).toHaveLength(1);
  });

  it("logs a fixed, self-authored message on a channel send failure — never the channel's own error text (CREDENTIALS)", async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('usd-1'), qty: 5, fee: 0.8, fee_currency: 'USD' }),
    ]);
    const logger = recordingLogger();
    const failingChannel: NonSterlingFeeAlertChannel = {
      postNonSterlingFeeAlert: async () => {
        throw new Error('secret bot token abc123 rejected by transport');
      },
    };

    await expect(
      new ExecutionImpl(
        makeInput(
          broker,
          store,
          undefined,
          undefined,
          logger,
          undefined,
          undefined,
          undefined,
          failingChannel,
        ),
      ).ingestFills(),
    ).resolves.not.toThrow();

    const failureEntries = logger.entries.filter(
      (entry) => entry.event === 'non_sterling_fee_alert_send_failed',
    );
    expect(failureEntries).toHaveLength(1);
    expect(JSON.stringify(failureEntries[0])).not.toContain('secret bot token');
  });
});
