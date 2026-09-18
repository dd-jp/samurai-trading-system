import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import type { AssetClass, BrokerFillId, Clock, Logger, OpenPosition } from '../../shared/index.js';
import { toBrokerFillId } from '../../shared/index.js';
import { recordingLogger } from '../../shared/recording-logger.js';
import { openSharedStore } from '../../shared/store/index.js';
import type { CostConfig, CostModel, MarketState } from '../../tools/backtest/index.js';
import { CostModelImpl, SAXO_COMMISSION_RATE } from '../../tools/backtest/index.js';
import { buildArmComparison, noCostBasisDrops } from '../control-arm/arm-comparison.js';
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
  UNATTRIBUTED_FLATTEN_FILL,
  UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED,
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
  UnattributedFlattenFillAlert,
  UnattributedFlattenFillAlertChannel,
} from './types.js';
import { UnrecordedVenuePositionThrottle } from './unrecorded-venue-position-throttle.js';

function openSessionCalendars(): Record<AssetClass, TradingCalendar> {
  return { crypto: new AlwaysOpenCalendar(), stocks: new AlwaysOpenCalendar() };
}

const NOW = new Date('2026-07-20T16:00:00Z');
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

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
  readonly flattenCalls: Array<{
    clientOrderId: string;
    instrument: string;
    side: 'buy' | 'sell';
    size: number;
  }> = [];
  rearmFailure: Error | undefined;

  constructor(private scriptedFills: NormalizedFill[]) {}

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
  scriptedOrder: NormalizedOrder | null = null;
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.scriptedOrder;
  }
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedBroker.resumeFlatten: ingestFills() does not reconcile');
  }
  async submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
  ): Promise<BrokerAck> {
    this.flattenCalls.push({ clientOrderId, instrument, side, size });
    return {
      client_order_id: clientOrderId,
      broker_order_ids: [clientOrderId],
      order_state: 'submitted',
    };
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedBroker.cancel: ingestFills() does not cancel');
  }
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

