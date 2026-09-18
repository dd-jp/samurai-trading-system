import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  buildProductionComponents,
  buildProductionOrchestrator,
  type ProductionConfig,
} from '../production.js';
import { MI_REFRESH_TRACE_ID } from './mi-refresh-queue.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-09-03T14:00:00Z');

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

function recordSpend(db: StoreHandle, costUsd: number): void {
  db.prepare(
    `INSERT INTO llm_spend (
       trace_id, stage, debate_id, model,
       input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       cost_usd, latency_ms, timestamp
     ) VALUES ('trace-prior', 'debate', 'debate-prior', 'openai/gpt-5.6-luna', 100, 100, 0, 0, ?, 10, ?)`,
  ).run(costUsd, NOW.toISOString());
}

type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig>): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    alpacaBrokerClient: {
      submitOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
        legs: [],
      })),
      submitLimitOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
      })),
      submitStopLimitOrder: vi.fn(async () => ({
        id: 'alpaca-order-2',
        client_order_id: 'k:stop',
        status: 'accepted',
      })),
      cancelOrder: vi.fn(async () => undefined),
      getOrder: vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'k',
        status: 'accepted',
        legs: [],
      })),
      listOrders: vi.fn(async () => []),
      listFills: vi.fn(async () => []),
    } as unknown as ProductionConfig['alpacaBrokerClient'],
    alpacaDataClient: {
      getBars: vi.fn(async () => []),
      getLatestQuote: vi.fn(async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 })),
    } as unknown as ProductionConfig['alpacaDataClient'],
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        },
        consecutive_losses: 0,
      })),
    } as unknown as ProductionConfig['accountState'],
    llmClient: { complete: vi.fn() } as unknown as ProductionConfig['llmClient'],
    polymarketClient: {
      fetchMarket: vi.fn(async () => undefined),
    } as unknown as ProductionConfig['polymarketClient'],
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
    ...overrides,
  } as StubConfig;
}

describe('MI refresh wiring (#1085)', () => {
  const ENV_VARS = [
    'NOUS_API_KEY',
    'NOUS_BASE_URL',
    'NOUS_MODEL',
    'NOUS_SENTIMENT_API_KEY',
    'NOUS_SENTIMENT_MODEL',
    'SAMURAI_SENTIMENT',
    'SAMURAI_SENTIMENT_RETRIEVAL',
  ] as const;
  const previous: Partial<Record<(typeof ENV_VARS)[number], string | undefined>> = {};
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    for (const name of ENV_VARS) {
      previous[name] = process.env[name];
      delete process.env[name];
    }
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
  });

  afterEach(() => {
    db.close();
    for (const name of ENV_VARS) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('drives the exposed queue from the analyst stage, under the root spend cap', async () => {
    const { logger, entries } = recordingLogger();
    recordSpend(db, 50);
    const components = buildProductionComponents(
      stubConfig(db, {
        logger,
        llmBudgetUsd: 50,
        universe: [{ asset: 'AAPL', asset_class: 'stocks' }],
      }),
    );

    await components.steps.analysts({
      trace_id: 'trace-1',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock: new SimulatedClock(NOW),
      bar: NOW,
    });
    await settle();

    const refusal = entries.find((entry) => entry.trace_id === MI_REFRESH_TRACE_ID);
    expect(refusal?.level).toBe('warn');
    expect(refusal?.message).toContain('refresh for AAPL not started');
    expect(refusal?.stage).toBe('market_intelligence');

    expect(components.marketIntelligenceRefresh?.refreshAttempted('AAPL')).toBe(true);
    expect(components.marketIntelligenceRefresh?.refreshAttempted('TSLA')).toBe(false);
  });

  it('drains the queue from the orchestrator own stop, so a refresh cannot outlive the store', async () => {
    const { logger, entries } = recordingLogger();
    recordSpend(db, 50);
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, {
        logger,
        llmBudgetUsd: 50,
        universe: [{ asset: 'AAPL', asset_class: 'stocks' }],
      }),
    );
    const queue = orchestrator.marketIntelligenceRefresh;
    expect(queue).toBeDefined();

    await orchestrator.stop();

    await queue?.refresh('tick-after-stop', 'AAPL', 'stocks');
    await settle();

    expect(queue?.depth).toBe(0);
    expect(entries.find((entry) => entry.trace_id === MI_REFRESH_TRACE_ID)).toBeUndefined();
  });

});
