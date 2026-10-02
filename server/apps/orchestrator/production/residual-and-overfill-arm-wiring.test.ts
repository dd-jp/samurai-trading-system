import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import { SqliteExecutionStore } from '../../../pipeline/execution/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { PolymarketClient } from '../../../providers/market-intelligence/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket, toBrokerFillId } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const { startFillSyncSpy } = vi.hoisted(() => ({ startFillSyncSpy: vi.fn() }));

vi.mock('../fill-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fill-sync.js')>();
  startFillSyncSpy.mockImplementation(actual.startFillSync);
  return { ...actual, startFillSync: startFillSyncSpy };
});

const NOW = new Date('2026-07-20T16:00:00Z');
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

class AmnesiacFlattenBroker implements BrokerAdapter {
  async submitBracket(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async fetchNewFills(): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.resizeProtectiveLegs: no fill is ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.rearmProtectiveLegs: no partial flatten here');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    return null;
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('AmnesiacFlattenBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('AmnesiacFlattenBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function seedAckedThenDeniedFlatten(store: ExecutionSharedStore, key: string): Promise<void> {
  await store.writeAheadFlatten({
    idempotency_key: key,
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'sell',
    size: 10,
    submitted_at: NOW,
    lot_held_quantities: [{ idempotency_key: `${key}-entry`, held: 10 }],
    exit_reason: 'flatten',
    decision_price: null,
    quote_bid: null,
    quote_ask: null,
    quote_mid: null,
    quote_observed_at: null,
    modelled_cost_breakdown: null,
  });
  await store.resolveFlattenSubmitted(
    key,
    { order_state: 'submitted', broker_order_ids: [`${key}:order`] },
    NOW,
  );
}

class ScriptedLiveBroker implements BrokerAdapter {
  rearmFailure: Error | undefined;

  constructor(private readonly scriptedFills: NormalizedFill[]) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error('ScriptedLiveBroker.submitBracket: positions are seeded directly, not placed');
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {}
  async rearmProtectiveLegs(): Promise<void> {
    if (this.rearmFailure !== undefined) throw this.rearmFailure;
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return null;
  }
  async resumeFlatten(): Promise<never> {
    throw new Error('ScriptedLiveBroker.resumeFlatten: ingestFills() does not reconcile');
  }
  async submitFlatten(): Promise<never> {
    throw new Error('ScriptedLiveBroker.submitFlatten: ingestFills() does not flatten');
  }
  async cancel(): Promise<never> {
    throw new Error('ScriptedLiveBroker.cancel: ingestFills() does not cancel');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

function fill(overrides: Partial<NormalizedFill> = {}): NormalizedFill {
  return {
    client_order_id: 'residual-live',
    broker_fill_id: toBrokerFillId('fill-1'),
    leg: 'entry',
    price: 100,
    qty: 5,
    fee: 1,
    timestamp: new Date('2026-07-20T15:00:00Z'),
    ...overrides,
  };
}

async function seedPosition(
  store: ExecutionSharedStore,
  overrides: Partial<OpenPosition> = {},
): Promise<void> {
  await store.writeAheadPosition({
    idempotency_key: 'residual-live',
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
    order_state: 'partially_filled',
    broker_order_ids: ['residual-live:entry', 'residual-live:stop', 'residual-live:target'],
    opened_at: OPENED_AT,
    decision_timestamp: OPENED_AT,
    conviction: 0.7,
    converged: true,
    ...overrides,
  });
}

type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, logger: Logger, broker: BrokerAdapter): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
    broker,
    llmClient: {
      complete: async () => {
        throw new Error('unreachable: this wiring test never runs a debate');
      },
    } as unknown as LlmClient,
    alpacaBrokerClient: {
      submitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      cancelOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      getOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      listOrders: async () => [],
      listFills: async () => [],
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: async () => [],
      getLatestQuote: async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 }),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      }),
    } as unknown as ProductionConfig['accountState'],
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: makeWiringRiskConfig(),
    verdictConfig: makeWiringVerdictConfig(),
    executionConfig: makeWiringExecutionConfig(),
    correlationConfig: makeWiringCorrelationConfig(),
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.3,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.2, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: makeWiringCostConfig(),
    ciiConsumerConfig: makeWiringCiiConsumerConfig(),
    tradingCalendar: new AlwaysOpenCalendar(),
    polymarketClient: new PolymarketClient({
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
      fetchImpl: (async () => {
        throw new Error('offline: this wiring proof must not reach Polymarket');
      }) as unknown as typeof fetch,
    }),
    polymarketPollIntervalMs: 20 * 24 * 60 * 60 * 1_000,
  } as StubConfig;
}