function makeUnattributedFlattenFillAlerts(): UnattributedFlattenFillAlertChannel & {
  alerts: UnattributedFlattenFillAlert[];
} {
  const alerts: UnattributedFlattenFillAlert[] = [];
  return {
    alerts,
    async postUnattributedFlattenFillAlert(alert: UnattributedFlattenFillAlert): Promise<void> {
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
  throttle: FilledZeroSizeThrottle = new FilledZeroSizeThrottle(),
  traceId = 'trace-1',
  clock: Clock = { now: () => NOW },
  nonSterlingFeeAlerts?: NonSterlingFeeAlertChannel,
  sessionCalendars: Record<AssetClass, TradingCalendar> = openSessionCalendars(),
  unattributedFlattenFillAlerts?: UnattributedFlattenFillAlertChannel,
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
    sessionCalendars,
    residualExposureAlerts,
    flattenOverfillAlerts,
    ...(nonSterlingFeeAlerts === undefined ? {} : { nonSterlingFeeAlerts }),
    ...(unattributedFlattenFillAlerts === undefined ? {} : { unattributedFlattenFillAlerts }),
    flattenReconcileAlerts: { postFlattenReconcileAlert: async () => {} },
    unrecordedVenuePositionAlerts: { postUnrecordedVenuePositionAlert: async () => {} },
    unrecordedVenuePositionThrottle: new UnrecordedVenuePositionThrottle(),
    logger,
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
    expect(position?.requested_size).toBe(10);
    expect(position?.filled_size).toBe(10);
    expect(position?.order_state).toBe('filled');
    expect(broker.resizeCalls.at(-1)).toEqual({ clientOrderId: 'key-1', filledQty: 10 });
  });

  it('emits exactly one correct ClosedTrade for a two-part partial fill then a stop-out', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10, side: 'buy', stop: 95 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 4, price: 100, fee: 1 }),
      fill({
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 6,
        price: 101,
        fee: 1,
        timestamp: new Date('2026-07-20T15:15:00Z'),
      }),
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
    expect(closed.entry).toBeCloseTo(100.6, 6);
    expect(closed.realized_pnl_net).toBeCloseTo(-60, 6);
    expect(closed.fees_total).toBeCloseTo(4, 6);
    expect(closed.closed_at).toEqual(new Date('2026-07-20T15:45:00Z'));
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
      fill({
        broker_fill_id: toBrokerFillId('e2'),
        leg: 'entry',
        qty: 6,
        price: 101,
        timestamp: new Date('2026-07-20T17:00:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    expect((await store.getPosition('key-1'))?.filled_size).toBe(4);
    expect(await store.getFills('key-1')).toHaveLength(1);
  });

  describe('residual re-arm on a partial flatten (#525)', () => {
    it("re-arms protective legs, sized to the residual, at the lot's own stop/target", async () => {
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

      const residualExposureAlerts = makeResidualExposureAlerts();

      await new ExecutionImpl(makeInput(broker, store, residualExposureAlerts)).ingestFills();

      expect(broker.rearmCalls).toEqual([
        { clientOrderId: 'key-1', instrument: 'AAPL', side: 'buy', qty: 6, stop: 95, target: 110 },
      ]);
      expect(residualExposureAlerts.alerts).toEqual([]);
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
          residual_qty_is_upper_bound: false,
          rearm_unsupported: false,
          stop: 95,
          target: 110,
          observed_at: NOW,
        },
      ]);
      expect((await store.getPosition('key-1'))?.filled_size).toBe(10);
      expect(await store.getFills('key-1')).toHaveLength(2);
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
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false on every pool line',
      );
      const residualExposureAlerts = makeResidualExposureAlerts();
      const logger = recordingLogger();

      await new ExecutionImpl(
        makeInput(broker, store, residualExposureAlerts, undefined, logger),
      ).ingestFills();

      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          event: 'residual_rearm_unsupported',
          message: expect.stringContaining('permanently refused'),
        }),
      );
      expect(broker.flattenCalls).toEqual([
        {
          clientOrderId: 'key-1:residual-reflatten-1',
          instrument: 'AAPL',
          side: 'sell',
          size: 6,
        },
      ]);
      expect(await store.getFlattenAttribution('key-1:residual-reflatten-1')).toMatchObject({
        lot_idempotency_keys: ['key-1'],
      });
      expect(residualExposureAlerts.alerts).toEqual([]);
      expect((await store.getResidualProtectionMarker('key-1'))?.unprotected_since).not.toBeNull();
      expect(await store.getFills('key-1')).toHaveLength(2);
    });

    it('pages, and sends no market order, when the venue that cannot re-arm is also shut (#1214)', async () => {
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
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false on every pool line',
      );
      const residualExposureAlerts = makeResidualExposureAlerts();
      const logger = recordingLogger();
      const shutCalendar: TradingCalendar = {
        isOpen: () => false,
        isTradingDay: () => true,
        sessionStart: () => NOW,
        sessionEnd: () => NOW,
      };

      await new ExecutionImpl(
        makeInput(
          broker,
          store,
          residualExposureAlerts,
          undefined,
          logger,
          undefined,
          undefined,
          undefined,
          undefined,
          { crypto: new AlwaysOpenCalendar(), stocks: shutCalendar },
        ),
      ).ingestFills();

      expect(broker.flattenCalls).toEqual([]);
      expect(residualExposureAlerts.alerts[0]).toMatchObject({
        idempotency_key: 'key-1',
        residual_qty: 6,
        rearm_unsupported: true,
      });
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          event: 'residual_reflatten_skipped',
          payload: expect.objectContaining({ reason: 'venue_shut' }),
        }),
      );
    });

    it('#1447: a store-read-failure page already recorded must not block this venue-refusal page, and this page uses its OWN dedup column', async () => {
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
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false on every pool line',
      );
      const residualExposureAlerts = makeResidualExposureAlerts();
      const shutCalendar: TradingCalendar = {
        isOpen: () => false,
        isTradingDay: () => true,
        sessionStart: () => NOW,
        sessionEnd: () => NOW,
      };
      await store.markResidualUnprotected('key-1', NOW);
      await store.markResidualAlerted('key-1', NOW);

      await new ExecutionImpl(
        makeInput(
          broker,
          store,
          residualExposureAlerts,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { crypto: new AlwaysOpenCalendar(), stocks: shutCalendar },
        ),
      ).ingestFills();

      expect(residualExposureAlerts.alerts).toEqual([
        expect.objectContaining({ idempotency_key: 'key-1', rearm_unsupported: true }),
      ]);
      expect(await store.getResidualRearmUnsupportedAlertedAtRaw('key-1')).not.toBeNull();
    });

    it('#1447: a second call for the same still-unsupported episode does not page twice — the observing poll consults the dedup BEFORE paging, not only records it after', async () => {
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
      broker.rearmFailure = new ProtectiveRearmUnsupportedError(
        'saxo',
        'IsOcoOrderSupported false on every pool line',
      );
      const residualExposureAlerts = makeResidualExposureAlerts();
      const shutCalendar: TradingCalendar = {
        isOpen: () => false,
        isTradingDay: () => true,
        sessionStart: () => NOW,
        sessionEnd: () => NOW,
      };
      await store.markResidualUnprotected('key-1', NOW);
      await store.markResidualRearmUnsupportedAlerted('key-1', NOW);

      await new ExecutionImpl(
        makeInput(
          broker,
          store,
          residualExposureAlerts,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { crypto: new AlwaysOpenCalendar(), stocks: shutCalendar },
        ),
      ).ingestFills();

      expect(residualExposureAlerts.alerts).toEqual([]);
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

  describe('store-read failure in the zero-new-fill re-arm path (#573)', () => {
    it('logs the sanitized store error and the lot key when the store read fails, alongside the upper-bound alert', async () => {
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
      const logger = recordingLogger();

      await new ExecutionImpl(
        makeInput(withFlatten, store, residualExposureAlerts, undefined, logger),
      ).ingestFills();

      expect(residualExposureAlerts.alerts).toContainEqual(
        expect.objectContaining({
          idempotency_key: 'key-2',
          residual_qty: 4,
          residual_qty_is_upper_bound: true,
        }),
      );
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

  describe('per-lot containment (#575)', () => {
    it("advances the other lots when one lot's advance fails, and names the failed lot", async () => {
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

      await expect(new ExecutionImpl(makeInput(broker, store)).ingestFills()).rejects.toThrow(
        'key-flaky',
      );

      expect((await store.getPosition('key-flaky'))?.filled_size).toBe(0);
      expect((await store.getPosition('key-healthy'))?.filled_size).toBe(10);
      expect((await store.getPosition('key-healthy'))?.order_state).toBe('filled');
    });

    it('does not re-arm a lot named by a flatten whose redistribution failed', async () => {
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

      expect(withFlatten.rearmCalls).toEqual([]);
      expect(residualExposureAlerts.alerts).toEqual([]);
      expect(await store.getFills('key-1')).toHaveLength(1);
    });
  });

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

      await expect(new ExecutionImpl(makeInput(broker, store)).ingestFills()).rejects.toThrow(
        /unresolved: lot-advance 'key-flaky' \(MSFT\) \[TypeError\]$/,
      );
    });

    it('names a flatten-attribution failure with no parens at all — instrument is null for a flatten-keyed scope', async () => {
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

      await expect(new ExecutionImpl(makeInput(withFlatten, store)).ingestFills()).rejects.toThrow(
        /unresolved: flatten-attribution 'flatten-1' \[Error\]$/,
      );
    });
  });

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

    it('marks a flatten swept and BOOKS its fill when its named lot is ALREADY closed at redistribution time', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
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

      await new ExecutionImpl(makeInput(withOrphanFlatten, store)).ingestFills();

      expect(store.writeLog).toContain('mark-flatten-fills-swept:flatten-orphan');
      expect(await store.getUnresolvedFlattens()).toEqual([]);
      const booked = await store.getFills('key-1');
      expect(booked).toHaveLength(3);
      expect(booked.at(-1)).toMatchObject({ broker_fill_id: 'fo1:key-1', leg: 'exit', qty: 10 });
    });

    it("books and pages a second flatten's fill when the FIRST flatten closed the lot between them", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
      const journalFlatten = async (key: string, held: number): Promise<void> => {
        await store.writeAheadFlatten({
          idempotency_key: key,
          instrument: 'AAPL',
          asset_class: 'stocks',
          side: 'sell',
          size: held,
          submitted_at: OPENED_AT,
          lot_held_quantities: [{ idempotency_key: 'key-1', held }],
          exit_reason: 'flatten',
          decision_price: null,
          quote_bid: null,
          quote_ask: null,
          quote_mid: null,
          modelled_cost_breakdown: null,
          quote_observed_at: null,
        });
        await store.resolveFlattenSubmitted(
          key,
          { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
          OPENED_AT,
        );
      };
      await journalFlatten('flatten-1', 10);

      const entry = fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      });
      const firstFlattenFill = fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      });
      const secondFlattenFill = fill({
        client_order_id: 'flatten-2',
        broker_fill_id: toBrokerFillId('f2'),
        leg: 'exit',
        qty: 4,
        timestamp: new Date('2026-07-20T15:45:00Z'),
      });

      const alerts = makeUnattributedFlattenFillAlerts();
      const logger = recordingLogger();
      const poll = async (fills: readonly NormalizedFill[]): Promise<void> => {
        await new ExecutionImpl(
          makeInput(
            new ScriptedBroker([...fills]),
            store,
            undefined,
            undefined,
            logger,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            alerts,
          ),
        ).ingestFills();
      };

      await poll([entry]);
      await poll([entry, firstFlattenFill]);
      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
      expect(alerts.alerts).toEqual([]);

      await journalFlatten('flatten-2', 4);
      await poll([entry, firstFlattenFill, secondFlattenFill]);

      expect(await store.getFills('key-1')).toMatchObject([
        { broker_fill_id: 'e1', leg: 'entry', qty: 10 },
        { broker_fill_id: 'f1:key-1', leg: 'exit', qty: 10 },
        { broker_fill_id: 'f2:key-1', leg: 'exit', qty: 4 },
      ]);
      expect(alerts.alerts).toMatchObject([
        {
          trace_id: 'trace-1',
          flatten_idempotency_key: 'flatten-2',
          lot_idempotency_key: 'key-1',
          instrument: 'AAPL',
          side: 'sell',
          broker_fill_id: 'f2:key-1',
          qty: 4,
        },
      ]);
      expect(
        logger.entries.filter((entry) => entry.message === UNATTRIBUTED_FLATTEN_FILL),
      ).toHaveLength(1);

      await poll([entry, firstFlattenFill, secondFlattenFill]);
      expect(await store.getFills('key-1')).toHaveLength(3);
      expect(alerts.alerts).toHaveLength(1);
      expect(
        logger.entries.filter(
          (entry) => entry.message === UNATTRIBUTED_FLATTEN_FILL_PERSIST_FAILED,
        ),
      ).toEqual([]);
    });

    it('holds the flatten sweep back when booking the split against the closed lot fails', async () => {
      class FailsOnSplitStore extends TestExecutionStore {
        override async applyLotAdvance(advance: LotAdvance): Promise<void> {
          if (advance.fills.some((lotFill) => lotFill.broker_fill_id === 'f2:key-1')) {
            throw new Error('simulated store outage on the unattributed split');
          }
          await super.applyLotAdvance(advance);
        }
      }

      const { db } = openTestExecutionStore();
      const store = new FailsOnSplitStore(db);
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
      const journalFlatten = async (key: string, held: number): Promise<void> => {
        await store.writeAheadFlatten({
          idempotency_key: key,
          instrument: 'AAPL',
          asset_class: 'stocks',
          side: 'sell',
          size: held,
          submitted_at: OPENED_AT,
          lot_held_quantities: [{ idempotency_key: 'key-1', held }],
          exit_reason: 'flatten',
          decision_price: null,
          quote_bid: null,
          quote_ask: null,
          quote_mid: null,
          modelled_cost_breakdown: null,
          quote_observed_at: null,
        });
        await store.resolveFlattenSubmitted(
          key,
          { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
          OPENED_AT,
        );
      };
      await journalFlatten('flatten-1', 10);

      const entry = fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      });
      const firstFlattenFill = fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      });
      const secondFlattenFill = fill({
        client_order_id: 'flatten-2',
        broker_fill_id: toBrokerFillId('f2'),
        leg: 'exit',
        qty: 4,
        timestamp: new Date('2026-07-20T15:45:00Z'),
      });
      const broker = new ScriptedBroker([entry, firstFlattenFill, secondFlattenFill]);
      const poll = async (fills: readonly NormalizedFill[]): Promise<void> => {
        broker.replaceFills([...fills]);
        await new ExecutionImpl(makeInput(broker, store)).ingestFills();
      };

      await poll([entry]);
      await poll([entry, firstFlattenFill]);
      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');

      await journalFlatten('flatten-2', 4);
      store.writeLog.length = 0;
      const outcome = await poll([entry, firstFlattenFill, secondFlattenFill]).then(
        () => null,
        (error: unknown) => error,
      );
      expect(store.writeLog).not.toContain('mark-flatten-fills-swept:flatten-2');
      expect(outcome).not.toBeNull();
      expect(await broker.fetchNewFills(new Date('2026-07-20T15:50:00Z'))).toEqual([]);
    });

    it('leaves a split dated after the poll clock unbooked', async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
      const journalFlatten = async (key: string, held: number): Promise<void> => {
        await store.writeAheadFlatten({
          idempotency_key: key,
          instrument: 'AAPL',
          asset_class: 'stocks',
          side: 'sell',
          size: held,
          submitted_at: OPENED_AT,
          lot_held_quantities: [{ idempotency_key: 'key-1', held }],
          exit_reason: 'flatten',
          decision_price: null,
          quote_bid: null,
          quote_ask: null,
          quote_mid: null,
          modelled_cost_breakdown: null,
          quote_observed_at: null,
        });
        await store.resolveFlattenSubmitted(
          key,
          { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
          OPENED_AT,
        );
      };
      await journalFlatten('flatten-1', 10);

      const entry = fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      });
      const firstFlattenFill = fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      });
      const futureFlattenFill = fill({
        client_order_id: 'flatten-2',
        broker_fill_id: toBrokerFillId('f2'),
        leg: 'exit',
        qty: 4,
        timestamp: new Date(NOW.getTime() + 60_000),
      });

      const alerts = makeUnattributedFlattenFillAlerts();
      const poll = async (fills: readonly NormalizedFill[]): Promise<void> => {
        await new ExecutionImpl(
          makeInput(
            new ScriptedBroker([...fills]),
            store,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            alerts,
          ),
        ).ingestFills();
      };

      await poll([entry]);
      await poll([entry, firstFlattenFill]);
      await journalFlatten('flatten-2', 4);
      await poll([entry, firstFlattenFill, futureFlattenFill]);

      expect(await store.getFills('key-1')).toHaveLength(2);
      expect(alerts.alerts).toEqual([]);
    });

    it("warns on an over-fill AND books the split when the flatten's named lot is already closed", async () => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
      await seedPosition(store, {
        idempotency_key: 'key-other',
        instrument: 'TSLA',
        requested_size: 5,
        stop: 190,
      });
      const journalFlatten = async (key: string, held: number): Promise<void> => {
        await store.writeAheadFlatten({
          idempotency_key: key,
          instrument: 'AAPL',
          asset_class: 'stocks',
          side: 'sell',
          size: held,
          submitted_at: OPENED_AT,
          lot_held_quantities: [{ idempotency_key: 'key-1', held }],
          exit_reason: 'flatten',
          decision_price: null,
          quote_bid: null,
          quote_ask: null,
          quote_mid: null,
          modelled_cost_breakdown: null,
          quote_observed_at: null,
        });
        await store.resolveFlattenSubmitted(
          key,
          { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
          OPENED_AT,
        );
      };
      await journalFlatten('flatten-1', 10);

      const entry = fill({
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      });
      const firstFlattenFill = fill({
        client_order_id: 'flatten-1',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      });
      const overFill = fill({
        client_order_id: 'flatten-2',
        broker_fill_id: toBrokerFillId('f2'),
        leg: 'exit',
        qty: 6,
        timestamp: new Date('2026-07-20T15:45:00Z'),
      });

      const alerts = makeUnattributedFlattenFillAlerts();
      const overfillAlerts = makeFlattenOverfillAlerts();
      const poll = async (fills: readonly NormalizedFill[]): Promise<void> => {
        await new ExecutionImpl(
          makeInput(
            new ScriptedBroker([...fills]),
            store,
            undefined,
            overfillAlerts,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            alerts,
          ),
        ).ingestFills();
      };

      await poll([entry]);
      await poll([entry, firstFlattenFill]);
      expect(overfillAlerts.warnings).toEqual([]);

      await journalFlatten('flatten-2', 4);
      await poll([entry, firstFlattenFill, overFill]);

      expect(overfillAlerts.warnings).toMatchObject([
        { idempotency_key: 'flatten-2', unattributed_qty: 2 },
      ]);
      expect(await store.getFills('key-1')).toMatchObject([
        { broker_fill_id: 'e1', leg: 'entry', qty: 10 },
        { broker_fill_id: 'f1:key-1', leg: 'exit', qty: 10 },
        { broker_fill_id: 'f2:key-1', leg: 'exit', qty: 4 },
      ]);
      expect(alerts.alerts).toHaveLength(1);

      await poll([entry, firstFlattenFill, overFill]);
      expect(overfillAlerts.warnings).toHaveLength(1);
      expect(await store.getFills('key-1')).toHaveLength(3);
      expect(alerts.alerts).toHaveLength(1);
    });

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

      await expect(
        new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger)).ingestFills(),
      ).resolves.toBeUndefined();

      expect((await store.getPosition('key-1'))?.order_state).toBe('closed');
      expect(await store.getClosedTrades()).toHaveLength(1);

      expect(await store.getUnresolvedFlattens()).toEqual([
        expect.objectContaining({
          idempotency_key: 'flatten-1',
          instrument: 'AAPL',
          status: 'submitted',
        }),
      ]);
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
      const residualExposureAlerts = makeResidualExposureAlerts();
      const flattenOverfillAlerts = makeFlattenOverfillAlerts();

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
      const failingFlattenOverfillAlerts: FlattenOverfillAlertChannel = {
        postFlattenOverfillWarning: async () => {
          throw new Error('Bearer super-secret-transport-token rejected the request');
        },
      };
      const logger = recordingLogger();

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
      expect(JSON.stringify(entry)).not.toContain('super-secret-transport-token');
    });
  });

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

