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
import { FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS } from '../../../pipeline/execution/index.js';
import { FILLED_WITH_ZERO_SIZE } from '../../../pipeline/execution/ingest-fills.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { Logger, OpenPosition } from '../../../shared/index.js';
import { SimulatedClock, toBrokerFillId } from '../../../shared/index.js';
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
const OPENED_AT = new Date('2026-07-20T14:00:00Z');

class WedgingBroker implements BrokerAdapter {
  constructor(
    private readonly order: NormalizedOrder,
    private readonly scriptedFills: NormalizedFill[],
  ) {}

  async submitBracket(): Promise<BrokerAck> {
    throw new Error('WedgingBroker.submitBracket: this wiring proof never enters a lot');
  }
  async getOrder(): Promise<NormalizedOrder | null> {
    return this.order;
  }
  async fetchNewFills(since: Date): Promise<NormalizedFill[]> {
    return this.scriptedFills.filter((fill) => fill.timestamp.getTime() >= since.getTime());
  }
  async resizeProtectiveLegs(): Promise<void> {
    throw new Error('WedgingBroker.resizeProtectiveLegs: no new fill is ever ingested here');
  }
  async rearmProtectiveLegs(): Promise<void> {
    throw new Error('WedgingBroker.rearmProtectiveLegs: no partial flatten in this scenario');
  }
  async resumeFlatten(): Promise<NormalizedOrder | null> {
    throw new Error('WedgingBroker.resumeFlatten: reconcile() has nothing unresolved to sweep');
  }
  async submitFlatten(): Promise<BrokerAck> {
    throw new Error('WedgingBroker.submitFlatten: this wiring proof never flattens');
  }
  async cancel(): Promise<void> {
    throw new Error('WedgingBroker.cancel: this wiring proof never cancels');
  }
  async getOpenPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
}

async function seedWedgedPosition(store: ExecutionSharedStore): Promise<void> {
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
  } as StubConfig;
}

describe('the FILLED_WITH_ZERO_SIZE throttle is wired through the real composition root (#1087)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('shares one throttle across every surface built from the same executionDeps, so a second surface does not re-warn mid-episode', async () => {
    const logger = recordingLogger();
    const { entries } = logger;
    const order: NormalizedOrder = {
      client_order_id: 'key-1',
      broker_order_ids: ['key-1:entry', 'key-1:stop', 'key-1:target'],
      order_state: 'filled',
      filled_qty: 10,
    };
    const broker = new WedgingBroker(order, [
      {
        client_order_id: 'key-1',
        broker_fill_id: toBrokerFillId('e1'),
        leg: 'entry',
        qty: 10,
        price: 100,
        fee: 1,
        timestamp: new Date(OPENED_AT.getTime() - 1),
      },
    ]);
    const config = stubConfig(db, logger);
    const clock = config.clock as SimulatedClock;
    const components = buildProductionComponents({ ...config, broker });
    await seedWedgedPosition(components.executionStore);

    const surfaceA = buildExecutionSurface(components.executionDeps, 'trace-wiring-a');
    await surfaceA.reconcile();
    for (let poll = 0; poll < 3; poll += 1) {
      await surfaceA.ingestFills();
    }

    clock.advanceTo(new Date(NOW.getTime() + FILLED_ZERO_SIZE_REANNOUNCE_EVERY_MS + 1));

    const surfaceB = buildExecutionSurface(components.executionDeps, 'trace-wiring-b');
    for (let poll = 0; poll < 3; poll += 1) {
      await surfaceB.ingestFills();
    }

    const [position] = await components.executionStore.getOpenPositions();
    expect(position?.idempotency_key).toBe('key-1');
    expect(position?.order_state).toBe('filled');
    expect(position?.filled_size).toBe(0);
    expect(await components.executionStore.getFills('key-1')).toHaveLength(0);

    const announcements = entries.filter((entry) => entry.message === FILLED_WITH_ZERO_SIZE);
    expect(announcements.map((entry) => entry.level)).toEqual(['warn', 'info']);
    expect(announcements[0]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 3,
    });
    expect(announcements[1]?.payload).toMatchObject({
      idempotency_key: 'key-1',
      instrument: 'AAPL',
      order_state: 'filled',
      consecutive: 4,
    });
    const stuckMsValues = announcements.map(
      (entry) => (entry.payload as { stuck_ms?: unknown })?.stuck_ms,
    );
    for (const stuckMs of stuckMsValues) {
      expect(typeof stuckMs).toBe('number');
    }
    expect(stuckMsValues[1]).toBeGreaterThan(stuckMsValues[0] as number);

    expect(logger).toBe(config.logger);
  });
});
