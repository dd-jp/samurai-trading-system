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
  NormalizedFill,
  NormalizedOrder,
  ResidualExposureAlert,
  ResidualExposureAlertChannel,
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
  /** #86's surface. `ingestFills()` never reconciles, so it is never called. */
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
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

function makeInput(
  broker: BrokerAdapter,
  store: TestExecutionStore,
  residualExposureAlerts: ResidualExposureAlertChannel = makeResidualExposureAlerts(),
  flattenOverfillAlerts: FlattenOverfillAlertChannel = makeFlattenOverfillAlerts(),
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
    residualExposureAlerts,
    flattenOverfillAlerts,
    // #519: `ingestFills()` never reconciles, so this is never posted to.
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
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

  describe('residual re-arm on a partial flatten (#525)', () => {
    it("re-arms protective legs, sized to the residual, at the lot's own stop/target", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { requested_size: 10, stop: 95, target: 110, side: 'buy' });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100 }),
        // A partial exit fill — 4 of the 10 held closed, 6 left naked. This
        // file bypasses the flatten-routing layer (`redistributeFlattenFills`)
        // by scripting the fill directly under the lot's own key; the
        // routing itself is covered end-to-end in execute.test.ts's
        // "flatten fill attribution" suite, via the real
        // `SimulatedBrokerAdapter`.
        fill({
          broker_fill_id: 'x1',
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
        fill({ broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: 'x1',
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
        fill({ broker_fill_id: 'e1', leg: 'entry', qty: 10, price: 100 }),
        fill({
          broker_fill_id: 'x1',
          leg: 'exit',
          qty: 4,
          price: 98,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);
      broker.rearmFailure = new Error('venue rejected the OCO order');
      const residualExposureAlerts = makeResidualExposureAlerts();

      await new ExecutionImpl(makeInput(broker, store, residualExposureAlerts)).ingestFills();

      expect(residualExposureAlerts.alerts).toEqual([
        {
          idempotency_key: 'key-1',
          instrument: 'AAPL',
          side: 'buy',
          residual_qty: 6,
          // The re-arm failed, not the fill read — so 6 is the measured
          // residual, not an upper bound.
          residual_qty_is_upper_bound: false,
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
        fill({ client_order_id: 'key-flaky', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({ client_order_id: 'key-healthy', broker_fill_id: 'e2', leg: 'entry', qty: 10 }),
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
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });
      // NULLed to a pre-migration-0021 row, which is the one shape that still
      // routes the split through `getEntryFillSizes` — the only `await`
      // between reading the lot keys and the (pure, unthrowable) split.
      db.prepare(
        'UPDATE flatten_submissions SET lot_held_quantities = NULL WHERE idempotency_key = ?',
      ).run('flatten-1');

      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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

  // #519/#526: bounds `reconcile()`'s flatten-journal rescan (migration 0023) —
  // see `SharedStore.markFlattenFillsSwept`'s doc for why the mark may only
  // fire once every named lot has durably advanced, never merely once a raw
  // fill was observed.
  describe('markFlattenFillsSwept gating (#519, #526)', () => {
    it('marks a flatten swept once its named lot durably advances', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      const entryOnly = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });
      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });
      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });
      // NULLed to a pre-migration-0021 row, routing the split through the
      // now-flaky `getEntryFillSizes` fallback — same technique the existing
      // #575 containment test above uses.
      db.prepare(
        'UPDATE flatten_submissions SET lot_held_quantities = NULL WHERE idempotency_key = ?',
      ).run('flatten-1');
      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'key-1',
          broker_fill_id: 'x1',
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
          broker_fill_id: 'fo1',
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
  });

  describe('flatten over-fill warning (#527)', () => {
    it('warns naming the flatten and the unattributed qty, and still drops the excess', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      // Poll 1 persists the lot's entry fill.
      const entryOnly = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });

      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
        { idempotency_key: 'flatten-1', unattributed_qty: 4, observed_at: NOW },
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
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });

      // A single scripted broker, polled TWICE: `fetchNewFills` re-offers the
      // same fills every call (filtered only by `since`), the same shape the
      // Simulated adapter takes in production (unlike Alpaca's flatten sweep,
      // which prunes after one poll) — the exact re-offer this test exists to
      // pin `ingestFills()` against.
      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
        { idempotency_key: 'flatten-1', unattributed_qty: 4, observed_at: NOW },
      ]);
    });

    it("emits no warning when a flatten fills exactly its named lots' held share", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });

      const entryOnly = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
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
      });

      const withFlatten = new ScriptedBroker([
        fill({ client_order_id: 'key-1', broker_fill_id: 'e1', leg: 'entry', qty: 10 }),
        fill({
          client_order_id: 'flatten-1',
          broker_fill_id: 'f1',
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
  });
});