describe('residual-exposure and flatten-overfill alerts name the arm that raised them (#1348)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    startFillSyncSpy.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  it("captures each arm's own fill-sync surface, not a swapped one", async () => {
    const logger = recordingLogger();
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live',
    );
    await seedAckedThenDeniedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control',
    );

    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, logger, new AmnesiacFlattenBroker()),
    );
    await orchestrator.start();

    expect(startFillSyncSpy).toHaveBeenCalledTimes(2);
    const controlExecution = startFillSyncSpy.mock.calls[0]?.[0].execution;
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    logger.entries.length = 0;
    await controlExecution.reconcile();
    await liveExecution.reconcile();
    await orchestrator.stop();

    const alerts = logger.entries.filter((entry) => entry.event === 'flatten_reconcile_unresolved');
    expect(alerts).toHaveLength(2);
    expect(
      alerts.map((entry) => ({
        trace_id: entry.trace_id,
        idempotency_key: (entry.payload as { idempotency_key?: string } | undefined)
          ?.idempotency_key,
      })),
    ).toEqual([
      { trace_id: 'control-arm-fill-sync', idempotency_key: 'flatten-control' },
      { trace_id: 'fill-sync', idempotency_key: 'flatten-live' },
    ]);
  });

  it("posts the live arm's own re-arm failure under the fill-sync trace id", async () => {
    const logger = recordingLogger();
    const store = new SqliteExecutionStore(guardedStore(db, 'execution'));
    await seedPosition(store);

    const broker = new ScriptedLiveBroker([
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

    const orchestrator = buildProductionOrchestrator(stubConfig(db, logger, broker));
    await orchestrator.start();
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    await liveExecution.ingestFills();
    await orchestrator.stop();

    const alerts = logger.entries.filter(
      (entry) => entry.event === 'residual_exposure_unprotected',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.trace_id).toBe('fill-sync');
    expect((alerts[0]?.payload as { idempotency_key?: string } | undefined)?.idempotency_key).toBe(
      'residual-live',
    );
  });

  it("posts the live arm's own over-filled flatten under the fill-sync trace id", async () => {
    const logger = recordingLogger();
    const store = new SqliteExecutionStore(guardedStore(db, 'execution'));
    await seedPosition(store, { idempotency_key: 'overfill-live', requested_size: 10 });
    await store.writeAheadFlatten({
      idempotency_key: 'flatten-overfill-live',
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'sell',
      size: 6,
      submitted_at: NOW,
      lot_held_quantities: [{ idempotency_key: 'overfill-live', held: 6 }],
      exit_reason: 'flatten',
      decision_price: null,
      quote_bid: null,
      quote_ask: null,
      quote_mid: null,
      quote_observed_at: null,
      modelled_cost_breakdown: null,
    });

    const broker = new ScriptedLiveBroker([
      fill({
        client_order_id: 'overfill-live',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
      }),
      fill({
        client_order_id: 'flatten-overfill-live',
        broker_fill_id: toBrokerFillId('f1'),
        leg: 'exit',
        qty: 10,
        timestamp: new Date('2026-07-20T15:30:00Z'),
      }),
    ]);

    const orchestrator = buildProductionOrchestrator(stubConfig(db, logger, broker));
    await orchestrator.start();
    const liveExecution = startFillSyncSpy.mock.calls[1]?.[0].execution;

    await liveExecution.ingestFills();
    await orchestrator.stop();

    const warnings = logger.entries.filter((entry) => entry.event === 'flatten_overfill_dropped');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.trace_id).toBe('fill-sync');
    expect(
      (warnings[0]?.payload as { idempotency_key?: string } | undefined)?.idempotency_key,
    ).toBe('flatten-overfill-live');
  });
});