describe('ExecutionImpl.ingestFills — cumulative partial fills (#842)', () => {
  function cumulativeEntry(cumQty: number, cumAvgPrice: number, at: string): NormalizedFill {
    return fill({
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
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);

    broker.replaceFills([cumulativeEntry(100, 101, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    expect(position?.filled_size).toBe(100);
    expect(position?.avg_entry_price).toBeCloseTo(101, 10);

    const fills = await store.getFills('key-1');
    expect(fills).toHaveLength(2);
    expect(fills[1]?.qty).toBe(50);
    expect(fills[1]?.price).toBeCloseTo(102, 10);
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

    broker.replaceFills([cumulativeEntry(80, 100.75, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    expect(position?.filled_size).toBe(80);
    expect(position?.order_state).toBe('partially_filled');
    expect(broker.resizeCalls.at(-1)).toEqual({ clientOrderId: 'key-1', filledQty: 80 });
  });

  it('ignores a cumulative that SHRINKS rather than un-booking a persisted fill', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
    const broker = new ScriptedBroker([cumulativeEntry(50, 100, '2026-07-20T15:00:00Z')]);
    const execution = new ExecutionImpl(makeInput(broker, store));
    await execution.ingestFills();

    broker.replaceFills([cumulativeEntry(30, 100, '2026-07-20T15:30:00Z')]);
    await execution.ingestFills();

    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(50);
    expect(broker.resizeCalls).toHaveLength(1);
  });

  it('leaves a non-cumulative feed alone — a re-offered id is still a duplicate', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 100, filled_size: 0 });
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

describe('ExecutionImpl.ingestFills — real-broker cost_breakdown fallback (#1001)', () => {
  const modelledCostBreakdown = {
    spread_cost: 0.5,
    commission: 1,
    slippage: 0.25,
    market_impact: 0.1,
  };
  const modelledProtectiveExitCostBreakdown = {
    spread_cost: 2,
    commission: 3,
    slippage: 1,
    market_impact: 2,
  };

  function closeBreakdownMatcher(expected: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  }) {
    return {
      spread_cost: expect.closeTo(expected.spread_cost, 9),
      commission: expect.closeTo(expected.commission, 9),
      slippage: expect.closeTo(expected.slippage, 9),
      market_impact: expect.closeTo(expected.market_impact, 9),
    };
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
    expect(e1?.cost_breakdown).toEqual(
      closeBreakdownMatcher({
        spread_cost: 0.2,
        commission: 0.4,
        slippage: 0.1,
        market_impact: 0.04,
      }),
    );
    expect(e2?.cost_breakdown).toEqual(
      closeBreakdownMatcher({
        spread_cost: 0.3,
        commission: 0.6,
        slippage: 0.15,
        market_impact: 0.06,
      }),
    );
  });

  it('leaves cost_breakdown unset on an entry fill when the lot carries no modelled snapshot', async () => {
    const { store } = openTestExecutionStore();
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

  it.each(['stop', 'target'] as const)(
    'prorates the modelled PROTECTIVE exit cost breakdown onto a %s leg fill',
    async (leg) => {
      const { store } = openTestExecutionStore();
      await seedPosition(store, {
        requested_size: 10,
        side: 'buy',
        modelled_cost_breakdown: modelledCostBreakdown,
        modelled_protective_exit_cost_breakdown: modelledProtectiveExitCostBreakdown,
      });
      const broker = new ScriptedBroker([
        fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10 }),
        fill({
          broker_fill_id: toBrokerFillId('x1'),
          leg,
          qty: 4,
          price: 95,
          timestamp: new Date('2026-07-20T15:30:00Z'),
        }),
      ]);

      await new ExecutionImpl(makeInput(broker, store)).ingestFills();

      const fills = await store.getFills('key-1');
      expect(fills.find((row) => row.broker_fill_id === 'x1')?.cost_breakdown).toEqual(
        closeBreakdownMatcher({
          spread_cost: 0.8,
          commission: 1.2,
          slippage: 0.4,
          market_impact: 0.8,
        }),
      );
    },
  );

  it('leaves cost_breakdown unset on a protective leg fill when the lot carries no protective snapshot', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
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
    expect(fills.find((row) => row.broker_fill_id === 's1')?.cost_breakdown).toBeUndefined();
  });

  it('charges the modelled protective commission on a stop fill the venue reported no fee for', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
      modelled_protective_exit_cost_breakdown: modelledProtectiveExitCostBreakdown,
    });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, fee: 0 }),
      fill({
        broker_fill_id: toBrokerFillId('s1'),
        leg: 'stop',
        qty: 10,
        price: 95,
        fee: 0,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills.find((row) => row.broker_fill_id === 's1')?.fee).toBeCloseTo(
      modelledProtectiveExitCostBreakdown.commission,
      9,
    );
    const closed = await store.getClosedTrades();
    expect(closed[0]?.modelled_cost_charged).toBe(true);
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
    expect(key1Exit?.cost_breakdown).toEqual(
      closeBreakdownMatcher({
        spread_cost: 0.3,
        commission: 0.6,
        slippage: 0.15,
        market_impact: 0.06,
      }),
    );
    expect(key2Exit?.cost_breakdown).toEqual(
      closeBreakdownMatcher({
        spread_cost: 0.2,
        commission: 0.4,
        slippage: 0.1,
        market_impact: 0.04,
      }),
    );
    expect(key1Exit?.flatten_idempotency_key).toBe('flatten-1');
    expect(key2Exit?.flatten_idempotency_key).toBe('flatten-1');
  });

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
    for (const row of exits) {
      expect(row.cost_breakdown).toEqual(
        closeBreakdownMatcher({
          spread_cost: modelledCostBreakdown.spread_cost / 2,
          commission: modelledCostBreakdown.commission / 2,
          slippage: modelledCostBreakdown.slippage / 2,
          market_impact: modelledCostBreakdown.market_impact / 2,
        }),
      );
    }
    const summed = exits.reduce(
      (total, row) => ({
        spread_cost: total.spread_cost + (row.cost_breakdown?.spread_cost ?? 0),
        commission: total.commission + (row.cost_breakdown?.commission ?? 0),
        slippage: total.slippage + (row.cost_breakdown?.slippage ?? 0),
        market_impact: total.market_impact + (row.cost_breakdown?.market_impact ?? 0),
      }),
      { spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 },
    );
    expect(summed).toEqual(closeBreakdownMatcher(modelledCostBreakdown));
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

describe('ExecutionImpl.ingestFills — arm cost symmetry (#1121)', () => {
  const modelledCostBreakdown = {
    spread_cost: 0.5,
    commission: 1,
    slippage: 0.25,
    market_impact: 0.1,
  };

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
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const fills = await store.getFills('key-1');
    expect(fills[0]?.fee).toBeCloseTo(1, 9);
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

    const controlResult = costModel.fill(fillRequest, marketState);

    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      modelled_cost_breakdown: controlResult.cost_breakdown,
    });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('e1'), leg: 'entry', qty: 10, price: 100, fee: 0 }),
    ]);
    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const liveFee = (await store.getFills('key-1'))[0]?.fee;
    expect(liveFee).toBeCloseTo(controlResult.cost_breakdown.commission, 9);
    expect(controlResult.cost_breakdown.commission).toBeGreaterThan(0);
  });

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
    const trades = new SqliteArmComparisonSource(db).getClosedTradeWindowBetween(from, to).trades;
    expect(trades.map((t) => t.idempotency_key).sort()).toEqual(['control-key', 'live-key']);

    const comparison = buildArmComparison({
      trades,
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      from,
      to,
      basis: 1000,
    });

    expect(comparison.live.realized_pnl_net).toBeCloseTo(comparison.control.realized_pnl_net, 9);
    expect(comparison.live.return_pct).toBeCloseTo(comparison.control.return_pct, 9);
    expect(comparison.live.trade_count).toBe(1);
    expect(comparison.control.trade_count).toBe(1);
  });

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
    expect(venueFee).toBeGreaterThan(0);
    expect(venueFee).toBeCloseTo(modelled, 9);
    expect(charged).toBeCloseTo(Math.max(venueFee, modelled), 9);
    expect(charged).toBeLessThan(venueFee + modelled);
  });

  it('charges the venue-reported fee when it EXCEEDS the modelled estimate, still exactly once', async () => {
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
    expect(totalFee).toBeCloseTo(modelledCostBreakdown.commission, 9);
  });

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
    expect(fills.find((row) => row.leg === 'entry')?.cost_breakdown).toBeDefined();
    expect(fills.find((row) => row.leg === 'exit')?.cost_breakdown).toBeUndefined();

    const closed = (await store.getClosedTrades())[0];
    expect(closed.modelled_cost_charged).toBe(false);
  });

  it('charges a live protective-leg (stop) exit the modelled commission, same as the entry leg', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, {
      requested_size: 10,
      side: 'buy',
      modelled_cost_breakdown: modelledCostBreakdown,
      modelled_protective_exit_cost_breakdown: modelledCostBreakdown,
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
    expect(stop?.fee).toBeCloseTo(modelledCostBreakdown.commission, 9);
    expect(stop?.cost_breakdown).toBeDefined();
    const closed = (await store.getClosedTrades())[0];
    expect(closed.fees_total).toBeCloseTo(modelledCostBreakdown.commission * 2, 9);
    expect(closed.modelled_cost_charged).toBe(true);
  });

  it('stamps modelled_cost_charged false on a pre-0061 lot that exits on a protective leg', async () => {
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
    expect(closed.fees_total).toBeCloseTo(modelledCostBreakdown.commission, 9);
    expect(closed.modelled_cost_charged).toBe(false);
  });

  it('#1546: a protective exit needs one successful capture, a flatten needs two', async () => {
    async function writeAheadFlattenFor(
      store: TestExecutionStore,
      capturedFlatten: boolean | undefined,
    ): Promise<void> {
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
        modelled_cost_breakdown: capturedFlatten === true ? modelledCostBreakdown : null,
      });
    }

    function buildExitFill(exit: 'stop' | 'flatten') {
      return exit === 'stop'
        ? fill({
            broker_fill_id: toBrokerFillId('s1'),
            leg: 'stop',
            qty: 10,
            price: 95,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          })
        : fill({
            client_order_id: 'flatten-1',
            broker_fill_id: toBrokerFillId('f1'),
            leg: 'exit',
            qty: 10,
            price: 110,
            fee: 0,
            timestamp: new Date('2026-07-20T15:30:00Z'),
          });
    }

    async function closeOn(
      exit: 'stop' | 'flatten',
      captures: { entry: boolean; flatten?: boolean },
    ): Promise<boolean> {
      const { store } = openTestExecutionStore();
      await seedPosition(store, {
        requested_size: 10,
        side: 'buy',
        ...(captures.entry
          ? {
              modelled_cost_breakdown: modelledCostBreakdown,
              modelled_protective_exit_cost_breakdown: modelledCostBreakdown,
            }
          : {}),
      });
      const entryFill = fill({
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        fee: 0,
      });
      await new ExecutionImpl(makeInput(new ScriptedBroker([entryFill]), store)).ingestFills();

      if (exit === 'flatten') await writeAheadFlattenFor(store, captures.flatten);

      await new ExecutionImpl(
        makeInput(new ScriptedBroker([entryFill, buildExitFill(exit)]), store),
      ).ingestFills();

      const closed = (await store.getClosedTrades())[0];
      return closed.modelled_cost_charged;
    }

    expect(await closeOn('stop', { entry: true })).toBe(true);
    expect(await closeOn('stop', { entry: false })).toBe(false);
    expect(await closeOn('flatten', { entry: true, flatten: true })).toBe(true);
    expect(await closeOn('flatten', { entry: true, flatten: false })).toBe(false);
  });
});

