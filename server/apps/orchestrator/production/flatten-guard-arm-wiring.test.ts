import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { Logger } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionOrchestrator, type ProductionConfig } from '../production.js';
import type { TraderStepDeps } from './direct-bind.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const { buildTraderStepsSpy } = vi.hoisted(() => ({ buildTraderStepsSpy: vi.fn() }));

vi.mock('./direct-bind.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./direct-bind.js')>();
  buildTraderStepsSpy.mockImplementation(actual.buildTraderSteps);
  return { ...actual, buildTraderSteps: buildTraderStepsSpy };
});

const NOW = new Date('2026-07-20T16:00:00Z');

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

async function seedUnresolvedFlatten(
  store: ExecutionSharedStore,
  key: string,
  instrument: string,
): Promise<void> {
  await store.writeAheadFlatten({
    idempotency_key: key,
    instrument,
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
}

function onlyArm(captured: readonly TraderStepDeps[], arm: 'live' | 'control'): TraderStepDeps {
  const matches = captured.filter((deps) => (deps.arm ?? 'live') === arm);
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    throw new Error(
      `expected exactly one ${arm}-arm buildTraderSteps call, captured ${matches.length}`,
    );
  }
  return only;
}

type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, logger: Logger): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger,
    llmClient: {
      complete: async () => {
        throw new Error('unreachable: this wiring test never runs a debate');
      },
    } as unknown as LlmClient,
    alpacaBrokerClient: {
      submitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitLimitOrder: async () => {
        throw new Error('unreachable: `broker` override bypasses the Alpaca wire client');
      },
      submitStopLimitOrder: async () => {
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

describe("the in-flight flatten guard reads its own arm's journal (#1389)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    buildTraderStepsSpy.mockClear();
  });

  afterEach(() => {
    db.close();
  });

  it("binds each arm's `getUnresolvedFlattens` to that arm's own store", async () => {
    const orchestrator = buildProductionOrchestrator({
      ...stubConfig(db, recordingLogger()),
      broker: new AmnesiacFlattenBroker(),
    });
    await orchestrator.start();
    await orchestrator.stop();

    const capturedDeps = buildTraderStepsSpy.mock.calls.map(([deps]) => deps as TraderStepDeps);
    const liveDeps = onlyArm(capturedDeps, 'live');
    const controlDeps = onlyArm(capturedDeps, 'control');

    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution')),
      'flatten-live',
      'AAPL',
    );
    await seedUnresolvedFlatten(
      new SqliteExecutionStore(guardedStore(db, 'execution'), 'control'),
      'flatten-control',
      'TSLA',
    );

    expect((await liveDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual(['AAPL']);
    expect((await controlDeps.getUnresolvedFlattens()).map((row) => row.instrument)).toEqual([
      'TSLA',
    ]);
  });
});
