
import type { FeedbackConfig, LoosenAppliedNotice } from '../../../pipeline/feedback-loop/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import {
  GdeltGkgClient,
  MI_SOURCES,
  MiArchiveStore,
  PolymarketClient,
} from '../../../providers/market-intelligence/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock, TokenBucket } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
  SqliteAlertDeliveryLog,
} from '../alert-delivery-log.js';
import {
  buildProductionComponents,
  buildProductionOrchestrator,
  type ProductionConfig,
} from '../production.js';
import {
  ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
  ENV_MI_ARCHIVE_RETENTION_DAYS,
} from './environment.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_CHAT_ID = '-100200300';

function offlineClients(): Pick<ProductionConfig, 'gdeltClient' | 'polymarketClient'> {
  const refuse = (async () => {
    throw new Error('offline: the test suite must not reach a vendor');
  }) as unknown as typeof fetch;
  const rateLimiter = new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
  return {
    gdeltClient: new GdeltGkgClient({ rateLimiter, fetchImpl: refuse }),
    polymarketClient: new PolymarketClient({ rateLimiter, fetchImpl: refuse }),
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

function stubConfig(
  db: StoreHandle,
  archive: MiArchiveStore,
  overrides: Partial<ProductionConfig> = {},
): ProductionConfig {
  return {
    db,
    miArchive: archive,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    tickIntervalMs: 100_000,
    heartbeatIntervalMs: 100_000,
    polymarketPollIntervalMs: 20 * DAY_MS,
    gdeltPollIntervalMs: 20 * DAY_MS,
    ...offlineClients(),
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
  } as ProductionConfig;
}

const feedbackCycleConfig = {
  intervalMs: DAY_MS,
  config: {
    weights: { max_step: 0.05, floor: 0.5, ceiling: 1.5, tighten_is: 'decrease' },
  } as unknown as FeedbackConfig,
  loosenNotices: { notifyLoosenApplied: vi.fn<(notice: LoosenAppliedNotice) => void>() },
} as NonNullable<ProductionConfig['feedback']>;

describe('the composition root RUNS its retention sweeps (#1313)', () => {
  const ENV_VARS = [
    ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    ENV_MI_ARCHIVE_RETENTION_DAYS,
  ] as const;
  const previous: Record<string, string | undefined> = {};
  let db: StoreHandle;
  let archive: MiArchiveStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    archive = new MiArchiveStore();
    for (const name of ENV_VARS) {
      previous[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    archive.close();
    db.close();
    for (const name of ENV_VARS) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function seedOverAgeAlertFailure(): void {
    new SqliteAlertDeliveryLog(db).recordFailure({
      chat_id: ALERT_CHAT_ID,
      method: 'sendMessage',
      body: 'Samurai TRADER DEGRADED',
      error: 'Telegram Bot API transport failure: fetch failed (sendMessage)',
      timestamp: new Date(
        NOW.getTime() - (DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS + 10) * DAY_MS,
      ),
    });
  }

  function alertFailureRows(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM alert_delivery_failures').get() as { n: number })
      .n;
  }

  function seedOverAgeArchiveRow(): void {
    const longAgo = new Date(NOW.getTime() - 200 * DAY_MS);
    archive.write(
      [
        {
          source: MI_SOURCES.alpacaNews,
          native_id: 'stale-1',
          updated_at: longAgo,
          payload: '{"headline":"stale"}',
          ingested_at: longAgo,
          fidelity: 'backfill',
        },
      ],
      [],
    );
  }

  function archiveRows(): number {
    return archive.rawRows(MI_SOURCES.alpacaNews).length;
  }

  it('sweeps both tables at construction, before anything is started', () => {
    seedOverAgeAlertFailure();
    seedOverAgeArchiveRow();
    expect(alertFailureRows()).toBe(1);
    expect(archiveRows()).toBe(1);

    buildProductionComponents(stubConfig(db, archive));

    expect(alertFailureRows()).toBe(0);
    expect(archiveRows()).toBe(0);
  });

  it('sweeps both tables again on the daily feedback cycle, outside its try block', async () => {
    const { logger, entries } = recordingLogger();
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, archive, { logger, feedback: feedbackCycleConfig }),
    );

    seedOverAgeAlertFailure();
    seedOverAgeArchiveRow();
    expect(alertFailureRows()).toBe(1);
    expect(archiveRows()).toBe(1);

    await orchestrator.start();

    expect(alertFailureRows()).toBe(0);
    expect(archiveRows()).toBe(0);

    expect(
      entries.some((entry) => entry.trace_id === 'feedback-cycle' && entry.level === 'error'),
    ).toBe(true);

    await orchestrator.stop();
  });
});
