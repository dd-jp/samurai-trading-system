import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LlmClient } from '../../../pipeline/debate-engine/index.js';
import type {
  BrokerAck,
  BrokerAdapter,
  SharedStore as ExecutionSharedStore,
  NormalizedFill,
  NormalizedOrder,
  NormalizedPosition,
} from '../../../pipeline/execution/index.js';
import { TERMINAL_SWEEP_AGE_MS } from '../../../pipeline/execution/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { buildExecutionSurface } from './direct-bind.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-07-20T16:00:00Z');
const OLD_DECISION_TIMESTAMP = new Date(NOW.getTime() - TERMINAL_SWEEP_AGE_MS - 60 * 60 * 1_000);

class NoOpBroker implements BrokerAdapter {
  async submitBracket(): Promise<BrokerAck> {
    throw new Error('NoOpBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    throw new Error('NoOpBroker.getOrder: no in-flight lot is seeded');
  }
  async fetchNewFills(): Promise<NormalizedFill[]> {
    return [];
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('NoOpBroker.resizeProtectiveLegs: no fill is ever ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('NoOpBroker.rearmProtectiveLegs: no partial flatten in this scenario');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error('NoOpBroker.resumeFlatten: no unresolved flatten is seeded');
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('NoOpBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('NoOpBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function seedOldRejectedPosition(store: ExecutionSharedStore): Promise<void> {
  const position: OpenPosition = {
    idempotency_key: 'key-old-rejected',
    debate_id: 'debate-old-rejected',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    requested_size: 10,
    filled_size: 0,
    avg_entry_price: 0,
    stop: 95,
    target: 110,
    order_state: 'rejected',
    broker_order_ids: [],
    opened_at: OLD_DECISION_TIMESTAMP,
    decision_timestamp: OLD_DECISION_TIMESTAMP,
    conviction: 0.7,
    converged: true,
  };
  await store.writeAheadPosition(position);
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
  } as StubConfig;
}

describe('the #1088 terminal-row sweep is wired through the real composition root', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('deletes an old, terminal, size-0 open_positions row when reconcile() runs through the production binding', async () => {
    const logger = recordingLogger();
    const config = stubConfig(db, logger);
    const components = buildProductionComponents({ ...config, broker: new NoOpBroker() });
    await seedOldRejectedPosition(components.executionStore);

    const surface = buildExecutionSurface(components.executionDeps, 'trace-terminal-sweep-wiring');
    const report = await surface.reconcile();

    expect(report.swept).toBe(1);

    const row = db
      .prepare('SELECT 1 FROM open_positions WHERE idempotency_key = ?')
      .get('key-old-rejected');
    expect(row).toBeUndefined();
  });
});
