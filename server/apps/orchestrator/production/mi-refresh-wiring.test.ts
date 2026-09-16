/**
 * The wiring proof for #1085 — the MI refresh queue is IN the analyst stage's
 * path, holding the REAL spend cap, and the stage returns before it has run.
 *
 * A separate file from `mi-refresh-queue.test.ts` on purpose, the same split
 * `rate-limit-wiring.test.ts` makes: that file tests what the queue does, this
 * one tests what the composition root does with one. A queue that is correct
 * and constructed nowhere on the shipped path is this repo's dominant defect
 * class, and no unit test can see it.
 *
 * ## The mutations these kill
 *
 * 1. Pass `composeMarketIntelligence([...])` straight to `buildAnalystsStep`
 *    instead of wrapping it in `MiRefreshQueue` (the pre-#1085 wiring). No
 *    `mi-refresh` line is ever logged, the analyst stage awaits the agent
 *    again, and both assertions below go red.
 * 2. Build the queue with `UNCAPPED_SPEND` instead of the root's `spendCap`.
 *    The refusal never happens, and the refusal assertion goes red — while
 *    every test in `spend-cap.test.ts` stays green, because the cap would be
 *    correct and simply not connected to the MI path.
 *
 * ## Why the assertion is a spend REFUSAL and not an ingested item
 *
 * A refusal is the one MI outcome this suite can observe without a socket:
 * the queue checks the cap before it dispatches, so nothing reaches Nous or
 * Alpaca. Asserting on an ingested item would need a live vendor.
 *
 * The ORDERING half of AC1 — that `refresh` returns before the work runs — is
 * pinned in `mi-refresh-queue.test.ts`, where a refresher can be held open.
 * It cannot be observed here: the only MI outcome reachable offline settles
 * within the real analyst stage's own awaits, so a "has not happened yet"
 * assertion would be measuring the stub's speed, not the queue's behaviour.
 *
 * ## Smoke-gate exclusion, stated rather than skipped
 *
 * `docs/coding-standards.md` requires a `npm run smoke` assertion for a newly
 * wired mechanism. `npm run smoke` runs offline with no Nous credentials, so
 * `sentimentCredentials` is `undefined`, no MI agent is built, and
 * `marketIntelligenceRefresh` is `undefined` by design — there is no
 * enforcement for the gate to observe, and a construction check would pass for
 * a queue nothing calls, which is the defect itself. This file is the
 * substitute: it drives the real `buildProductionComponents` with credentials
 * present.
 */
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

/** A macrotask turn, so the enqueue-driven worker has run by the time this resolves */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

/** Spends the whole budget before the run starts, so the cap refuses from the first check */
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

/** The narrowest `ProductionConfig` that reaches a bound `steps.analysts`. Every transport is a stub. */
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
    // Enough for the sentiment agent to build — which is what puts an MI
    // writer, and therefore a queue, on the analyst path at all. No call is
    // ever made: the cap refuses before dispatch
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

    // Kills mutation 2: the refusal exists only because the queue holds the
    // ROOT's `spendCap` and reads it before dispatching. Swap in
    // `UNCAPPED_SPEND` and this goes red while `spend-cap.test.ts` stays green
    const refusal = entries.find((entry) => entry.trace_id === MI_REFRESH_TRACE_ID);
    expect(refusal?.level).toBe('warn');
    expect(refusal?.message).toContain('refresh for AAPL not started');
    expect(refusal?.stage).toBe('market_intelligence');

    // Kills mutation 1: this is the SAME instance `stop()` drains, so the
    // analyst stage cannot be driving some other refresher while the exposed
    // queue sits idle — which is what "wired" has to mean here
    expect(components.marketIntelligenceRefresh?.refreshAttempted('AAPL')).toBe(true);
    expect(components.marketIntelligenceRefresh?.refreshAttempted('TSLA')).toBe(false);
  });

  it('drains the queue from the orchestrator own stop, so a refresh cannot outlive the store', async () => {
    // The price of moving the refresh off the tick: the tick drain no longer
    // covers it, and its archive/store write can land after the store closes
    //
    // Through `buildProductionOrchestrator`, NOT the components — the drain is
    // a line inside that `stop()`, and a test calling `queue.stop()` itself
    // would pass with the line deleted (it did, until #1105's review). The
    // observable is the LATCH: the orchestrator's `stop()` is the only thing
    // between an idle queue and a stopped one, and a stopped queue drops a
    // refresh instead of dispatching it
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

    // Post-stop, so it can only be admitted by a queue the shutdown never
    // reached. Delete the drain line from `stop()` and this dispatches, logs
    // its refusal, and both assertions go red
    await queue?.refresh('tick-after-stop', 'AAPL', 'stocks');
    await settle();

    expect(queue?.depth).toBe(0);
    expect(entries.find((entry) => entry.trace_id === MI_REFRESH_TRACE_ID)).toBeUndefined();
  });

  // The other half of the shutdown contract — that `stop()` AWAITS the refresh
  // already dispatched rather than merely latching — is pinned in
  // `mi-refresh-queue.test.ts`, where a refresher can be held open. It cannot
  // be observed here: the only refresh reachable offline is one the cap
  // refuses, which completes instantly
});