describe('ExecutionImpl.reconcile() then ingestFills() — the adopted-from-reconcile path', () => {
  it('produces a coherent position record: filled_size matches once ingestFills runs', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 10 });
    const broker = new ScriptedBroker([
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
    expect((await store.getPosition('key-1'))?.filled_size).toBe(0);

    await execution.ingestFills();

    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(10);
    expect(position?.avg_entry_price).toBe(100);
    expect(logger.entries.some((e) => e.message === FILLED_WITH_ZERO_SIZE)).toBe(false);
  });

  it('warns exactly once for a permanently wedged lot, never re-reporting while it stays wedged (#1383)', async () => {
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
    for (let poll = 0; poll < 40; poll += 1) {
      await execution.ingestFills();
    }

    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(0);
    expect(await store.getFills('key-1')).toHaveLength(0);

    const warnings = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
    expect(warnings[0]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 3,
    });
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
    let currentTime = NOW;
    const clock: Clock = { now: () => currentTime };
    const execution = new ExecutionImpl(
      makeInput(broker, store, undefined, undefined, logger, undefined, 'trace-1', clock),
    );

    await execution.reconcile();
    await execution.ingestFills();
    await execution.ingestFills();
    await execution.ingestFills();

    currentTime = new Date(currentTime.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1);
    await execution.ingestFills();

    currentTime = new Date(currentTime.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1);
    await execution.ingestFills();

    const announcements = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(announcements.map((e) => e.level)).toEqual(['warn', 'info', 'info']);
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
    await execution.ingestFills();
    await execution.ingestFills();
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);

    broker.replaceFills([{ ...entryFill, timestamp: new Date('2026-07-20T15:00:00Z') }]);
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_ZERO_SIZE_CLEARED)).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(10);
  });

  it('a lot resolved by rejection, not by advancing, never reports cleared — the leaked episode is inert (#1383)', async () => {
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
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);

    await store.updatePositionState('key-1', { order_state: 'rejected', broker_order_ids: [] });
    const position = await store.getPosition('key-1');
    expect(position?.order_state).toBe('rejected');
    expect(await store.getOpenPositions()).toHaveLength(0);

    await execution.ingestFills();
    await execution.ingestFills();
    expect(logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE)).toHaveLength(1);
    expect(logger.entries.some((e) => e.message === FILLED_ZERO_SIZE_CLEARED)).toBe(false);
  });

  it('does not reset the wedge streak when a non-entry fill lands on a still-wedged lot (#1087 review, pass 2)', async () => {
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
    const throttle = new FilledZeroSizeThrottle();
    const execution = new ExecutionImpl(
      makeInput(broker, store, undefined, undefined, logger, throttle),
    );

    await execution.reconcile();
    await execution.ingestFills();
    await execution.ingestFills();

    const stopFill = fill({
      broker_fill_id: toBrokerFillId('s1'),
      leg: 'stop',
      qty: 10,
      price: 95,
      timestamp: new Date('2026-07-20T15:00:00Z'),
    });
    broker.replaceFills([entryFill, stopFill]);
    await execution.ingestFills();

    expect(await store.getFills('key-1')).toHaveLength(1);
    expect((await store.getPosition('key-1'))?.filled_size).toBe(0);

    const warningsSoFar = logger.entries.filter((e) => e.message === FILLED_WITH_ZERO_SIZE);
    expect(warningsSoFar).toHaveLength(0);

    expect(throttle.observe('key-1', NOW)).toEqual({ announce: 'warn', consecutive: 3 });
  });
});

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

  it('raises the same line and page for a split booked against an already-closed lot', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { idempotency_key: 'key-1', requested_size: 10, stop: 95 });
    await seedPosition(store, {
      idempotency_key: 'key-other',
      instrument: 'TSLA',
      requested_size: 5,
      stop: 190,
    });
    const journalFlatten = async (key: string, held: number): Promise<void> => {
      await store.writeAheadFlatten({
        idempotency_key: key,
        instrument: 'AAPL',
        asset_class: 'stocks',
        side: 'sell',
        size: held,
        submitted_at: OPENED_AT,
        lot_held_quantities: [{ idempotency_key: 'key-1', held }],
        exit_reason: 'flatten',
        decision_price: null,
        quote_bid: null,
        quote_ask: null,
        quote_mid: null,
        modelled_cost_breakdown: null,
        quote_observed_at: null,
      });
      await store.resolveFlattenSubmitted(
        key,
        { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
        OPENED_AT,
      );
    };
    await journalFlatten('flatten-1', 10);

    const entry = fill({
      client_order_id: 'key-1',
      broker_fill_id: toBrokerFillId('e1'),
      leg: 'entry',
      qty: 10,
    });
    const firstFlattenFill = fill({
      client_order_id: 'flatten-1',
      broker_fill_id: toBrokerFillId('f1'),
      leg: 'exit',
      qty: 10,
      timestamp: new Date('2026-07-20T15:30:00Z'),
    });
    const secondFlattenFill = fill({
      client_order_id: 'flatten-2',
      broker_fill_id: toBrokerFillId('f2'),
      leg: 'exit',
      qty: 4,
      fee: 0.8,
      fee_currency: 'USD',
      timestamp: new Date('2026-07-20T15:45:00Z'),
    });

    const feeAlerts = makeNonSterlingFeeAlerts();
    const logger = recordingLogger();
    const poll = async (fills: readonly NormalizedFill[]): Promise<void> => {
      await new ExecutionImpl(
        makeInput(
          new ScriptedBroker([...fills]),
          store,
          undefined,
          undefined,
          logger,
          undefined,
          undefined,
          undefined,
          feeAlerts,
        ),
      ).ingestFills();
    };

    await poll([entry]);
    await poll([entry, firstFlattenFill]);
    expect((await store.getPosition('key-1'))?.order_state).toBe('closed');

    await journalFlatten('flatten-2', 4);
    await poll([entry, firstFlattenFill, secondFlattenFill]);

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: FEE_CURRENCY_NOT_BOOK_CURRENCY,
        payload: expect.objectContaining({
          idempotency_key: 'key-1',
          instrument: 'AAPL',
          broker_fill_id: 'f2:key-1',
          fee: 0.8,
          fee_currency: 'USD',
        }),
      }),
    );
    expect(feeAlerts.alerts).toMatchObject([
      { idempotency_key: 'key-1', instrument: 'AAPL', fee_currency: 'USD' },
    ]);

    await poll([entry, firstFlattenFill, secondFlattenFill]);
    expect(
      logger.entries.filter((line) => line.message === FEE_CURRENCY_NOT_BOOK_CURRENCY),
    ).toHaveLength(1);
    expect(feeAlerts.alerts).toHaveLength(1);
  });
});

