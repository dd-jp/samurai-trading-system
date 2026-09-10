/**
 * The retention sweeps are EXECUTED by the composition root (#1313) — not
 * merely spelled there.
 *
 * ## Why this file exists
 *
 * `alert-delivery-failure-retention.test.ts` (#1131) and
 * `mi-archive-retention.test.ts` (#1060) both assert their prune call sites by
 * matching `production.ts` as TEXT. #1306's review measured what that catches:
 * wrapping the daily `pruneAlertDeliveryFailuresWithLog(...)` call in a `/* ...
 * *\/` block comment left all 11 tests in that file green, because the call
 * text is still present in the source the regex reads. Reproduced on this
 * branch before this file was written, same result.
 *
 * A source-text match therefore pins the ARGUMENT SEQUENCE and the textual
 * placement of a call, which is what those two files' remaining cases are for.
 * It does not pin that the call runs. This repo's dominant defect class is a
 * tested mechanism nothing calls, so the guard against it has to observe a
 * side effect instead of a substring.
 *
 * ## What each case observes, and why it is the only honest observable
 *
 * A seeded, over-age row DISAPPEARS. Not a log line: both
 * `pruneAlertDeliveryFailuresWithLog` and `pruneMiArchiveWithLog` log only a
 * NONZERO delete — `if (deleted === 0) return;` sits above the `logger.log` in
 * each — so the ordinary case, a sweep that runs and finds nothing over-age,
 * emits nothing at all, and an absent log does not separate "never ran" from
 * "ran and deleted nothing". Under these two cases specifically a log
 * assertion would in fact have passed, because the seeded row makes each
 * delete nonzero; the row count is preferred anyway, since 1 -> 0 is entailed
 * by the delete having executed whatever the helpers' logging policy later
 * becomes.
 *
 * The startup and daily cases are separated by WHEN the row is seeded, which
 * is the load-bearing trick here:
 *
 * - startup: seed, then construct. `buildProductionComponents` is the only
 *   thing that runs, so a deleted row can only have come from the `'startup'`
 *   call site.
 * - daily: construct FIRST (its startup prune runs against tables that are
 *   still empty), then seed, then `start()`. The row is younger than the
 *   construction that already swept, so a deleted row can only have come from
 *   `runFeedbackCycle`, which `scheduleFeedbackCycle` runs synchronously at
 *   `start()` on a virgin schedule store (#1110's catch-up pass).
 *
 * `llm_call_log`'s sweep (#1045, `llm-call-log-retention.test.ts`) has the
 * same regex-only shape and is NOT covered here — #1313 scoped the fix to the
 * two files above.
 */

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
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-09-06T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_CHAT_ID = '-100200300';

/**
 * Both vendors' read APIs need no credentials, so nothing but an injected stub
 * stops `start()` from reaching them — `startup.test.ts` and
 * `production.test.ts` both carry this argument, and `vitest.setup.ts` is the
 * suite-wide backstop. The pacing override is theirs too: the shipped
 * two-tokens-then-one-per-five-seconds pace is wall-clock coupling for a client
 * that throws before it opens a socket.
 */
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

/** The narrowest `ProductionConfig` that both composition roots accept. Every transport is a stub. */
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
    // Long enough that neither timer fires between `start()` and `stop()`.
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
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
    } as ProductionConfig['verdictConfig'],
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

/**
 * Only the `weights` band is filled in — the startup seeder (#371) reads it
 * before the first cycle, and `runDailyCycle`'s own throw on the rest is
 * caught and logged inside `runFeedbackCycle`'s try. Same fixture, and same
 * reason, as production.test.ts's timer case.
 */
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
    // Both resolvers read `process.env` at call time inside both roots, so an
    // operator override present in the ambient environment would change the
    // cutoffs these cases seed against.
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

  /** Over-age against the default 30-day retention, by a margin no rounding closes. */
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

  /** Over-age against the default 90-day MI window, by the same kind of margin. */
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

    // No `start()`: `buildProductionComponents` is the only thing that runs,
    // so the deletes below can only be the `'startup'` call sites'.
    buildProductionComponents(stubConfig(db, archive));

    expect(alertFailureRows()).toBe(0);
    expect(archiveRows()).toBe(0);
  });

  it('sweeps both tables again on the daily feedback cycle, outside its try block', async () => {
    const { logger, entries } = recordingLogger();
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, archive, { logger, feedback: feedbackCycleConfig }),
    );

    // AFTER construction, so the startup sweep has already run against empty
    // tables and cannot be what deletes these rows.
    seedOverAgeAlertFailure();
    seedOverAgeArchiveRow();
    expect(alertFailureRows()).toBe(1);
    expect(archiveRows()).toBe(1);

    await orchestrator.start();

    expect(alertFailureRows()).toBe(0);
    expect(archiveRows()).toBe(0);

    // `runDailyCycle` throws on this deliberately minimal `feedback.config`,
    // and the throw is caught and logged inside `runFeedbackCycle`'s try, so
    // this entry is proof the cycle really did reach a throwing
    // `runDailyCycle`. With the deletes above, that pins ONE half of the
    // placement rule — the prunes run BEFORE a throwing `runDailyCycle`, which
    // is the hazard the rule exists for. Mutated on this branch: moving the
    // alert prune below `runDailyCycle` inside the try leaves the row alive
    // and the first assertion above red.
    //
    // It does NOT pin "outside the try". Moving the same prune inside the try
    // but ABOVE `runDailyCycle` was mutated too: this case stays fully green
    // and only the source-text case in
    // `alert-delivery-failure-retention.test.ts` reddens. The two placements
    // are behaviourally identical — the prune swallows its own errors — so the
    // try boundary is pinned by text there and the ordering by execution here,
    // and neither file holds both halves alone.
    expect(
      entries.some((entry) => entry.trace_id === 'feedback-cycle' && entry.level === 'error'),
    ).toBe(true);

    await orchestrator.stop();
  });
});