describe('fx_rate_to_gbp is carried through verbatim (#1521)', () => {
  it('persists a rate an adapter reports, alongside its source', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('usd-1'),
        qty: 5,
        fee: 0.8,
        fee_currency: 'USD',
        fx_rate_to_gbp: 0.79,
        fx_rate_to_gbp_source: 'venue',
      }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const [persisted] = await store.getFills('key-1');
    expect(persisted?.fx_rate_to_gbp).toBe(0.79);
    expect(persisted?.fx_rate_to_gbp_source).toBe('venue');
  });

  it('logs the reason on the same fee_currency_not_book_currency line when no rate is reported', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 5 });
    const broker = new ScriptedBroker([
      fill({
        broker_fill_id: toBrokerFillId('usd-1'),
        qty: 5,
        fee: 0.8,
        fee_currency: 'USD',
        fx_rate_to_gbp_source: 'not_reported_by_venue',
      }),
    ]);
    const logger = recordingLogger();

    await new ExecutionImpl(makeInput(broker, store, undefined, undefined, logger)).ingestFills();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: FEE_CURRENCY_NOT_BOOK_CURRENCY,
        payload: expect.objectContaining({
          broker_fill_id: 'usd-1',
          fx_rate_to_gbp: undefined,
          fx_rate_to_gbp_source: 'not_reported_by_venue',
        }),
      }),
    );

    const [persisted] = await store.getFills('key-1');
    expect(persisted?.fx_rate_to_gbp).toBeUndefined();
    expect(persisted?.fx_rate_to_gbp_source).toBe('not_reported_by_venue');
  });

  it('omits both fields for a book-currency fill, no adapter having reported either', async () => {
    const { store } = openTestExecutionStore();
    await seedPosition(store, { requested_size: 2 });
    const broker = new ScriptedBroker([
      fill({ broker_fill_id: toBrokerFillId('gbp-1'), qty: 2, fee: 0.1, fee_currency: 'GBP' }),
    ]);

    await new ExecutionImpl(makeInput(broker, store)).ingestFills();

    const [persisted] = await store.getFills('key-1');
    expect(persisted?.fx_rate_to_gbp).toBeUndefined();
    expect(persisted?.fx_rate_to_gbp_source).toBeUndefined();
  });
});

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
