/**
 * Composition-root tests (#236) — the seam orchestrator-spec.md names:
 * "given fake/stub adapters for each closed-over dependency, assert the
 * returned `TickSteps` callables produce the same call shape the existing
 * `SequentialTickRunner` unit tests already fake". Plus the process-level
 * behaviour this ticket adds: startup order, heartbeat cadence, loop
 * lifecycle, and the cross-tick overlap guard.
 *
 * Deliberately not asserted here: any stage's decision logic (each stage's
 * own suite owns that) and a live broker round-trip (ADR-0004's "wiring
 * validated" bar is a manual E2E run, not a unit test).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICATOR_UNAVAILABLE_COUNTER } from '../../pipeline/analysts/index.js';
import { buildArmComparison } from '../../pipeline/control-arm/index.js';
import {
  AnthropicLlmClient,
  LATENCY_BUDGET_MS,
  llmCallsPerDebate,
  MAX_ROUNDS_BY_ASSET_CLASS,
  MockLlmClient,
  SqliteDebateLogStore,
  SqliteSpendCap,
  UNCAPPED_SPEND,
} from '../../pipeline/debate-engine/index.js';
import { SimulatedBrokerAdapter, SqliteExecutionStore } from '../../pipeline/execution/index.js';
import type { DailyMetricsSample, FeedbackConfig } from '../../pipeline/feedback-loop/index.js';
import {
  ARM_DIVERGENCE_RETURN_GAP_PCT,
  DEFAULT_ARM_COMPARISON_WINDOW_MS,
  nextBoundary,
  SqliteFeedbackCycleScheduleStore,
  SqliteTuningStore,
} from '../../pipeline/feedback-loop/index.js';
import type {
  BenchmarkObservation,
  BenchmarkSeriesSource,
} from '../../pipeline/outside-benchmark/index.js';
import { MarketDataBenchmarkSeriesSource } from '../../pipeline/outside-benchmark/index.js';
import type { VolatilityReading } from '../../pipeline/risk-manager/index.js';
import {
  RISK_CRITIC_SKIPPED_REASON,
  SqliteRiskCriticStore,
} from '../../pipeline/risk-manager/index.js';
import {
  ADR_0018_SUBCLASS_BRACKETS,
  DEFAULT_TRADER_CONFIG,
  NO_PRECEDENT_MULTIPLIER,
  SqliteSetupStore,
} from '../../pipeline/trader/index.js';
import type {
  ApprovalOutcome,
  ApprovalRequest,
  VerdictDecision,
} from '../../pipeline/verdict/index.js';
import type {
  AlpacaBar,
  AlpacaQuote,
  Bar,
  DataSource,
  LseMarkClient,
} from '../../providers/market-data-service/index.js';
import {
  AlpacaDataSource,
  AlwaysOpenCalendar,
  AssetClassRoutingDataSource,
  FAILOVER_CIRCUIT_COOLDOWN_MS,
  FAILOVER_CIRCUIT_FAILURE_THRESHOLD,
  FixtureDataSource,
  LSE_TABLE_COVERAGE_END,
  LseMarkDataSource,
  LseRegularHoursCalendar,
  londonEntryWindow,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  UsEquityRegularHoursCalendar,
} from '../../providers/market-data-service/index.js';
import {
  GROK_REFRESH_MS,
  MiArchiveStore,
  PolymarketClient,
  X_SEARCH_MODEL,
} from '../../providers/market-intelligence/index.js';
import type { ClosedTrade, OrderIntent, TradingArm } from '../../shared/index.js';
import { currentTraceId, SimulatedClock, TokenBucket, toBrokerFillId } from '../../shared/index.js';
import type { NousCredentials } from '../../shared/llm/index.js';
import { DEFAULT_NOUS_MODELS, UNGATED_LLM_IN_FLIGHT } from '../../shared/llm/index.js';
import { guardedStore, openSharedStore, type StoreHandle } from '../../shared/store/index.js';
import type { MetricsSuite } from '../../tools/backtest/index.js';
import { CostModelImpl, SqliteStage2SelectionStore } from '../../tools/backtest/index.js';
import { loggingAlertChannel } from './alert-catalogue.js';
import { LLM_SPEND_CAP_BREACH } from './breach-text.js';
import { UnwiredApprovalChannel } from './console-channels.js';
import { DebateBarDecisionGate } from './decision-bar-gate.js';
import { FILL_SYNC_TRACE_ID, RECONCILE_TRACE_ID } from './fill-sync.js';
import { LIVE_BOOK_GBP, LIVE_BOOK_SIZING_USD, paperStartingProfile } from './paper-profile.js';
import { type CapitalCeilingUsd, toCapitalCeilingUsd } from './production/capital-ceiling.js';
import {
  CONTROL_FILL_SYNC_TRACE_ID,
  CONTROL_RECONCILE_TRACE_ID,
} from './production/control-arm-wiring.js';
import { MIN_RETURN_OBSERVATIONS } from './production/daily-equity-metrics-source.js';
import type { DataFailoverAlert } from './production/data-failover.js';
import { buildPersistence } from './production/direct-bind.js';
import { MIN_TICKS_INSIDE_FLATTEN_WINDOW } from './production/flatten-tick-coupling.js';
import type { LseCalendarCoverageAlert } from './production/lse-calendar-coverage-alert.js';
import { LSE_COVERAGE_ALERT_HORIZON_DAYS } from './production/lse-calendar-coverage-guard.js';
import {
  MI_NO_DATA_BY_NAME_COUNTER,
  MI_NO_DATA_BY_SUBCLASS_COUNTER,
} from './production/mi-coverage.js';
import {
  BENCHMARK_INSTRUMENTS,
  buildAlpacaDataSource,
  buildBenchmarkDataSource,
  buildDefaultLlmClient,
  buildHeldAssetsReader,
  buildProductionComponents,
  buildProductionOrchestrator,
  buildProductionTickRunner,
  type DailyMetricsConfig,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  equityCalendarFor,
  type FeedbackCycleConfig,
  type ProductionConfig,
  resolveApprovalsChannel,
  SMOKE_TEST_UNIVERSE,
  startTickLoop,
  universeAssetClasses,
} from './production.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import { buildTrendingCloses } from './smoke-run.js';
import { CONTROL_BOOK_ANCHOR_KEY } from './sqlite-account-state-store.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import { SequentialTickRunner } from './tick-runner.js';
import type {
  Logger,
  Scheduler,
  TickOutcome,
  TickPlan,
  TickRunner,
  UniverseInstrument,
} from './types.js';

/**
 * #1226 — the only seam that lets a test reach `new XSearchClient(...)`
 * without setting `process.env`: `tryNousCredentials('sentiment')` (the ONE
 * call site in `production.ts`) reads `NOUS_BASE_URL`/`NOUS_*_API_KEY`
 * straight from the environment with no `ProductionConfig` field to carry a
 * fake credential in, so it is mocked here rather than routed through config.
 *
 * Defaults to the REAL implementation (`importOriginal`), so every other test
 * in this file that never touches `tryNousCredentialsMock` sees identical
 * behaviour to the unmocked function — same as today, undefined absent real
 * env vars. Only the #1226 describe block below overrides it, once per case,
 * via `mockImplementationOnce`.
 */
const { tryNousCredentialsMock } = vi.hoisted(() => ({ tryNousCredentialsMock: vi.fn() }));

vi.mock('../../shared/llm/nous-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/llm/nous-config.js')>();
  tryNousCredentialsMock.mockImplementation(actual.tryNousCredentials);
  return { ...actual, tryNousCredentials: tryNousCredentialsMock };
});

/**
 * #1226 — a spy standing in for the constructor itself, so the #1226 test
 * observes the exact options object `buildProductionComponents` hands
 * `XSearchClient`, `maxSearchResults` included, rather than inferring it from
 * the client's behaviour. `GrokAgent` only stores its `client` at
 * construction (never calls a method on it), so a bare mock never needs to
 * behave like a real `XSearchClient`.
 */
const { XSearchClientMock } = vi.hoisted(() => ({ XSearchClientMock: vi.fn() }));

vi.mock('../../providers/market-intelligence/grok/x-search-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../providers/market-intelligence/grok/x-search-client.js')
    >();
  return { ...actual, XSearchClient: XSearchClientMock };
});

/**
 * #1321 round 2 — a spy standing in for `startFillSync` itself, so a test can
 * assert on the exact `reconcileTraceId`/`fillSyncTraceId` pair
 * `production.ts` hands each arm's RECURRING poll, not just the one-shot
 * `runStartupReconcile` call the existing #1321 case below pins. Defaults to
 * the real implementation (`importOriginal`), same posture as
 * `tryNousCredentialsMock` above, so every other test in this file that never
 * inspects `startFillSyncSpy` sees identical behaviour to the unmocked
 * function.
 */
const { startFillSyncSpy } = vi.hoisted(() => ({ startFillSyncSpy: vi.fn() }));

vi.mock('./fill-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fill-sync.js')>();
  startFillSyncSpy.mockImplementation(actual.startFillSync);
  return { ...actual, startFillSync: startFillSyncSpy };
});

/**
 * #1106 — a spy standing in for the constructor itself, so a test can observe
 * the exact `spendCap` `buildProductionComponents` hands `MiIngestAgent`
 * rather than inferring it from behaviour. Delegates to the real class by
 * default (`importOriginal`), same posture as `tryNousCredentialsMock` and
 * `startFillSyncSpy` above: every other test in this file that never touches
 * this mock still gets a real, hydrating agent (or `undefined`, when
 * `buildMiIngestAgent`'s own guards say so) rather than a stub that silently
 * drops `.hydrate()`.
 */
const { MiIngestAgentMock } = vi.hoisted(() => ({ MiIngestAgentMock: vi.fn() }));

vi.mock('../../providers/market-intelligence/mi-ingest-agent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../providers/market-intelligence/mi-ingest-agent.js')>();
  // `new MiIngestAgentMock(...)` constructs its OWN implementation function
  // (tinyspy's `new`-call semantics, so `instanceof` on the mock still works),
  // and arrow functions cannot be constructors — a plain `function` here, not
  // the arrow used for `startFillSyncSpy`/`tryNousCredentialsMock` above,
  // which are both called plainly, never with `new`.
  // biome-ignore lint/complexity/useArrowFunction: must stay a `function` — an arrow here throws "is not a constructor" the moment production.ts calls `new MiIngestAgent(...)`.
  MiIngestAgentMock.mockImplementation(function (deps: unknown) {
    return new actual.MiIngestAgent(deps as ConstructorParameters<typeof actual.MiIngestAgent>[0]);
  });
  return { ...actual, MiIngestAgent: MiIngestAgentMock };
});

const START = new Date('2026-07-29T12:00:00.000Z');

/**
 * #528 — `startFillSync` self-arms a `setTimeout` on `fillPollIntervalMs`
 * (default 15s, `DEFAULT_FILL_POLL_INTERVAL_MS`) independent of
 * `tickIntervalMs`/`heartbeatIntervalMs`. None of the cases that pass this
 * exercise fill-sync at all, but a day-plus `vi.advanceTimersByTimeAsync`
 * still has to walk every 15s poll in the window regardless — confirmed by
 * isolating the four affected cases: parking this constant alone took each
 * from a 5000ms+ timeout under load to single-digit milliseconds quiet.
 * See docs/coding-standards.md "Fake-timer advances" for the general
 * pattern.
 *
 * Deliberately under 2^31-1 ms (~24.8 days, Node's `setTimeout` delay cap) —
 * a delay above that overflows a 32-bit signed int and is clamped to fire on
 * the NEXT tick instead of being deferred, which turns "parked" into a
 * near-0ms self-reschedule loop. 20 days clears every advance in this file
 * (longest is 75h) with headroom under the cap.
 *
 * That headroom is a coupling, not a constant: a future case advancing 20
 * days or more would step past this and silently re-activate fill-sync
 * mid-advance, reintroducing the slowdown with no signal beyond the case
 * getting mysteriously slower. If you add an advance anywhere near that,
 * raise this — but stay under 2^31-1 ms, which leaves under 5 days of room.
 * If an advance ever needs to exceed ~24 days, this approach is exhausted
 * and the poll has to be stopped rather than parked.
 */
const NO_FILL_POLL_MS = 20 * 24 * 60 * 60 * 1_000;

/**
 * Parks the Polymarket poll timer for the same reason, and it is not merely a
 * speed knob (#504).
 *
 * The composition root starts a `setInterval` firing `refresh` every
 * `DEFAULT_POLYMARKET_POLL_INTERVAL_MS`. Several cases here advance fake timers
 * by 47 HOURS in one step, which fires that interval ~190 times; each firing
 * walks all eight curated rows, and because `offlinePolymarketClient` throws on
 * the transport the agent deliberately leaves its hourly bucket UNMARKED so the
 * next pass retries. That is correct production behaviour (a vendor outage must
 * not suppress the retry) and ~1,500 pointless stub calls inside a 5s test
 * budget — three cases timed out on it. The startup `refresh` still runs on
 * every boot, so the wiring this file exists to assert is untouched; only the
 * repeat is parked.
 */
const NO_POLYMARKET_POLL_MS = 20 * 24 * 60 * 60 * 1_000;

function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
  const entries: Parameters<Logger['log']>[0][] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

/**
 * Every leaf `ProductionConfig` requires, stubbed. The transports are stubs
 * because the codebase ships no implementation of them (see production.ts's
 * doc comment) — not because a real one is being avoided here.
 */
/**
 * `ProductionConfig` with the seams this stub ALWAYS supplies marked
 * non-optional.
 *
 * They are optional on `ProductionConfig` because the composition root builds
 * a default when they are absent — but this fixture always passes them, and
 * assertions below read `config.alpacaBrokerClient.submitOrder` directly.
 * Narrowing once here beats six non-null assertions at the call sites.
 */
type StubConfig = ProductionConfig &
  Required<Pick<ProductionConfig, 'alpacaBrokerClient' | 'heartbeatChannel'>>;

/**
 * A Polymarket client that reaches no network, injected by `stubConfig` into
 * every boot in this file (#504).
 *
 * The composition root builds this agent UNCONDITIONALLY — its read APIs are
 * keyless, so unlike every other vendor here nothing else gates it — and
 * `start()` fires `void polymarketAgent.refresh('startup')` immediately. Before
 * this existed, a DNS-level probe over this file recorded live calls to
 * `gamma-api.polymarket.com` and `clob.polymarket.com` while all 92 tests
 * passed, because `refresh` never throws by contract and the failure was
 * swallowed into a `warn`. `vitest.setup.ts` is the backstop that made it
 * visible; this is the fix that makes the file honest rather than merely
 * refused.
 *
 * The pacing override is `startup.test.ts`'s, for its reason: the shipped
 * `capacity: 2, refillPerSecond: 0.2` is right for a real vendor and pure
 * wall-clock coupling for a stub that throws before it reaches a socket, and
 * this file boots the orchestrator 29 times.
 */
const offlinePolymarketClient = new PolymarketClient({
  rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  fetchImpl: (async () => {
    throw new Error('offline: the test suite must not reach Polymarket');
  }) as unknown as typeof fetch,
});

function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig> = {}): StubConfig {
  const submitOrder = vi.fn(async () => ({
    id: 'alpaca-order-1',
    client_order_id: 'k',
    status: 'accepted',
    legs: [],
  }));

  // Cast on the way out, not on the literal: `exactOptionalPropertyTypes`
  // makes `{ ...base, ...overrides }` unassignable to `StubConfig`, because
  // `Partial<ProductionConfig>` permits a caller to pass an explicit
  // `approvals: undefined` and erase a required field. No caller does, and
  // typing `overrides` loosely enough to say so would defeat the point of the
  // parameter. The fields below are still checked — the cast only covers the
  // spread.
  return {
    db,
    clock: new SimulatedClock(START),
    mode: 'paper',
    alpacaBrokerClient: {
      submitOrder,
      // #586: a crypto bracket goes to the venue as a PLAIN limit entry —
      // `submitOrder`'s native bracket is the verified 422 for crypto.
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
    } as unknown as NonNullable<ProductionConfig['alpacaBrokerClient']>,
    alpacaDataClient: {
      getBars: vi.fn(async (): Promise<AlpacaBar[]> => []),
      getLatestQuote: vi.fn(
        async (): Promise<AlpacaQuote> => ({ t: START.toISOString(), ap: 100, bp: 99 }),
      ),
    },
    polymarketClient: offlinePolymarketClient,
    polymarketPollIntervalMs: NO_POLYMARKET_POLL_MS,
    llmClient: { complete: vi.fn() } as unknown as ProductionConfig['llmClient'],
    heartbeatChannel: { postHeartbeat: vi.fn(async () => undefined) },
    approvals: {
      requestApproval: vi.fn(
        // `ApprovalOutcome` is the bare union `'approved' | 'rejected' |
        // 'timeout'`, not an object with a `status` — the `as unknown as`
        // below was masking a stub that returned a shape the port never had.
        async (_request: ApprovalRequest): Promise<ApprovalOutcome> => 'timeout',
      ),
    } as unknown as ProductionConfig['approvals'],
    orphanAlerts: { postOrphanAlert: vi.fn(async () => undefined) },
    ciiScoreProvider: { getCii: vi.fn(async () => null) },
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        // `as const`: `SessionBasis` discriminates on `known: true | false`,
        // and without it the literal widens to `boolean` and matches neither.
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        } as const,
        consecutive_losses: 0,
      })),
    },
    volatility: {
      // `VolatilityReading` is per-asset-class (`{ crypto, stocks }`); the
      // former `{ atr_percentile: 0.5 }` shape has not existed for some time
      // and only survived because the `as VolatilityReading` cast silenced it.
      //
      // That cast was not merely untidy — it made the volatility breaker
      // INERT for every test in this file. With neither `crypto` nor `stocks`
      // present, both readings were `undefined` and every comparison against
      // the trip threshold was false, so the composed-tick chain below has
      // never actually run that breaker. These values sit under
      // `baseline × multiplier` (0.05 × 3 crypto, 0.02 × 3 stocks) so the
      // breaker now genuinely evaluates and genuinely stays armed.
      getVolatilityReading: vi.fn(
        async (): Promise<VolatilityReading> => ({ crypto: 0.02, stocks: 0.01 }),
      ),
    },
    // Not `{}` either, and for the same reason as `verdictConfig` below:
    // `buildProductionComponents` now refuses a config whose
    // `flatten_before_close_ms` would silently disable flat-by-close (#691), so
    // an empty cast here is a lie the assertion is the first code to notice.
    // The real defaults rather than a hand-picked value — every one of these
    // tests wants "a sound trader config", not a particular window.
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: {} as ProductionConfig['riskConfig'],
    // Not `{}` like its neighbours: `buildProductionComponents` reads the
    // automation dial to refuse a HITL-engaging config (#434), so an empty cast
    // here is a lie the assertion is the first code to notice. `auto` is what
    // ADR-0007 mandates and what every other fixture in this file uses.
    //
    // `max_mark_age` is here for exactly the same reason since #1389: the boot
    // assertion bounding the post-close flatten grace reads Verdict's copy —
    // gate 2a is the ceiling the grace is spent against — so an omitted field
    // reaches it as `undefined` and throws before any of these tests run.
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
      max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
    } as ProductionConfig['verdictConfig'],
    executionConfig: {} as ProductionConfig['executionConfig'],
    correlationConfig: {} as ProductionConfig['correlationConfig'],
    // Not `{}` like its neighbours either, for the same reason as
    // `verdictConfig` above: since #634 `CircuitBreakers` validates its
    // hysteresis band at construction, so an empty cast here is a config that
    // cannot be built at all. These are `REAL_CONFIGS.breakerConfig`'s values
    // — which also makes the volatility-reading comment above true, since the
    // baselines it names (0.05 crypto, 0.02 stocks) now actually exist.
    breakerConfig: {
      daily_loss_pct: 0.05,
      daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
      max_drawdown_pct: 0.2,
      max_consecutive_losses: 5,
      volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
      auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
    } as ProductionConfig['breakerConfig'],
    costConfig: {} as ProductionConfig['costConfig'],
    ciiConsumerConfig: { pollIntervalMs: 600_000 },
    ...overrides,
  } as StubConfig;
}

/** A minimal but structurally complete `go` — enough for Execution to reach the broker. */
function goVerdict(): VerdictDecision {
  const order: OrderIntent = {
    idempotency_key: 'idem-exec',
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    side: 'buy',
    intent_type: 'entry',
    size: 0.01,
    entry: 100,
    stop: 90,
    target: 120,
    time_in_force: 'gtc',
    decision_timestamp: START,
    decided_at: START,
    metadata: {
      debate_id: 'debate-1',
      conviction: 0.8,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
    },
  };

  return {
    status: 'go',
    order,
    no_go_reason: null,
    no_go_detail: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: order.idempotency_key,
    timestamp: START,
  };
}

/**
 * The config a fixture needs when it parks its tick interval hours-wide to keep
 * fake timers quiet.
 *
 * Parking the tick used to mean widening one number (#670). Since #1389 the
 * flatten knobs are a coupled family and all three have to move together:
 *
 * - `flatten_before_close_ms` is bounded BELOW by
 *   `MIN_TICKS_INSIDE_FLATTEN_WINDOW * tickIntervalMs`,
 * - `flatten_after_close_ms` is bounded BELOW by one `tickIntervalMs`, and
 * - `flatten_after_close_ms` is bounded ABOVE by
 *   `verdictConfig.max_mark_age.stocks`, because gate 2a refuses a flatten
 *   priced off a mark older than that however mandatory the exit is.
 *
 * So a 48-hour tick against the stub's 1-hour mark-age ceiling has NO sound
 * config: widen the grace to fit the tick and the ceiling rejects it, leave it
 * and the tick coupling rejects it. The honest fixture raises the ceiling with
 * the tick rather than routing around either assertion.
 *
 * Real deployments never meet that squeeze — the shipped profile ticks every
 * two minutes with a five-minute grace under a fifteen-minute ceiling — but the
 * derived constraint is real and worth reading off this helper:
 * `tickIntervalMs <= verdictConfig.max_mark_age.stocks` is now enforced at
 * boot, transitively, for any config that flattens at all.
 */
function quietFlattenOverrides(tickIntervalMs: number): Partial<ProductionConfig> {
  return {
    traderConfig: {
      ...DEFAULT_TRADER_CONFIG,
      flatten_before_close_ms: MIN_TICKS_INSIDE_FLATTEN_WINDOW * tickIntervalMs,
      flatten_after_close_ms: tickIntervalMs,
    },
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
      max_mark_age: { crypto: tickIntervalMs, stocks: tickIntervalMs },
    } as ProductionConfig['verdictConfig'],
  };
}

/**
 * Real per-stage config values (same shapes direct-bind.test.ts pins).
 *
 * This is cast to its stage types at the use site, so a field going missing
 * here does not fail the typecheck — it fails as behaviour, or it does not fail
 * at all. `flatten_before_close_ms` was absent until #691's guard made it
 * throw: without the guard these three integration tests ran the composed
 * chain with flat-by-close silently inert, which is the same hole the guard
 * exists to close, one layer up in the test fixture.
 */
const REAL_CONFIGS = {
  traderConfig: {
    conviction_floor: 0.5,
    flatten_before_close_ms: 5 * 60 * 1_000,
    // #1389's other half of the same window, and absent here for the same
    // reason `flatten_before_close_ms` was until #691: this object is cast at
    // the use site, so only the boot guard notices it missing.
    flatten_after_close_ms: 5 * 60 * 1_000,
    max_risk_per_trade: 0.01,
    asset_class_risk_multiplier: { crypto: 0.5, stocks: 1 },
    atr_timeframe: '1h',
    atr_lookback: 14,
    atr_k: 2,
    vol_floor_fraction: 0.002,
    non_converged_haircut: 0.5,
    reward_risk_multiple: 2,
    min_viable_notional: 10,
    time_in_force: 'gtc',
    subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
    // #739. Present and EMPTY, not absent: this fixture is cast to its stage
    // type, so an omitted field is not a typecheck failure — it is a `decide`
    // that throws mid-chain, which is exactly what happened when this field was
    // first added. Empty means the per-subclass regime is unarmed, which is the
    // state of the universe these integration cases drive.
    subclass_of: {},
  },
  riskConfig: {
    max_position_size_fraction_of_equity: 1,
    per_asset_cap_fraction_of_equity: 1,
    per_asset_class_cap_fraction_of_equity: { crypto: 1, stocks: 1 },
    portfolio_gross_cap_fraction_of_equity: 2,
    concentration: { cap_fraction_of_equity: 1, threshold: 0.9 },
    min_viable_size: 0.0001,
    cii_threshold: 80,
    // An hour, matching `max_signal_age` below: this integration test drives
    // the composed chain against fixture marks, and a freshness bound sized
    // for production would make it a clock test. #640's behaviour is covered
    // in `portfolio-view.test.ts`.
    max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
  },
  verdictConfig: {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 3_600_000, stocks: 3_600_000 },
    max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
    drift_tolerance_pct: { crypto: 0.5, stocks: 0.5 },
    human_timeout: 60_000,
    allow_extended_hours: true,
    flag_thresholds: { size_over: 1_000_000 },
  },
  executionConfig: {
    simulated: {
      volatility_indicator: {
        indicator: 'atr',
        params: { period: 14 },
        // Required since #315. Omitting it made `getIndicator` build a window
        // with `timeframe: undefined`, which matches no stored bar, so the
        // volatility read failed and the breaker halted the whole chain.
        timeframe: '1h',
        lookback: 15,
      },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  },
  correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
  breakerConfig: {
    daily_loss_pct: 0.05,
    daily_loss_pct_by_class: { crypto: 0.05, stocks: 0.05 },
    max_drawdown_pct: 0.2,
    max_consecutive_losses: 5,
    volatility: { baseline: { crypto: 0.05, stocks: 0.02 }, multiplier: 3 },
    auto_rearm: { recovery_drawdown_pct: 0.05, max_days_tripped: 5 },
  },
  costConfig: {
    crypto: {
      spreadVolatilityCoefficient: 0.1,
      commissionRate: 0.0026,
      slippageCoefficient: 0.05,
      impactK: 0.5,
    },
    stocks: {
      spreadVolatilityCoefficient: 0.05,
      commissionRate: 0.0005,
      slippageCoefficient: 0.02,
      impactK: 0.3,
    },
  },
} as unknown as Pick<
  ProductionConfig,
  | 'traderConfig'
  | 'riskConfig'
  | 'verdictConfig'
  | 'executionConfig'
  | 'correlationConfig'
  | 'breakerConfig'
  | 'costConfig'
>;

/**
 * An hourly bar series long enough for the ATR/ADV lookbacks the chain reads.
 *
 * Rises **with pullbacks** (`buildTrendingCloses`), not monotonically. A
 * monotonic ramp has no down bars, so its RSI is exactly 100 and the technical
 * analyst reads `neutral` — "overbought" — on the strongest possible uptrend.
 * That left the mediator as the chain's only directional participant, so the
 * `go` these tests assert came through the mediator-override branch #625 exists
 * to close rather than through a desk that agreed on a direction.
 */
function fixtureBars(instrument: string, timeframe: string, count: number, stepMs: number): Bar[] {
  const closes = buildTrendingCloses(count, 99 + count);

  return Array.from({ length: count }, (_, index) => {
    const close_time = new Date(START.getTime() - (count - index) * stepMs);
    // Indexed directly, no `?? 100` fallback: `buildTrendingCloses` returns
    // exactly `count` entries, and silently substituting a flat price would
    // corrupt the RSI/SMA these fixtures exist to produce.
    const price = closes[index];
    if (price === undefined) throw new Error(`fixtureBars: no close at index ${index}`);
    return {
      instrument,
      timeframe,
      open_time: new Date(close_time.getTime() - stepMs),
      close_time,
      open: price,
      high: price + 2,
      low: price - 2,
      close: price,
      volume: 1_000,
      source: 'fixture',
    };
  });
}

describe('SMOKE_TEST_UNIVERSE', () => {
  it('is a narrow, crypto-only universe (ADR-0004 §4)', () => {
    expect(SMOKE_TEST_UNIVERSE).toHaveLength(1);
    expect(SMOKE_TEST_UNIVERSE[0]).toEqual({ asset: 'BTC-USD', asset_class: 'crypto' });
  });
});

/**
 * #1167 — orchestrator-spec.md names the hazard: the routing pool and the
 * scheduler each ran `config.universe ?? SMOKE_TEST_UNIVERSE` independently
 * (a third copy lived in index.ts's startup log line), and only stayed
 * consistent because nothing yet makes the two calls see different config —
 * a config that answers differently on a later read (dynamic resolution via
 * #751, or, cheaper, a stateful accessor) is exactly what would expose it.
 *
 * A value/identity assertion on today's wiring cannot, by itself, tell a
 * shared resolution apart from two separate calls that happen to read the
 * same immutable config — both return the identical reference. So the
 * wiring is checked separately below, and this source scan is what actually
 * satisfies "a second resolution site cannot be added without a test
 * failing": it fails on the count, not on any value a duplicated call would
 * produce. It counts the fallback expression itself rather than calls to a
 * named helper — a review of an earlier version of this fix found that a
 * helper function sitting in this file is exactly as easy to call twice as
 * the expression is to write twice, so the fallback is inlined into
 * `buildProductionComponents` rather than wrapped.
 *
 * Residual gaps, stated rather than discovered:
 * - Text scan, not data-flow analysis: it cannot see through a *newly
 *   written* helper that wraps the expression and is called from two
 *   places, nor `||`, `??=`, a destructuring default, a ternary, or an
 *   aliased `SMOKE_TEST_UNIVERSE` import used as an equivalent fallback.
 * - The comment/string stripper below cannot tell a regex literal from
 *   division, so a regex literal containing a quote desyncs it for the
 *   rest of that file. The two known instances are scanned raw instead
 *   (see `KNOWN_STRIPPER_DESYNCS`); a THIRD, new one is caught only when
 *   it also unbalances braces — measured, NOT the common case: a regex
 *   with an odd apostrophe count desyncs to EOF, and an appended
 *   statement after it is brace-balanced by construction, so the usual
 *   shape of this defect (add the regex, add a call site below it) will
 *   not trip the balance check. Code review is the backstop for that
 *   shape; no mechanism closes it here.
 * Closing either categorically needs real static analysis of this file,
 * which is out of proportion to a currently-latent hazard; code review is
 * the remaining backstop, the same as it is for any other refactor that
 * keeps a test green while reintroducing the bug the test exists to catch.
 */
describe('universe resolution is a single site (#1167)', () => {
  // `server/`, not just this directory: `SMOKE_TEST_UNIVERSE` is re-exported
  // from index.ts, so a consumer outside orchestrator/ could write its own
  // `?? SMOKE_TEST_UNIVERSE` fallback and a scan scoped to orchestrator/
  // would never see it.
  const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function serverSourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.name === 'node_modules') continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        found.push(...serverSourceFiles(path));
        continue;
      }
      if (child.name.endsWith('.ts') && !child.name.endsWith('.test.ts')) found.push(path);
    }
    return found;
  }

  /**
   * Files whose regex literals contain a `'`/`"`/backtick character, which
   * `stripCommentsAndStrings` below (no real lexer to tell a regex literal
   * from division) misreads as a string opener — corrupting everything
   * after it in that file, silently, which is far worse than the false
   * positive the stripper exists to fix. Found by running the brace-balance
   * check below over every file in `server/` on a known-clean tree; scanned
   * as RAW text instead — no false negative on these two, at the cost of
   * false-positive exposure to a comment or string quoting the fallback
   * pattern in either of them. If the brace-balance check below ever flags
   * a THIRD file, investigate before adding it here — that check is a
   * lower bound, not a general detector: measured, it does NOT catch the
   * likely shape of a new instance (a regex whose odd apostrophe count
   * desyncs to EOF, followed by an ordinary, brace-neutral statement), so
   * this list is not proven exhaustive, only the two instances found here.
   */
  const KNOWN_STRIPPER_DESYNCS = new Set([
    'shared/store/write-guard.ts',
    'tools/check-path-citations.ts',
  ]);

  /**
   * `typescript` is on v7's native-compiler API, which no longer exports a
   * scanner/tokenizer (`Object.keys(require('typescript'))` is just
   * `['version', 'versionMajorMinor']`) — there is no real parser available
   * to lean on here. This is a small hand-rolled one instead of a single
   * regex, specifically so `//` and `/*` inside a string (a URL is the
   * realistic case) don't get misread as a comment start and swallow real
   * code after them — that direction of error would hide a genuine
   * duplicate, which is worse than the false positive it would be fixing.
   * Comment stripping only; it does not track template-literal `${}`
   * interpolation, so an occurrence written inside one would not be
   * counted — not a realistic shape for this specific fallback expression.
   *
   * Does NOT distinguish a regex literal from division — an unavoidable gap
   * without real parsing (regex-vs-division is themselves context-
   * sensitive), so a regex literal containing a quote character reads as a
   * string opener and desyncs everything after it. `KNOWN_STRIPPER_DESYNCS`
   * above routes the two files this is known to affect around the stripper
   * entirely; the brace-balance check below only catches a new instance
   * when it also unbalances braces, which the likely shape of this defect
   * (see `KNOWN_STRIPPER_DESYNCS`'s doc comment) typically will not do.
   */
  function stripCommentsAndStrings(source: string): string {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
      const c = source[i];
      const c2 = source[i + 1];
      if (c === '/' && c2 === '/') {
        i += 2;
        while (i < n && source[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && c2 === '*') {
        i += 2;
        while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        out += ' ';
        i++;
        while (i < n && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  // Self-check on the stripper above, not on production code — if this goes
  // red, the guard test below is no longer trustworthy either way.
  it.each([
    ['real code', 'const universe = config.universe ?? SMOKE_TEST_UNIVERSE;', 1],
    ['a // line comment quoting it', '// config.universe ?? SMOKE_TEST_UNIVERSE\nconst x = 1;', 0],
    [
      'a /** */ doc comment quoting it',
      '/**\n * config.universe ?? SMOKE_TEST_UNIVERSE\n */\nconst x = 1;',
      0,
    ],
    ['a string literal quoting it', "const x = 'literally ?? SMOKE_TEST_UNIVERSE';", 0],
    [
      "a // inside an unrelated string doesn't swallow real code after it",
      "const u = 'https://x'; const universe = config.universe ?? SMOKE_TEST_UNIVERSE;",
      1,
    ],
    [
      'two real occurrences',
      'const a = c.u ?? SMOKE_TEST_UNIVERSE;\nconst b = c.u ?? SMOKE_TEST_UNIVERSE;',
      2,
    ],
  ])('stripCommentsAndStrings: %s', (_name, input, expected) => {
    const occurrences = (stripCommentsAndStrings(input).match(/\?\?\s*SMOKE_TEST_UNIVERSE/g) ?? [])
      .length;
    expect(occurrences).toBe(expected);
  });

  // A KNOWN_STRIPPER_DESYNCS entry that stops matching any file the walk
  // actually finds — a rename or move landing in the same commit as its
  // import updates, say — would silently rejoin the stripped set instead
  // of failing to compile, and per the balance check's own doc comment
  // that set's net does not reliably catch a new desync. So the set's
  // membership is asserted directly, not left to be caught downstream.
  it('every KNOWN_STRIPPER_DESYNCS entry resolves to a server source file the walk finds', () => {
    const found = new Set(serverSourceFiles(SERVER_DIR).map((path) => relative(SERVER_DIR, path)));
    const stale = [...KNOWN_STRIPPER_DESYNCS].filter((entry) => !found.has(entry));
    expect(stale).toEqual([]);
  });

  // `{`/`}` must balance in valid, comment/string-stripped TypeScript; a
  // nonzero delta is a lower bound on stripper desync, not a proof of its
  // absence — see `stripCommentsAndStrings`'s doc comment for why the
  // likely shape of a new desync typically will not unbalance braces.
  function braceDelta(code: string): number {
    return (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
  }

  it('stripCommentsAndStrings leaves braces balanced on every server source file it strips', () => {
    const desynced = serverSourceFiles(SERVER_DIR)
      .filter((path) => !KNOWN_STRIPPER_DESYNCS.has(relative(SERVER_DIR, path)))
      .map((path) => ({ path, code: readFileSync(path, 'utf8') }))
      .filter(({ code }) => braceDelta(stripCommentsAndStrings(code)) !== 0)
      .map(({ path }) => relative(SERVER_DIR, path));

    expect(desynced).toEqual([]);
  });

  it('the SMOKE_TEST_UNIVERSE fallback appears exactly once, in production.ts, across all server sources', () => {
    // KNOWN_STRIPPER_DESYNCS files are scanned raw (no false negative, at
    // the cost of false-positive exposure to a comment/string quoting the
    // pattern); every other file goes through the stripper.
    const scanned = serverSourceFiles(SERVER_DIR).map((path) => {
      const raw = readFileSync(path, 'utf8');
      const code = KNOWN_STRIPPER_DESYNCS.has(relative(SERVER_DIR, path))
        ? raw
        : stripCommentsAndStrings(raw);
      return { path, code };
    });

    const matches = scanned.filter(({ code }) => /\?\?\s*SMOKE_TEST_UNIVERSE/.test(code));

    // A duplicate landing in a second file names that file in the failure;
    // a duplicate landing inside production.ts alongside the real one does
    // not (this assertion still passes with two occurrences in one file) —
    // the occurrence count below is what catches that case, on its own.
    expect(matches.map(({ path }) => basename(path))).toEqual(['production.ts']);

    const occurrences = matches.reduce(
      (count, { code }) => count + (code.match(/\?\?\s*SMOKE_TEST_UNIVERSE/g)?.length ?? 0),
      0,
    );
    expect(occurrences).toBe(1);
  });
});

describe('universe resolution is shared, not re-derived (#1167)', () => {
  let db: StoreHandle;

  const EXPLICIT_UNIVERSE: readonly UniverseInstrument[] = [
    { asset: 'ISF', asset_class: 'stocks' },
  ];

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('buildProductionComponents resolves the configured universe once and exposes THAT instance', () => {
    const overridden = buildProductionComponents(stubConfig(db, { universe: EXPLICIT_UNIVERSE }));
    expect(overridden.universe).toBe(EXPLICIT_UNIVERSE);

    const defaulted = buildProductionComponents(stubConfig(db));
    expect(defaulted.universe).toBe(SMOKE_TEST_UNIVERSE);
  });

  it("buildProductionOrchestrator's scheduler runs on, and exposes, the SAME resolution — not a second one", () => {
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, { universe: EXPLICIT_UNIVERSE, tradingCalendar: new AlwaysOpenCalendar() }),
    );

    expect(orchestrator.universe).toBe(EXPLICIT_UNIVERSE);
    expect(orchestrator.scheduler.nextTick(new SimulatedClock(START)).instruments).toEqual(
      EXPLICIT_UNIVERSE,
    );
  });
});

describe('equityCalendarFor', () => {
  /**
   * #668 landed `LseRegularHoursCalendar` with NO production caller — this
   * repo's dominant defect shape, and the worst possible instance of it: every
   * flatten on the live leg would have resolved through the US 16:00 ET
   * boundary, which is 20:00/21:00 London, hours after the 16:30 LSE close.
   * The overnight carry #668 exists to prevent, arriving through the
   * composition root rather than through the rule.
   */
  it('gives the live equity leg the LSE calendar (ADR-0015: Saxo GIA, LSE ETPs)', () => {
    const calendar = equityCalendarFor({ mode: 'live' } as unknown as ProductionConfig);

    // 2026-07-15 is a Wednesday. 16:25 London (BST) = 15:25 UTC — inside the
    // LSE session, and already an hour past it under the US calendar's clock.
    expect(calendar.isOpen(new Date('2026-07-15T15:25:00Z'))).toBe(true);
    // 17:00 London = 16:00 UTC, after the 16:30 LSE close but well inside the
    // US session. This is the assertion that fails if the US calendar is used.
    expect(calendar.isOpen(new Date('2026-07-15T16:00:00Z'))).toBe(false);
    expect(calendar.sessionEnd(new Date('2026-07-15T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T15:30:00.000Z',
    );
  });

  it('leaves paper on the US calendar, which is the venue paper actually trades', () => {
    const calendar = equityCalendarFor({ mode: 'paper' } as unknown as ProductionConfig);

    expect(calendar.sessionEnd(new Date('2026-07-15T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-15T20:00:00.000Z',
    );
  });

  it('honours an explicit override in either mode', () => {
    const injected = new AlwaysOpenCalendar();

    expect(
      equityCalendarFor({ mode: 'live', tradingCalendar: injected } as unknown as ProductionConfig),
    ).toBe(injected);
  });
});

describe('resolveApprovalsChannel (#1152)', () => {
  it('falls back to UnwiredApprovalChannel when no approvals is injected', () => {
    expect(resolveApprovalsChannel({})).toBeInstanceOf(UnwiredApprovalChannel);
  });

  it('returns the injected channel unchanged when one is supplied', () => {
    const injected = { requestApproval: async () => 'approved' as const };

    expect(resolveApprovalsChannel({ approvals: injected })).toBe(injected);
  });
});

describe('buildProductionComponents', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * #691 — the boot refuses a config that would silently disable flat-by-close.
   *
   * The Trader carries the same check, and on review that runtime one was the
   * whole objection: `flatten_before_close_ms: 0` DEPLOYS CLEANLY and first
   * surfaces on a tick that already reached the Trader. On a soak that is hours
   * of a process that looks healthy while holding overnight against ADR-0014.
   * Asserted here, at the composition root, for the same reason
   * `assertAutomationLevelSupported` is — refuse a bad config while nothing is
   * half-constructed.
   */
  it('refuses to build with a non-positive flatten window (#691)', () => {
    const config = stubConfig(db);

    expect(() =>
      buildProductionComponents({
        ...config,
        traderConfig: { ...config.traderConfig, flatten_before_close_ms: 0 },
      }),
    ).toThrow(/flatten_before_close_ms must be > 0/);
  });

  it('binds all six TickSteps as callables', () => {
    const { steps } = buildProductionComponents(stubConfig(db));

    for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution'] as const) {
      expect(typeof steps[stage]).toBe('function');
    }
  });

  /**
   * #1080's wiring proof, and the defect class it belongs to: a relay with a
   * writer and no reader. `buildAnalystsStep` can classify every skip it
   * returns, and if the root forgets either `skipKinds` (the writer) or
   * `analystSkipKind` (the reader) the audit row keeps saying `quorum_skip`
   * with every unit test still green — the shape of #388's unconstructed rate
   * limiter and #433's unread tuning dial.
   *
   * Driven through the SHIPPED step rather than a hand-built adapter: the
   * question is what the composition root wired, not what the adapter can do.
   *
   * This is the wiring evidence in place of a smoke-gate assertion, and the
   * exclusion is structural rather than a shortcut: `yarn smoke` gates on the
   * pipeline TRANSACTING end to end, so its fixtures produce views on every
   * tick and no quorum skip occurs in a passing smoke run at all. A gate
   * assertion would have to make the smoke run fail to have anything to read.
   */
  it('reports the cause of a quorum skip back through the steps it exposes (#1080)', async () => {
    const { steps } = buildProductionComponents(stubConfig(db));

    const views = await steps.analysts({
      trace_id: 'trace-skip',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock: new SimulatedClock(START),
      bar: START,
    });

    // The fixture source has no bars for this name, so the mandatory technical
    // analyst fails on a data gap — a fault, not a deadline.
    expect(views).toEqual([]);
    expect(steps.analystSkipKind?.('trace-skip')).toBe('fault');
  });

  it('binds the execution step onto the injected Alpaca client', async () => {
    const config = stubConfig(db);
    const { steps } = buildProductionComponents(config);

    await steps.execution(goVerdict());

    // #586: the verdict's instrument is crypto (BTC-USD), so the adapter's
    // emulated path submits a PLAIN limit entry — `submitOrder`'s native
    // bracket order class is the verified 422 for crypto (#550) and must
    // never be reached.
    expect(config.alpacaBrokerClient.submitLimitOrder).toHaveBeenCalled();
    expect(config.alpacaBrokerClient.submitOrder).not.toHaveBeenCalled();
  });

  it('exposes the same broker instance the execution step submits through', async () => {
    // The invariant that matters: `AlpacaBrokerAdapter` keeps its bracket-leg
    // map in memory, so the adapter reachable via `components.broker` must be
    // the one the bound step uses — not a second instance over the same
    // account, which would lose those lookups.
    const config = stubConfig(db);
    const components = buildProductionComponents(config);
    const submitSpy = vi.spyOn(components.broker, 'submitBracket');

    await components.steps.execution(goVerdict());

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it(
    "wires the run's own Logger into the execution surface's ExecutionInput.logger " +
      '(#573) — not a fresh default, and not silently dropped',
    () => {
      // #573's whole point: a store/broker/alert failure `ingestFills()`/
      // `reconcile()` catches gets a local trace ONLY if the `Logger` they
      // were handed is the real one, not a default a dropped composition-root
      // wire would fall back to (or worse, no logger reachable at all). A
      // unit test on `ingestFills()` alone cannot catch that regression —
      // it constructs `ExecutionInput` by hand, so it can't tell whether
      // `buildProductionComponents` actually threads the real instance
      // through. This is the seam that can: `components.executionDeps` is the
      // SAME object `buildExecutionStep`/`buildExecutionSurface`
      // (production/direct-bind.ts) copy `logger: deps.logger` from,
      // unchanged, into every `ExecutionInput` they construct — the same
      // "assert the composition root, not just the unit" reasoning the
      // broker-identity test just above takes for `components.broker`.
      const logger = recordingLogger();
      const config = stubConfig(db, { logger });

      const components = buildProductionComponents(config);

      expect(components.executionDeps.logger).toBe(logger);
    },
  );

  it(
    "wires the run's own Logger into AlpacaBrokerAdapterInput.logger (#609) — a real " +
      'fill-sweep failure through the composition-root-built broker gets a local trace ' +
      'through the SAME logger, not a dropped seam',
    async () => {
      // #609's whole point, mirrored off the #573 test just above: a unit
      // test on `AlpacaBrokerAdapter` alone constructs its input by hand, so
      // it cannot tell whether `buildProductionComponents` actually threads
      // the real `Logger` through to it rather than the field silently going
      // unwired. This asserts the composition root, not just the adapter.
      const logger = recordingLogger();
      const config = stubConfig(db, { logger });
      const components = buildProductionComponents(config);

      // A stocks order, unlike `goVerdict()`'s crypto one, submits through
      // the NATIVE bracket path (`submitOrder`) rather than the emulated one
      // — the loop `fetchNewFills`'s #609 fix logs from directly. Built from
      // scratch rather than spreading `goVerdict().order` (`OrderIntent |
      // null` on `VerdictDecision` — a spread of a nullable type loses the
      // required-ness TS would otherwise check).
      const baseGo = goVerdict();
      const stocksOrder: OrderIntent = {
        ...(baseGo.order as OrderIntent),
        instrument: 'AAPL',
        asset_class: 'stocks',
        idempotency_key: 'idem-exec-stocks',
      };
      const stocksVerdict: VerdictDecision = {
        ...baseGo,
        order: stocksOrder,
        idempotency_key: 'idem-exec-stocks',
      };
      await components.steps.execution(stocksVerdict);

      // A genuine per-source failure on the just-submitted bracket — an
      // unparseable `filled_qty`, not the modelled/expected
      // `UnpricedFillError` — read through the SAME `alpacaBrokerClient` the
      // composition root gave the broker. Cast the same way `stubConfig`
      // casts its own `alpacaBrokerClient` fixture (line ~165): this double
      // only needs the fields `fetchNewFills`'s bracket loop actually reads.
      config.alpacaBrokerClient.getOrder = vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'idem-exec-stocks',
        status: 'filled',
        filled_qty: 'N/A',
        filled_avg_price: '100.02',
        filled_at: START.toISOString(),
        legs: [],
      })) as unknown as typeof config.alpacaBrokerClient.getOrder;

      // Single bracket, all-failed sweep: `fetchNewFills` throws (the
      // pre-existing, unchanged behaviour) — the assertion below is about
      // the log line #609 now emits BEFORE that throw, not about the throw
      // itself.
      await components.broker.fetchNewFills(new Date(0)).catch(() => undefined);

      expect(
        logger.entries.some(
          (entry) => entry.message === 'Alpaca fetchNewFills: per-source failure',
        ),
      ).toBe(true);
    },
  );

  it('buildProductionTickRunner returns a SequentialTickRunner', () => {
    expect(buildProductionTickRunner(stubConfig(db))).toBeInstanceOf(SequentialTickRunner);
  });

  it(
    'refuses to build with mode "live" and no declared capital ceiling (#569) — ' +
      '`capitalCeilingUsd` is optional and absent from `REQUIRED_INJECTED_CONFIG`, so a ' +
      'programmatic caller reaching this function directly (bypassing `liveStartingProfile`, ' +
      'which always sets it) could otherwise size a live run off unclamped equity',
    () => {
      const config = stubConfig(db, { mode: 'live' });

      expect(() => buildProductionComponents(config)).toThrow(/capitalCeilingUsd/);
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1_000],
  ])(
    'refuses to build with a %s capital ceiling smuggled past the brand (#569 review) — the ' +
      'brand is compile-time only, and a JS or cast caller assembling ProductionConfig by hand ' +
      'can still pass a failed parse; `Math.min` would read NaN as "no bound"',
    (_label, ceiling: number) => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: ceiling as CapitalCeilingUsd,
      });

      expect(() => buildProductionComponents(config)).toThrow(/capitalCeilingUsd/);
    },
  );

  /**
   * #1180: `sizing_capital_ceiling_resolved` is the run's ONLY record of which
   * rate produced the ceiling every position is sized against, and it is what
   * makes a constant defensible where an env var was refused — a soak's log is
   * where the pairing is checked. Nothing asserted it: the whole emitting block
   * could be deleted and every other gate stayed green.
   *
   * Both cases are here because either alone is satisfiable by a literal.
   * `derived_by_conversion: config.capitalCeilingUsdPerGbp !== undefined` reads
   * `true` under a hard-coded `true` if only the paper branch is pinned, and a
   * live ceiling stamped with a rate it was never converted at is precisely the
   * misattribution the field exists to prevent.
   *
   * The expectations come off `config` — the object actually handed to the
   * composition root — not off a second `paperStartingProfile('paper')` call,
   * for the reason the #1112 AC3 test below spells out: re-deriving both sides
   * from one source makes the assertion hold for any ceiling the running config
   * happens to carry.
   */
  it('logs the resolved sizing ceiling with the rate that produced it (#1180)', () => {
    const logger = recordingLogger();
    const profile = paperStartingProfile('paper');
    // Spread conditionally under `exactOptionalPropertyTypes`: a profile that
    // stopped declaring either field leaves it ABSENT here rather than
    // explicitly `undefined`, and the assertions then fail on the real shape.
    const config = stubConfig(db, {
      logger,
      ...(profile.capitalCeilingUsd === undefined
        ? {}
        : { capitalCeilingUsd: profile.capitalCeilingUsd }),
      ...(profile.capitalCeilingUsdPerGbp === undefined
        ? {}
        : { capitalCeilingUsdPerGbp: profile.capitalCeilingUsdPerGbp }),
    });

    buildProductionComponents(config);

    const entry = logger.entries.find((line) => line.event === 'sizing_capital_ceiling_resolved');
    expect(entry).toBeDefined();
    expect(entry?.message).toContain('USD/GBP');
    expect(entry?.payload).toEqual({
      capital_ceiling_usd: config.capitalCeilingUsd,
      derived_by_conversion: true,
      usd_per_gbp: config.capitalCeilingUsdPerGbp,
      usd_per_gbp_provenance: expect.stringContaining('SIZING_USD_PER_GBP'),
    });
  });

  it('logs a ceiling declared in the account currency as derived by nothing (#1180)', () => {
    const logger = recordingLogger();
    const config = stubConfig(db, {
      logger,
      capitalCeilingUsd: toCapitalCeilingUsd(2_000, 'test'),
    });

    buildProductionComponents(config);

    const entry = logger.entries.find((line) => line.event === 'sizing_capital_ceiling_resolved');
    expect(entry).toBeDefined();
    expect(entry?.message).toContain('no FX conversion applied');
    // `toEqual`, not `toMatchObject`: the absence of a rate is the assertion.
    // A rate reported against a ceiling nobody converted would attribute a
    // number to arithmetic that never ran.
    expect(entry?.payload).toEqual({
      capital_ceiling_usd: 2_000,
      derived_by_conversion: false,
    });
  });

  describe('xMaxSearchResults (#1161)', () => {
    const savedEnv = process.env.SAMURAI_X_MAX_RESULTS;

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.SAMURAI_X_MAX_RESULTS;
      else process.env.SAMURAI_X_MAX_RESULTS = savedEnv;
    });

    it(
      'refuses a non-positive-integer config value, naming ProductionConfig.xMaxSearchResults ' +
        'rather than the env var — WITHOUT SAMURAI_X_MAX_RESULTS ever being set, so a ' +
        "programmatic caller is refused on the same bound an operator's env var is held to, " +
        "rather than reaching `XSearchClient`'s ceiling clamp, which forgives an excessive " +
        'value but was never built to catch a nonsensical one',
      () => {
        delete process.env.SAMURAI_X_MAX_RESULTS;
        const config = stubConfig(db, { xMaxSearchResults: 0 });

        expect(() => buildProductionComponents(config)).toThrow(
          /ProductionConfig\.xMaxSearchResults/,
        );
      },
    );

    it('accepts a positive-integer config value with no env var set at all', () => {
      delete process.env.SAMURAI_X_MAX_RESULTS;
      const config = stubConfig(db, { xMaxSearchResults: 7 });

      expect(() => buildProductionComponents(config)).not.toThrow();
    });

    it(
      'the config value wins over a malformed SAMURAI_X_MAX_RESULTS — proof the composition ' +
        'root reads `config.xMaxSearchResults` rather than always parsing the environment',
      () => {
        process.env.SAMURAI_X_MAX_RESULTS = 'ten';
        const config = stubConfig(db, { xMaxSearchResults: 7 });

        expect(() => buildProductionComponents(config)).not.toThrow();
      },
    );
  });

  /**
   * #1226 — #1161 (above) mutation-proved that `config.xMaxSearchResults`
   * WINS the read, but never observed the value actually reaching
   * `XSearchClient`: every case above runs with `sentimentCredentials`
   * undefined (no Nous env vars), so `sentimentCredentials === undefined ?
   * undefined : new XSearchClient(...)` never takes its `new XSearchClient`
   * branch at all — confirmed by hand: those cases log `mi_agent_absent`,
   * not silence. This block is the one case in the file that gets
   * `tryNousCredentials('sentiment')` to return something, via
   * `tryNousCredentialsMock` (module-mocked above), so the constructor call
   * actually happens and `XSearchClientMock` has something to observe.
   */
  describe('XSearchClient delivery of xMaxSearchResults (#1226)', () => {
    const FAKE_SENTIMENT_CREDENTIALS: NousCredentials = {
      apiKey: 'fake-sentiment-key',
      baseUrl: 'https://nous.test/v1',
      model: 'x-ai/grok-4.5',
    };

    afterEach(() => {
      XSearchClientMock.mockClear();
      tryNousCredentialsMock.mockClear();
    });

    it(
      'passes the resolved xMaxSearchResults cap through to `new XSearchClient(...)` — ' +
        'without ever setting `process.env`, and with `sentimentCredentials` genuinely ' +
        'defined rather than falling into the `mi_agent_absent` path #1161 tested against',
      () => {
        // `tryNousCredentialsMock` is shared file-wide, and many earlier tests'
        // `buildProductionComponents` calls DO invoke it (delegating to the real
        // implementation) — the call is gated on `sentimentEnabled`
        // (`production.ts:1595`), so only cases that leave sentiment on reach it;
        // e.g. the `SAMURAI_SENTIMENT = 'off'` describe block above never does.
        // Clear its call count regardless, so the assertion below measures only
        // this test's call, not whatever the file accumulated before it.
        tryNousCredentialsMock.mockClear();
        tryNousCredentialsMock.mockImplementationOnce(() => FAKE_SENTIMENT_CREDENTIALS);
        const logger = recordingLogger();
        const config = stubConfig(db, {
          sentimentEnabled: true,
          sentimentRetrieval: true,
          xMaxSearchResults: 4,
          logger,
        });

        buildProductionComponents(config);

        // `mockImplementationOnce` above is a one-shot queue: if this assertion
        // is ever 0, the fake credential was never consumed (e.g. a future edit
        // makes `buildProductionComponents` throw before it's read) and would
        // otherwise silently leak onto whichever later test in this file next
        // calls `tryNousCredentials('sentiment')`.
        expect(tryNousCredentialsMock).toHaveBeenCalledTimes(1);

        // Proof this run took the real branch, not the absent-agent one #1161's
        // tests all take — the constructor call below is otherwise vacuous.
        expect(logger.entries.some((entry) => entry.event === 'mi_agent_absent')).toBe(false);
        expect(XSearchClientMock).toHaveBeenCalledTimes(1);
        expect(XSearchClientMock).toHaveBeenCalledWith(
          expect.objectContaining({ maxSearchResults: 4 }),
        );
      },
    );

    /**
     * #1283 — #1226 (above) pinned only `maxSearchResults`; the review that
     * closed it flagged the rest of the same `new XSearchClient(...)` call as
     * still unobserved. `model` is the one that matters: `production.ts`
     * overrides `sentimentCredentials.model` (the pinned credential, which
     * 400s on `x_search`) with the routed alias `X_SEARCH_MODEL`. Asserting
     * against the imported constant, rather than a copied `'~x-ai/grok-latest'`
     * literal, is what makes this catch the actual regression named above —
     * `model: sentimentCredentials.model` silently reintroducing the pinned
     * credential — without also depending on `X_SEARCH_MODEL`'s current value.
     * `apiKey`/`baseUrl` have no such constant (they are
     * `FAKE_SENTIMENT_CREDENTIALS`' own fields, asserted against that fixture
     * instead), `windowMs` has one (`GROK_REFRESH_MS`), and `logger` is
     * asserted against the same `recordingLogger()` instance `stubConfig` was
     * given.
     */
    it(
      'passes apiKey, baseUrl, the routed model alias, windowMs, and logger through to ' +
        '`new XSearchClient(...)` unchanged from their sources — same harness as the ' +
        'maxSearchResults case above, extended to the constructor arguments #1226 left ' +
        'unobserved',
      () => {
        tryNousCredentialsMock.mockClear();
        tryNousCredentialsMock.mockImplementationOnce(() => FAKE_SENTIMENT_CREDENTIALS);
        const logger = recordingLogger();
        const config = stubConfig(db, {
          sentimentEnabled: true,
          sentimentRetrieval: true,
          xMaxSearchResults: 4,
          logger,
        });

        buildProductionComponents(config);

        expect(tryNousCredentialsMock).toHaveBeenCalledTimes(1);
        expect(XSearchClientMock).toHaveBeenCalledTimes(1);
        expect(XSearchClientMock).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: FAKE_SENTIMENT_CREDENTIALS.apiKey,
            baseUrl: FAKE_SENTIMENT_CREDENTIALS.baseUrl,
            model: X_SEARCH_MODEL,
            windowMs: GROK_REFRESH_MS,
            logger,
          }),
        );
      },
    );
  });

  /**
   * #1106 round 1: `MiIngestAgent` now refuses on a spend-cap breach itself,
   * the same seam `GrokAgent` already read — but no test anywhere pinned that
   * the composition root hands it the REAL cap rather than `UNCAPPED_SPEND`,
   * so a future edit could wire `spendCap: UNCAPPED_SPEND` unconditionally
   * (the pre-#1106 posture) and every other test in this file would stay
   * green: none of them build `MiIngestAgent` at all (`config.miArchive` is
   * `undefined` everywhere else), and `yarn smoke` never reaches this
   * constructor either, since the offline/keyless smoke run has neither Nous
   * sentiment credentials nor `ALPACA_API_KEY`/`ALPACA_API_SECRET`.
   */
  describe('MiIngestAgent spend-cap wiring (#1106)', () => {
    const FAKE_SCORING_CREDENTIALS: NousCredentials = {
      apiKey: 'fake-scoring-key',
      baseUrl: 'https://nous.test/v1',
      model: 'x-ai/grok-4.5',
    };

    beforeEach(() => {
      vi.stubEnv('ALPACA_API_KEY', 'dummy-key-not-a-credential');
      vi.stubEnv('ALPACA_API_SECRET', 'dummy-secret-not-a-credential');
    });

    afterEach(() => {
      MiIngestAgentMock.mockClear();
      tryNousCredentialsMock.mockClear();
      vi.unstubAllEnvs();
    });

    it('passes the real, budget-backed SqliteSpendCap through to `new MiIngestAgent(...)`, not UNCAPPED_SPEND', () => {
      tryNousCredentialsMock.mockImplementationOnce(() => FAKE_SCORING_CREDENTIALS);
      const config = stubConfig(db, {
        sentimentEnabled: true,
        llmBudgetUsd: 50,
        miArchive: new MiArchiveStore(),
      });

      buildProductionComponents(config);

      expect(MiIngestAgentMock).toHaveBeenCalledTimes(1);
      const passedSpendCap = MiIngestAgentMock.mock.calls[0]?.[0]?.spendCap;
      expect(passedSpendCap).toBeInstanceOf(SqliteSpendCap);
      expect(passedSpendCap).not.toBe(UNCAPPED_SPEND);
      // Not just "a real cap, some budget" — THIS config's budget.
      expect(passedSpendCap.check().budget_usd).toBe(50);
    });
  });

  // `[...BENCHMARK_INSTRUMENTS]`, not a hardcoded `['SPY', 'AGG']` literal
  // (#989 review) — a second, independent enumeration of the same set the
  // guard itself derives from `BENCHMARK_COMPOSITION` would silently stop
  // covering a future third benchmark leg.
  it.each([...BENCHMARK_INSTRUMENTS])(
    'refuses to build with mode "live" and %s still directly in the universe (#989) — ' +
      "PRE-#751, `marketData`'s own `AlpacaDataSource` can write a matching bar normalized " +
      "against `equityCalendarFor`'s `LseRegularHoursCalendar` (live mode) while " +
      "`buildBenchmarkDataSource`'s fixed benchmark port writes the SAME " +
      '(instrument, timeframe, open_time) row normalized against ' +
      '`UsEquityRegularHoursCalendar` — a silent last-write-wins collision in the shared ' +
      "`bars` table. `benchmarkMarketDataStore`'s doc above names this residual gap.",
    (instrument) => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        universe: [{ asset: instrument, asset_class: 'stocks' }],
      });

      // Not `new RegExp(instrument)` (#989 review): that would pass on ANY
      // unrelated error that happens to contain "SPY"/"AGG" as a substring,
      // not necessarily this guard. Match the guard's distinctive phrase
      // instead.
      expect(() => buildProductionComponents(config)).toThrow(
        /collides with the outside-benchmark path/,
      );
    },
  );

  it(
    'does NOT refuse mode "paper" with SPY in the universe and no tradingCalendar override ' +
      '(#989) — the guard keys on the RESOLVED trading calendar, not `mode` directly, and ' +
      'plain `mode: "paper"` resolves `equityCalendarFor` to `UsEquityRegularHoursCalendar`, ' +
      "which matches `buildBenchmarkDataSource`'s own fixed calendar — no disagreement to guard",
    () => {
      const config = stubConfig(db, {
        mode: 'paper',
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    },
  );

  it(
    'refuses mode "paper" with an explicit LSE tradingCalendar override and SPY in the ' +
      'universe (#989 review — the false negative a `mode`-only guard would miss) — ' +
      'this override pattern already exists elsewhere in this file (see the flatten-tail ' +
      "tests' `pinLse` config) and reproduces the exact same collision mechanism: the " +
      'resolved calendar is `LseRegularHoursCalendar` while `buildBenchmarkDataSource` stays ' +
      'pinned to `UsEquityRegularHoursCalendar`, regardless of `mode`',
    () => {
      const config = stubConfig(db, {
        mode: 'paper',
        tradingCalendar: new LseRegularHoursCalendar(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).toThrow(
        /collides with the outside-benchmark path/,
      );
    },
  );

  it(
    'does NOT refuse mode "live" with an explicit US tradingCalendar override and SPY in the ' +
      'universe (#989 review — the false positive a `mode`-only guard would wrongly reject) — ' +
      'the resolved calendar is `UsEquityRegularHoursCalendar`, matching ' +
      "`buildBenchmarkDataSource`'s own calendar exactly, so there is no real mismatch even " +
      'though `mode` is "live"',
    () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        tradingCalendar: new UsEquityRegularHoursCalendar(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    },
  );

  it(
    'refuses mode "live" with a third, unmatched tradingCalendar override and SPY in the ' +
      'universe (#989 review — the fail-open enumeration a `instanceof LseRegularHoursCalendar` ' +
      'check would miss) — the guard checks fail-CLOSED (anything other than an exact ' +
      '`UsEquityRegularHoursCalendar` match is treated as a potential mismatch), not an ' +
      'enumerated `LseRegularHoursCalendar` case, so a calendar this system has never seen ' +
      'before (here `AlwaysOpenCalendar`, the crypto default) does not silently bypass it ' +
      'the way a positive enumeration would',
    () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        tradingCalendar: new AlwaysOpenCalendar(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).toThrow(
        /collides with the outside-benchmark path/,
      );
    },
  );

  it(
    'refuses mode "live" with a SUBCLASS of UsEquityRegularHoursCalendar as the tradingCalendar ' +
      'override and SPY in the universe (#989 review — `instanceof` matches subclasses, so ' +
      '`.constructor !==` is the check, not `!(x instanceof ...)`) — a subclass overriding ' +
      'session normalization (this codebase already has one such pattern, ' +
      '`NeverTradingCalendar` in trading-calendar.test.ts) is not provably the SAME ' +
      "normalization as `buildBenchmarkDataSource`'s fixed calendar just because it inherits " +
      'from it',
    () => {
      class SubclassCalendar extends UsEquityRegularHoursCalendar {}
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        tradingCalendar: new SubclassCalendar(),
        universe: [{ asset: 'SPY', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).toThrow(
        /collides with the outside-benchmark path/,
      );
    },
  );

  it(
    'does NOT refuse mode "live" with a universe that excludes SPY/AGG (#989) — a universe ' +
      'holding neither symbol has no collision to guard against',
    () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        universe: [{ asset: 'AAPL', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    },
  );

  it(
    'refuses mode "live" with a lower-cased "spy" in the universe (#989 review) — ' +
      'ProductionConfig.universe is caller-assembled and untyped on case, so the guard ' +
      'compares case-insensitively rather than trusting every caller to upper-case first',
    () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        universe: [{ asset: 'spy', asset_class: 'stocks' }],
      });

      expect(() => buildProductionComponents(config)).toThrow(
        /collides with the outside-benchmark path/,
      );
    },
  );

  it(
    'does NOT refuse mode "live" with an LSE-only universe post-#751 (#989) — exactly the ' +
      "case #751's cutover is supposed to make safe: `3SPY` is an LSE ETP ticker, not the " +
      "US underlying 'SPY', so it must not trip a guard keyed on the literal symbol",
    () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        universe: [{ asset: '3SPY', asset_class: 'stocks' }],
        lseMarkClient: {
          vendor: 'fake-lse-vendor',
          getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
          getLatestQuote: vi.fn(async () => ({
            price: 31_240,
            currency: 'GBp',
            observed_at: START,
          })),
        },
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    },
  );

  describe('the LSE table coverage guard at boot (#1378)', () => {
    // One civil day past LSE_TABLE_COVERAGE_END — deliberately not a
    // half-day-shaped date, so this exercises the coverage cliff itself
    // rather than any half-day-specific behaviour.
    const oneDayPastCoverage = new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`);
    oneDayPastCoverage.setUTCDate(oneDayPastCoverage.getUTCDate() + 1);

    it(
      'refuses to build with mode "live" past LSE_TABLE_COVERAGE_END, naming today\'s date, ' +
        'both tables, both *_CHECKED_THROUGH constants, and #1387 (open) as where to extend',
      () => {
        const config = stubConfig(db, {
          mode: 'live',
          capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
          clock: new SimulatedClock(oneDayPastCoverage),
        });

        expect(() => buildProductionComponents(config)).toThrow(
          new RegExp(`past LSE_TABLE_COVERAGE_END \\(${LSE_TABLE_COVERAGE_END}\\).*Extend`, 's'),
        );
        expect(() => buildProductionComponents(config)).toThrow(/LSE_HOLIDAYS/);
        expect(() => buildProductionComponents(config)).toThrow(/LSE_HALF_DAYS/);
        expect(() => buildProductionComponents(config)).toThrow(/LSE_HOLIDAYS_CHECKED_THROUGH/);
        expect(() => buildProductionComponents(config)).toThrow(/LSE_HALF_DAYS_CHECKED_THROUGH/);
        // The dangerous read this guard exists to prevent, named explicitly
        // rather than left implicit — matches LSE_HALF_DAYS's own doc.
        expect(() => buildProductionComponents(config)).toThrow(/16:30/);
        expect(() => buildProductionComponents(config)).toThrow(/#1387/);
        // Never cites #1378 (this ticket) as the place to extend the
        // tables — citing it would be circular the moment it closes.
        expect(() => buildProductionComponents(config)).not.toThrow(/#1378/);
        // Nor #1379 — an operator-facing refusal must never cite a closed
        // ticket as where to extend the tables.
        expect(() => buildProductionComponents(config)).not.toThrow(/#1379/);
      },
    );

    it('does NOT refuse at exactly LSE_TABLE_COVERAGE_END — the last covered date', () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        clock: new SimulatedClock(new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`)),
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    });

    it('does not run this guard for mode "paper" (resolves UsEquityRegularHoursCalendar)', () => {
      const config = stubConfig(db, {
        mode: 'paper',
        clock: new SimulatedClock(oneDayPastCoverage),
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    });

    it('does not run this guard for mode "live" with an injected non-LSE tradingCalendar', () => {
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        tradingCalendar: new UsEquityRegularHoursCalendar(),
        clock: new SimulatedClock(oneDayPastCoverage),
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
    });

    it(
      'posts a routed lseCalendarCoverageAlerts warning when the coverage end is within ' +
        'LSE_COVERAGE_ALERT_HORIZON_DAYS — ahead of the hard refusal, so the cliff is visible ' +
        'before it bites',
      () => {
        const posted: LseCalendarCoverageAlert[] = [];
        const withinHorizon = new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`);
        withinHorizon.setUTCDate(
          withinHorizon.getUTCDate() - Math.floor(LSE_COVERAGE_ALERT_HORIZON_DAYS / 2),
        );
        const config = stubConfig(db, {
          mode: 'live',
          capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
          clock: new SimulatedClock(withinHorizon),
          lseCalendarCoverageAlerts: {
            postLseCalendarCoverageAlert: (alert) => {
              posted.push(alert);
            },
          },
        });

        expect(() => buildProductionComponents(config)).not.toThrow();
        expect(posted).toHaveLength(1);
        expect(posted[0]?.coverage_end).toBe(LSE_TABLE_COVERAGE_END);
        expect(posted[0]?.days_remaining).toBeGreaterThanOrEqual(0);
        expect(posted[0]?.days_remaining).toBeLessThanOrEqual(LSE_COVERAGE_ALERT_HORIZON_DAYS);
      },
    );

    it('does not post lseCalendarCoverageAlerts well outside the horizon (default START)', () => {
      const posted: LseCalendarCoverageAlert[] = [];
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        lseCalendarCoverageAlerts: {
          postLseCalendarCoverageAlert: (alert) => {
            posted.push(alert);
          },
        },
      });

      buildProductionComponents(config);

      expect(posted).toHaveLength(0);
    });

    it('posts at exactly LSE_COVERAGE_ALERT_HORIZON_DAYS (the boundary is inclusive)', () => {
      const posted: LseCalendarCoverageAlert[] = [];
      const atHorizon = new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`);
      atHorizon.setUTCDate(atHorizon.getUTCDate() - LSE_COVERAGE_ALERT_HORIZON_DAYS);
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        clock: new SimulatedClock(atHorizon),
        lseCalendarCoverageAlerts: {
          postLseCalendarCoverageAlert: (alert) => {
            posted.push(alert);
          },
        },
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
      expect(posted).toHaveLength(1);
      expect(posted[0]?.days_remaining).toBe(LSE_COVERAGE_ALERT_HORIZON_DAYS);
    });

    it('does not post one day outside LSE_COVERAGE_ALERT_HORIZON_DAYS', () => {
      const posted: LseCalendarCoverageAlert[] = [];
      const oneDayOutsideHorizon = new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`);
      oneDayOutsideHorizon.setUTCDate(
        oneDayOutsideHorizon.getUTCDate() - (LSE_COVERAGE_ALERT_HORIZON_DAYS + 1),
      );
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        clock: new SimulatedClock(oneDayOutsideHorizon),
        lseCalendarCoverageAlerts: {
          postLseCalendarCoverageAlert: (alert) => {
            posted.push(alert);
          },
        },
      });

      expect(() => buildProductionComponents(config)).not.toThrow();
      expect(posted).toHaveLength(0);
    });

    it(
      'the backstop cannot strand an open position: the calendar stays non-throwing past ' +
        'the cliff (residual boot-only gap), and boot refusal is the primary guarantee',
      () => {
        const calendar = new LseRegularHoursCalendar();

        expect(() => calendar.isOpen(oneDayPastCoverage)).not.toThrow();
        expect(() => calendar.sessionEnd(oneDayPastCoverage)).not.toThrow();
        expect(() => calendar.sessionStart(oneDayPastCoverage)).not.toThrow();
        expect(calendar.coversCloseFor(oneDayPastCoverage)).toBe(false);
      },
    );

    it('refuses to boot on an unmodelled half-day past coverage (AC5)', () => {
      // Christmas Eve, two years past LSE_TABLE_COVERAGE_END — half-day-shaped
      // but never checked against the source, so LSE_HALF_DAYS was never
      // extended to cover it. Derived from the constant rather than a bare
      // literal so extending the table doesn't strand this inside coverage.
      // The guard must refuse before a live leg can ever reach
      // LseRegularHoursCalendar's un-verified 16:30 guess for this date
      // (trading-calendar.test.ts pins the calendar-level half of this:
      // coversCloseFor is false and the resolver stays total).
      const unmodelledHalfDay = new Date(
        `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 2}-12-24T12:00:00Z`,
      );
      // The half-day-shaped premise only holds if this lands on a weekday;
      // asserted explicitly so a future coverage-end shift that puts it on
      // a weekend reds this test instead of silently testing something else.
      expect(unmodelledHalfDay.getUTCDay()).toBeGreaterThanOrEqual(1);
      expect(unmodelledHalfDay.getUTCDay()).toBeLessThanOrEqual(5);
      const config = stubConfig(db, {
        mode: 'live',
        capitalCeilingUsd: toCapitalCeilingUsd(1_000, 'test'),
        clock: new SimulatedClock(unmodelledHalfDay),
      });

      expect(() => buildProductionComponents(config)).toThrow(/LSE_TABLE_COVERAGE_END/);
    });
  });

  it(
    "hooks Feedback Loop's onTradeClose off the returned executionStore's " +
      'writeClosedTrade (#237) — not off any TickSteps member',
    async () => {
      // The composition-root seam #237 actually adds: whichever caller
      // eventually reaches `components.executionStore.writeClosedTrade`
      // (today nothing in-repo does — `ingestFills()` scheduling is a later
      // ticket's job), the Feedback Loop setup-store labelling fires as a
      // side effect, with no `TickSteps` involved.
      const components = buildProductionComponents(stubConfig(db));
      const setupStore = new SqliteSetupStore(db);
      const vector = { debate_features: [0.7, 1, 1, 0.1], market_features: [0.3, 0.5] };
      setupStore.writeSetup('debate-close-1', vector, new Date('2026-07-29T09:00:00Z'));

      await components.executionStore.applyLotAdvance({
        idempotency_key: 'key-close-1',
        fills: [],
        closed_trade: {
          idempotency_key: 'key-close-1',
          debate_id: 'debate-close-1',
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          side: 'buy',
          entry: 100,
          stop: 90,
          filled_size: 10,
          realized_pnl_net: 200, // R = 2
          fees_total: 1,
          opened_at: new Date('2026-07-29T09:30:00Z'),
          closed_at: new Date('2026-07-29T10:00:00Z'),
          close_reason: 'target',
          modelled_cost_charged: true,
        },
      });

      const neighbors = setupStore.findNeighbors(vector, new Date('2026-07-29T11:00:00Z'));
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0]?.r_multiple).toBe(2);
    },
  );
});

/**
 * `buildDefaultLlmClient` — the live-client fallback `ProductionConfig.llmClient`
 * being optional now takes when omitted (kimi-3-review on #284: MEDIUM-tier
 * wiring with no matching test at the time). Only the build-time seam is
 * exercised here (env parsing, missing-key throw, the startup `warn` log) —
 * the built `NousMessagesClient` itself never has `createMessage` called, so
 * no `fetch` stub is needed.
 */
describe('buildProductionComponents (default llmClient fallback)', () => {
  let db: StoreHandle;
  const NOUS_VARS = [
    'NOUS_API_KEY',
    'NOUS_BASE_URL',
    'NOUS_MODEL',
    'NOUS_DEBATE_API_KEY',
    'NOUS_DEBATE_MODEL',
    'NOUS_SENTIMENT_API_KEY',
    'NOUS_SENTIMENT_MODEL',
    'SAMURAI_SENTIMENT',
  ] as const;
  let previous: Partial<Record<(typeof NOUS_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    db = openSharedStore(':memory:');
    previous = {};
    for (const name of NOUS_VARS) {
      previous[name] = process.env[name];
      delete process.env[name];
    }
    // The default configured state for these tests: a base URL and a shared
    // key, so the debate client builds. Individual tests delete what they are
    // about.
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
    // The sentiment agent shares these variables and would otherwise build a
    // live client on every case here. It has its own tests.
    process.env.SAMURAI_SENTIMENT = 'off';
  });

  afterEach(() => {
    db.close();
    for (const name of NOUS_VARS) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function configWithoutLlmClient(overrides: Partial<ProductionConfig> = {}): ProductionConfig {
    const { llmClient: _llmClient, ...rest } = stubConfig(db, overrides);
    return rest;
  }

  it('throws when no Nous key is set and llmClient is omitted', () => {
    delete process.env.NOUS_API_KEY;

    expect(() => buildProductionComponents(configWithoutLlmClient())).toThrow(/NOUS_API_KEY/);
  });

  it('throws when NOUS_BASE_URL is unset — there is deliberately no default endpoint', () => {
    delete process.env.NOUS_BASE_URL;

    expect(() => buildProductionComponents(configWithoutLlmClient())).toThrow(/NOUS_BASE_URL/);
  });

  /**
   * The one that matters for the money. An unpriced model records a null
   * `cost_usd`, the spend cap sums nulls as zero, and ADR-0008's $50/14d
   * ceiling silently stops existing. Refusing at build time is what keeps that
   * from being a runtime surprise nobody sees.
   */
  it('refuses a model with no rate in MODEL_RATES, because unpriced means uncapped', () => {
    process.env.NOUS_DEBATE_MODEL = 'vendor/not-a-real-model';

    expect(() => buildProductionComponents(configWithoutLlmClient())).toThrow(/MODEL_RATES/);
  });

  it('logs a startup warn and defaults to the debate role model when built live', () => {
    const logger = recordingLogger();

    buildProductionComponents(configWithoutLlmClient({ logger }));

    // Found by CONTENT, not by being the first warn: the root emits several
    // startup warnings (the spend cap adds one), and position is not a
    // property this test is about.
    const warning = logger.entries.find((entry) => entry.message.includes('NousMessagesClient'));
    expect(warning?.level).toBe('warn');
    expect(warning?.payload).toMatchObject({ model: DEFAULT_NOUS_MODELS.debate });
  });

  it('honors NOUS_DEBATE_MODEL as an override in the logged payload', () => {
    process.env.NOUS_DEBATE_MODEL = 'anthropic/claude-haiku-4.5';
    const logger = recordingLogger();

    buildProductionComponents(configWithoutLlmClient({ logger }));

    const warning = logger.entries.find((entry) => entry.message.includes('NousMessagesClient'));
    expect(warning?.payload).toMatchObject({ model: 'anthropic/claude-haiku-4.5' });
  });

  it('prefers the role-specific key over the shared one', () => {
    delete process.env.NOUS_API_KEY;
    process.env.NOUS_DEBATE_API_KEY = 'test-fake-debate-key';
    const logger = recordingLogger();

    expect(() => buildProductionComponents(configWithoutLlmClient({ logger }))).not.toThrow();
  });

  it('builds a real AnthropicLlmClient wrapping the live client, not just a log side effect', () => {
    const logger = recordingLogger();

    const client = buildDefaultLlmClient(logger, UNGATED_LLM_IN_FLIGHT);

    // Instance type + retry/timeout budget, not only the model threaded
    // through the startup warn log's payload (kimi-3-review on #284).
    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(DEFAULT_LLM_CLIENT_CONFIG).toEqual({
      max_tokens: 1024,
      // 28,000ms, DERIVED from the budget invariant asserted below (#1080)
      // rather than chosen. Written as the literal it must resolve to, so a
      // change to the derivation has to be re-read here instead of being
      // silently absorbed.
      timeoutMs: 28_000,
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    });
  });

  /**
   * #1080. One call's own worst case — every attempt its retry schedule
   * affords, plus the backoffs between them — must still fit inside the budget
   * the debate races, or a single retried call guarantees the debate ends on
   * budget expiry no matter how fast the rest of it is.
   *
   * Both budget figures are literals on purpose. `DEFAULT_LLM_TIMEOUT_MS` is
   * derived from `LATENCY_BUDGET_MS.stocks`, so comparing the shipped config
   * against that same constant is an identity — it holds for any budget,
   * including one nobody chose. Pinning the numbers makes the sides
   * independent: a hand-edited `timeoutMs` fails the inequality, and a moved
   * latency budget or round cap fails a literal and has to be re-read here.
   */
  it('cannot let one logical LLM call outlast the latency budget it runs inside', () => {
    expect(LATENCY_BUDGET_MS.stocks).toBe(112_000);

    const { maxAttempts, maxDelayMs } = DEFAULT_LLM_CLIENT_CONFIG.retry;
    const worstCaseLogicalCallMs =
      maxAttempts * DEFAULT_LLM_CLIENT_CONFIG.timeoutMs + (maxAttempts - 1) * maxDelayMs;

    expect(worstCaseLogicalCallMs).toBeLessThanOrEqual(112_000);
  });

  /**
   * #1080's own acceptance criterion, as an invariant: the budget must afford
   * every call the debate it bounds issues, at the per-attempt ceiling.
   *
   * The per-call cost here is `timeoutMs` and not the whole retry schedule
   * because `enforceLatencyBudget` aborts the debate at the budget: a retry
   * cannot overrun the tick, only cause the budget to fire. What the budget has
   * to afford is the clean path where every call returns. The retried worst
   * case for a single call is pinned by the test above.
   */
  it('affords every sequential call a stocks debate issues (#1080)', () => {
    expect(MAX_ROUNDS_BY_ASSET_CLASS.stocks).toBe(1);
    expect(DEFAULT_LLM_CLIENT_CONFIG.timeoutMs).toBe(28_000);

    const worstCaseDebateMs =
      llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks) * DEFAULT_LLM_CLIENT_CONFIG.timeoutMs;

    expect(worstCaseDebateMs).toBeLessThanOrEqual(112_000);
  });

  /**
   * #1080, and the reason it had to be inferred rather than read: a retried
   * attempt was invisible everywhere. `AnthropicLlmClient` starts its
   * `latency_ms` clock inside the attempt and meters only through
   * `recordSpend`, which a failed attempt never reaches — so a timeout that
   * halved a debate's budget left no log line and no `llm_spend` row.
   *
   * Driven through the REAL client the composition root builds, not through
   * `withRetry` directly (that loop has its own tests): the defect class this
   * guards is a mechanism that exists, is tested, and is wired nowhere.
   */
  it('logs each retried LLM attempt through the client the composition root builds', async () => {
    const logger = recordingLogger();
    // Every attempt gets a well-formed HTTP response; what makes the call
    // retryable is the caller's own parse rejecting it, which is the cheapest
    // retryable error to provoke without a timer.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
              model: DEFAULT_NOUS_MODELS.debate,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const client = buildDefaultLlmClient(logger, UNGATED_LLM_IN_FLIGHT);
    let parses = 0;

    await expect(
      client.complete({
        prompt: 'p',
        context: {
          analyst_views: [],
          attribution: { trace_id: 'trace-1', stage: 'debate', debate_id: 'debate-9' },
        },
        parseResponse: () => {
          parses += 1;
          return { valid: false, reason: 'unparseable' };
        },
      }),
    ).rejects.toThrow();

    // Two attempts made, and the FIRST one — the attempt no other record keeps
    // — is on the log.
    expect(parses).toBe(2);
    const retryLine = logger.entries.find((entry) => entry.message.startsWith('llm retry:'));
    expect(retryLine?.level).toBe('warn');
    expect(retryLine?.trace_id).toBe('trace-1');
    expect(retryLine?.payload).toMatchObject({
      attempt: 1,
      max_attempts: 2,
      debate_id: 'debate-9',
      model: DEFAULT_NOUS_MODELS.debate,
    });

    // #1394: the SAME line now names what it is retrying.
    // `RetryAttemptReport.error` is `unknown`, so a rate limit and a bad draw
    // used to produce identical lines, and only the first is worth waiting out.
    expect(retryLine?.payload).toMatchObject({ failure_cause: 'unparseable' });

    // #1394's terminal line, and the one a session-wide count of LLM failures
    // by cause is read off. Asserted here rather than only on
    // `AnthropicLlmClient` because a classifier the composition root never
    // wires is this repo's dominant defect class: delete `onCallFailed` from
    // `buildDefaultLlmClient` and every seam below still fails open in silence.
    const failedLine = logger.entries.find((entry) => entry.event === 'llm_call_failed');
    expect(failedLine?.level).toBe('warn');
    expect(failedLine?.trace_id).toBe('trace-1');
    expect(failedLine?.payload).toMatchObject({
      failure_cause: 'unparseable',
      debate_id: 'debate-9',
      llm_stage: 'debate',
      model: DEFAULT_NOUS_MODELS.debate,
    });
    // Once per CALL, not once per attempt — the retry line owns those.
    expect(logger.entries.filter((entry) => entry.event === 'llm_call_failed')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

/**
 * The composed chain actually running — the closest in-repo stand-in for
 * ADR-0004's "wiring validated" bar, which itself is a manual run against
 * real Alpaca paper. Every stage is the real implementation; only the leaves
 * with no in-repo transport are swapped for the in-repo doubles the codebase
 * already ships (`FixtureDataSource`, `SimulatedBrokerAdapter`,
 * `MockLlmClient`), and the stores are the real `Sqlite*` ones.
 */
/**
 * #745 — the counter behind an unavailable analyst axis, asserted AT THE
 * COMPOSITION ROOT.
 *
 * Deliberately not "the analyst calls the sink when given one" (that is
 * `technical-axes.test.ts`'s job): a counter that only exists when a test
 * hands it in is dead in production, and this repo's dominant defect class is
 * exactly that — a tested mechanism nothing calls. This drives the REAL
 * `buildProductionComponents` analysts step against a thin instrument and
 * reads the log the wired sink writes to.
 */
describe('technical_indicator_unavailable is wired by the composition root (#745)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('emits the counter for every enrichment axis a thin instrument cannot fill', async () => {
    const clock = new SimulatedClock(START);
    // 19 5m bars: enough for the core (SMA 14, RSI 15, ATR% 15), short of
    // every enrichment kind. Before #745 this instrument produced no view at
    // all — the technical analyst is `mandatory`, so it was a `quorum_skip`.
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 19, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 20, 60 * 60_000),
    ];
    const logger = recordingLogger();
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      logger,
      dataSource: new FixtureDataSource(
        bars,
        { price: 160, observed_at: START, source: 'fixture' },
        'crypto',
      ),
      llmClient: new MockLlmClient(),
    });

    const { steps } = buildProductionComponents(config);
    const views = await steps.analysts({
      trace_id: 'trace-745-root',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });

    // The whole point of the split: a view, not a quorum skip.
    expect(views.some((view) => view.analyst_type === 'technical')).toBe(true);

    // `LogEntry.payload` is `{}`-typed at the port, so the counter fields are
    // read through a narrow local view rather than by widening the port.
    const counters = logger.entries
      .map((entry) => ({
        ...entry,
        fields: entry.payload as { counter?: string; kind?: string } | undefined,
      }))
      .filter((entry) => entry.fields?.counter === INDICATOR_UNAVAILABLE_COUNTER);
    expect(counters.map((entry) => entry.fields?.kind).sort()).toEqual([
      'adx',
      'bb_kc_squeeze',
      'donchian_pos',
      'macd_histogram',
      'volume_participation',
    ]);
    // The counter's own name reaches the log line, so a scrape can find it
    // without knowing the payload schema.
    expect(counters[0]?.message).toContain(INDICATOR_UNAVAILABLE_COUNTER);
    expect(counters[0]?.trace_id).toBe('trace-745-root');
  });
});

/**
 * #752 — the per-name/per-subclass `NO_DATA` coverage counter and the
 * degraded-coverage alert are wired at the composition root, mirroring the
 * #745 telemetry-wiring test above for the same defect class: a counter or
 * an alert nothing calls. Driven against the REAL `buildProductionComponents`
 * — `MarketIntelligenceStore` starts empty and no MI writer is configured in
 * this stub, so the ticking instrument is guaranteed to miss coverage.
 */
describe('market-intelligence coverage is wired by the composition root (#752)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('records the counter, posts the alert naming the instrument, sets the degraded flag, and does not halt the tick', async () => {
    const clock = new SimulatedClock(START);
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 30, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 30, 60 * 60_000),
    ];
    const logger = recordingLogger();
    const alertsPosted: unknown[] = [];
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      logger,
      dataSource: new FixtureDataSource(
        bars,
        { price: 160, observed_at: START, source: 'fixture' },
        'crypto',
      ),
      llmClient: new MockLlmClient(),
      miCoverageAlerts: {
        postCoverageAlert: async (alert) => {
          alertsPosted.push(alert);
        },
      },
    });

    const components = buildProductionComponents(config);

    // Not degraded before any tick has run — the flag is a live read, not a
    // default-on latch.
    expect(components.marketIntelligenceCoverage.degraded).toBe(false);

    const views = await components.steps.analysts({
      trace_id: 'trace-752-root',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });

    // Criterion 3: the run still starts — the tick produced its views rather
    // than throwing or blocking.
    expect(views.length).toBeGreaterThan(0);

    // Criterion 1: the counter is recorded and reaches the log stream.
    const counterEntries = logger.entries
      .map((entry) => ({
        ...entry,
        fields: entry.payload as
          | { counter_by_name?: string; counter_by_subclass?: string; instrument?: string }
          | undefined,
      }))
      .filter((entry) => entry.fields?.counter_by_name === MI_NO_DATA_BY_NAME_COUNTER);
    expect(counterEntries).toHaveLength(1);
    expect(counterEntries[0]?.fields?.instrument).toBe('BTC-USD');
    expect(counterEntries[0]?.fields?.counter_by_subclass).toBe(MI_NO_DATA_BY_SUBCLASS_COUNTER);

    // Criterion 2: the alert names the instrument and reaches the injected
    // channel — proving `production.ts` actually wires `config.miCoverageAlerts`
    // rather than leaving the log-only default in place.
    expect(alertsPosted).toHaveLength(1);
    expect(alertsPosted[0]).toMatchObject({ instrument: 'BTC-USD' });

    // Criterion 2: the degraded-coverage flag is set on the run.
    expect(components.marketIntelligenceCoverage.degraded).toBe(true);
    expect(components.marketIntelligenceCoverage.missingInstruments).toContain('BTC-USD');
  });
});

/**
 * #1396 — the llm-failure-rate guard is wired at the composition root,
 * mirroring the #752 market-intelligence-coverage wiring test above for the
 * same defect class: a monitor and an alert channel nothing calls.
 *
 * History rows are written directly through `components.debateLog` — the
 * SAME `SqliteDebateLogStore` instance `checkLlmFailureRate` reads — rather
 * than forced through real LLM failures, which would need a client that
 * fails on demand inside `enforceLatencyBudget`'s timeout race. What this
 * test proves is narrower and is the thing #1396 actually risks: that
 * `production.ts` threads `config.llmFailureRateAlerts` and the shared store
 * into `buildDebateStep`, not that the rate arithmetic itself is correct —
 * that half is `llm-failure-rate-guard.test.ts`'s job.
 */
describe('llm-failure-rate guard is wired by the composition root (#1396)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function llmForOneDebate(): MockLlmClient {
    const client = new MockLlmClient();
    for (let i = 0; i < 40; i += 1) {
      client.enqueueText(
        JSON.stringify({ stance: 'bullish', rationale: 'fixture rationale', converged: true }),
      );
    }
    return client;
  }

  it('reads real history through the store the debate step writes, and posts to the injected channel', async () => {
    const clock = new SimulatedClock(START);
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 30, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 30, 60 * 60_000),
    ];
    const alertsPosted: unknown[] = [];
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      logger: recordingLogger(),
      dataSource: new FixtureDataSource(
        bars,
        { price: 160, observed_at: START, source: 'fixture' },
        'crypto',
      ),
      llmClient: llmForOneDebate(),
      llmFailureRateAlerts: {
        postLlmFailureRateAlert: (alert) => {
          alertsPosted.push(alert);
        },
      },
    });

    const components = buildProductionComponents(config);

    // Two `llm_failure` rows and five `budget` rows, all inside the 24h
    // window — seven truncations, the denominator (review round 1 F2:
    // `total` counts `termination = 'latency_truncated'` rows, not every
    // debate_log row). Deliberately above, not pinned at,
    // `MIN_TRUNCATIONS_FOR_LLM_FAILURE_RATE` (5) — review round 2 F5: a count
    // exactly at the floor made this test boundary-fragile (an off-by-one in
    // the floor comparison would pass unnoticed). The tick below writes an
    // EIGHTH row at `clock.now()` that CONVERGES (`llmForOneDebate` always
    // returns `converged: true`), so it is excluded from `total` — the rate
    // stays 2/7 (~0.286), still over `LLM_FAILURE_RATE_THRESHOLD` (0.25).
    for (let i = 0; i < 7; i += 1) {
      components.debateLog.writeLog({
        debate_id: `debate-1396-history-${i}`,
        instrument: 'BTC-USD',
        bar_timestamp: new Date(START.getTime() - (i + 1) * 60_000),
        contributions: [],
        direction: 'bullish',
        rounds: 1,
        created_at: new Date(START.getTime() - (i + 1) * 60_000),
        termination: 'latency_truncated',
        termination_cause: i < 2 ? 'llm_failure' : 'budget',
      });
    }

    const views = await components.steps.analysts({
      trace_id: 'trace-1396-root',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });
    expect(views.length).toBeGreaterThan(0);

    await components.steps.debate({
      trace_id: 'trace-1396-root',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views,
      clock,
      bar: START,
    });

    // `checkLlmFailureRate` is fire-and-forget (the debate resolved above);
    // flush the microtask queue so its one `await` (the alert POST) settles
    // before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    // Proves `production.ts` actually wires `config.llmFailureRateAlerts`
    // and `components.debateLog` into the SAME guard the debate step calls,
    // rather than leaving the log-only default in place.
    expect(alertsPosted).toHaveLength(1);
    expect(alertsPosted[0]).toMatchObject({ llm_failure_count: 2, total_count: 7 });
    expect((alertsPosted[0] as { rate: number }).rate).toBeCloseTo(2 / 7);
  });
});

/**
 * #1084 — `tickSkipAlerts` is threaded from `ProductionConfig` through
 * `buildProductionOrchestrator`'s own `startTickLoop({...})` call, not just
 * proven against `startTickLoop` directly. The "tick-skip escalation (#1084)"
 * suite nested under `describe('startTickLoop', ...)` elsewhere in this file
 * injects a mock channel straight into `startTickLoop`'s deps — it proves the
 * threshold/throttle/escalation LOGIC is correct, not that
 * `buildProductionOrchestrator` actually wires a real channel to it. Same
 * defect class #745/#746/#752 above document: a mechanism implemented,
 * unit-tested, and never actually called from the composition root.
 *
 * `yarn smoke` cannot exercise this (see its `tickSkipAlerts` comment):
 * overlapping tick passes never occur in a seconds-long offline run where
 * everything settles inside one `tickIntervalMs`. This suite is the
 * enforcement evidence that comment points to.
 */
describe('tickSkipAlerts is wired by the composition root (#1084)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const fourInstrumentUniverse: UniverseInstrument[] = [
    { asset: 'A', asset_class: 'crypto' },
    { asset: 'B', asset_class: 'crypto' },
    { asset: 'C', asset_class: 'crypto' },
    { asset: 'D', asset_class: 'crypto' },
  ];

  /** Same shape as `blockingRunner` (the `startTickLoop` suite, above): every claimed
   *  instrument stays "busy" until the test explicitly releases it. */
  function blockingTickRunner() {
    const releases: Array<() => void> = [];
    const runInstrument = vi.fn(
      () =>
        new Promise<TickOutcome>((resolve) => {
          releases.push(() => resolve({ trace_id: 't', final_stage: 'execution' }));
        }),
    );
    return {
      runInstrument,
      releaseAll: () => {
        for (const release of releases.splice(0)) release();
      },
    };
  }

  /**
   * THE MUTATION THIS KILLS: drop `tickSkipAlerts: config.tickSkipAlerts ??
   * loggingAlertChannel('tickSkipAlerts', logger)` from the `startTickLoop({...})`
   * call in `buildProductionOrchestrator` (production.ts). Every test in the
   * `startTickLoop`-level "tick-skip escalation (#1084)" suite still passes —
   * they call `startTickLoop` directly — while a real, injected channel
   * (Telegram in a live run) would silently never receive a materially
   * degraded pass.
   */
  it('reaches a real materially-degraded tick pass through buildProductionOrchestrator', async () => {
    const tickSkipAlerts = { postTickSkipAlert: vi.fn(async () => {}) };
    const { runInstrument, releaseAll } = blockingTickRunner();
    const config = stubConfig(db, {
      universe: fourInstrumentUniverse,
      tradingCalendar: new AlwaysOpenCalendar(),
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      maxConcurrentInstruments: 4,
      tickSkipAlerts,
    });

    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockImplementation(runInstrument);

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(1_000); // tick 1: claims all four, hangs
    expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000); // tick 2: all four still busy
    expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledTimes(1);
    expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: 4, planned: 4 }),
    );

    releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    await orchestrator.stop();
  });

  /**
   * THE OTHER HALF of the same mutation: drop only the
   * `?? loggingAlertChannel('tickSkipAlerts', logger)` fallback and pass `config.tickSkipAlerts`
   * bare. An unconfigured run (nothing injected — `SAMURAI_ALERTS` unset in a
   * programmatic caller) would then silently regress to #1084's original bug:
   * a degraded pass with nowhere to escalate to, not even the log.
   */
  it('falls back to the logging default when nothing is injected', async () => {
    const logger = recordingLogger();
    const { runInstrument, releaseAll } = blockingTickRunner();
    const config = stubConfig(db, {
      universe: fourInstrumentUniverse,
      tradingCalendar: new AlwaysOpenCalendar(),
      logger,
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      maxConcurrentInstruments: 4,
    });

    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockImplementation(runInstrument);

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const warned = logger.entries.find((entry) =>
      entry.message.includes('tick pass materially degraded'),
    );
    expect(warned?.level).toBe('warn');
    expect(warned?.message).toContain('4 of 4');

    releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    await orchestrator.stop();
  });
});

/**
 * #1280 — the spend cap's `onBreach` payload, as the composition root actually
 * builds it, driven through the REAL log-only `breachAlerts` channel.
 *
 * `breach-text.test.ts` and `alert-catalogue.test.ts` pin
 * `breachStage`'s two arms against alerts they construct themselves, which
 * says nothing about what `production.ts` posts. Replacing the root's
 * `breaches: [LLM_SPEND_CAP_BREACH]` with any other string leaves both of
 * those suites green while silently reverting the spend-cap breach line to
 * `stage: 'feedback-loop'` — the tested-mechanism-nobody-calls shape this
 * ticket exists to close, landing on the wiring this ticket added. This joins
 * the two halves so the substitution is red.
 *
 * The trigger is the BOOT refusal (`startingTotal()` on an already-spent
 * database), which is the cheapest reachable path to that closure — it needs
 * no tick, no timer and no LLM. That makes this a test about the payload, not
 * about provenance: at boot there is no ambient id, so `trace_id` reads
 * `'feedback-cycle'` (the mislabel the catalogue's `breachAlerts` entry
 * records and #1343 fixes by widening the port). It is deliberately not
 * asserted here.
 */
describe("the spend cap's breach payload is wired by the composition root (#1280)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it("files the breach it posts under the spend cap's own stage, not the daily cycle's", () => {
    // One priced call, straight into the table the cap sums — $2.00 against a
    // $1.00 ceiling, so `startingTotal()` refuses on the budget arm during
    // `buildProductionComponents` itself.
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model,
         input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens,
         cost_usd, latency_ms, timestamp
       ) VALUES ('trace-boot', 'debate', 'debate-boot', 'openai/gpt-5.6-luna',
                 100, 100, 0, 0, 2.0, 10, ?)`,
    ).run(START.toISOString());

    const logger = recordingLogger();
    // The REAL channel, not a `vi.fn()`: a stub would capture the payload but
    // not the derivation, and the defect is only visible where the two meet.
    const config = stubConfig(db, {
      logger,
      llmBudgetUsd: 1,
      breachAlerts: loggingAlertChannel('breachAlerts', logger),
    });

    buildProductionComponents(config);

    const breaches = logger.entries.filter((entry) => entry.event === 'kill_threshold_breach');
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.payload).toMatchObject({ breaches: [LLM_SPEND_CAP_BREACH] });
    expect(breaches[0]?.stage).toBe('debate');
  });
});

/**
 * #746 — `AnalystOrchestratorDeps.sessionCalendars` is wired by the
 * composition root, mirroring the #745 telemetry-wiring test immediately
 * above for the same defect class: a mechanism nothing calls. Driven against
 * the REAL `buildProductionComponents`, not a unit test of `AnalystOrchestrator`
 * in isolation — a stubbed deps object would prove the orchestrator CAN thread
 * a calendar, not that `production.ts` actually supplies its real
 * `sessionCalendars` pair rather than leaving the orchestrator's safe
 * `AlwaysOpenCalendar` default in place.
 */
describe('sessionCalendars is wired by the composition root (#746)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('threads the real per-asset-class calendar to the analyst — a stocks instrument gets a real session VWAP, not the orchestrator default', async () => {
    const clock = new SimulatedClock(START);
    // 19 5m bars: enough for the technical analyst's CORE reads (mandatory),
    // same shape as the #745 test above — the session VWAP line renders
    // regardless of the enrichment axes, which is not this test's concern.
    const bars = [
      ...fixtureBars('AAPL', '5m', 19, 5 * 60_000),
      ...fixtureBars('AAPL', '1h', 20, 60 * 60_000),
    ];
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      dataSource: new FixtureDataSource(
        bars,
        { price: 160, observed_at: START, source: 'fixture' },
        'stocks',
      ),
      llmClient: new MockLlmClient(),
      // Default (`mode: 'paper'` from `stubConfig`) resolves through
      // `equityCalendarFor` to `UsEquityRegularHoursCalendar` — a calendar
      // with a real session, unlike the orchestrator's `AlwaysOpenCalendar`
      // default.
    });

    const { steps } = buildProductionComponents(config);
    const views = await steps.analysts({
      trace_id: 'trace-746-root',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock,
      bar: START,
    });

    const technical = views.find((view) => view.analyst_type === 'technical');
    expect(technical).toBeDefined();
    const sessionLine = technical?.key_points.find((line) => line.startsWith('Session VWAP (5m):'));
    expect(sessionLine).toBeDefined();
    // If the orchestrator's own `AlwaysOpenCalendar` default were reached
    // instead of `production.ts`'s real `sessionCalendars.stocks`, this would
    // read exactly "Session VWAP (5m): no session to anchor to" regardless of
    // asset class — the wiring gap this test exists to catch.
    expect(sessionLine).not.toBe('Session VWAP (5m): no session to anchor to');
  });

  it('still reports no session to anchor to for crypto — AlwaysOpenCalendar is the correct wiring, not a leftover default', async () => {
    const clock = new SimulatedClock(START);
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 19, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 20, 60 * 60_000),
    ];
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      dataSource: new FixtureDataSource(
        bars,
        { price: 160, observed_at: START, source: 'fixture' },
        'crypto',
      ),
      llmClient: new MockLlmClient(),
    });

    const { steps } = buildProductionComponents(config);
    const views = await steps.analysts({
      trace_id: 'trace-746-crypto',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });

    const technical = views.find((view) => view.analyst_type === 'technical');
    expect(technical?.key_points).toContain('Session VWAP (5m): no session to anchor to');
  });
});

describe('composed tick chain (integration)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('drives one instrument through the composed steps, recording each stage it reaches', async () => {
    const clock = new SimulatedClock(START);
    const hourMs = 60 * 60 * 1_000;
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 60, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 60, hourMs),
      ...fixtureBars('BTC-USD', '1m', 60, 60_000),
      ...fixtureBars('BTC-USD', '1d', 40, 24 * hourMs),
    ];
    const dataSource = new FixtureDataSource(
      bars,
      { price: 160, observed_at: START, source: 'fixture' },
      'crypto',
      // `Quote` carries no `source` — that field belongs to `Mark`.
      { bid: 159.5, ask: 160.5, observed_at: START },
    );

    const llmClient = new MockLlmClient();
    for (let i = 0; i < 40; i += 1) {
      llmClient.enqueueText(
        JSON.stringify({ stance: 'bullish', rationale: 'fixture rationale', converged: true }),
      );
    }

    const costModel = new CostModelImpl(REAL_CONFIGS.costConfig);
    const marketDataForBroker = new MarketDataServiceImpl(
      dataSource,
      clock,
      'live',
      new SqliteMarketDataStore(db),
    );

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      dataSource,
      llmClient,
      broker: new SimulatedBrokerAdapter({
        clock,
        costModel,
        marketData: marketDataForBroker,
        config: REAL_CONFIGS.executionConfig.simulated,
      }),
    });

    const { steps } = buildProductionComponents(config);
    const persistence = buildPersistence(db);
    const logger = recordingLogger();

    const outcome = await new SequentialTickRunner(steps).runInstrument(
      { asset: 'BTC-USD', asset_class: 'crypto' },
      {
        clock,
        trace_id: 'trace-composed',
        logger,
        auditLog: persistence.auditLog,
        currentTickStore: persistence.currentTickStore,
        // #743: this is the composed DECISION chain — the pass needs a claim.
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    const stages = persistence.auditLog.getByTraceId('trace-composed').map((row) => row.stage);

    // All six stages, in order, one audit row each, under one trace_id — and
    // the bracket actually reached the broker.
    expect(stages).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(outcome.final_stage).toBe('execution');
    expect(outcome.verdict_status).toBe('go');
    expect(outcome.execution_result?.status).toBe('submitted');
    expect(outcome.execution_result?.broker_order_ids).toHaveLength(3);

    // The progress row is upserted per stage and deleted on completion.
    expect(persistence.currentTickStore.get('BTC-USD')).toBeUndefined();
    // #753: the log now carries BOTH arms, so it is filtered to the live trace
    // rather than compared whole. The control arm's own stages are asserted
    // just below — this line is about the LIVE pass being untouched by it.
    expect(
      logger.entries
        .filter((entry) => entry.trace_id === 'trace-composed')
        .map((entry) => entry.stage),
    ).toEqual(stages);

    /**
     * #753 — FALSIFIER ARM 2 RAN, on this same tick, through the real
     * composition root.
     *
     * This is the composition-root proof the ticket's "run it in parallel with
     * the soak from the first day" constraint needs: not that the control arm
     * exists and is tested, but that `buildProductionComponents` actually binds
     * it and that a single `runInstrument` call drives it. Deleting the
     * `controlArm:` line from `production.ts` — or the `await
     * this.steps.controlArm?.(...)` from the tick runner — must fail HERE,
     * at the root, rather than leaving a green unit suite around a mechanism
     * nothing calls.
     */
    const controlStages = persistence.auditLog
      .getByTraceId('trace-composed:control')
      .map((row) => row.stage);
    expect(controlStages).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);

    // Same six stages, same instrument, same bar — and a DIFFERENT lot, because
    // `arm` is a hash input to the idempotency key. Without that the control's
    // order would have been deduped away against the live arm's, silently, on
    // exactly the bars the two arms agree.
    const armRows = db
      .prepare('SELECT arm, idempotency_key FROM open_positions ORDER BY arm')
      .all() as { arm: string; idempotency_key: string }[];
    expect(armRows.map((row) => row.arm)).toEqual(['control', 'live']);
    expect(armRows[0]?.idempotency_key).not.toEqual(armRows[1]?.idempotency_key);

    // #302: the `go` verdict above must have left a real `verdict_log` row
    // through the PRODUCTION composition path (`buildProductionComponents`
    // -> `buildVerdictStep`), not a hand-rolled `LoggingVerdict` wiring in
    // this test. `OrphanVerdictScanner`'s startup query depends on this row
    // existing — with no writer wired, the query always returns zero
    // orphans regardless of the truth. Reverting `direct-bind.ts`'s
    // `buildVerdictStep` to a bare `new VerdictImpl()` must fail this
    // assertion.
    const verdictLogRow = db
      .prepare('SELECT trace_id, status, instrument FROM verdict_log WHERE trace_id = ?')
      .get('trace-composed') as
      | { trace_id: string; status: string; instrument: string }
      | undefined;
    expect(verdictLogRow).toEqual({
      trace_id: 'trace-composed',
      status: 'go',
      instrument: 'BTC-USD',
    });
  });

  /**
   * The other side of the boundary the test above sits on, and the reason both
   * halves exist.
   *
   * Until `tsconfig.test.json` type-checked this file, `stubConfig` supplied
   * `{ atr_percentile: 0.5 } as VolatilityReading` — a shape the type has not
   * had for some time. `VolatilityReading` is `{ crypto, stocks }`, so BOTH
   * real fields were `undefined`, every comparison against
   * `baseline x multiplier` was false, and the volatility breaker had never
   * once evaluated in the composed chain. The test above passed on a breaker
   * that could not fire.
   *
   * Fixing the shape alone would only have proven the breaker stays armed on a
   * calm reading. This proves it can actually stop a tick: `breakers.test.ts`
   * covers the trip in isolation, but nothing covered it through the wiring,
   * which is exactly the gap that let the inert stub survive.
   */
  it('stops the composed chain at risk when the volatility breaker trips', async () => {
    const clock = new SimulatedClock(START);
    const hourMs = 60 * 60 * 1_000;
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 60, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 60, hourMs),
      ...fixtureBars('BTC-USD', '1m', 60, 60_000),
      ...fixtureBars('BTC-USD', '1d', 40, 24 * hourMs),
    ];
    const dataSource = new FixtureDataSource(
      bars,
      { price: 160, observed_at: START, source: 'fixture' },
      'crypto',
      { bid: 159.5, ask: 160.5, observed_at: START },
    );

    const llmClient = new MockLlmClient();
    for (let i = 0; i < 40; i += 1) {
      llmClient.enqueueText(
        JSON.stringify({ stance: 'bullish', rationale: 'fixture rationale', converged: true }),
      );
    }

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      dataSource,
      llmClient,
      // 0.5 against a `{ crypto: 0.05 } x 3` ceiling — far over the line.
      volatility: {
        getVolatilityReading: vi.fn(
          async (): Promise<VolatilityReading> => ({ crypto: 0.5, stocks: 0.5 }),
        ),
      },
    });

    const { steps } = buildProductionComponents(config);
    const persistence = buildPersistence(db);

    const outcome = await new SequentialTickRunner(steps).runInstrument(
      { asset: 'BTC-USD', asset_class: 'crypto' },
      {
        clock,
        trace_id: 'trace-vol-trip',
        logger: recordingLogger(),
        auditLog: persistence.auditLog,
        currentTickStore: persistence.currentTickStore,
        // #743: this is the composed DECISION chain — the pass needs a claim.
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    const stages = persistence.auditLog.getByTraceId('trace-vol-trip').map((row) => row.stage);

    // Risk is reached and is where it ends: no verdict, no execution.
    expect(stages).toEqual(['analysts', 'debate', 'trader', 'risk']);
    expect(outcome.final_stage).toBe('risk');
    expect(outcome.execution_result).toBeUndefined();
  });

  /**
   * #568 review: the exit-fill reader is bound HERE, in
   * `buildProductionComponents`, and the regression class this project keeps
   * producing is a mechanism that exists and is wired to the wrong thing.
   * `direct-bind.test.ts` builds its own binding, so it proves the seam works,
   * not that the composition root uses it — a `getExitFillSizes` bound to a
   * SECOND store would pass every test there while computing held quantity
   * from a database that does not hold these lots.
   *
   * Pinned two ways, because either alone is escapable: the spy proves the
   * trader step calls THIS instance (a second store leaves it untouched), and
   * the sized intent proves that instance sees the same fill rows
   * `getOpenPositions` served the lot from (a second store over a different
   * db would size the exit at the lot's original 10).
   */
  it('binds the trader step exit-fill reader to the same executionStore the open lots come from (#568)', async () => {
    const clock = new SimulatedClock(START);
    const hourMs = 60 * 60 * 1_000;
    const dataSource = new FixtureDataSource(
      [
        ...fixtureBars('BTC-USD', '5m', 60, 5 * 60_000),
        ...fixtureBars('BTC-USD', '1h', 60, hourMs),
        ...fixtureBars('BTC-USD', '1m', 60, 60_000),
        ...fixtureBars('BTC-USD', '1d', 40, 24 * hourMs),
      ],
      { price: 160, observed_at: START, source: 'fixture' },
      'crypto',
      { bid: 159.5, ask: 160.5, observed_at: START },
    );
    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      clock,
      dataSource,
      llmClient: new MockLlmClient(),
    });

    const components = buildProductionComponents(config);

    // A lot of 10 with 4 already flattened, written through the very store
    // the composition root hands `getOpenPositions`.
    await components.executionStore.writeAheadPosition({
      idempotency_key: 'lot-partially-flattened',
      debate_id: 'debate-earlier',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      side: 'buy',
      intent_type: 'entry',
      requested_size: 10,
      filled_size: 10,
      avg_entry_price: 150,
      stop: 140,
      target: 180,
      order_state: 'filled',
      broker_order_ids: [],
      opened_at: START,
      decision_timestamp: START,
      conviction: 0.6,
      converged: true,
    });
    await components.executionStore.applyLotAdvance({
      idempotency_key: 'lot-partially-flattened',
      fills: [
        {
          idempotency_key: 'lot-partially-flattened',
          broker_fill_id: toBrokerFillId('fill-earlier-partial-flatten'),
          leg: 'exit',
          price: 158,
          qty: 4,
          fee: 0.1,
          timestamp: START,
        },
      ],
    });

    const readExitFills = vi.spyOn(components.executionStore, 'getExitFillSizes');

    const intent = await components.steps.trader({
      trace_id: 'trace-568-wiring',
      instrument: 'BTC-USD',
      // Opposite the held long, so the Trader flattens.
      debate: {
        synthesis: 'bearish',
        position: 'short',
        confidence: 0.9,
        contributions: [],
        disagreement_summary: '',
        open_items: [],
        converged: true,
        rounds_completed: 1,
        latency_ms: 10,
        direction: 'bearish',
        debate_id: 'debate-568-wiring',
        // #687: the Trader keys the exit on the DEBATE's bar. START is
        // bar-aligned, so this is the bar the old clock-flooring produced.
        bar_timestamp: START,
        read: true,
      },
      clock,
    });

    expect(readExitFills).toHaveBeenCalledWith(['lot-partially-flattened']);
    expect(intent?.intent_type).toBe('exit');
    expect(intent?.size).toBe(6);
  });
});

describe('startTickLoop', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const persistence = () => ({
    auditLog: { record: vi.fn() },
    currentTickStore: { upsert: vi.fn(), delete: vi.fn(), get: vi.fn() },
    orphanScanner: { scan: vi.fn(async () => []) },
  });

  const planScheduler = (plan: TickPlan): Scheduler => ({ nextTick: () => plan });

  const plan: TickPlan = {
    instruments: [{ asset: 'BTC-USD', asset_class: 'crypto' }],
    tick_time: START,
  };

  it('runs one instrument per tick on the configured interval', async () => {
    const runInstrument = vi.fn(
      async (): Promise<TickOutcome> => ({ trace_id: 't', final_stage: 'analysts' }),
    );
    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    expect(runInstrument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it('does not stack a second tick while one is still running', async () => {
    let release!: () => void;
    const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { trace_id: 't', final_stage: 'analysts' };
    });

    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);

    // Several interval periods elapse while the first tick is still in
    // flight: no second pass may start.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

    // The second pass is now the in-flight one; `stop()` drains it, so it has
    // to be released too or the shutdown legitimately waits forever.
    release();
    await loop.stop();
  });

  it('records the failure and keeps ticking when the tick throws an unrenderable value (#1262)', async () => {
    const logger = recordingLogger();
    // Circular (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
    // (defeats the `String()` fallback too) — the value `describeThrown`'s own
    // doc says it cannot render alone.
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;

    let ticks = 0;
    const scheduler: Scheduler = {
      nextTick: () => {
        ticks += 1;
        if (ticks === 1) throw hostile;
        return plan;
      },
    };
    const runInstrument = vi.fn(
      async (): Promise<TickOutcome> => ({ trace_id: 't', final_stage: 'analysts' }),
    );

    const loop = startTickLoop({
      scheduler,
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger,
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // The catch's own comment promises 'an error should cost one tick, not the
    // run'. Rendering the thrown value unguarded inverted that: the throw
    // escaped `runOnce` into `void runOnce()`, becoming an unhandled rejection
    // that `installFaultHandlers` treats as fatal — and it ran BEFORE the log
    // call, so nothing recorded why.
    const failure = logger.entries.find((entry) => entry.message === 'tick failed');
    expect(failure?.payload).toEqual({ error: '[unrenderable error]' });

    // One tick, not the run: the next interval still ticks.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);

    await loop.stop();
  });

  it('logs and survives an instrument that throws inside a tick (#507)', async () => {
    const logger = recordingLogger();
    const runInstrument = vi
      .fn<TickRunner['runInstrument']>()
      .mockRejectedValueOnce(new Error('stage exploded'))
      .mockResolvedValue({ trace_id: 't', final_stage: 'analysts' });

    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger,
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // Caught inside tick-loop.ts's per-worker try/catch (#507), not this
    // module's `runOnce` catch: the instrument-level failure line fires...
    expect(logger.entries.some((entry) => entry.message === 'instrument failed: BTC-USD')).toBe(
      true,
    );
    // ...and 'tick failed' — which used to be the ONLY record of a throw
    // anywhere in this path — does not, because `runTickPlan` no longer
    // rejects the whole tick over one instrument's failure.
    expect(logger.entries.some((entry) => entry.message === 'tick failed')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it('never re-enters an instrument still in flight, even when a sibling already threw (#507, #669)', async () => {
    // #507's invariant, re-expressed for the per-instrument guard (#669).
    //
    // The original defect: FAST's throw alone rejected `runTickPlan`'s
    // `Promise.all`, which resolved `runOnce` and cleared the global
    // `inFlight` flag while SLOW was still mid-pipeline, so the next tick
    // started a second SLOW pass alongside the first. That is the invariant
    // that still matters, and it is asserted directly below — per instrument,
    // rather than through the global flag that used to stand in for it.
    //
    // What deliberately CHANGED with #669: FAST is no longer held hostage. The
    // old global guard dropped the whole tick while SLOW ran, and because
    // crypto is the large majority of debate volume that starvation was
    // systematically one-directional — a slow crypto debate costing the equity
    // leg ticks out of its ~2h window. FAST now runs every interval.
    let releaseSlow!: () => void;
    const twoInstrumentPlan: TickPlan = {
      instruments: [
        { asset: 'FAST', asset_class: 'crypto' },
        { asset: 'SLOW', asset_class: 'crypto' },
      ],
      tick_time: START,
    };
    const nextTick = vi.fn((): TickPlan => twoInstrumentPlan);
    const runInstrument = vi.fn(async (signal): Promise<TickOutcome> => {
      if (signal.asset === 'FAST') throw new Error('fast instrument exploded');
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return { trace_id: 't', final_stage: 'execution' };
    });

    const callsFor = (asset: string): number =>
      runInstrument.mock.calls.filter(([signal]) => signal.asset === asset).length;

    const loop = startTickLoop({
      scheduler: { nextTick },
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 2,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // FAST already threw and was caught; SLOW is still blocked on its gate.
    expect(callsFor('FAST')).toBe(1);
    expect(callsFor('SLOW')).toBe(1);

    // Five more interval periods with SLOW still in flight.
    await vi.advanceTimersByTimeAsync(5_000);

    // THE INVARIANT (#507): SLOW is never re-entered while its pass is live.
    expect(callsFor('SLOW')).toBe(1);
    // THE FIX (#669): FAST kept ticking instead of being starved by SLOW.
    expect(callsFor('FAST')).toBeGreaterThan(1);

    releaseSlow();
    await vi.advanceTimersByTimeAsync(1_000);
    // Released, SLOW is eligible again.
    expect(callsFor('SLOW')).toBeGreaterThan(1);

    // The later SLOW pass's own gate, so `stop()` doesn't wait forever.
    releaseSlow();
    await loop.stop();
  });

  it('a slow pass settling does not release an instrument a newer pass re-claimed', async () => {
    // The fast-reclaim-then-slow-settle ordering, which the guard's own
    // backstop used to break.
    //
    // Pass 1 claims FAST and SLOW. FAST settles almost immediately and is
    // released, so tick 2 legitimately re-claims FAST into pass 2 — which then
    // blocks. SLOW finally settles, pass 1 completes, and its `finally`
    // backstop ran `delete` over EVERY asset pass 1 had claimed, FAST included
    // — clearing a guard pass 2 owned. The next tick then started a second
    // concurrent pass on FAST: the exact reentrancy #669 exists to prevent,
    // reintroduced by the backstop meant to protect it.
    //
    // Ownership tokens make the stale release a no-op.
    const gates: Record<string, (() => void) | undefined> = {};
    let fastCallCount = 0;
    const twoInstrumentPlan: TickPlan = {
      instruments: [
        { asset: 'FAST', asset_class: 'crypto' },
        { asset: 'SLOW', asset_class: 'crypto' },
      ],
      tick_time: START,
    };
    const runInstrument = vi.fn(async (signal): Promise<TickOutcome> => {
      if (signal.asset === 'SLOW') {
        await new Promise<void>((resolve) => {
          gates.SLOW = resolve;
        });
        return { trace_id: 't', final_stage: 'execution' };
      }

      fastCallCount += 1;
      // The FIRST FAST pass settles at once (so it can be re-claimed); every
      // later one blocks, so a second concurrent FAST pass would be visible as
      // a call count that keeps climbing while one is still gated.
      if (fastCallCount === 1) {
        return { trace_id: 't', final_stage: 'execution' };
      }
      await new Promise<void>((resolve) => {
        gates.FAST = resolve;
      });
      return { trace_id: 't', final_stage: 'execution' };
    });

    const loop = startTickLoop({
      scheduler: { nextTick: (): TickPlan => twoInstrumentPlan },
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 2,
    });

    // Tick 1: FAST settles immediately, SLOW blocks.
    await vi.advanceTimersByTimeAsync(1_000);
    // Tick 2: FAST is free, so it is re-claimed into a new pass — and blocks.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fastCallCount).toBe(2);

    // SLOW settles, completing pass 1 and firing its backstop over FAST too.
    gates.SLOW?.();
    await vi.advanceTimersByTimeAsync(0);

    // Several more ticks. FAST's pass 2 is still gated, so the guard must hold.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fastCallCount).toBe(2);

    gates.FAST?.();
    await vi.advanceTimersByTimeAsync(0);
    gates.SLOW?.();
    await vi.advanceTimersByTimeAsync(0);
    gates.FAST?.();
    gates.SLOW?.();
    await loop.stop();
  });

  it('claims atomically, so a duplicated asset in one plan cannot run twice', async () => {
    // Check-and-claim used to be `filter` then a separate `add` loop, which is
    // not atomic per asset: both copies passed the filter before either was
    // claimed. `nextTick` returning a duplicate is not expected — but "not
    // expected" is what the guard is for, and the failure is silent.
    const duplicatePlan: TickPlan = {
      instruments: [
        { asset: 'BTC-USD', asset_class: 'crypto' },
        { asset: 'BTC-USD', asset_class: 'crypto' },
      ],
      tick_time: START,
    };
    let release!: () => void;
    const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { trace_id: 't', final_stage: 'execution' };
    });

    const loop = startTickLoop({
      scheduler: { nextTick: (): TickPlan => duplicatePlan },
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 2,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runInstrument).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await loop.stop();
  });

  it('stop() waits for an in-flight tick instead of abandoning it mid-pipeline', async () => {
    let release!: () => void;
    let finished = false;
    const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      finished = true;
      return { trace_id: 't', final_stage: 'execution' };
    });

    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);

    const stopping = loop.stop();
    expect(finished).toBe(false);

    release();
    await stopping;
    expect(finished).toBe(true);
  });

  /**
   * #692 — `stop()` must resolve even when a pass fails while it is awaiting.
   *
   * Be precise about what this does and does not prove. It PINS the outcome; it
   * does not demonstrate the shield, because `runTickPlan` cannot currently
   * reject at all — #507's per-worker try/catch means an instrument throw never
   * reaches its `Promise.all`. So today `stop()` is safe for a reason that
   * lives in tick-loop.ts, not here.
   *
   * That is exactly why the shield is worth its line. The comment above
   * `Promise.all` used to claim the safety came from `runOnce` swallowing its
   * own errors, which is false — `runOnce`'s catch covers its own `await` and
   * marks nothing handled for a second consumer of the same promise. Anyone
   * adding an await outside the worker's try/catch would have made `stop()`
   * reject and abandon every other in-flight pass, with the comment here
   * asserting that could not happen.
   */
  it('stop() resolves rather than rejecting when the in-flight pass fails (#692)', async () => {
    let release!: () => void;
    const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('pipeline blew up during shutdown');
    });

    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    // stop() snapshots `passes` here, BEFORE the pass fails — the ordering the
    // finding turns on. A raw chain in that set would reject `Promise.all`.
    const stopping = loop.stop();
    release();

    await expect(stopping).resolves.toBeUndefined();
  });

  it('reports a duplicated instrument as a scheduler fault, not as a slow previous pass (#692)', async () => {
    // The two skips share a code path and mean opposite things: a still-running
    // instrument is the steady state #669 exists to tolerate, while the same
    // asset twice in one plan is a malformed plan. Reporting the second as
    // "still running from a previous pass" hid it precisely when caught.
    const logger = recordingLogger();
    const duplicatePlan = {
      instruments: [
        { asset: 'BTC-USD', asset_class: 'crypto' as const },
        { asset: 'BTC-USD', asset_class: 'crypto' as const },
      ],
      tick_time: START,
    };
    const runInstrument = vi.fn(
      async (): Promise<TickOutcome> => ({ trace_id: 't', final_stage: 'analysts' }),
    );

    const loop = startTickLoop({
      scheduler: planScheduler(duplicatePlan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger,
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await loop.stop();

    // The guard still holds: the duplicate lost to itself, one run only.
    expect(runInstrument).toHaveBeenCalledTimes(1);
    expect(logger.entries.some((entry) => entry.message.includes('duplicate instrument'))).toBe(
      true,
    );
    expect(
      logger.entries.some((entry) => entry.message.includes('still running from a previous pass')),
    ).toBe(false);
  });

  /**
   * The case the first cut of the duplicate warn missed, caught on review.
   *
   * Keying duplicate detection off `claims` only worked when the FIRST
   * occurrence was claimable. If it was already running from a prior pass it
   * never entered `claims`, so the second occurrence fell through to the
   * `running` check and was reported as an ordinary slow pass — the malformed
   * plan hidden again, in the case where a duplicate is most likely to matter,
   * since a plan that repeats an asset while that asset is mid-pipeline is the
   * one that would breach the one-pass-per-instrument invariant if the guard
   * ever slipped.
   */
  it('still reports a duplicate whose first occurrence is already running (#692)', async () => {
    const logger = recordingLogger();
    let release!: () => void;
    const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { trace_id: 't', final_stage: 'execution' };
    });

    const btc = { asset: 'BTC-USD', asset_class: 'crypto' as const };
    let plans = 0;
    const scheduler = {
      nextTick: () => {
        plans += 1;
        // First tick claims BTC and blocks. Second tick returns it TWICE while
        // the first pass still holds it: one occurrence is legitimately busy,
        // the other is the scheduler fault.
        return { instruments: plans === 1 ? [btc] : [btc, btc], tick_time: START };
      },
    };

    const loop = startTickLoop({
      scheduler: scheduler as never,
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger,
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(logger.entries.some((entry) => entry.message.includes('duplicate instrument'))).toBe(
      true,
    );

    release();
    await loop.stop();
  });

  it('stops scheduling further ticks after stop()', async () => {
    const runInstrument = vi.fn(
      async (): Promise<TickOutcome> => ({ trace_id: 't', final_stage: 'analysts' }),
    );
    const loop = startTickLoop({
      scheduler: planScheduler(plan),
      runner: { runInstrument } as TickRunner,
      clock: new SimulatedClock(START),
      logger: recordingLogger(),
      persistence: persistence() as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);
  });

  describe('held-first flatten-tail priority (#1390)', () => {
    const threeInstrumentPlan: TickPlan = {
      instruments: [
        { asset: 'FLAT_A', asset_class: 'stocks' },
        { asset: 'HELD', asset_class: 'stocks' },
        { asset: 'FLAT_B', asset_class: 'stocks' },
      ],
      tick_time: START,
    };

    it('dispatches the held instrument first, ahead of its fixed-order position', async () => {
      const started: string[] = [];
      const runInstrument = vi.fn(async (signal: { asset: string }): Promise<TickOutcome> => {
        started.push(signal.asset);
        return { trace_id: 't', final_stage: 'execution' };
      });

      const loop = startTickLoop({
        scheduler: planScheduler(threeInstrumentPlan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger: recordingLogger(),
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 1,
        heldAssets: async () => new Set(['HELD']),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await loop.stop();

      expect(started).toEqual(['HELD', 'FLAT_A', 'FLAT_B']);
    });

    it('falls back to the unordered plan and warns when the held-position lookup fails', async () => {
      const started: string[] = [];
      const runInstrument = vi.fn(async (signal: { asset: string }): Promise<TickOutcome> => {
        started.push(signal.asset);
        return { trace_id: 't', final_stage: 'execution' };
      });
      const logger = recordingLogger();

      const loop = startTickLoop({
        scheduler: planScheduler(threeInstrumentPlan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger,
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 1,
        heldAssets: async () => {
          throw new Error('store unavailable');
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await loop.stop();

      // The tick still ran, in the scheduler's own order — a failed lookup
      // costs priority, not the tick.
      expect(started).toEqual(['FLAT_A', 'HELD', 'FLAT_B']);
      expect(
        logger.entries.some((entry) => entry.message.includes('held-position lookup failed')),
      ).toBe(true);
    });

    /**
     * Round-1 review finding 6: before #1390, `runOnce`'s prologue (`nextTick`
     * through the claim loop) had no `await` in it, so `stop()` — synchronous
     * up to its OWN first await — could never observe `runOnce` mid-prologue;
     * `passes` always gained the in-flight pass's entry before `stop()`'s
     * `Promise.all([...passes])` snapshot could be taken. `await
     * deps.heldAssets()` is a new yield point ahead of that snapshot: without
     * the `if (stopped) return;` re-check this test pins, `stop()` racing
     * during the held-position read would resolve without ever waiting for
     * the instruments that pass goes on to claim and dispatch.
     */
    it('does not dispatch any instrument if stop() resolves while heldAssets() is still pending', async () => {
      const started: string[] = [];
      const runInstrument = vi.fn(async (signal: { asset: string }): Promise<TickOutcome> => {
        started.push(signal.asset);
        return { trace_id: 't', final_stage: 'execution' };
      });

      let resolveHeldAssets!: (assets: ReadonlySet<string>) => void;
      const heldAssetsGate = new Promise<ReadonlySet<string>>((resolve) => {
        resolveHeldAssets = resolve;
      });

      const loop = startTickLoop({
        scheduler: planScheduler(threeInstrumentPlan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger: recordingLogger(),
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 1,
        heldAssets: () => heldAssetsGate,
      });

      // Fires the tick; `runOnce` reaches `await deps.heldAssets()` and parks
      // there — `heldAssetsGate` is still unresolved, so nothing past that
      // point (the claim loop, `passes.add`) has run yet.
      await vi.advanceTimersByTimeAsync(1_000);

      // Races in while the pass is parked. Nothing is in `passes` yet, so
      // this resolves immediately rather than waiting for the parked pass.
      await loop.stop();

      // The parked pass resumes; the `stopped` re-check must abort it before
      // it claims or dispatches anything.
      resolveHeldAssets(new Set(['HELD']));
      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual([]);
      expect(runInstrument).not.toHaveBeenCalled();
    });
  });

  describe('tick-skip escalation (#1084)', () => {
    const fourInstrumentPlan: TickPlan = {
      instruments: [
        { asset: 'A', asset_class: 'crypto' },
        { asset: 'B', asset_class: 'crypto' },
        { asset: 'C', asset_class: 'crypto' },
        { asset: 'D', asset_class: 'crypto' },
      ],
      tick_time: START,
    };

    /** Never resolves until the test releases it — every claimed instrument stays "busy". */
    const blockingRunner = () => {
      const releases: Array<() => void> = [];
      const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { trace_id: 't', final_stage: 'execution' };
      });
      return {
        runInstrument,
        releaseAll: () => {
          for (const release of releases.splice(0)) release();
        },
      };
    };

    it('escalates a materially degraded pass (majority of the plan busy)', async () => {
      const logger = recordingLogger();
      const { runInstrument, releaseAll } = blockingRunner();
      const tickSkipAlerts = { postTickSkipAlert: vi.fn(async () => {}) };

      const loop = startTickLoop({
        scheduler: planScheduler(fourInstrumentPlan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger,
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 4,
        tickSkipAlerts,
      });

      // Tick 1: all four instruments claimed and dispatched — nothing is
      // skipped yet, so no escalation.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runInstrument).toHaveBeenCalledTimes(4);
      expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();

      // Tick 2: all four are still busy from tick 1 (4 of 4 planned) — a
      // materially degraded pass, escalated on its first occurrence.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledTimes(1);
      expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          skipped: 4,
          planned: 4,
          skipped_instruments: ['A', 'B', 'C', 'D'],
          consecutive_ticks: 1,
        }),
      );

      // Skip behaviour itself is UNCHANGED (#692): no new dispatch happened
      // on tick 2 for any of the four busy instruments, and the existing
      // `info` skip log still fires exactly as before.
      expect(runInstrument).toHaveBeenCalledTimes(4);
      expect(
        logger.entries.some((entry) =>
          entry.message.includes('still running from a previous pass'),
        ),
      ).toBe(true);

      releaseAll();
      await loop.stop();
    });

    it('leaves a small routine skip quiet (one instrument busy, below the floor)', async () => {
      const logger = recordingLogger();
      let release!: () => void;
      const runInstrument = vi.fn(async (): Promise<TickOutcome> => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { trace_id: 't', final_stage: 'analysts' };
      });
      const tickSkipAlerts = { postTickSkipAlert: vi.fn(async () => {}) };

      const loop = startTickLoop({
        scheduler: planScheduler(plan), // single-instrument plan
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger,
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 1,
        tickSkipAlerts,
      });

      await vi.advanceTimersByTimeAsync(1_000); // tick 1: dispatches, blocks
      // Several further ticks all see the one instrument still busy (1 of 1
      // planned) — below TICK_SKIP_ALERT_MIN_INSTRUMENTS, so this is the
      // ordinary "one slow debate" case and must stay quiet.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();
      // The existing quiet `info` log is untouched.
      expect(
        logger.entries.some((entry) =>
          entry.message.includes('still running from a previous pass'),
        ),
      ).toBe(true);

      release();
      await loop.stop();
    });

    it('does not spam on repeated degraded ticks, and repeats every 8th (#1084 throttle convention)', async () => {
      const { runInstrument, releaseAll } = blockingRunner();
      const tickSkipAlerts = { postTickSkipAlert: vi.fn(async () => {}) };

      const loop = startTickLoop({
        scheduler: planScheduler(fourInstrumentPlan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger: recordingLogger(),
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 4,
        tickSkipAlerts,
      });

      // Tick 1 is clean (nothing busy yet). Ticks 2-10 are all degraded
      // (4 of 4 busy each time): alert on the 1st degraded tick (tick 2)
      // and again on the 9th (tick 10) — never in between.
      for (let i = 0; i < 10; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }

      expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledTimes(2);
      expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ consecutive_ticks: 1 }),
      );
      expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ consecutive_ticks: 9 }),
      );

      releaseAll();
      await loop.stop();
    });
  });
});

/**
 * Round-1 review finding 1 (BLOCKING): the FIRST version of #1390's
 * `heldAssets` wiring read only `components.executionStore` — `arm: 'live'`
 * rows (#753's `WHERE arm = ?` scoping). Every held lot in the ticket's own
 * incident (all nine control lots: AAPL, NFLX, AMZN, QQQ, PLTR, SMCI, MSTR,
 * RIOT, UBER) was `arm: 'control'`, so on the incident tick that reader
 * returned the empty set and `orderHeldFirst` was the identity — bit-
 * identical to no fix at all. This drives `buildHeldAssetsReader` (the exact
 * function `startTickLoop({ heldAssets: ... })` is bound to inside
 * `buildProductionOrchestrator`) through a REAL `ProductionComponents` built
 * by `buildProductionComponents`, not a hand-rolled synthetic reader — a
 * regression back to live-store-only is invisible to any test that injects
 * its own `heldAssets` closure, which is exactly why finding 1 survived round
 * 1's mutation evidence.
 */
/**
 * Shared by every #1390 test below that needs a real filled lot in a real
 * `SqliteExecutionStore` — the composition-root tests need it before
 * `buildProductionOrchestrator` even runs, so this can't stay nested inside
 * one describe block.
 */
function openLot(instrument: string, idempotencyKey: string) {
  return {
    idempotency_key: idempotencyKey,
    debate_id: `debate-${idempotencyKey}`,
    instrument,
    asset_class: 'stocks' as const,
    side: 'buy' as const,
    intent_type: 'entry' as const,
    requested_size: 10,
    filled_size: 10,
    avg_entry_price: 150,
    stop: 140,
    target: 180,
    order_state: 'filled' as const,
    broker_order_ids: [],
    opened_at: START,
    decision_timestamp: START,
    conviction: 0.6,
    converged: true,
  };
}

describe('heldAssets covers both arms, through the composition root (#1390)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it("unions the live arm's held instruments with the control arm's, not the live arm alone", async () => {
    const components = buildProductionComponents(stubConfig(db));

    // A live-arm lot and a DIFFERENT control-arm lot — through the same two
    // stores `buildHeldAssetsReader` reads, `components.executionStore` (live)
    // and `components.controlArmWiring.store` (control), so this only proves
    // something if the reader genuinely reaches both.
    await components.executionStore.writeAheadPosition(openLot('AAPL', 'live-lot'));
    await components.controlArmWiring.store.writeAheadPosition(openLot('QQQ', 'control-lot'));

    const heldAssets = await buildHeldAssetsReader(components)();

    expect(heldAssets).toEqual(new Set(['AAPL', 'QQQ']));

    // The exact regression finding 1 caught: reading the live store alone
    // (#1390's first version) sees only the live lot and misses the control
    // one — reproduced here directly against the same two stores, so a
    // future change that narrows `buildHeldAssetsReader` back to one store
    // fails this assertion, not just the union one above.
    const liveOnly = new Set(
      (await components.executionStore.getOpenPositions()).map((p) => p.instrument),
    );
    expect(liveOnly).toEqual(new Set(['AAPL']));
    expect(liveOnly.has('QQQ')).toBe(false);
  });

  it("returns the live arm's held instruments when the control arm holds nothing", async () => {
    const components = buildProductionComponents(stubConfig(db));

    await components.executionStore.writeAheadPosition(openLot('AAPL', 'live-lot'));

    const heldAssets = await buildHeldAssetsReader(components)();

    expect(heldAssets).toEqual(new Set(['AAPL']));
  });
});

/**
 * Round-2 review finding 1: every test above proves `buildHeldAssetsReader`
 * itself is correct, and the `startTickLoop`-level "held-first flatten-tail
 * priority (#1390)" suite (above, in `describe('startTickLoop', ...)`) proves
 * `orderHeldFirst` is applied correctly when a `heldAssets` function is
 * supplied — but none of them prove `buildProductionOrchestrator` actually
 * SUPPLIES one. A reviewer deleted `heldAssets: buildHeldAssetsReader(components)`
 * from the `startTickLoop({...})` call in `buildProductionOrchestrator` and
 * the full suite (6157 tests) stayed green, and `smoke-run.ts`'s offline
 * harness never references `heldAssets` either — so that one line had zero
 * test coverage. This drives a real tick through the real orchestrator,
 * against a held lot seeded through a SEPARATE `SqliteExecutionStore`
 * instance over the same `db` (proving the read reaches whatever
 * `buildProductionOrchestrator` itself wires, not a reference this test
 * happens to hold), and observes real dispatch order.
 */
describe('held-first reordering reaches a real tick through buildProductionOrchestrator (#1390)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const universe: UniverseInstrument[] = [
    { asset: 'FLAT_A', asset_class: 'crypto' },
    { asset: 'HELD', asset_class: 'crypto' },
    { asset: 'FLAT_B', asset_class: 'crypto' },
  ];

  /**
   * THE MUTATION THIS KILLS: drop `heldAssets: buildHeldAssetsReader(components)`
   * from `buildProductionOrchestrator`'s `startTickLoop({...})` call
   * (production.ts). Every other #1390 test in this file still passes —
   * this is the only one that dispatches through the real composition root,
   * where HELD would fall back to its fixed-order position (second).
   */
  it('dispatches the held instrument first even though it sits second in the fixed universe order', async () => {
    await new SqliteExecutionStore(guardedStore(db, 'execution'), 'live').writeAheadPosition(
      openLot('HELD', 'seed-lot'),
    );

    const dispatchOrder: string[] = [];
    const config = stubConfig(db, {
      universe,
      tradingCalendar: new AlwaysOpenCalendar(),
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockImplementation(
      async (signal: { asset: string }): Promise<TickOutcome> => {
        dispatchOrder.push(signal.asset);
        return { trace_id: 't', final_stage: 'execution' };
      },
    );

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(dispatchOrder).toEqual(['HELD', 'FLAT_A', 'FLAT_B']);

    await orchestrator.stop();
  });
});

describe('buildProductionOrchestrator', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
    // #1110: `scheduleFeedbackCycle`'s boundary math runs on `Date.now()`,
    // deliberately independent of the injected (often-frozen) `clock` — see
    // that function's DESIGN DECISION 1 comment. Left unpinned,
    // `vi.useFakeTimers()` starts the faked clock at the REAL wall-clock
    // instant the test happened to run at, so a UTC-day/interval boundary
    // could fall anywhere inside a short `advanceTimersByTimeAsync` window —
    // any test asserting an exact feedback-cycle fire count would pass or
    // fail depending on the real second it ran in. `START` is exactly
    // divisible by 1_000ms, so pinning to it puts a boundary AT `START`
    // itself (the virgin-store catch-up fires immediately, at t=0) with
    // every later one landing on a clean +1_000ms mark — making every fire
    // count asserted in this file reproducible regardless of wall-clock time
    // at test-run.
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('runs the orphan scan exactly once, at startup, before any tick', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      // #738: the scheduler no longer exempts the default `SMOKE_TEST_UNIVERSE`
      // (BTC-USD) from the calendar gate, and `START` (12:00 UTC) is outside
      // `UsEquityRegularHoursCalendar` — this test is about the orphan-scan
      // ordering, not the calendar, so it forces the plan open the same way
      // `smoke-run.ts` does.
      tradingCalendar: new AlwaysOpenCalendar(),
    });
    const orchestrator = buildProductionOrchestrator(config);
    const scanSpy = vi.spyOn(orchestrator.orphanScanner, 'scan');
    const runSpy = vi
      .spyOn(orchestrator.tickRunner, 'runInstrument')
      .mockResolvedValue({ trace_id: 't', final_stage: 'analysts' });

    await orchestrator.start();
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalled();

    await orchestrator.stop();
  });

  /**
   * #1321, through the REAL composition root rather than `fill-sync.test.ts`'s
   * direct calls. The control arm is built unconditionally (no env flag,
   * `buildControlArmWiring` above), so `start()` always runs both arms'
   * startup reconcile — the exact call pair whose trace ids collapsed onto one
   * literal before this fix. A wiring regression that passed `RECONCILE_TRACE_ID`
   * (the live constant) to the control arm's call in `production.ts` would
   * leave `fill-sync.test.ts` green — that file never touches `production.ts`'s
   * wiring — so this is the test that actually pins the composition root, not
   * just the module.
   */
  it("start() gives each arm's startup reconcile its own trace_id (#1321)", async () => {
    const logger = recordingLogger();
    const config = stubConfig(db, {
      logger,
      tradingCalendar: new AlwaysOpenCalendar(),
    });
    const orchestrator = buildProductionOrchestrator(config);

    await orchestrator.start();

    const completions = logger.entries.filter((e) => e.message === 'startup reconcile complete');
    expect(completions).toHaveLength(2);
    expect(completions.map((e) => e.trace_id).sort()).toEqual(
      [RECONCILE_TRACE_ID, CONTROL_RECONCILE_TRACE_ID].sort(),
    );
    expect(RECONCILE_TRACE_ID).not.toEqual(CONTROL_RECONCILE_TRACE_ID);

    await orchestrator.stop();
  });

  /**
   * #1321 round 2. The case above pins `runStartupReconcile`'s one-shot call,
   * but 7 of the 10 lines #1321 relabelled are in `runPoll` — the RECURRING
   * fill-sync loop, not the startup call — and nothing exercised that path:
   * `start()`/`stop()` never drives a poll (the loop only fires on its own
   * `setTimeout`, which this file's default `fillPollIntervalMs` and the
   * absence of any `vi.advanceTimersByTimeAsync` here both leave unfired), so
   * a regression that passed the LIVE constants to the control arm's
   * `startFillSync` call (production.ts) — as opposed to its
   * `runStartupReconcile` call, a different call site — left the case above
   * green. Confirmed by reverting that call to `reconcileTraceId:
   * RECONCILE_TRACE_ID, fillSyncTraceId: FILL_SYNC_TRACE_ID` locally: all
   * other tests in this file (170) still passed.
   *
   * Rather than drive an actual poll (which would need both arms' real
   * `ingestFills()` to reject in a controlled way, through two independently
   * constructed broker/store stacks — the control arm's `SimulatedBrokerAdapter`
   * is a different instance from the live arm's `broker`, so there is no
   * single seam to fail both from), this asserts directly on the
   * `startFillSync` call site itself via `startFillSyncSpy` (defined at the
   * top of this file) — the exact deps object each arm's LOOP is armed with,
   * which is what the recurring `runPoll` lines actually read.
   *
   * Asserts positionally, not as a sorted set: production.ts calls
   * `startFillSync` for the control arm first, then the live arm,
   * unconditionally and with nothing branching between the two calls (see the
   * call site) — a property of the composition root this test is pinning, not
   * an incidental detail. A sorted-set comparison would pass if the two
   * calls' trace-id arguments were swapped (live arm gets the control pair
   * and vice versa) — exactly the copy-paste shape a regression here would
   * take, and worse than the bug #1321 fixes: the live arm's loop would then
   * log as `control-arm-*` and get silently filtered out by anything modelled
   * on #1319's `NOT LIKE '%:control'` pattern.
   */
  it("start() gives each arm's recurring fill-sync loop its own trace_id (#1321)", async () => {
    const config = stubConfig(db, {
      tradingCalendar: new AlwaysOpenCalendar(),
    });
    const orchestrator = buildProductionOrchestrator(config);

    startFillSyncSpy.mockClear();
    await orchestrator.start();

    expect(startFillSyncSpy).toHaveBeenCalledTimes(2);
    const [controlDeps] = startFillSyncSpy.mock.calls[0];
    const [liveDeps] = startFillSyncSpy.mock.calls[1];

    expect(controlDeps.reconcileTraceId).toBe(CONTROL_RECONCILE_TRACE_ID);
    expect(controlDeps.fillSyncTraceId).toBe(CONTROL_FILL_SYNC_TRACE_ID);
    expect(liveDeps.reconcileTraceId).toBe(RECONCILE_TRACE_ID);
    expect(liveDeps.fillSyncTraceId).toBe(FILL_SYNC_TRACE_ID);

    await orchestrator.stop();
  });

  /**
   * The composition root is the only place that can compose the flatten tail —
   * it holds both `traderConfig.flatten_before_close_ms` and the equity
   * calendar, and the scheduler holds neither. So it is also the only place
   * this can be verified end to end, and `stocks-tick-window.test.ts` alone
   * would be a tested mechanism nothing calls: exactly the shape that let
   * `LseRegularHoursCalendar` ship with no production caller (#668).
   */
  describe('the equity tick window reaches the flatten (#706)', () => {
    const WEDNESDAY_16_26 = new Date('2026-08-19T16:26:00+01:00');
    const WEDNESDAY_16_00 = new Date('2026-08-19T16:00:00+01:00');

    const windowedConfig = (now: Date, pinLse: boolean) =>
      stubConfig(db, {
        clock: new SimulatedClock(now),
        // Pinned for the London cases rather than left to `mode: 'paper'`,
        // which resolves the US calendar and puts the close at 16:00 ET — five
        // hours from these London instants and untestable against the LSE
        // window. Left unpinned for the venue case below, which is about
        // exactly that resolution.
        ...(pinLse ? { tradingCalendar: new LseRegularHoursCalendar() } : {}),
        stocksTradingWindow: londonEntryWindow(),
        universe: [{ asset: 'LQQ3', asset_class: 'stocks', subclass: 'index_etp_3x' }],
        // #734: this was `3USL` until that ticket. Both are LSE ETPs, but the
        // pool declares 3USL in USD, which the mark source now refuses at
        // construction rather than mid-tick — so a case about the tick WINDOW
        // would have failed for a currency reason. `LQQ3` is the same shape of
        // instrument and is declared in GBX. The composition root also refuses
        // to build a source for an LSE ticker without a vendor client rather
        // than routing it to Alpaca, which does not list it; nothing here reads
        // a price, so a stub satisfies that seam.
        lseMarkClient: {
          vendor: 'stub-lse-vendor',
          getBars: vi.fn(async () => ({ currency: 'GBP', candles: [] })),
          getLatestQuote: vi.fn(async () => ({
            price: 100,
            currency: 'GBP',
            observed_at: now,
          })),
        },
        tickIntervalMs: 1_000,
        heartbeatIntervalMs: 1_000,
      });

    const ranAt = async (now: Date, pinLse = true): Promise<boolean> => {
      const config = windowedConfig(now, pinLse);
      // The tail is `flatten_before_close_ms` wide, so 16:26 is only inside it
      // while that is 5 minutes. Asserted, not assumed — a stub drifting to a
      // narrower window would make the positive case below silently vacuous.
      expect(config.traderConfig.flatten_before_close_ms).toBe(5 * 60_000);

      const orchestrator = buildProductionOrchestrator(config);
      const runSpy = vi
        .spyOn(orchestrator.tickRunner, 'runInstrument')
        .mockResolvedValue({ trace_id: 't', final_stage: 'analysts' });

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await orchestrator.stop();

      return runSpy.mock.calls.length > 0;
    };

    it('ticks equities at 16:26, inside the flatten window', async () => {
      // The assertion the original #706 change needed and did not have. The
      // Trader is the only thing that flattens and it runs on a tick, so with
      // the bare entry window this is `false` and flat-by-close silently stops
      // running — `trader_log` reading exactly like a session with nothing to
      // flatten, the same signature #691 found on a non-positive window.
      expect(await ranAt(WEDNESDAY_16_26)).toBe(true);
    });

    it('still does not tick equities at 16:00, outside both spans', async () => {
      // The narrowing must survive the fix. If the tail had been implemented by
      // widening the entry window instead of unioning a separate span, this is
      // the test that would catch it.
      expect(await ranAt(WEDNESDAY_16_00)).toBe(false);
    });

    it('resolves the tail through the mode-selected calendar, not a pinned venue', async () => {
      // The tail derives from `sessionEnd`, and `sessionEnd` is per venue:
      // `equityCalendarFor` returns LSE in `live` and US in `paper`, and the
      // Trader flattens against `sessionCalendars.stocks`, which is that same
      // function on that same config. The two are separate INSTANCES — the
      // component root builds one and this root builds another — so what makes
      // them agree is that the function is pure and the calendars hold no
      // state. Both halves are load-bearing, and neither is visible from the
      // London cases above, which pin the calendar and so would pass against a
      // hard-coded LSE tail.
      //
      // 15:56 ET is 20:56 London: past the LSE close, inside the US session,
      // and five minutes from the US close. It ticks only if the tail resolved
      // through the calendar `mode: 'paper'` selects.
      expect(await ranAt(new Date('2026-08-19T15:56:00-04:00'), false)).toBe(true);
    });
  });

  it('fires the heartbeat on its own interval, independent of the tick cadence', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 10_000,
      heartbeatIntervalMs: 1_000,
    });
    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockResolvedValue({
      trace_id: 't',
      final_stage: 'analysts',
    });

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(config.heartbeatChannel.postHeartbeat).toHaveBeenCalledTimes(3);
    await orchestrator.stop();
  });

  it('defaults the heartbeat to the soak cadence, not the tick cadence (#342)', async () => {
    // #342: at 60s the dead-man's-switch posts ~20k messages over the 14-day
    // soak (#238) and the operator mutes the chat. The default is the external
    // watchdog's staleness threshold — 15 minutes — and `heartbeatIntervalMs`
    // stays the knob for anything that wants it tighter.
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15 * 60_000);

    const config = stubConfig(db, { tickIntervalMs: 100_000 });
    // No `heartbeatIntervalMs` — the default is what is under test.
    expect(config.heartbeatIntervalMs).toBeUndefined();
    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockResolvedValue({
      trace_id: 't',
      final_stage: 'analysts',
    });

    await orchestrator.start();
    // A minute in — where the old default had already posted once.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(config.heartbeatChannel.postHeartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_MS - 60_000);
    expect(config.heartbeatChannel.postHeartbeat).toHaveBeenCalledTimes(1);
    await orchestrator.stop();
  });

  it('stop() halts both the heartbeat and the tick loop', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
    });
    const orchestrator = buildProductionOrchestrator(config);
    const runSpy = vi
      .spyOn(orchestrator.tickRunner, 'runInstrument')
      .mockResolvedValue({ trace_id: 't', final_stage: 'analysts' });

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await orchestrator.stop();

    const beats = (config.heartbeatChannel.postHeartbeat as ReturnType<typeof vi.fn>).mock.calls
      .length;
    const ticks = runSpy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(
      (config.heartbeatChannel.postHeartbeat as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(beats);
    expect(runSpy.mock.calls.length).toBe(ticks);
  });

  it('polls Polymarket again on the configured interval, not just at startup (#504)', async () => {
    // Nothing else covers the repeating poll. `stubConfig` parks the interval
    // at NO_POLYMARKET_POLL_MS for every other case in this file, and the
    // smoke gate cannot reach it either — its 15-minute default against a run
    // that finishes in seconds means only the startup refresh is observed
    // there. Deleting the `setInterval` in `production.ts` would otherwise
    // leave the whole suite green, which is this repo's signature defect.
    let fetches = 0;
    const countingClient = new PolymarketClient({
      rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
      fetchImpl: (async () => {
        fetches += 1;
        throw new Error('offline: the test suite must not reach Polymarket');
      }) as unknown as typeof fetch,
    });

    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, {
        tickIntervalMs: 1_000,
        polymarketClient: countingClient,
        polymarketPollIntervalMs: 60_000,
      }),
    );
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockResolvedValue({
      trace_id: 't',
      final_stage: 'analysts',
    });

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(0);
    const afterStartup = fetches;
    expect(afterStartup).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches).toBeGreaterThan(afterStartup);

    await orchestrator.stop();
    const afterStop = fetches;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetches).toBe(afterStop);
  });

  it('stop() is idempotent', async () => {
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, { tickIntervalMs: 1_000, heartbeatIntervalMs: 1_000 }),
    );
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockResolvedValue({
      trace_id: 't',
      final_stage: 'analysts',
    });
    await orchestrator.start();
    await orchestrator.stop();
    await expect(orchestrator.stop()).resolves.toBeUndefined();
  });

  it('leaves the daily feedback cycle unstarted when it is not configured', async () => {
    const logger = recordingLogger();
    const config = stubConfig(db, {
      logger,
      tickIntervalMs: 48 * 60 * 60 * 1_000,
      heartbeatIntervalMs: 48 * 60 * 60 * 1_000,
      fillPollIntervalMs: NO_FILL_POLL_MS,
      ...quietFlattenOverrides(48 * 60 * 60 * 1_000),
    });
    const orchestrator = buildProductionOrchestrator(config);

    await orchestrator.start();
    // Well past the 24h default cycle: with no `feedback` block, no cycle runs.
    await vi.advanceTimersByTimeAsync(47 * 60 * 60 * 1_000);
    expect(logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle')).toHaveLength(0);

    // ...but it is no longer SILENT about it (#327). Unstarted-by-omission is
    // the failure mode: the run looks healthy and learns nothing.
    const startupWarns = logger.entries.filter(
      (entry) => entry.stage === 'feedback-loop' && entry.trace_id === 'startup',
    );
    expect(startupWarns).toHaveLength(1);
    expect(startupWarns[0]?.level).toBe('warn');
    expect(startupWarns[0]?.message).toContain('ProductionConfig.feedback');
    // Names the kill-lines that consequently never run.
    expect(startupWarns[0]?.message).toContain('pbo_over_max');
    await orchestrator.stop();
  });

  it('REFUSES TO BOOT when a kill line is configured past its in-code clamp (#638)', () => {
    // ADR-0013 makes the numeric thresholds the only stop left, so a config
    // edit was the entire distance between the running system and an arbitrary
    // risk limit. Refusing the process is the correct answer — a silent clamp
    // would read as accepted and leave the operator believing a limit is in
    // force that is not.
    const config = stubConfig(db, {
      feedback: {
        intervalMs: 1_000,
        config: {
          weights: { max_step: 0.05, floor: 0.5, ceiling: 1.5, tighten_is: 'decrease' },
          kill_thresholds: {
            // The one hard kill criterion in the whole record, softened tenfold.
            max_pbo: 0.5,
            min_oos_sharpe: 0.5,
            min_deflated_sharpe: 0.95,
            max_live_backtest_divergence: 0.5,
          },
        } as unknown as FeedbackConfig,
        loosenNotices: { notifyLoosenApplied: vi.fn() } as never,
      },
    });

    expect(() => buildProductionOrchestrator(config)).toThrow(/max_pbo/);
    expect(() => buildProductionOrchestrator(config)).toThrow(/REFUSED, not clamped/);
  });

  it('runs the daily feedback cycle on its own timer when configured', async () => {
    const logger = recordingLogger();
    const config = stubConfig(db, {
      logger,
      tickIntervalMs: 100_000,
      heartbeatIntervalMs: 100_000,
      feedback: {
        intervalMs: 1_000,
        // Only the `weights` band is filled in, because the startup seeder
        // (#371) reads it before the first cycle — the `{}` this used to be
        // was a cast past a required field, not a valid config. Everything
        // else stays empty on purpose: this case is about the TIMER firing,
        // and `runDailyCycle`'s own throw on the rest is caught and logged as
        // one of the two `feedback-cycle` entries asserted below.
        config: {
          weights: { max_step: 0.05, floor: 0.5, ceiling: 1.5, tighten_is: 'decrease' },
        } as unknown as FeedbackConfig,
        loosenNotices: { notifyLoosenApplied: vi.fn() } as never,
      },
    });
    const orchestrator = buildProductionOrchestrator(config);

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const cycleEntries = logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle');
    // 3, not 2: #1110 makes a virgin schedule fire on `start()` itself (the
    // bug it fixes is exactly "a restarted process never accumulates a full
    // interval of uptime"), then two more at the 1s-interval boundaries
    // `advanceTimersByTimeAsync(2_000)` crosses.
    expect(cycleEntries).toHaveLength(3);

    // No `metrics` block, so the kill-line detector is still inert — and says
    // so at startup rather than leaving it to be discovered (#327).
    // Narrowed to the WARNS since #371: startup also emits an `info` naming
    // the analyst-weight rows the seeder wrote. The property this case is
    // about is that the metrics warn is the only degraded-mode warning left.
    const metricsWarn = logger.entries.filter(
      (entry) =>
        entry.trace_id === 'startup' && entry.stage === 'feedback-loop' && entry.level === 'warn',
    );
    expect(metricsWarn).toHaveLength(1);
    expect(metricsWarn[0]?.level).toBe('warn');
    expect(metricsWarn[0]?.message).toContain('FeedbackCycleConfig.metrics');

    await orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    // Still 3 — `stop()`'s `clearTimeout` actually cancels the pending
    // re-arm, matching the count asserted above rather than the pre-#1110
    // count of 2.
    expect(logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle')).toHaveLength(3);
  });

  /**
   * #971 — the matched control's comparison has a production caller.
   *
   * Every unit of `runArmComparisonCycle` can pass while nothing in the
   * composition root calls it, which is this repo's dominant defect class and
   * exactly what happened to `buildArmComparison` before this ticket: it was
   * reachable only from `yarn report:arms`, when a human remembered to run it.
   *
   * The `metrics` block is deliberately ABSENT here. The comparison must run on
   * a cycle with no `MetricsSuite` — it is derived from `closed_trades`, not
   * from the equity series — and nesting it inside `runMetricsCheck` (which
   * returns early with no suite) would have left it silently un-run for most of
   * a soak.
   */
  describe('the arm comparison runs on the daily feedback cycle (#971)', () => {
    const CLOSED_AT = new Date(START.getTime() - 24 * 60 * 60 * 1_000);

    function insertTrade(arm: 'live' | 'control', index: number, pnl: number): void {
      db.prepare(
        `INSERT INTO closed_trades (
           idempotency_key, debate_id, instrument, asset_class, side, entry, stop,
           filled_size, realized_pnl_net, fees_total, opened_at, closed_at, close_reason, arm
         ) VALUES (?, ?, '3LTS', 'stocks', 'buy', 100, 95, 1, ?, 0, ?, ?, 'target', ?)`,
      ).run(
        `${arm}-${index}`,
        `debate-${arm}-${index}`,
        pnl,
        new Date(CLOSED_AT.getTime() - 60_000).toISOString(),
        new Date(CLOSED_AT.getTime() + index * 1_000).toISOString(),
        arm,
      );
    }

    function feedbackOnlyConfig(overrides: Partial<ProductionConfig> = {}): StubConfig {
      return stubConfig(db, {
        tickIntervalMs: 48 * 60 * 60 * 1_000,
        heartbeatIntervalMs: 48 * 60 * 60 * 1_000,
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...quietFlattenOverrides(48 * 60 * 60 * 1_000),
        feedback: {
          intervalMs: 1_000,
          config: paperStartingProfile('paper').feedback?.config as FeedbackConfig,
        },
        ...overrides,
      });
    }

    it('computes and persists a sample with no metrics source configured', async () => {
      const logger = recordingLogger();
      const orchestrator = buildProductionOrchestrator(feedbackOnlyConfig({ logger }));

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await orchestrator.stop();

      const computed = logger.entries.filter(
        (entry) => entry.message === 'arm comparison computed',
      );
      // 2 log lines, not 1: #1110's virgin-store catch-up fires once on
      // `start()`, then the 1s boundary fires again inside the 1_000ms
      // advance below. Both log — logging happens on every cycle regardless
      // of whether the DB row changes.
      expect(computed).toHaveLength(2);
      // Both arms, both columns — a log line carrying a return without its
      // drawdown would re-open doc 12 D4 at the surface.
      const payload = computed[0]?.payload as {
        live: { return_pct: number; max_drawdown_pct: number };
        control: { return_pct: number; max_drawdown_pct: number };
      };
      expect(payload.live.max_drawdown_pct).toBeTypeOf('number');
      expect(payload.control.max_drawdown_pct).toBeTypeOf('number');

      // Still 1 ROW: `stubConfig`'s default `clock` is a `SimulatedClock`
      // frozen at `START` (never advanced by this test), so both cycles
      // compute the identical `computed_at` and `INSERT OR REPLACE`
      // (migration 0034) collapses them — this collapsing was already the
      // suite's behavior pre-#1110, not something the restart-durable
      // schedule changes.
      const rows = db.prepare('SELECT diverged FROM arm_comparison_samples').all() as {
        diverged: number;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.diverged).toBe(0);
    });

    it('alerts through the armDivergenceAlerts slot when the control dominates', async () => {
      for (let i = 0; i < 5; i += 1) {
        insertTrade('live', i, -1);
        insertTrade('control', i, 4);
      }
      const postArmDivergenceAlert = vi.fn();
      const orchestrator = buildProductionOrchestrator(
        feedbackOnlyConfig({ armDivergenceAlerts: { postArmDivergenceAlert } }),
      );

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await orchestrator.stop();

      // 2, not 1 — see the boot-catch-up comment above; the alert channel is
      // called per cycle, unaffected by the store's `INSERT OR REPLACE`.
      expect(postArmDivergenceAlert).toHaveBeenCalledTimes(2);
      const alert = postArmDivergenceAlert.mock.calls[0]?.[0] as {
        comparison: {
          live: { return_pct: number; max_drawdown_pct: number };
          control: { return_pct: number; max_drawdown_pct: number };
        };
      };
      expect(alert.comparison.control.return_pct).toBeGreaterThan(alert.comparison.live.return_pct);
      expect(alert.comparison.control.max_drawdown_pct).toBeLessThanOrEqual(
        alert.comparison.live.max_drawdown_pct,
      );

      const rows = db.prepare('SELECT diverged FROM arm_comparison_samples').all() as {
        diverged: number;
      }[];
      expect(rows[0]?.diverged).toBe(1);
    });

    /**
     * #1112 AC3 — the comparison's denominator and the Trader's sizing
     * denominator resolve from ONE source, made falsifiable rather than
     * asserted by code review.
     *
     * Both halves of that are load-bearing, and each one alone is a test that
     * cannot fail. `production.ts`'s `runArmComparison` closes over the
     * `LIVE_BOOK_SIZING_USD` module constant directly for `basis` — it does
     * not read `config.capitalCeilingUsd` at all — so:
     *
     * - The expectation must be read off `config`, the object actually handed
     *   to `buildProductionOrchestrator`, not re-derived from a second
     *   independent `paperStartingProfile('paper')` call. Otherwise both sides
     *   are the module constant and the assertion holds for any ceiling the
     *   running config carries, `undefined` included.
     * - The config's ceiling must come from the PROFILE, not from an inline
     *   `LIVE_BOOK_SIZING_USD` literal here. `stubConfig` (which `feedbackOnlyConfig`
     *   builds on) declares no ceiling of its own, so an inline literal pins
     *   two references to one constant and survives `paperStartingProfile`
     *   dropping `capitalCeilingUsd` entirely — the #1112 defect itself.
     */
    it('the arm comparison basis and the paper sizing ceiling are the same value (#1112)', async () => {
      // Spread conditionally under `exactOptionalPropertyTypes`, matching
      // `paper-profile.ts`'s own idiom: a profile that stopped declaring a
      // ceiling leaves it ABSENT here, and the final assertion then compares
      // the persisted `basis` against `undefined` and fails, which is the
      // point.
      const ceiling = paperStartingProfile('paper').capitalCeilingUsd;
      const config = feedbackOnlyConfig(
        ceiling === undefined ? {} : { capitalCeilingUsd: ceiling },
      );
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await orchestrator.stop();

      const row = db
        .prepare('SELECT basis FROM arm_comparison_samples ORDER BY computed_at DESC LIMIT 1')
        .get() as { basis: number } | undefined;
      expect(row?.basis).toBeDefined();
      expect(row?.basis).toBe(config.capitalCeilingUsd);
    });
  });

  /**
   * #981 — the outside benchmarks have a production caller, asserted THROUGH
   * the real composition root.
   *
   * The smoke gate's probe drives `runOutsideBenchmarkCycle` directly, so it
   * proves the cycle works and proves nothing about the wiring: deleting
   * `runOutsideBenchmarks(comparison)` from `runFeedbackCycle` would leave
   * `yarn smoke` green. This case is the one that goes red — it starts the
   * real orchestrator, lets FL's own timer fire, and reads
   * `outside_benchmark_samples`.
   *
   * The series is injected (`benchmarkSeriesSource`) rather than faked at the
   * vendor: the DEFAULT path builds its Alpaca client on first read and there
   * is no credential here, which is the point of that seam. What is under test
   * is the call site, not the vendor.
   */
  describe('the outside benchmarks run on the daily feedback cycle (#981)', () => {
    const DAY_MS = 24 * 60 * 60 * 1_000;

    /**
     * Resolves synchronously with an already-built array — no timer, no I/O —
     * so a single `advanceTimersByTimeAsync` drains the fire-and-forget
     * `.then()` chain the composition root attaches.
     *
     * The pad before `from` is required, not decorative: `buildOutsideBenchmark`
     * refuses to measure without an anchor bar at or before the window start,
     * and without it both benchmarks would land in `unmeasured` and this case
     * would read a wiring failure that isn't one.
     */
    class FakeBenchmarkSeries implements BenchmarkSeriesSource {
      readonly instruments: string[] = [];

      async getDailyCloses(
        instrument: string,
        from: Date,
        to: Date,
      ): Promise<BenchmarkObservation[]> {
        this.instruments.push(instrument);
        const observations: BenchmarkObservation[] = [];
        let close = 100;
        let day = 0;
        for (let t = from.getTime() - 3 * DAY_MS; t <= to.getTime(); t += DAY_MS) {
          // A dip partway through, deliberately: a monotonic series has a
          // drawdown of exactly 0, which `Number.isFinite` would accept from a
          // hardcoded zero column just as happily. This makes the persisted
          // drawdown a measurement the assertion can actually distinguish.
          close *= day === 4 ? 0.97 : 1.001;
          day += 1;
          observations.push({ close_time: new Date(t), close });
        }
        return observations;
      }
    }

    function feedbackOnlyConfig(overrides: Partial<ProductionConfig> = {}): StubConfig {
      return stubConfig(db, {
        tickIntervalMs: 48 * 60 * 60 * 1_000,
        heartbeatIntervalMs: 48 * 60 * 60 * 1_000,
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...quietFlattenOverrides(48 * 60 * 60 * 1_000),
        feedback: {
          intervalMs: 1_000,
          config: paperStartingProfile('paper').feedback?.config as FeedbackConfig,
        },
        ...overrides,
      });
    }

    it('persists a benchmark row per benchmark, over the arm comparison window', async () => {
      const series = new FakeBenchmarkSeries();
      const logger = recordingLogger();
      const orchestrator = buildProductionOrchestrator(
        feedbackOnlyConfig({ benchmarkSeriesSource: series, logger }),
      );

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await orchestrator.stop();

      // Both legs of both benchmarks were asked for — SPY twice (it is the
      // 60/40's equity leg too), AGG once.
      expect(series.instruments).toContain('SPY');
      expect(series.instruments).toContain('AGG');

      const rows = db
        .prepare(
          'SELECT benchmark, window_from, window_to, max_drawdown_pct FROM outside_benchmark_samples',
        )
        .all() as {
        benchmark: string;
        window_from: string;
        window_to: string;
        max_drawdown_pct: number;
      }[];
      expect(rows.map((row) => row.benchmark).sort()).toEqual(['sixty_forty', 'spy']);
      // Return AND drawdown together, persisted (doc 12 D4). The series dips,
      // so a real measurement is strictly positive — a zero here would mean the
      // column was defaulted rather than computed.
      expect(rows.every((row) => Number.isFinite(row.max_drawdown_pct))).toBe(true);
      expect(rows.every((row) => row.max_drawdown_pct > 0)).toBe(true);

      // The window is the arm comparison's own, to the millisecond — inherited,
      // never recomputed (#636).
      const armWindows = db
        .prepare('SELECT window_from, window_to FROM arm_comparison_samples')
        .all() as { window_from: string; window_to: string }[];
      expect(armWindows).toHaveLength(1);
      for (const row of rows) {
        expect(row.window_from).toBe(armWindows[0]?.window_from);
        expect(row.window_to).toBe(armWindows[0]?.window_to);
      }

      // 2, not 1 — #1110's boot catch-up fires once immediately, then the 1s
      // boundary fires again inside the advance above; each cycle logs.
      expect(
        logger.entries.filter((entry) => entry.message === 'outside benchmarks computed'),
      ).toHaveLength(2);
    });
  });

  /**
   * #987 item 1 — the case above proves `buildBenchmarkDataSource` itself is
   * universe-independent, but it INJECTS `benchmarkSeriesSource`, so it can
   * never notice `production.ts`'s wiring reverting to the pre-#986 defect
   * (`benchmarkSeries` rebuilt from `marketData`/`buildAlpacaDataSource`
   * instead of `components.benchmarkSeries`/`buildBenchmarkDataSource`).
   * Verified red-first: temporarily reverting that one construction back to
   * `new MarketDataBenchmarkSeriesSource(marketData)` fails this case (rows
   * come back empty — the SPY rejection happens in a fire-and-forget path and
   * does not surface directly in the assertion diff) while leaving every
   * other case in this file green, including the injected-override case
   * directly above.
   *
   * So this drives the REAL default wiring end to end: an LSE-only universe,
   * no `benchmarkSeriesSource` override, and a real (lazily-built)
   * `AlpacaHttpDataClient('stocks', ...)` underneath — with only `fetch`
   * itself stubbed, at the HTTP boundary `buildDefaultAlpacaDataClient`
   * ultimately calls, the same technique `alpaca-http-client.test.ts` and
   * the OHLCV-failover block below use. `ALPACA_API_KEY`/`_SECRET` are
   * placeholders only, matching the #734 LSE-leg block's pattern above —
   * nothing here makes a real request.
   */
  describe('the outside benchmarks survive the LSE cutover through the DEFAULT wiring (#987)', () => {
    const DAY_MS = 24 * 60 * 60 * 1_000;
    const LSE_UNIVERSE = [
      { asset: 'LQQ3', asset_class: 'stocks' as const },
      { asset: '3SPY', asset_class: 'stocks' as const },
    ];

    beforeEach(() => {
      vi.stubEnv('ALPACA_API_KEY', 'dummy-key-not-a-credential');
      vi.stubEnv('ALPACA_API_SECRET', 'dummy-secret-not-a-credential');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    const lseClient = (): LseMarkClient => ({
      vendor: 'fake-lse-vendor',
      getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
      getLatestQuote: vi.fn(async () => ({ price: 31_240, currency: 'GBp', observed_at: START })),
    });

    /**
     * Answers `GET /v2/stocks/{symbol}/bars` with one daily close per
     * calendar day spanning the request's own `start`/`end` — the only
     * endpoint this path reaches (`getDailyCloses` never marks, so
     * `/quotes/latest` is never requested). A dip partway through for the
     * same reason `FakeBenchmarkSeries` above dips: a monotonic series has a
     * drawdown of exactly 0, indistinguishable from a defaulted column.
     */
    function stocksBarsFetchMock() {
      return vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (!parsed.pathname.includes('/bars')) {
          throw new Error(`unexpected fetch in test: ${url}`);
        }
        const startParam = parsed.searchParams.get('start');
        const endParam = parsed.searchParams.get('end');
        if (startParam === null || endParam === null) {
          throw new Error(`expected start/end query params in test: ${url}`);
        }
        const start = new Date(startParam);
        const end = new Date(endParam);
        const bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> =
          [];
        let close = 100;
        // `AlpacaHttpClient.getBars` widens `start` by `BUFFER_MULTIPLIER` (8x)
        // and then trims the response to the most recent `limit` rows via
        // `.slice(-limit)` — so a dip indexed off `start` in a wide request
        // (as this fixture's was) gets sliced away entirely before it ever
        // reaches `buildOutsideBenchmark`, and never shows up in the computed
        // series. Index off `end` instead: `DIP_DAYS_BEFORE_END` days before
        // `end` survives the slice (well inside the last `limit` rows) AND
        // lands inside the comparison window, not the anchor pad before it
        // (`ANCHOR_PAD_BARS` days older than the window start).
        const DIP_DAYS_BEFORE_END = 10;
        for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
          const daysBeforeEnd = Math.round((end.getTime() - t) / DAY_MS);
          close *= daysBeforeEnd === DIP_DAYS_BEFORE_END ? 0.97 : 1.001;
          bars.push({
            t: new Date(t).toISOString(),
            o: close,
            h: close + 1,
            l: close - 1,
            c: close,
            v: 1_000,
          });
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => ({ bars }),
          text: async () => JSON.stringify({ bars }),
        } as Response;
      });
    }

    function lseFeedbackOnlyConfig(overrides: Partial<ProductionConfig> = {}): StubConfig {
      return stubConfig(db, {
        universe: LSE_UNIVERSE,
        lseMarkClient: lseClient(),
        tickIntervalMs: 48 * 60 * 60 * 1_000,
        heartbeatIntervalMs: 48 * 60 * 60 * 1_000,
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...quietFlattenOverrides(48 * 60 * 60 * 1_000),
        feedback: {
          intervalMs: 1_000,
          config: paperStartingProfile('paper').feedback?.config as FeedbackConfig,
        },
        ...overrides,
      });
    }

    it('persists SPY/AGG-derived benchmark rows through the real orchestrator, with no benchmarkSeriesSource override', async () => {
      vi.stubGlobal('fetch', stocksBarsFetchMock());
      const logger = recordingLogger();
      const orchestrator = buildProductionOrchestrator(lseFeedbackOnlyConfig({ logger }));

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await orchestrator.stop();

      const rows = db
        .prepare('SELECT benchmark, max_drawdown_pct FROM outside_benchmark_samples')
        .all() as { benchmark: string; max_drawdown_pct: number }[];

      expect(rows.map((row) => row.benchmark).sort()).toEqual(['sixty_forty', 'spy']);
      expect(rows.every((row) => Number.isFinite(row.max_drawdown_pct))).toBe(true);
      // The fixture dips `DIP_DAYS_BEFORE_END` days before `end` so drawdown !=
      // 0 — assert that for the `spy` row so this can't pass on a defaulted 0
      // column.
      expect(rows.find((row) => row.benchmark === 'spy')?.max_drawdown_pct).toBeGreaterThan(0);

      // 2, not 1 — #1110's boot catch-up fires once immediately, then the 1s
      // boundary fires again inside the advance above; each cycle logs.
      expect(
        logger.entries.filter((entry) => entry.message === 'outside benchmarks computed'),
      ).toHaveLength(2);
    });
  });

  /**
   * #1110 — see `scheduleFeedbackCycle`'s doc comment (production.ts) for
   * what this fixes and why.
   *
   * These drive the real composition root through repeated boot/stop cycles
   * on the SAME store (`db` is never recreated between them, only the
   * orchestrator instance is — the honest shape of a process restart) and
   * assert directly on `arm_comparison_samples`, the table #1110 reports as
   * permanently empty. `scheduleFeedbackCycle`'s own doc comment carries the
   * recorded design decisions this exercises end to end rather than merely
   * by construction.
   */
  describe('the daily cycle survives process restarts (#1110)', () => {
    /**
     * `clock` is a parameter, not a default, because these cases need it to
     * ADVANCE in lockstep with the fake timers driving the schedule (see
     * `advanceBoth` below) — the opposite of every other case in this file,
     * which relies on `stubConfig`'s frozen default specifically so repeat
     * fires collapse to one row via `INSERT OR REPLACE`. Collapsing is
     * exactly what these cases must NOT do: distinct rows per day are the
     * property under test.
     */
    function restartDurableConfig(
      clock: SimulatedClock,
      intervalMs: number,
      overrides: Partial<ProductionConfig> = {},
    ): StubConfig {
      return stubConfig(db, {
        clock,
        tickIntervalMs: 48 * 60 * 60 * 1_000,
        heartbeatIntervalMs: 48 * 60 * 60 * 1_000,
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...quietFlattenOverrides(48 * 60 * 60 * 1_000),
        feedback: {
          intervalMs,
          config: paperStartingProfile('paper').feedback?.config as FeedbackConfig,
        },
        ...overrides,
      });
    }

    function sampleRows(): { computed_at: string; window_from: string; window_to: string }[] {
      return db
        .prepare(
          'SELECT computed_at, window_from, window_to FROM arm_comparison_samples ORDER BY computed_at',
        )
        .all() as { computed_at: string; window_from: string; window_to: string }[];
    }

    /**
     * Scoped to `key = 'default'` (the COMPLETED boundary) — not a bare
     * `SELECT`, because pass-2's `key = 'attempt'` row (finding 1) can now
     * share this table, and an unscoped query would return whichever of the
     * two rows SQLite happens to return first.
     */
    function feedbackScheduleLastBoundary(): string | null {
      const row = db
        .prepare("SELECT last_boundary FROM feedback_cycle_schedule WHERE key = 'default'")
        .get() as { last_boundary: string } | undefined;
      return row?.last_boundary ?? null;
    }

    /** Scoped to `key = 'attempt'` — see `feedbackScheduleLastBoundary` above. */
    function feedbackScheduleAttemptedBoundary(): string | null {
      const row = db
        .prepare("SELECT last_boundary FROM feedback_cycle_schedule WHERE key = 'attempt'")
        .get() as { last_boundary: string } | undefined;
      return row?.last_boundary ?? null;
    }

    /**
     * Moves BOTH time sources #1110 deliberately keeps separate
     * (`scheduleFeedbackCycle`'s DESIGN DECISION 1 comment): the fake
     * `Date`/timers the scheduler reads, and the injected `clock` the
     * cycle's own business timestamps (`computed_at`, the window) read. They
     * are independent by design and nothing keeps them in lockstep
     * automatically — a real process needs no such helper because `clock` IS
     * `SystemClock` there, so this exists only because the test wants
     * distinct, dated windows instead of the frozen-clock collapse every
     * other case in this file relies on.
     */
    async function advanceBoth(clock: SimulatedClock, ms: number): Promise<void> {
      clock.advanceTo(new Date(clock.now().getTime() + ms));
      await vi.advanceTimersByTimeAsync(ms);
    }

    /**
     * `advanceBoth`, chunked at every `boundaryMs` boundary in between.
     *
     * `scheduleFeedbackCycle` only ever fires (past the synchronous boot
     * catch-up, which needs no help from this) at an EXACT
     * `currentBoundary` — `nextBoundary`'s delay is computed to land there
     * precisely — so the only place `clock` can be read mid-advance is
     * exactly on a boundary. Chunking there means `clock` is never preset
     * past the instant a fire can actually happen: unlike `advanceBoth`,
     * which sets `clock` to the FAR end of the whole step before any of it
     * elapses (fine when nothing reads `clock` mid-step, wrong here since a
     * boundary fire in the middle would read tomorrow's clock value for
     * today's boundary).
     */
    async function advanceAcrossBoundaries(
      clock: SimulatedClock,
      ms: number,
      boundaryMs: number,
    ): Promise<void> {
      let remaining = ms;
      while (remaining > 0) {
        const now = clock.now().getTime();
        const step = Math.min(remaining, nextBoundary(clock.now(), boundaryMs).getTime() - now);
        await advanceBoth(clock, step);
        remaining -= step;
      }
    }

    it('boots into an immediate catch-up, a sub-interval restart does not re-fire, and an over-interval restart fires exactly once', async () => {
      const clock = new SimulatedClock(START);
      const intervalMs = 1_000;

      // Boot: a virgin schedule/store catches up immediately — #1110's bug
      // was precisely that this never happened on its own.
      const first = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await first.start();
      expect(sampleRows()).toHaveLength(1);
      await first.stop();

      // Sub-interval restart: well under the 1_000ms interval, so the
      // current boundary is unchanged and already stamped by `first` — no
      // second row. Two restarts in a row, to prove "repeated restarts
      // inside one period do not produce repeated cycles for that period"
      // rather than merely "one restart doesn't."
      await advanceBoth(clock, 200);
      const second = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await second.start();
      expect(sampleRows()).toHaveLength(1);
      await second.stop();

      await advanceBoth(clock, 200);
      const third = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await third.start();
      expect(sampleRows()).toHaveLength(1);
      await third.stop();

      // Over-interval restart: down for 10 whole intervals (10_000ms against
      // a 1_000ms interval). A burst-fire bug would produce 10 catch-up rows
      // for the boundaries missed; DESIGN DECISION 2 caps catch-up at
      // exactly one.
      await advanceBoth(clock, 10_000);
      const fourth = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await fourth.start();
      expect(sampleRows()).toHaveLength(2);
      await fourth.stop();
    });

    it('one sample per day, each carrying its own window, over a multi-day run restarted more often than the interval', async () => {
      const DAY_MS = 24 * 60 * 60 * 1_000;
      // A UTC-midnight-aligned start, so `currentBoundary` lands exactly on
      // calendar days — the same alignment DESIGN DECISION 1 gets for free
      // in production from epoch-anchoring.
      const DAY0 = new Date('2026-08-01T00:00:00.000Z');
      vi.setSystemTime(DAY0);
      const clock = new SimulatedClock(DAY0);

      // 5h, not a divisor of the 24h interval: every restart lands at a
      // different phase of the day, so no restart boundary can coincide with
      // a day boundary and leave the "did the boundary check happen just
      // before or just after the restart" case unexercised.
      const RESTART_GAP_MS = 5 * 60 * 60 * 1_000;
      // 15 restarts * 5h = 75h — enough to cross all three of the next
      // calendar days (at the 24h/48h/72h marks) while still restarting
      // between every crossing, not just once per day.
      const RESTARTS = 15;

      for (let i = 0; i < RESTARTS; i += 1) {
        const orchestrator = buildProductionOrchestrator(
          restartDurableConfig(clock, DAY_MS, { logger: recordingLogger() }),
        );
        await orchestrator.start();

        // Checked once, well before the first day boundary (20h elapsed,
        // 4h short of the 24h mark): four restarts in, still exactly the
        // one boot-catch-up row — proving the frequent restarts alone,
        // absent an actual day boundary, produce nothing extra.
        if (i === 3) {
          expect(sampleRows()).toHaveLength(1);
        }

        await advanceAcrossBoundaries(clock, RESTART_GAP_MS, DAY_MS);
        await orchestrator.stop();
      }

      const rows = sampleRows();
      // One row for the initial boot (day 0) plus one for each of the three
      // day boundaries the 75h run crossed — despite 15 separate restarts.
      expect(rows).toHaveLength(4);

      // Each row's own window: consecutive `window_to` values exactly one
      // day apart, never merged and never skipped — spacing alone. Also
      // `window_from` (#1110 finding 6): the arm comparison's window is a
      // ROLLING `DEFAULT_ARM_COMPARISON_WINDOW_MS` lookback from `now`
      // (`from = now - window_ms`, arm-comparison-cycle.ts), not a sliding
      // window chained to the previous row's `window_to` — so the invariant
      // finding 6 is actually after is that the span stays constant as
      // `window_to` advances. A regression that pinned `window_from` to the
      // run's start (cumulative windows instead of rolling ones) would still
      // pass a `window_to`-only check, and cumulative windows would corrupt
      // the #753 comparison silently, but a GROWING span here catches it.
      for (let i = 1; i < rows.length; i += 1) {
        const prevTo = new Date(rows[i - 1]?.window_to as string).getTime();
        const currTo = new Date(rows[i]?.window_to as string).getTime();
        const currFrom = new Date(rows[i]?.window_from as string).getTime();
        expect(currTo - prevTo).toBe(DAY_MS);
        expect(currTo - currFrom).toBe(DEFAULT_ARM_COMPARISON_WINDOW_MS);
      }
    });

    it('a throwing schedule store still re-arms the timer, and a later boundary fires once the store recovers (finding 1)', async () => {
      const clock = new SimulatedClock(START);
      const intervalMs = 1_000;
      const logger = recordingLogger();

      const orchestrator = buildProductionOrchestrator(
        restartDurableConfig(clock, intervalMs, { logger }),
      );
      // The boot catch-up runs with the table intact, so it is `start()`'s
      // OWN startup-log read of `lastBoundary()` (a separate call site, not
      // `runIfDue`) that this test must not disturb — sabotage happens only
      // after `start()` returns.
      await orchestrator.start();
      expect(sampleRows()).toHaveLength(1);

      // Sabotage the table: the NEXT scheduled `runIfDue` — armed by the
      // boot catch-up's own `finally` — throws reading `lastBoundary()`
      // instead of getting `null`/a real boundary, simulating a transient
      // `SQLITE_BUSY` from the shared WAL file the service-api process also
      // reads.
      db.exec('DROP TABLE feedback_cycle_schedule');
      await advanceBoth(clock, intervalMs);

      // Before this fix, an uncaught throw here left the re-arm — the
      // function's last statement — never reached, and the cycle never fired
      // again for the rest of the process's life, silently.
      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'feedback-cycle' &&
            entry.level === 'error' &&
            entry.message.includes('feedback cycle pass failed'),
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(sampleRows()).toHaveLength(1);

      // The store recovers (a transient failure clearing on its own) and the
      // timer — which DID re-arm despite the throw — fires the next boundary.
      db.exec(
        'CREATE TABLE feedback_cycle_schedule (key TEXT PRIMARY KEY, last_boundary TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      await advanceBoth(clock, intervalMs);

      expect(sampleRows().length).toBeGreaterThanOrEqual(2);
      expect(feedbackScheduleLastBoundary()).not.toBeNull();

      await orchestrator.stop();
    });

    it('a throwing schedule store at the startup-log call site does not crash start() — it logs and lets the guarded runIfDue read decide', async () => {
      const clock = new SimulatedClock(START);
      const intervalMs = 1_000;
      const logger = recordingLogger();

      const orchestrator = buildProductionOrchestrator(
        restartDurableConfig(clock, intervalMs, { logger }),
      );

      // Sabotage BEFORE `start()`, not after: this is `start()`'s own direct
      // `lastBoundary()` call for the startup log (production.ts, just above
      // `scheduleFeedbackCycle`), a separate call site from `runIfDue`'s
      // guarded one. Before the fix this line threw an uncaught
      // `SqliteError` straight out of `start()` — dropping the table after
      // `start()` returns (as "finding 1" above does) never exercises it,
      // because by then the startup log has already read successfully.
      db.exec('DROP TABLE feedback_cycle_schedule');

      await expect(orchestrator.start()).resolves.toBeDefined();

      // The startup-log read failure is reported on its own, distinct from
      // `runIfDue`'s "feedback cycle pass failed" message.
      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'startup' &&
            entry.level === 'error' &&
            entry.message.includes('could not read the feedback cycle schedule store at startup'),
        ).length,
      ).toBe(1);

      // `runIfDue` runs synchronously inside `start()` too (same table, same
      // failure) — it must be guarded the same way, not left to throw just
      // because the startup log already swallowed its own copy of the error.
      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'feedback-cycle' &&
            entry.level === 'error' &&
            entry.message.includes('feedback cycle pass failed'),
        ).length,
      ).toBeGreaterThanOrEqual(1);

      // Neither call site could read the store, so no cycle ran yet — the
      // operator-facing `info` line must not claim a catch-up that did not
      // happen (the read failed, so `feedbackDueNow` cannot be trusted).
      expect(sampleRows()).toHaveLength(0);
      const feedbackScheduleInfoLines = logger.entries.filter(
        (entry) =>
          entry.trace_id === 'startup' &&
          entry.stage === 'feedback-loop' &&
          entry.level === 'info' &&
          entry.message.includes('daily feedback cycle'),
      );
      expect(feedbackScheduleInfoLines).toHaveLength(1);
      expect(feedbackScheduleInfoLines[0]?.message).toContain('UNKNOWN');
      expect(feedbackScheduleInfoLines[0]?.message).not.toContain(
        'catching up on the current boundary',
      );
      expect(feedbackScheduleInfoLines[0]?.payload).toMatchObject({
        stored_boundary_read_failed: true,
      });

      // The store recovers and the timer — which still re-armed despite both
      // failures — catches up on its next fire.
      db.exec(
        'CREATE TABLE feedback_cycle_schedule (key TEXT PRIMARY KEY, last_boundary TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      await advanceBoth(clock, intervalMs);

      expect(sampleRows()).toHaveLength(1);
      expect(feedbackScheduleLastBoundary()).not.toBeNull();

      await orchestrator.stop();
    });

    it('an unrenderable attempt-marker failure still runs the cycle and re-arms — #1351', async () => {
      const clock = new SimulatedClock(START);
      const intervalMs = 1_000;
      const logger = recordingLogger();

      // Same hostile shape as the #1262 tick-loop test above: circular
      // (defeats `JSON.stringify`) with a throwing `Symbol.toPrimitive`
      // (defeats the `String()` fallback too).
      const hostile: Record<string, unknown> = {
        [Symbol.toPrimitive]: () => {
          throw new Error('render boom');
        },
      };
      hostile.self = hostile;

      // Sabotages ONLY `recordAttempt` (production.ts:3648, the "BEFORE
      // `runFeedbackCycle`" write), not `recordBoundary` or `lastBoundary` —
      // isolates the `attemptError` catch (production.ts:3665) from the
      // schedule-store failures the two tests above already cover.
      const recordAttemptSpy = vi
        .spyOn(SqliteFeedbackCycleScheduleStore.prototype, 'recordAttempt')
        .mockImplementationOnce(() => {
          throw hostile;
        });

      const orchestrator = buildProductionOrchestrator(
        restartDurableConfig(clock, intervalMs, { logger }),
      );
      await orchestrator.start();

      // Before the fix, rendering `hostile` inside the `attemptError` catch's
      // own log-payload construction threw and escaped the catch — skipping
      // `runFeedbackCycle(feedback)` (production.ts:3669) and
      // `recordBoundary` (production.ts:3672) below it, so the boot
      // catch-up's cycle would be silently lost rather than merely
      // unmarked-as-attempted.
      expect(sampleRows()).toHaveLength(1);
      expect(feedbackScheduleLastBoundary()).not.toBeNull();

      // The catch's own diagnostic line must land, and with the guard's
      // fixed placeholder — proof the render itself did not throw, not just
      // proof that something downstream recovered.
      const attemptFailure = logger.entries.find(
        (entry) =>
          entry.trace_id === 'feedback-cycle' && entry.event === 'feedback_attempt_marker_failed',
      );
      expect(attemptFailure?.payload).toEqual({ error: '[unrenderable error]' });

      recordAttemptSpy.mockRestore();
      await orchestrator.stop();
    });

    /** The dial `dialAdjustmentValues` and the finding-1/5 test below tune. */
    const RISK_DIAL_NAME = 'max_position_size_fraction_of_equity';
    const RISK_DIAL_SHIPPED = 0.05;

    /**
     * `to_value`s recorded for one risk-threshold dial, oldest first — for
     * counting steps. Scoped to `dial_type = 'risk_threshold'` too, not just
     * `dial_name`, since an analyst weight and a risk threshold could share a
     * name and this helper must not silently mix their rows.
     */
    function dialAdjustmentValues(dialName: string): number[] {
      return (
        db
          .prepare(
            "SELECT to_value FROM dial_adjustments WHERE dial_type = 'risk_threshold' AND dial_name = ? ORDER BY id",
          )
          .all(dialName) as { to_value: number }[]
      ).map((row) => row.to_value);
    }

    /**
     * A restart-durable config whose feedback cycle has real, unconditional
     * tuning work to do — a `risk_threshold` proposal, rather than the bare
     * zero-trade cycle every other case in this describe block uses. Needed
     * to observe whether a restart-driven retry applies the guardrail-capped
     * step a SECOND time (finding 1), which a zero-trade cycle can never show
     * since it has no dial to move.
     */
    function restartDurableConfigWithDial(
      clock: SimulatedClock,
      intervalMs: number,
      overrides: Partial<ProductionConfig> = {},
    ): StubConfig {
      return restartDurableConfig(clock, intervalMs, {
        riskConfig: {
          [RISK_DIAL_NAME]: RISK_DIAL_SHIPPED,
        } as ProductionConfig['riskConfig'],
        feedback: {
          intervalMs,
          config: paperStartingProfile('paper').feedback?.config as FeedbackConfig,
          // Target the dial's own floor (a quarter of `RISK_DIAL_SHIPPED`,
          // `capDial` in paper-profile.ts) — far enough below the ceiling
          // that two consecutive `max_step` moves both land short of it, so
          // a double-apply is visible as two distinct `to_value`s rather than
          // both moves being swallowed by the same floor clamp.
          proposals: [
            { kind: 'risk_threshold', name: RISK_DIAL_NAME, target: RISK_DIAL_SHIPPED * 0.25 },
          ],
        },
        ...overrides,
      });
    }

    it(
      'records the boundary AFTER the cycle runs — a schedule-store write failure does not erase ' +
        'the cycle work, and a restart does not re-run it a second time (finding 1 / finding 5)',
      async () => {
        const clock = new SimulatedClock(START);
        const intervalMs = 1_000;
        const logger = recordingLogger();

        // Blocks writes to the COMPLETION row only (`key = 'default'`) — the
        // attempt row (`key = 'attempt'`) still writes
        // successfully, so `runIfDue` reaches `runFeedbackCycle` and only the
        // trailing `recordBoundary` fails. Isolates the store call the
        // ordering note above is about from the cycle's own (unrelated) work.
        db.exec(`
        CREATE TRIGGER block_schedule_write
        BEFORE INSERT ON feedback_cycle_schedule
        WHEN NEW.key = 'default'
        BEGIN
          SELECT RAISE(ABORT, 'simulated write failure');
        END;
      `);

        const first = buildProductionOrchestrator(
          restartDurableConfigWithDial(clock, intervalMs, { logger }),
        );
        await first.start();

        // The cycle's own substantive work ran and persisted despite the
        // trailing schedule write failing — proof `runFeedbackCycle` is called
        // BEFORE `recordBoundary`, not gated behind a successful write. One
        // guardrail-capped step applied: 0.05 - 0.005 = 0.045.
        expect(sampleRows()).toHaveLength(1);
        expect(dialAdjustmentValues(RISK_DIAL_NAME)).toEqual([0.045]);
        expect(feedbackScheduleLastBoundary()).toBeNull();
        expect(feedbackScheduleAttemptedBoundary()).not.toBeNull();
        expect(
          logger.entries.filter(
            (entry) =>
              entry.trace_id === 'feedback-cycle' &&
              entry.level === 'error' &&
              entry.message.includes('feedback cycle pass failed'),
          ).length,
        ).toBeGreaterThanOrEqual(1);
        await first.stop();

        // Restart with the write no longer blocked. The boundary was never
        // stamped complete, so it is still "due" — but it WAS attempted, so
        // the retry must not run `runFeedbackCycle` again (finding 1): doing
        // so would apply the risk-threshold guardrail step a second time,
        // 0.045 -> 0.04, silently doubling the per-cycle move the guardrail
        // exists to cap. `clock` (not the wall-clock boundary check) advances
        // a little, the way a restart's own elapsed time naturally would.
        db.exec('DROP TRIGGER block_schedule_write');
        clock.advanceTo(new Date(clock.now().getTime() + 500));
        const secondLogger = recordingLogger();
        const second = buildProductionOrchestrator(
          restartDurableConfigWithDial(clock, intervalMs, { logger: secondLogger }),
        );
        await second.start();

        // Still exactly one sample and one dial step — the retry recorded
        // completion for the already-attempted boundary without re-running
        // the cycle.
        expect(sampleRows()).toHaveLength(1);
        expect(dialAdjustmentValues(RISK_DIAL_NAME)).toEqual([0.045]);
        expect(
          secondLogger.entries.filter(
            (entry) =>
              entry.trace_id === 'feedback-cycle' &&
              entry.level === 'warn' &&
              entry.message.includes('already attempted'),
          ),
        ).toHaveLength(1);
        expect(feedbackScheduleLastBoundary()).not.toBeNull();

        await second.stop();
      },
    );

    it('a stop() followed by a second start() on the SAME orchestrator re-arms the feedback cycle (#1110)', async () => {
      const clock = new SimulatedClock(START);
      const intervalMs = 1_000;
      const orchestrator = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));

      await orchestrator.start();
      expect(sampleRows()).toHaveLength(1);
      await orchestrator.stop();

      // `stop()` sets `feedbackScheduleStopped = true`. Before pass-2's fix
      // nothing ever reset it back to `false` — `scheduleFeedbackCycle`'s own
      // `runIfDue` only checks it inside the `finally` AFTER a pass
      // completes, so this SAME builder's second `start()` below would run
      // its boot catch-up cycle once (unconditional on the flag) and then
      // have the `finally` refuse to re-arm for anything after it — #1110's
      // exact symptom through a third door, on a second `start()` rather
      // than a fresh process.
      await advanceBoth(clock, 10_000);
      const beforeSecondStart = sampleRows().length;
      await orchestrator.start();
      // Boot catch-up on the second `start()`: `runIfDue`'s `try` body never
      // reads `feedbackScheduleStopped` (only the `finally`, to decide
      // re-arming), so this catch-up runs regardless of the reset above —
      // this assertion would still pass even under the missing-reset
      // regression. What actually discriminates that regression is the
      // re-arm assertion below: without the reset, `stop()`'s stale `true`
      // survives into this `finally` and blocks the timer from ever being
      // armed again.
      expect(sampleRows().length).toBeGreaterThan(beforeSecondStart);

      // The re-arm, not just the boot catch-up: a normal fire past the
      // second `start()` must still happen too — proven the same way, by an
      // increase, not by an exact count that also depends on boundary phase.
      const beforeNextTick = sampleRows().length;
      await advanceBoth(clock, intervalMs);
      expect(sampleRows().length).toBeGreaterThan(beforeNextTick);

      await orchestrator.stop();
    });

    it.each([
      [0, /FeedbackCycleConfig\.intervalMs must be positive, got 0/],
      // `NaN <= 0` and `Infinity <= 0` are both `false`,
      // so the bare `<= 0` guard let both through — `currentBoundary` then
      // produced an Invalid Date and boot died at `.toISOString()` with a
      // bare, unattributed `RangeError` instead of this named message.
      [Number.NaN, /FeedbackCycleConfig\.intervalMs must be positive, got NaN/],
      [Number.POSITIVE_INFINITY, /FeedbackCycleConfig\.intervalMs must be positive, got Infinity/],
    ])(
      'refuses to start with a non-finite or non-positive FeedbackCycleConfig.intervalMs ' +
        '(%p), naming the cause (#1110)',
      async (intervalMs, expectedMessage) => {
        const clock = new SimulatedClock(START);
        const orchestrator = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));

        // Not a regression to soften: the plain `setInterval(fn, 0)` this
        // schedule replaced would have hot-looped on the same bad config, so
        // failing loudly at boot is strictly better. The fix is naming the
        // cause instead of letting `cycle-schedule.ts`'s generic
        // "intervalMs must be positive" surface with no mention of which
        // config field produced it.
        await expect(orchestrator.start()).rejects.toThrow(expectedMessage);
      },
    );
  });

  /**
   * #366 — `ProductionConfig.feedback` had no supplier, so the `#327` warn
   * above fired on every real paper start and the daily timer never began. A
   * 14-day soak (#238) therefore ran 5 of the 6 pipeline stages while looking
   * healthy.
   *
   * These drive the CHECKED-IN profile through the real composition root, not
   * a stub config: the bug was precisely that the shipped entrypoint's config
   * lacked a field, which a hand-built test config can never reproduce.
   */
  describe('feedback cycle wiring for a paper soak (#366)', () => {
    /** Long enough that the tick/heartbeat timers stay out of the way. */
    const QUIET = 48 * 60 * 60 * 1_000;

    /**
     * The flatten window has to be parked alongside the tick (#670), or
     * `assertFlattenWindowCoversTickInterval` refuses the boot before any of
     * these cases run.
     *
     * That refusal is CORRECT and not something to route around: flat-by-close
     * is evaluated on a tick, so a 48-hour tick against the profile's 5-minute
     * window is a config in which nothing would ever flatten. These cases park
     * the tick because they are about feedback-cycle wiring and want the timers
     * out of the way — so the honest expression of that intent is to park the
     * window too, rather than to leave a config asserting something about
     * flattening that the tick rate cannot deliver.
     */
    const QUIET_FLATTEN_WINDOW = MIN_TICKS_INSIDE_FLATTEN_WINDOW * QUIET;

    /**
     * Returns the logger alongside the config rather than making each caller
     * dig it back out of `config.logger` behind a cast — the recording type is
     * the thing every case here asserts on.
     */
    function paperProfileConfig(overrides: Partial<ProductionConfig> = {}): {
      config: ProductionConfig;
      logger: ReturnType<typeof recordingLogger>;
    } {
      const logger = recordingLogger();
      const config = stubConfig(db, {
        ...paperStartingProfile('paper'),
        // Narrowed to one asset class on purpose (#381, and unaffected by
        // #738's later narrowing of `DEFAULT_UNIVERSE` itself to
        // equities-only): `stubConfig` injects a single `alpacaDataClient`,
        // which `buildAlpacaDataSource` correctly REFUSES for a mixed
        // universe (one wire client cannot serve both Alpaca path roots).
        // These cases are about the feedback cycle, so they hold the
        // market-data wiring at the shape they were written against; a
        // MIXED universe and its routing source are asserted directly,
        // elsewhere in this file (`MIXED_UNIVERSE`).
        universe: SMOKE_TEST_UNIVERSE,
        logger,
        tickIntervalMs: QUIET,
        heartbeatIntervalMs: QUIET,
        traderConfig: {
          ...paperStartingProfile('paper').traderConfig,
          flatten_before_close_ms: QUIET_FLATTEN_WINDOW,
          // #1389's grace is the same argument one bell later, and one tick is
          // all `assertFlattenWindowCoversTickInterval` requires of it.
          flatten_after_close_ms: QUIET,
        },
        // ...but the grace is ALSO bounded above by gate 2a's mark-age ceiling
        // (`assertFlattenGraceWithinMarkAge`), so parking the tick raises that
        // ceiling too or no config exists at all. Spread the profile's own
        // `verdictConfig` rather than casting a fresh one: the two fields these
        // cases do not care about (`max_signal_age`, `drift_tolerance_pct`) are
        // the profile's real values and there is no reason to lose them.
        verdictConfig: {
          ...paperStartingProfile('paper').verdictConfig,
          max_mark_age: { crypto: QUIET, stocks: QUIET },
        },
        // #528: none of these cases exercise fill-sync — see NO_FILL_POLL_MS.
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...overrides,
      });
      return { config, logger };
    }

    it('starts the daily cycle, with neither not_started nor a missing-feedback warn', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // Past the 24h default cadence the profile deliberately does not
      // override.
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1_000);

      // The two things a paper start must no longer emit.
      expect(
        logger.entries.filter(
          (entry) => (entry.payload as { feedback_cycle?: string } | undefined)?.feedback_cycle,
        ),
      ).toHaveLength(0);
      expect(
        logger.entries.filter((entry) => entry.message.includes('ProductionConfig.feedback')),
      ).toHaveLength(0);

      // ...and the cycle really ran, rather than merely not warning. 2, not
      // 1: #1110's boot catch-up fires immediately on a virgin store (START
      // is midday, so the FIRST UTC-midnight boundary after boot falls ~12h
      // in, well inside the 25h advance), then the wall-clock boundary fires
      // once more.
      expect(
        logger.entries.filter((entry) => entry.message === 'daily feedback cycle complete'),
      ).toHaveLength(2);

      await orchestrator.stop();
    });

    it('no longer warns that metrics is unset — the profile supplies it (#379)', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();

      // The inversion #379 decided. #345 left `metrics` unset and this warn
      // fired for the whole soak; the profile now supplies the real
      // series-backed source, so a paper start must NOT report the detector as
      // unwired.
      expect(
        logger.entries.filter((entry) =>
          entry.message.includes('FeedbackCycleConfig.metrics is not set'),
        ),
      ).toHaveLength(0);
      expect(
        logger.entries.filter(
          (entry) =>
            (entry.payload as { kill_lines?: string } | undefined)?.kill_lines === 'not_evaluated',
        ),
      ).toHaveLength(0);

      // ...and the wiring is announced rather than left silent: the first
      // cycle is 24h away and the first SUITE is a quarter away, so an
      // operator reading startup gets the state from the log, not by inference.
      const wired = logger.entries.find(
        (entry) =>
          (entry.payload as { metrics_source?: string } | undefined)?.metrics_source === 'wired',
      );
      expect(wired?.level).toBe('info');
      expect(wired?.trace_id).toBe('startup');

      await orchestrator.stop();
    });

    it('says at startup that the other three kill-lines have no revalidation input', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(3 * 25 * 60 * 60 * 1_000);

      // The half of the removed "metrics is not set" warn that #375 does not
      // cover — CONDITIONAL since #579: with no usable frozen Stage 2
      // selection in the store, the three snapshot-gated lines are un-run on
      // every cycle, and wiring `metrics` must not turn that from stated into
      // merely true.
      const gated = logger.entries.filter((entry) =>
        entry.message.includes('evaluated ONLY from a revalidation snapshot'),
      );
      expect(gated).toHaveLength(1);
      expect(gated[0]?.level).toBe('warn');
      expect(gated[0]?.trace_id).toBe('startup');
      expect(gated[0]?.payload).toMatchObject({
        kill_lines_gated_on_revalidation: [
          'pbo_over_max',
          'oos_sharpe_under_min',
          'dsr_insignificant',
        ],
        persisted_selections: 0,
      });

      await orchestrator.stop();
    });

    it('says at startup that the three kill-lines are ARMED when a fresh Stage 2 selection exists (#579)', async () => {
      // The startup line claimed "no component in this repo produces" a
      // revalidation snapshot long after #384 shipped one, and that stale text
      // is what #579 was filed from. The statement must be read off the same
      // store the metrics source reads, not asserted unconditionally.
      new SqliteStage2SelectionStore(db).record({
        config_hash: 'cfg-1',
        asset_class: 'crypto',
        selected_at: new Date('2026-08-06T23:17:16Z'),
        window: { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z') },
        backtest_sharpe: 1.2,
        oos_sharpe: 0.9,
        fold_sharpes: [0.8, 1.0],
        pbo: 0.55,
        dsr: 0.39,
        n_trials: 24,
        overall_pass: false,
      });
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();

      const armed = logger.entries.filter((entry) =>
        entry.message.includes('ARMED by the frozen Stage 2 selection'),
      );
      expect(armed).toHaveLength(1);
      expect(armed[0]?.level).toBe('info');
      expect(armed[0]?.trace_id).toBe('startup');
      expect(armed[0]?.payload).toMatchObject({
        selections: [{ asset_class: 'crypto', pbo: 0.55, dsr: 0.39 }],
      });
      expect(
        logger.entries.filter((entry) =>
          entry.message.includes('evaluated ONLY from a revalidation snapshot'),
        ),
      ).toHaveLength(0);

      await orchestrator.stop();
    });

    it('keeps #375 visible: the divergence kill-line is announced inert at startup', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // Three cadences. The announcement is a property of the frozen config,
      // not of the day, so repeating it daily for 14 days would be noise.
      await vi.advanceTimersByTimeAsync(3 * 25 * 60 * 60 * 1_000);

      // This is the warn that would have been SWALLOWED by wiring `metrics`:
      // it used to be emitted on the first computed suite, and the gate puts
      // that ~60 sessions out, while the blanket "all four kill-lines stay
      // unevaluated" warn that covered it is now correctly gone.
      const inert = logger.entries.filter((entry) =>
        entry.message.includes('live_backtest_divergence_over_max is INERT'),
      );
      expect(inert).toHaveLength(1);
      expect(inert[0]?.level).toBe('warn');
      expect(inert[0]?.trace_id).toBe('startup');
      expect(inert[0]?.payload).toMatchObject({ backtest_reference_sharpe: 0 });

      await orchestrator.stop();
    });

    /**
     * #736's property, asserted where it actually lives: the store.
     *
     * This describe used to assert the opposite — that a proposed loosening
     * expired unapplied in paper and live. ADR-0013 Decision 2 rejected that
     * state in as many words ("a queue that nobody drains is not a control —
     * it is a permanently-stuck dial that reads as governed"), and these cases
     * now prove the removal end to end, through the real composition root and
     * the real SQLite tuning store rather than a fixture.
     *
     * The profile declares no `risk_thresholds` dial (nothing writes that
     * table yet), so this case adds one and seeds a value — otherwise the
     * path is unreachable and the test would be vacuous.
     */
    function loosenConfig(overrides: Partial<ProductionConfig> = {}): {
      config: ProductionConfig;
      feedback: FeedbackCycleConfig;
      logger: ReturnType<typeof recordingLogger>;
      tuning: SqliteTuningStore;
    } {
      const profileFeedback = paperStartingProfile('paper').feedback;
      if (profileFeedback === undefined) {
        // Narrowed rather than cast: an absent block is the bug #366 fixes, so
        // it must fail here loudly instead of being asserted away.
        throw new Error('paperStartingProfile supplied no feedback block');
      }

      const tuning = new SqliteTuningStore(db, new SimulatedClock(START));
      tuning.setRiskThreshold('max_position_size', 5_000);

      const feedback: FeedbackCycleConfig = {
        intervalMs: 1_000,
        config: {
          ...profileFeedback.config,
          risk_thresholds: {
            max_position_size: {
              max_step: 500,
              floor: 1_000,
              ceiling: 10_000,
              tighten_is: 'decrease',
            },
          },
        },
        // Raising a loss-bounding cap — the move that used to be queued for a
        // human and therefore never made at all.
        proposals: [{ kind: 'risk_threshold', name: 'max_position_size', target: 6_000 }],
      };

      const { config, logger } = paperProfileConfig({ feedback, ...overrides });

      return { config, feedback, logger, tuning };
    }

    it('APPLIES the loosening in paper mode and records it as reversible', async () => {
      const { config, logger, tuning } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // #1110: `start()` already ran the first cycle synchronously (a virgin
      // schedule catches up immediately), so this case's single application
      // is done before any advance. Held under the 1_000ms `intervalMs` so a
      // second boundary — and a second, compounding loosening step — does
      // not also fire; that scenario belongs to the restart/cadence tests,
      // not to this one.
      await vi.advanceTimersByTimeAsync(500);

      // THE assertion of #736, and the exact line this test used to assert the
      // negation of. Bounded to one `max_step`, not the 6,000 proposed.
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_500);
      // ...and it IS written to the audit log: ADR-0013 requires every applied
      // change logged and reversible, and `from` is what reverses it.
      expect(
        db
          .prepare(
            'SELECT from_value AS f, to_value AS t, direction AS d, status AS s ' +
              'FROM dial_adjustments WHERE dial_name = ?',
          )
          .get('max_position_size'),
      ).toEqual({ f: 5_000, t: 5_500, d: 'loosen', s: 'applied' });

      const cycle = logger.entries.find(
        (entry) => entry.message === 'daily feedback cycle complete',
      );
      expect(cycle?.payload).toMatchObject({
        param_updates: { max_position_size: { from: 5_000, to: 5_500, direction: 'loosen' } },
        applied: true,
      });
      // The field that named the queue is gone with it.
      expect(cycle?.payload).not.toHaveProperty('loosen_pending_approval');

      await orchestrator.stop();
    });

    it('falls back to the log-only channel and says the threshold MOVED', async () => {
      const { config, logger } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      // Nothing supplied `loosenNotices`, so the composition root's own
      // stand-in is what the cycle reached — the same default shape
      // `breachAlerts` has.
      const entry = logger.entries.find((e) => e.message.includes('LOOSENING applied'));
      expect(entry?.level).toBe('warn');
      expect(entry?.payload).toMatchObject({ name: 'max_position_size', applied: true });

      await orchestrator.stop();
    });

    it('uses the transport SAMURAI_ALERTS selected when one is supplied', async () => {
      const notifyLoosenApplied = vi.fn();
      const { config, tuning } = loosenConfig({ loosenNotices: { notifyLoosenApplied } });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // #1110: the boot cycle already ran inside `start()`; stay under the
      // 1_000ms interval so a second cycle does not also fire.
      await vi.advanceTimersByTimeAsync(500);

      expect(notifyLoosenApplied).toHaveBeenCalledTimes(1);
      expect(notifyLoosenApplied.mock.calls[0]?.[0]).toMatchObject({
        name: 'max_position_size',
        from: 5_000,
        // The BOUNDED value actually written, not the raw target — one
        // `max_step`, not the 6,000 the proposal asked for.
        to: 5_500,
      });
      // The notice reports the store, whichever channel carries it.
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_500);

      await orchestrator.stop();
    });

    it('still lets an explicit per-cycle loosenNotices override win', async () => {
      const perCycle = vi.fn();
      const topLevel = vi.fn();
      const { config, feedback } = loosenConfig({
        loosenNotices: { notifyLoosenApplied: topLevel },
      });
      const orchestrator = buildProductionOrchestrator({
        ...config,
        feedback: { ...feedback, loosenNotices: { notifyLoosenApplied: perCycle } },
      });

      await orchestrator.start();
      // #1110: the boot cycle already ran inside `start()`; stay under the
      // 1_000ms interval so a second cycle does not also fire.
      await vi.advanceTimersByTimeAsync(500);

      expect(perCycle).toHaveBeenCalledTimes(1);
      expect(topLevel).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    /**
     * #371 — the cycle #366 started could not move an analyst weight, because
     * `analyst_weights` had no writer: `runDailyCycle` steps only an analyst
     * it can already read a row for, so every cycle attributed real trades and
     * then `continue`d past every analyst forever.
     *
     * These drive the whole path through the REAL stores — Execution's
     * `closed_trades` writer, the Debate Engine's `debate_log` writer, the
     * SQLite tuning store and adjustment log — off the checked-in paper
     * profile. Nothing is hand-placed in `analyst_weights`: if the seeder is
     * removed, there is no row and the weight cannot move.
     */
    describe('analyst weight seeding (#371)', () => {
      const DEBATE_ID = 'debate-371';
      /** One `max_step` of the profile's band: (1.5 − 0.5) / 20. */
      const ONE_STEP = 0.05;

      /**
       * A winning long, and the debate that produced it, written through the
       * stores that own those tables.
       *
       * R = realized_pnl_net / (|entry − stop| × filled_size) = 200/100 = +2,
       * the analyst backed it (`final_position: 'bullish'` against a `buy`),
       * and its influence is above `shadow_influence_ceiling` (0.2), so credit
       * is the influence term alone: 0.5 × 2 = +1. `impliedWeight` squashes
       * that to 1.0 + 0.5·tanh(1) ≈ 1.38 — well past one `max_step`, so the
       * cycle's move is the cap, which is what makes the expected value exact.
       */
      async function seedRealTradeAndDebate(): Promise<void> {
        new SqliteDebateLogStore(db).writeLog({
          debate_id: DEBATE_ID,
          instrument: 'BTC-USD',
          bar_timestamp: new Date(START.getTime() - 2 * 60 * 60 * 1_000),
          contributions: [
            {
              analyst_id: 'technical',
              analyst_type: 'technical',
              stance_during_debate: ['bullish', 'bullish'],
              final_position: 'bullish',
              rationale: 'trend intact',
              influence_score: 0.5,
            },
          ],
          direction: 'bullish',
          rounds: 2,
          created_at: new Date(START.getTime() - 2 * 60 * 60 * 1_000),
        });

        await new SqliteExecutionStore(db).applyLotAdvance({
          idempotency_key: 'lot-371',
          fills: [],
          closed_trade: {
            idempotency_key: 'lot-371',
            debate_id: DEBATE_ID,
            instrument: 'BTC-USD',
            asset_class: 'crypto',
            side: 'buy',
            entry: 100,
            stop: 90,
            filled_size: 10,
            realized_pnl_net: 200,
            fees_total: 1,
            opened_at: new Date(START.getTime() - 3 * 60 * 60 * 1_000),
            // Inside the profile's 48h attribution window, at or before `now`.
            closed_at: new Date(START.getTime() - 1 * 60 * 60 * 1_000),
            close_reason: 'target',
            modelled_cost_charged: true,
          },
        });
      }

      function paperConfigWithFastCycle(): ReturnType<typeof paperProfileConfig> {
        const profileFeedback = paperStartingProfile('paper').feedback;
        if (profileFeedback === undefined) {
          throw new Error('paperStartingProfile supplied no feedback block');
        }
        return paperProfileConfig({
          feedback: { ...profileFeedback, intervalMs: 1_000 },
        });
      }

      it('seeds every analyst neutral at startup, then steps the one with a record', async () => {
        await seedRealTradeAndDebate();
        const { config, logger } = paperConfigWithFastCycle();
        const orchestrator = buildProductionOrchestrator(config);
        const tuning = new SqliteTuningStore(db, new SimulatedClock(START));

        await orchestrator.start();

        // Seeded, then immediately cycled — not seeded-then-idle: #1110 makes
        // a virgin schedule catch up inside `start()` itself, so by the time
        // `start()` resolves the root has already seeded every analyst
        // neutral (proven below by the 'analyst weight rows ready' log line's
        // `seeded: [...]`) AND run the one cycle that had real evidence
        // waiting for it. That the seed-then-tune ordering held (rather than
        // the seed being skipped, or the cycle reading a not-yet-seeded row)
        // is exactly what `technical` already having moved off its neutral
        // seed demonstrates.
        expect(tuning.getAnalystWeights()).toEqual({
          technical: 1 + ONE_STEP,
          fundamental: 1,
          sentiment: 1,
        });

        // Held under the 1_000ms `intervalMs` so a second boundary — and a
        // second, compounding attribution of the SAME frozen-clock window's
        // trade — does not also fire; that compounding is real (the window is
        // `(clock.now() − attribution_window_ms, clock.now()]` and this
        // suite's `clock` never advances) but is a distinct property from the
        // one this case tests, and is exercised by
        // `does not reset a tuned weight when the process restarts` instead.
        await vi.advanceTimersByTimeAsync(500);

        // THE assertion #371 exists for: a weight actually moved, off real
        // closed trades joined to a real debate log row.
        const weights = tuning.getAnalystWeights();
        expect(weights.technical).toBeCloseTo(1 + ONE_STEP, 10);
        // No debate record, no evidence, no move — the analysts that did not
        // trade stay exactly where they were seeded.
        expect(weights.fundamental).toBe(1);
        expect(weights.sentiment).toBe(1);

        // ...and it is in the audit trail, not just in the dial.
        const adjustment = db
          .prepare(
            `SELECT dial_type, dial_name, from_value, to_value, reason
               FROM dial_adjustments WHERE dial_type = 'analyst_weight'`,
          )
          .get() as
          | {
              dial_type: string;
              dial_name: string;
              from_value: number;
              to_value: number;
              reason: string;
            }
          | undefined;
        expect(adjustment?.dial_name).toBe('technical');
        expect(adjustment?.from_value).toBe(1);
        expect(adjustment?.to_value).toBeCloseTo(1 + ONE_STEP, 10);
        expect(adjustment?.reason).toBe('attribution');

        expect(
          logger.entries.find(
            (entry) => entry.message === 'analyst weight rows ready for the daily cycle',
          )?.payload,
        ).toEqual({
          seeded: ['technical', 'fundamental', 'sentiment'],
          already_tuned: [],
        });

        await orchestrator.stop();
      });

      /**
       * The fail-fast decision, made testable rather than left as prose (PR
       * #376 review). A store that will not take the seed insert is a BROKEN
       * store — the same handle carries open positions, fills and the broker's
       * bracket index — so `start()` must reject before anything can trade,
       * not log a warn and go on placing orders. This asserts both halves:
       * the rejection, and that no loop was running by then.
       */
      it('refuses to start at all when the store cannot take the seed', async () => {
        const { config } = paperProfileConfig({
          feedback: { config: paperStartingProfile('paper').feedback?.config as FeedbackConfig },
          tickIntervalMs: 100,
          heartbeatIntervalMs: 100,
        });
        // A store that answers every other startup read but cannot be written
        // — the shape a broken/partially-migrated database actually has.
        db.prepare('DROP TABLE analyst_weights').run();

        const orchestrator = buildProductionOrchestrator(config);

        await expect(orchestrator.start()).rejects.toThrow(/analyst_weights/);

        // Nothing was started before it failed: past several heartbeat
        // intervals, the heartbeat has never fired, so neither the fill poll
        // nor the tick loop (both registered after it) can be running either.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(config.heartbeatChannel?.postHeartbeat).not.toHaveBeenCalled();

        await orchestrator.stop();
      });

      /**
       * The restart case, end to end. Over a 14-day soak (#238) the process
       * WILL restart; a seeder that rewrote its neutral value on boot would
       * erase every step the loop had made and leave the run reporting tuning
       * activity while permanently re-flattening itself.
       */
      it('does not reset a tuned weight when the process restarts', async () => {
        await seedRealTradeAndDebate();

        const first = buildProductionOrchestrator(paperConfigWithFastCycle().config);
        await first.start();
        // #1110: `start()` already ran the boot catch-up cycle (step 1). Held
        // under the 1_000ms `intervalMs` so a second boundary does not also
        // fire here — the second step below is deliberately the SECOND
        // process's own boundary crossing, not a second one from the first.
        await vi.advanceTimersByTimeAsync(500);
        await first.stop();

        const tuning = new SqliteTuningStore(db, new SimulatedClock(START));
        const tuned = tuning.getAnalystWeights().technical;
        expect(tuned).toBeCloseTo(1 + ONE_STEP, 10);

        // Second process, same database.
        const { config, logger } = paperConfigWithFastCycle();
        const second = buildProductionOrchestrator(config);
        await second.start();

        // Immediately after startup and before the new process's first cycle:
        // the tuned value survived, and the seeder says it wrote nothing.
        expect(tuning.getAnalystWeights().technical).toBe(tuned);
        expect(
          logger.entries.find(
            (entry) => entry.message === 'analyst weight rows ready for the daily cycle',
          )?.payload,
        ).toEqual({
          seeded: [],
          already_tuned: ['technical', 'fundamental', 'sentiment'],
        });

        // And the second process's cycle carries on from where the first
        // stopped — a second step, not a repeat of the first. `second`'s own
        // boot check (above) found the current boundary already stamped by
        // `first`, so it waited for the NEXT boundary rather than firing
        // immediately — this advance is exactly the remaining half of that
        // 1_000ms interval.
        await vi.advanceTimersByTimeAsync(500);
        expect(tuning.getAnalystWeights().technical).toBeCloseTo(1 + 2 * ONE_STEP, 10);

        await second.stop();
      });
    });
  });

  /**
   * #327 — `computeMetrics` had no production caller, so all four kill-lines
   * were unreachable in a paper run. These assert the EFFECTS of the wiring
   * (an alert posted, a risk threshold actually written), not that a function
   * was invoked: a spy on the call would pass against a stub that does
   * nothing.
   */
  describe('kill-line wiring (#327)', () => {
    const SUITE: MetricsSuite = {
      sharpe: 0.2,
      sortino: 0.3,
      calmar: 0.4,
      max_drawdown: 0.2,
      profit_factor: 1.1,
      expectancy: 0.05,
      skew: 0.1,
      kurtosis: 0.5,
      turnover: 0.3,
      exposure: 0.4,
      per_period_sharpe: 0.0126,
      annualization_factor: 15.87,
      observations: 252,
    };

    function feedbackConfig(): FeedbackConfig {
      const dial = {
        max_step: 0.05,
        floor: 0.1,
        ceiling: 0.9,
        tighten_is: 'decrease' as const,
      };
      return {
        attribution_window_ms: 24 * 60 * 60 * 1_000,
        weights: dial,
        strategy_params: {},
        risk_thresholds: { max_position_size: dial },
        kill_thresholds: {
          max_pbo: 0.05,
          min_oos_sharpe: 0.5,
          min_deflated_sharpe: 0.95,
          max_live_backtest_divergence: 0.5,
        },
      };
    }

    function metricsConfig(
      db: StoreHandle,
      overrides: {
        sample?: DailyMetricsSample | undefined;
        backtest_reference_sharpe?: number;
      } = {},
    ) {
      const logger = recordingLogger();
      const postBreachAlert = vi.fn();
      // Seeded so `autoTighten` has a row to step — an absent threshold is a
      // documented no-op, which would make the test vacuous.
      const tuning = new SqliteTuningStore(db, new SimulatedClock(START));
      tuning.setRiskThreshold('max_position_size', 0.8);

      const config = stubConfig(db, {
        logger,
        tickIntervalMs: 100_000,
        heartbeatIntervalMs: 100_000,
        breachAlerts: { postBreachAlert },
        feedback: {
          intervalMs: 1_000,
          config: feedbackConfig(),
          loosenNotices: { notifyLoosenApplied: vi.fn() },
          metrics: {
            source: {
              getDailyMetrics: () =>
                'sample' in overrides
                  ? overrides.sample
                  : // `revalidation` omitted rather than set to `undefined`:
                    // it is optional on `DailyMetricsSample` and nothing here
                    // supplies a default to override.
                    { daily: SUITE },
            },
            backtest_reference_sharpe: overrides.backtest_reference_sharpe ?? 1.5,
          },
        },
      });

      return { config, logger, postBreachAlert, tuning };
    }

    it('calls computeMetrics from the daily timer: a breaching suite alerts AND auto-tightens', async () => {
      // live sharpe 0.2 vs reference 1.5 = 87% divergence, over the 0.5 line.
      const { config, logger, postBreachAlert, tuning } = metricsConfig(db);
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // #1110: `start()` already ran the boot catch-up cycle. Held under the
      // 1_000ms `intervalMs` so a second boundary — and a second breach alert
      // — does not also fire.
      await vi.advanceTimersByTimeAsync(500);

      // The operator alert actually fired, through the real channel seam.
      expect(postBreachAlert).toHaveBeenCalledTimes(1);
      expect(postBreachAlert.mock.calls[0]?.[0]).toMatchObject({
        breaches: ['live_backtest_divergence_over_max'],
      });
      // ...and the defensive auto-tighten actually WROTE. This is the
      // assertion that goes red if the computeMetrics call is removed.
      expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);

      const breachLog = logger.entries.find((e) => e.message.includes('KILL-THRESHOLD BREACH'));
      expect(breachLog?.level).toBe('error');

      await orchestrator.stop();
    });

    it('records revalidation-skipped lines rather than reporting a clean bill of health', async () => {
      // Healthy divergence, no revalidation snapshot — the shape of an
      // ordinary non-revalidation day.
      const { config, logger, postBreachAlert } = metricsConfig(db, {
        backtest_reference_sharpe: 0.2,
      });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(postBreachAlert).not.toHaveBeenCalled();
      const metricsLog = logger.entries.find((e) => e.message === 'daily metrics computed');
      expect(metricsLog).toBeDefined();
      // Not an empty array: three lines were skipped, not passed.
      expect(metricsLog?.payload).toMatchObject({
        breaches: [],
        not_evaluated: ['pbo_over_max', 'oos_sharpe_under_min', 'dsr_insignificant'],
      });

      await orchestrator.stop();
    });

    it('warns once — not every cycle — that a non-positive reference Sharpe makes divergence inert', async () => {
      const { config, logger } = metricsConfig(db, { backtest_reference_sharpe: 0 });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // Three cycles.
      await vi.advanceTimersByTimeAsync(3_500);

      const inertWarns = logger.entries.filter((e) =>
        e.message.includes('live_backtest_divergence_over_max is INERT'),
      );
      expect(inertWarns).toHaveLength(1);
      expect(inertWarns[0]?.level).toBe('warn');

      // The line is recorded as un-evaluated on every cycle even so.
      const metricsLog = logger.entries.find((e) => e.message === 'daily metrics computed');
      expect(metricsLog?.payload).toMatchObject({
        not_evaluated: [
          'pbo_over_max',
          'oos_sharpe_under_min',
          'dsr_insignificant',
          'live_backtest_divergence_over_max',
        ],
      });

      await orchestrator.stop();
    });

    it('warns every cycle when the source yields no suite, and computes nothing', async () => {
      const { config, logger, postBreachAlert, tuning } = metricsConfig(db, { sample: undefined });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(2_500);

      const skipped = logger.entries.filter((e) =>
        e.message.includes('no daily MetricsSuite this cycle'),
      );
      expect(skipped.length).toBeGreaterThanOrEqual(2);
      expect(skipped[0]?.level).toBe('warn');
      expect(postBreachAlert).not.toHaveBeenCalled();
      // Untouched: nothing was computed, so nothing was tightened.
      expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.8);

      await orchestrator.stop();
    });

    it('a metrics failure does not take the timer or the tuning cycle down', async () => {
      const { config, logger } = metricsConfig(db);
      const feedback = config.feedback as NonNullable<ProductionConfig['feedback']>;
      (feedback.metrics as NonNullable<typeof feedback.metrics>).source = {
        getDailyMetrics: () => {
          throw new Error('metrics source exploded');
        },
      };
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(2_500);

      // Caught and logged, and the timer kept running.
      expect(
        logger.entries.filter((e) => e.message === 'daily feedback cycle failed').length,
      ).toBeGreaterThanOrEqual(2);

      await orchestrator.stop();
    });

    it('#766: posts a threshold-clamp alert when the kill-line check itself is out of bounds', async () => {
      const { config, logger } = metricsConfig(db);
      const postThresholdClampAlert = vi.fn();
      const feedback = config.feedback as NonNullable<ProductionConfig['feedback']>;
      config.thresholdClampAlerts = { postThresholdClampAlert };
      const orchestrator = buildProductionOrchestrator(config);

      // Started with the shipped-valid kill lines — `buildProductionComponents`
      // boot-checks the SAME field (production.ts, ~line 458) and would refuse
      // to construct at all if this were done before `start()`. Mutated in
      // place AFTER boot, so what fails is specifically the PER-CYCLE check
      // (metrics.ts's `assertKillThresholdsWithinBounds` inside
      // `computeMetrics`), not the boot-time one #638 already covers.
      await orchestrator.start();
      feedback.config.kill_thresholds.max_pbo = 0.5; // bound: max 0.05

      await vi.advanceTimersByTimeAsync(1_500);

      expect(
        logger.entries.filter((e) => e.message === 'daily feedback cycle failed').length,
      ).toBeGreaterThanOrEqual(1);
      expect(postThresholdClampAlert).toHaveBeenCalled();
      expect(postThresholdClampAlert.mock.calls[0]?.[0]).toMatchObject({
        where: 'daily-kill-line-check',
        // #1280: this seam runs outside any tick, so it threads the same
        // `'feedback-cycle'` its surrounding lines log under — the in-tick
        // half of the pair is direct-bind.test.ts's `TRACE_ID` assertion.
        trace_id: 'feedback-cycle',
      });

      await orchestrator.stop();
    });

    it('#766: proves by removal — with no channel injected, the cycle still fails the same way', async () => {
      const { config, logger } = metricsConfig(db);
      const feedback = config.feedback as NonNullable<ProductionConfig['feedback']>;
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      feedback.config.kill_thresholds.max_pbo = 0.5;

      await vi.advanceTimersByTimeAsync(1_500);

      expect(
        logger.entries.filter((e) => e.message === 'daily feedback cycle failed').length,
      ).toBeGreaterThanOrEqual(1);

      await orchestrator.stop();
    });
  });

  /**
   * #379 — the paper profile now supplies `metrics`, so `computeMetrics` has a
   * production caller for the first time.
   *
   * These drive the profile's OWN source (`SqliteDailyEquityMetricsSource`)
   * over the real `daily_equity`, `dial_adjustments` and `risk_thresholds`
   * tables, because the property that makes wiring it safe is a store-level
   * one: below the gate nothing is computed and nothing is written. A stubbed
   * source would assert the wiring and prove nothing about the gate, which is
   * the entire safety argument (ADR-0006 §5).
   */
  describe('kill-line detector armed from the paper profile (#379)', () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1_000;
    const SERIES_START = Date.UTC(2026, 0, 1);
    /** One cadence for the daily timer, short enough to advance fake timers over. */
    const CYCLE_MS = 1_000;

    /**
     * `count` observations on consecutive UTC midnights — the spacing
     * `usableRun` requires — wobbling around 100k so the series has non-zero
     * variance (a flat account has no Sharpe and the library rightly throws).
     */
    function seedDailyEquity(count: number): void {
      const store = new SqliteDailyEquityStore(db);
      for (let i = 0; i < count; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, 100_000 + (i % 7) * 250 - i * 3, at, true);
      }
    }

    /**
     * The profile's real feedback block, with two deliberate deviations —
     * without them the auto-tighten path is unreachable and every "nothing was
     * written" assertion below would pass vacuously:
     *
     * - a declared `risk_thresholds` dial with a seeded value, because the
     *   profile declares none (nothing writes that table yet — see
     *   paper-profile.ts);
     * - a positive `backtest_reference_sharpe`, because the profile's 0 makes
     *   the divergence line inert by design (#375).
     *
     * `metrics.source` is the profile's own factory, untouched. That is the
     * thing under test.
     */
    function armedConfig(): {
      config: ProductionConfig;
      logger: ReturnType<typeof recordingLogger>;
      tuning: SqliteTuningStore;
      postBreachAlert: ReturnType<typeof vi.fn>;
    } {
      const profileFeedback = paperStartingProfile('paper').feedback;
      if (profileFeedback?.metrics === undefined) {
        throw new Error('paperStartingProfile supplied no metrics block');
      }

      const logger = recordingLogger();
      const postBreachAlert = vi.fn();
      const tuning = new SqliteTuningStore(db, new SimulatedClock(START));
      tuning.setRiskThreshold('max_position_size', 5_000);

      const config = stubConfig(db, {
        logger,
        tickIntervalMs: 100_000,
        heartbeatIntervalMs: 100_000,
        breachAlerts: { postBreachAlert },
        feedback: {
          intervalMs: CYCLE_MS,
          config: {
            ...profileFeedback.config,
            risk_thresholds: {
              max_position_size: {
                max_step: 500,
                floor: 1_000,
                ceiling: 10_000,
                tighten_is: 'decrease',
              },
            },
          },
          metrics: { ...profileFeedback.metrics, backtest_reference_sharpe: 100 },
        },
      });

      return { config, logger, tuning, postBreachAlert };
    }

    /** Rows the defensive auto-tighten wrote — the only ones `computeMetrics` appends. */
    function autoTightenRows(): number {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM dial_adjustments WHERE reason = ?')
        .get('breach_auto_tighten') as { n: number };
      return row.n;
    }

    it('below the gate: no suite, no autoTighten, no AdjustmentLog row', async () => {
      // MIN observations yield MIN−1 returns — exactly one short of the gate.
      seedDailyEquity(MIN_RETURN_OBSERVATIONS);
      const { config, logger, tuning, postBreachAlert } = armedConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // #1110: `start()` already ran the boot catch-up cycle. Held under
      // `CYCLE_MS` so a second boundary — and a second refusal — does not
      // also fire; this case is about ONE gate check, not the cadence
      // ('logs the refusal once per CYCLE' below covers repeats).
      await vi.advanceTimersByTimeAsync(500);

      // The gate refused, and said why — with the count, so an operator can
      // see the run approaching the threshold rather than merely being under
      // it.
      const refusal = logger.entries.filter((e) => e.message.includes('insufficient observations'));
      expect(refusal).toHaveLength(1);
      expect(refusal[0]?.level).toBe('warn');
      expect(refusal[0]?.payload).toMatchObject({
        usable_returns: MIN_RETURN_OBSERVATIONS - 1,
        required: MIN_RETURN_OBSERVATIONS,
      });
      // Nothing was computed, so nothing may look computed.
      expect(logger.entries.filter((e) => e.message === 'daily metrics computed')).toHaveLength(0);
      expect(postBreachAlert).not.toHaveBeenCalled();
      // THE two store assertions: the threshold is where it was seeded, and
      // the audit log has no defensive-tighten row.
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_000);
      expect(autoTightenRows()).toBe(0);

      await orchestrator.stop();
    });

    it('at the gate: computeMetrics runs, and a breach reaches the real stores', async () => {
      // One more observation than returns required — n observations give n−1.
      seedDailyEquity(MIN_RETURN_OBSERVATIONS + 1);
      // A real closed trade inside the derived window, so the suite's
      // trade-derived fields have something to be derived FROM. Found by
      // mutation: handing the source an empty trade reader passed every other
      // assertion here while silently zeroing turnover, exposure, profit
      // factor and expectancy — the half of the suite an operator reads back.
      await new SqliteExecutionStore(db).applyLotAdvance({
        idempotency_key: 'closed-in-window',
        fills: [],
        closed_trade: {
          idempotency_key: 'closed-in-window',
          debate_id: 'debate-1',
          instrument: 'BTC-USD',
          asset_class: 'crypto',
          side: 'buy',
          entry: 100,
          stop: 90,
          filled_size: 10,
          realized_pnl_net: 50,
          fees_total: 2,
          opened_at: new Date(SERIES_START + 10 * MS_PER_DAY),
          closed_at: new Date(SERIES_START + 11 * MS_PER_DAY),
          close_reason: 'target',
          modelled_cost_charged: true,
        },
      });
      const { config, logger, tuning, postBreachAlert } = armedConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      // #1110: `start()` already ran the boot catch-up cycle. Held under
      // `CYCLE_MS` so a second boundary — and a second breach/tighten — does
      // not also fire.
      await vi.advanceTimersByTimeAsync(500);

      // It ran: a real suite, derived from the real series.
      const computed = logger.entries.find((e) => e.message.includes('daily metrics computed'));
      if (computed === undefined) throw new Error('computeMetrics did not run');
      const daily = (computed.payload as { daily: MetricsSuite }).daily;
      expect(Number.isFinite(daily.sharpe)).toBe(true);
      // The closed trade above reached the suite: turnover is trade-derived,
      // so a zero here means the source was handed no trade reader at all.
      expect(daily.turnover).toBeGreaterThan(0);
      expect(logger.entries.filter((e) => e.message.includes('insufficient observations'))).toEqual(
        [],
      );

      // ...and the effects landed, which is what distinguishes a wired
      // detector from a called one: the live Sharpe is far under the 100
      // reference, so divergence breaches, alerts, and tightens by one step.
      expect(postBreachAlert).toHaveBeenCalledTimes(1);
      expect(postBreachAlert.mock.calls[0]?.[0]).toMatchObject({
        breaches: ['live_backtest_divergence_over_max'],
      });
      expect(tuning.getRiskThresholds().max_position_size).toBe(4_500);
      expect(autoTightenRows()).toBe(1);

      await orchestrator.stop();
    });

    it('builds the source ONCE, at construction, so a bad one fails the start', () => {
      // Found by mutation: resolving the factory inside the cycle instead of
      // here passed every other test. It is not equivalent. The source's own
      // constructor refuses a `minReturnObservations` below the floor
      // (ADR-0006 §5), and a config error of that kind must stop the process
      // it belongs to — resolved per cycle it would instead surface up to 24h
      // later, inside the timer's catch, as one more "daily feedback cycle
      // failed" line in an unattended soak.
      const { config } = armedConfig();
      const feedback = config.feedback as NonNullable<ProductionConfig['feedback']>;
      const construct = vi.fn(() => {
        throw new Error('metrics source refused its config');
      });
      const bad = {
        ...config,
        feedback: {
          ...feedback,
          metrics: { ...(feedback.metrics as DailyMetricsConfig), source: construct },
        },
      };

      expect(() => buildProductionOrchestrator(bad)).toThrow(/refused its config/);
      expect(construct).toHaveBeenCalledTimes(1);
    });

    it('logs the refusal once per CYCLE, not once per tick', async () => {
      seedDailyEquity(MIN_RETURN_OBSERVATIONS);
      const { config, logger } = armedConfig();
      // Ticks an order of magnitude faster than the cycle: a per-tick log
      // would put ~20,000 identical lines into an unattended 14-day soak
      // (#238), which is how the heartbeat's own cadence bug (#342) presented.
      const orchestrator = buildProductionOrchestrator({ ...config, tickIntervalMs: 100 });

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(3 * CYCLE_MS + 500);

      // 4 cycles, not 3: #1110's boot catch-up fires immediately on the
      // virgin schedule, then the three `CYCLE_MS` boundaries this advance
      // crosses. The property under test — once per CYCLE, never per tick —
      // is unaffected by which count is correct, only by whether every
      // firing logs exactly once.
      expect(
        logger.entries.filter((e) => e.message.includes('insufficient observations')),
      ).toHaveLength(4);
      // The orchestrator's own "nothing to check this cycle" line keeps the
      // same cadence — one per cycle, never per tick.
      expect(
        logger.entries.filter((e) => e.message.includes('no daily MetricsSuite this cycle')),
      ).toHaveLength(4);

      await orchestrator.stop();
    });

    it('keeps the divergence line un-evaluated under the profile’s own inert reference (#375)', async () => {
      seedDailyEquity(MIN_RETURN_OBSERVATIONS + 1);
      const profileFeedback = paperStartingProfile('paper').feedback;
      if (profileFeedback?.metrics === undefined) {
        throw new Error('paperStartingProfile supplied no metrics block');
      }
      const logger = recordingLogger();
      const postBreachAlert = vi.fn();
      const config = stubConfig(db, {
        logger,
        tickIntervalMs: 100_000,
        heartbeatIntervalMs: 100_000,
        breachAlerts: { postBreachAlert },
        // Unmodified this time: the profile's `backtest_reference_sharpe: 0`.
        feedback: { ...profileFeedback, intervalMs: CYCLE_MS },
      });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(CYCLE_MS + 500);

      // A computed suite that reports the divergence line as UN-RUN rather
      // than passed — the distinction #327 exists for, and the one #379 must
      // not swallow now that the "metrics is not set" warn is gone.
      const computed = logger.entries.find((e) => e.message === 'daily metrics computed');
      expect(computed?.payload).toMatchObject({
        breaches: [],
        not_evaluated: [
          'pbo_over_max',
          'oos_sharpe_under_min',
          'dsr_insignificant',
          'live_backtest_divergence_over_max',
        ],
      });
      expect(postBreachAlert).not.toHaveBeenCalled();

      await orchestrator.stop();
    });
  });

  it('schedules the narrow smoke universe by default', () => {
    // #738: the scheduler gates `SMOKE_TEST_UNIVERSE`'s BTC-USD on the
    // calendar like any other instrument now — no crypto bypass — so this
    // test forces the gate open the same way `smoke-run.ts` does, to isolate
    // what it actually asserts (the DEFAULT universe, not the calendar).
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, { tradingCalendar: new AlwaysOpenCalendar() }),
    );
    const tickPlan = orchestrator.scheduler.nextTick(new SimulatedClock(START));
    expect(tickPlan.instruments).toEqual([{ asset: 'BTC-USD', asset_class: 'crypto' }]);
  });

  /**
   * Market-data wiring for a universe that spans both asset classes (#381).
   *
   * The hazard is #358's, and it is invisible in fixtures: a `FixtureDataSource`
   * has no endpoint to get wrong, so a mixed universe pointed at one Alpaca
   * path root passes every offline test and 404s on every equity call in
   * production. These cases assert the composition, not the responses.
   */
  describe('buildAlpacaDataSource — mixed-universe market data', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    // #738: `DEFAULT_UNIVERSE` no longer spans both asset classes — crypto is
    // out of Samurai's scope, so the production default is equities-only.
    // These cases are about `buildAlpacaDataSource`'s ROUTING given a mixed
    // universe, which can still be constructed and configured explicitly
    // (`AssetClass`/`UniverseInstrument` still accept a `'crypto'` row) —
    // just no longer the shape the default resolves to.
    const MIXED_UNIVERSE = [
      ...DEFAULT_UNIVERSE,
      { asset: 'BTC-USD', asset_class: 'crypto' as const },
    ];

    // `AlpacaHttpDataClient` refuses to be constructed without credentials, and
    // these cases build the real default clients on purpose — building them is
    // the thing under test. Placeholders only; nothing here makes a request,
    // and no real credential is read or written.
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    beforeEach(() => {
      process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
      process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    });
    afterEach(() => {
      if (savedKey === undefined) delete process.env.ALPACA_API_KEY;
      else process.env.ALPACA_API_KEY = savedKey;
      if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET;
      else process.env.ALPACA_API_SECRET = savedSecret;
    });

    it('routes per instrument when the universe spans crypto and stocks', () => {
      const source = buildAlpacaDataSource({}, MIXED_UNIVERSE, calendar);

      expect(source).toBeInstanceOf(AssetClassRoutingDataSource);
    });

    it('stays a single plain source when the universe holds one asset class', () => {
      // No routing indirection where there is nothing to route — the smoke
      // path keeps exactly the shape it had.
      const source = buildAlpacaDataSource({}, SMOKE_TEST_UNIVERSE, calendar);

      expect(source).toBeInstanceOf(AlpacaDataSource);
    });

    it('serves an all-equity universe from the STOCKS source, not the crypto default', async () => {
      // Found by mutation testing: asserting `universeAssetClasses` in
      // isolation left `buildAlpacaDataSource` free to keep the old
      // `?? 'crypto'` hardcode for the single-class branch, and the whole
      // suite stayed green while an all-equity universe was served from the
      // crypto path root — #358 exactly.
      //
      // Observed through the normalized `Mark`, because that is the only place
      // a source's asset class is visible from outside: `NormalizingDataSource`
      // stamps `asset_class` from the config it was constructed with.
      const source = buildAlpacaDataSource(
        {
          alpacaDataClient: {
            getBars: vi.fn(async (): Promise<AlpacaBar[]> => []),
            getLatestQuote: vi.fn(
              async (): Promise<AlpacaQuote> => ({ t: START.toISOString(), ap: 100, bp: 99 }),
            ),
          },
        },
        [
          { asset: 'SPY', asset_class: 'stocks' },
          { asset: 'AAPL', asset_class: 'stocks' },
        ],
        calendar,
      );

      const mark = await source.fetchMark('SPY', START, 'live');
      expect(mark.asset_class).toBe('stocks');
    });

    it("derives the asset class from the universe rather than defaulting to 'crypto'", () => {
      // The old default was `'crypto'` regardless of what was being traded, so
      // an all-equity universe would have been served entirely from the crypto
      // path root. `universeAssetClasses` is what makes the wiring follow the
      // tick plan.
      expect(universeAssetClasses([{ asset: 'SPY', asset_class: 'stocks' }])).toEqual(['stocks']);
      expect(universeAssetClasses(MIXED_UNIVERSE)).toEqual(['crypto', 'stocks']);
      expect(universeAssetClasses([])).toEqual([]);
    });

    it('refuses a single alpacaDataClient for a mixed universe instead of misrouting half of it', () => {
      // One wire client is built against one path root. Silently applying it to
      // both halves is exactly the #358 outage, so this fails loudly at
      // construction — before any order or any tick.
      expect(() =>
        buildAlpacaDataSource(
          { alpacaDataClient: { getBars: vi.fn(), getLatestQuote: vi.fn() } },
          MIXED_UNIVERSE,
          calendar,
        ),
      ).toThrow(/#358|both/);
    });

    it('refuses a dataSourceAssetClass that contradicts the universe', () => {
      // Found in review: the mixed-universe branch throws, but a CONTRADICTING
      // single-class override used to be obeyed silently — an all-equity
      // universe forced to 'crypto' sends every bars request to
      // /v1beta3/crypto/us and 404s, which is the same #358 misroute one branch
      // over. Both directions are refused now.
      expect(() =>
        buildAlpacaDataSource(
          { dataSourceAssetClass: 'crypto' },
          [{ asset: 'SPY', asset_class: 'stocks' }],
          calendar,
        ),
      ).toThrow(/#358|contradict|holds only/);
    });

    it('still accepts a dataSourceAssetClass that agrees with the universe', () => {
      expect(() =>
        buildAlpacaDataSource({ dataSourceAssetClass: 'crypto' }, SMOKE_TEST_UNIVERSE, calendar),
      ).not.toThrow();
    });

    it('still honours the override for an EMPTY universe, which contradicts nothing', () => {
      // The case the field was added for and the only one left where it
      // decides anything: no instrument asserts an asset class, so there is
      // nothing for the override to disagree with.
      expect(() =>
        buildAlpacaDataSource({ dataSourceAssetClass: 'stocks' }, [], calendar),
      ).not.toThrow();
    });

    it('still honours an injected client for a single-asset-class universe', () => {
      // The narrow case every existing test and the smoke run rely on.
      expect(() =>
        buildAlpacaDataSource(
          { alpacaDataClient: { getBars: vi.fn(), getLatestQuote: vi.fn() } },
          SMOKE_TEST_UNIVERSE,
          calendar,
        ),
      ).not.toThrow();
    });
  });

  /**
   * #734 — the LSE mark source, asserted THROUGH the composition root.
   *
   * Same reason #562's cases below are: `lse-mark-source.test.ts` proves the
   * class works, and this repo's dominant defect is a tested mechanism nothing
   * calls. These cases fail if `buildAlpacaDataSource` stops consulting the
   * pool, which is what would silently send `LQQ3` to an Alpaca endpoint that
   * answers `invalid symbol`.
   */
  describe('buildAlpacaDataSource — the LSE equity leg (#734)', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    // Both declared GBX in the pool. The USD-declared majority gets its own
    // case below — it is the finding, not the happy path.
    const LSE_UNIVERSE = [
      { asset: 'LQQ3', asset_class: 'stocks' as const },
      { asset: '3SPY', asset_class: 'stocks' as const },
    ];
    // The no-LSE regression case below builds the real default Alpaca clients,
    // which refuse to construct without credentials. Placeholders only; nothing
    // here makes a request, and no real credential is read or written.
    const savedKey = process.env.ALPACA_API_KEY;
    const savedSecret = process.env.ALPACA_API_SECRET;
    beforeEach(() => {
      process.env.ALPACA_API_KEY = 'dummy-key-not-a-credential';
      process.env.ALPACA_API_SECRET = 'dummy-secret-not-a-credential';
    });
    afterEach(() => {
      if (savedKey === undefined) delete process.env.ALPACA_API_KEY;
      else process.env.ALPACA_API_KEY = savedKey;
      if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET;
      else process.env.ALPACA_API_SECRET = savedSecret;
    });

    const lseClient = (): LseMarkClient => ({
      vendor: 'fake-lse-vendor',
      getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
      getLatestQuote: vi.fn(async () => ({
        price: 31_240,
        currency: 'GBp',
        observed_at: START,
      })),
    });

    it('builds an LseMarkDataSource for a universe of pool lse_tickers', () => {
      const source = buildAlpacaDataSource({ lseMarkClient: lseClient() }, LSE_UNIVERSE, calendar);

      expect(source).toBeInstanceOf(LseMarkDataSource);
    });

    it('refuses to boot an LSE universe with no vendor client, rather than 404ing per tick', () => {
      expect(() => buildAlpacaDataSource({}, LSE_UNIVERSE, calendar)).toThrow(
        /no ProductionConfig\.lseMarkClient was supplied/,
      );
    });

    it('refuses a universe that mixes LSE ETPs with Alpaca-served instruments', () => {
      // Both are asset_class 'stocks', so AssetClassRoutingDataSource cannot
      // split them and every LSE symbol would go to Alpaca.
      expect(() =>
        buildAlpacaDataSource(
          { lseMarkClient: lseClient() },
          [...LSE_UNIVERSE, { asset: 'SPY', asset_class: 'stocks' as const }],
          calendar,
        ),
      ).toThrow(/mixes LSE leveraged ETPs/);
    });

    it('refuses at boot — not mid-tick — a universe holding a USD-declared pool row', () => {
      // Eight of the eleven checked-in rows declare USD (doc 34 §3.2), so this
      // is the pool's majority case, not an edge. The failure has to land here,
      // at construction: a `MarkCurrencyError` on the first live read would
      // arrive after the orchestrator was up and possibly holding a position.
      expect(() =>
        buildAlpacaDataSource(
          { lseMarkClient: lseClient() },
          [{ asset: '3USL', asset_class: 'stocks' as const }],
          calendar,
        ),
      ).toThrow(/3USL \(USD\)/);
    });

    it('leaves every universe without an lse_ticker on exactly the path it had', () => {
      // The regression that matters most: shipped profiles hold no LSE ticker,
      // so this branch must be invisible to them.
      expect(buildAlpacaDataSource({}, DEFAULT_UNIVERSE, calendar)).toBeInstanceOf(
        AlpacaDataSource,
      );
      expect(buildAlpacaDataSource({}, SMOKE_TEST_UNIVERSE, calendar)).toBeInstanceOf(
        AlpacaDataSource,
      );
    });

    it('will not mark an lse_ticker off its screening_instrument, through the built source', async () => {
      // The substitution the issue names as "the failure mode worth a test",
      // asserted on the object the composition root actually returns.
      const source = buildAlpacaDataSource({ lseMarkClient: lseClient() }, LSE_UNIVERSE, calendar);

      await expect(source.fetchMark('SPY', START, 'live')).rejects.toThrow(/SCREENING INSTRUMENT/);
    });

    it('serves a GBP mark stamped at the vendor observation time', async () => {
      // #641/#640 gate on `Mark.observed_at`; a request-time stamp is the one
      // way this whole ticket could land and still not make them pass.
      const observed = new Date(START.getTime() - 30_000);
      const source = buildAlpacaDataSource(
        {
          lseMarkClient: {
            vendor: 'fake-lse-vendor',
            getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
            getLatestQuote: vi.fn(async () => ({
              price: 31_240,
              currency: 'GBp',
              observed_at: observed,
            })),
          },
        },
        LSE_UNIVERSE,
        calendar,
      );

      const mark = await source.fetchMark('LQQ3', START, 'live');

      expect(mark.price).toBeCloseTo(312.4, 10);
      expect(mark.observed_at).toEqual(observed);
      expect(mark.asset_class).toBe('stocks');
    });
  });

  /**
   * #981 — the outside benchmarks have to survive the LSE cutover (#751).
   *
   * The regression this exists for is latent rather than live: no shipped
   * profile puts LSE tickers in `universe` yet, so nothing fails today. But
   * `buildAlpacaDataSource` returns `LseMarkDataSource` EXCLUSIVELY the moment
   * one does, and that source refuses `'SPY'` on purpose (#734 — SPY is a
   * `screening_instrument`, the US underlying a 3x LSE ETP tracks). Had the
   * benchmarks kept reading through the pipeline's own `MarketDataService`,
   * the cutover would have parked BOTH benchmarks (60/40 has a SPY leg too) in
   * `unmeasured` permanently — caught per-benchmark, logged at `warn`, panel
   * reading "Absent, not zero", nothing red anywhere. #636 requires the
   * opposite: FL keeps computing an outside benchmark on its own cadence no
   * matter what the live universe trades.
   *
   * So the first case pins the LIVE path's refusal (the defect's mechanism)
   * and the second proves the BENCHMARK path serves the same two symbols under
   * the same LSE-only configuration. Both go through the whole chain the
   * production caller uses — `MarketDataBenchmarkSeriesSource` over a
   * `MarketDataServiceImpl` over the built source — not against the sources in
   * isolation, because the isolation is exactly what hid this.
   */
  describe('buildBenchmarkDataSource — benchmarks outlive the LSE cutover (#981)', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const DAY_MS = 24 * 60 * 60 * 1_000;
    const WINDOW_TO = START;
    const WINDOW_FROM = new Date(START.getTime() - 30 * DAY_MS);
    // Pool `lse_ticker`s, both GBp-declared — the same pair the #734 cases
    // above use, so this stays a fact about the pool and not a literal.
    const LSE_UNIVERSE = [
      { asset: 'LQQ3', asset_class: 'stocks' as const },
      { asset: '3SPY', asset_class: 'stocks' as const },
    ];

    const lseClient = (): LseMarkClient => ({
      vendor: 'fake-lse-vendor',
      getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
      getLatestQuote: vi.fn(async () => ({ price: 31_240, currency: 'GBp', observed_at: START })),
    });

    /** A stocks-rooted wire client, so no credential and no network is needed. */
    const benchmarkClient = (): NonNullable<ProductionConfig['alpacaDataClient']> => ({
      getBars: vi.fn(async (_symbol: string, _timeframe: string, asOf: Date, limit: number) =>
        Array.from({ length: limit }, (_unused, index): AlpacaBar => {
          const open = new Date(asOf.getTime() - (limit - index) * DAY_MS);
          return { t: open.toISOString(), o: 100, h: 101, l: 99, c: 100 + index, v: 1_000 };
        }),
      ),
      getLatestQuote: vi.fn(
        async (): Promise<AlpacaQuote> => ({ t: START.toISOString(), ap: 100, bp: 99 }),
      ),
    });

    const seriesOver = (source: DataSource): MarketDataBenchmarkSeriesSource =>
      new MarketDataBenchmarkSeriesSource(
        new MarketDataServiceImpl(
          source,
          new SimulatedClock(START),
          'live',
          new SqliteMarketDataStore(db),
        ),
      );

    it('is refused for SPY and AGG through the LIVE universe-derived source', async () => {
      // The defect's mechanism, asserted so the second case cannot pass for a
      // reason unrelated to the routing.
      const live = seriesOver(
        buildAlpacaDataSource({ lseMarkClient: lseClient() }, LSE_UNIVERSE, calendar),
      );

      await expect(live.getDailyCloses('SPY', WINDOW_FROM, WINDOW_TO)).rejects.toThrow(
        /SCREENING INSTRUMENT/,
      );
      // AGG takes the other branch — not a screening instrument, simply not in
      // the pool — so the 60/40 leg fails for its own reason, not SPY's.
      await expect(live.getDailyCloses('AGG', WINDOW_FROM, WINDOW_TO)).rejects.toThrow(
        /not an lse_ticker/,
      );
    });

    it('serves SPY and AGG closes with an LSE-only universe configured', async () => {
      // The builder takes no `universe` and no `ProductionConfig` at all, which
      // is why this holds: there is nothing for an LSE cutover to change.
      const series = seriesOver(buildBenchmarkDataSource({ dataClient: benchmarkClient() }));

      for (const instrument of ['SPY', 'AGG']) {
        const closes = await series.getDailyCloses(instrument, WINDOW_FROM, WINDOW_TO);

        expect(closes.length).toBeGreaterThan(0);
        expect(closes.every((observation) => Number.isFinite(observation.close))).toBe(true);
        // The anchor `buildOutsideBenchmark` refuses to measure without.
        expect(closes[0]?.close_time.getTime()).toBeLessThanOrEqual(WINDOW_FROM.getTime());
      }
    });

    it('cannot be handed the live session calendar, which is LSE in live mode', () => {
      // `equityCalendarFor` returns `LseRegularHoursCalendar` when
      // `mode === 'live'`. Accepting a calendar here would re-couple the
      // benchmarks to the live configuration through the back door: US bars
      // normalized against London sessions and `LSE_HOLIDAYS` — a REAL
      // divergence, not a latent one. `LSE_HOLIDAYS` and `US_HOLIDAYS`
      // (trading-calendar.ts) disagree on several civil dates, each one a
      // daily `isTradingDay` call would answer differently under the two
      // calendars. Closed structurally rather than by any empirical
      // agreement — the option does not exist, so it cannot come back by
      // accident.
      expect(() =>
        buildBenchmarkDataSource({
          // @ts-expect-error — no `calendar` option: the US equities session is
          // fixed inside the builder, where no configuration can reach it.
          calendar: new LseRegularHoursCalendar(),
          dataClient: benchmarkClient(),
        }),
      ).not.toThrow();
    });

    it('builds its Alpaca client on first read, so a missing key cannot fail a boot', async () => {
      // Deferred construction is load-bearing, not incidental: on the LSE
      // cutover the live path builds NO Alpaca client at all, and a secondary
      // context-only measurement must not be able to take the trading loop
      // down over a credential it alone needs. The absence surfaces as one
      // `unmeasured` benchmark instead.
      const savedKey = process.env.ALPACA_API_KEY;
      const savedSecret = process.env.ALPACA_API_SECRET;
      delete process.env.ALPACA_API_KEY;
      delete process.env.ALPACA_API_SECRET;
      try {
        const source = buildBenchmarkDataSource({});

        await expect(
          source.fetchBars('SPY', { timeframe: '1d', lookback: 5 }, START),
        ).rejects.toThrow(/ALPACA_API_KEY/);
      } finally {
        if (savedKey === undefined) delete process.env.ALPACA_API_KEY;
        else process.env.ALPACA_API_KEY = savedKey;
        if (savedSecret === undefined) delete process.env.ALPACA_API_SECRET;
        else process.env.ALPACA_API_SECRET = savedSecret;
      }
    });
  });

  /**
   * #562 — the LIVE orchestrator's OHLCV failover, asserted THROUGH
   * `buildProductionOrchestrator` rather than against `FailoverDataSource` in
   * isolation (which `failover-data-source.test.ts` covers).
   *
   * That distinction is the whole point of the issue: #560 landed a working
   * `withOhlcvFailover` and wired it into the backfill script only, so the
   * live path kept a single vendor with no catch, no second source and no
   * alert. A unit test of the wrapper would have stayed green throughout.
   * These cases fail if the composition root stops constructing one.
   *
   * Driven through `orchestrator.marketData`, the real `MarketDataServiceImpl`
   * the root built, against a COLD `:memory:` store — a warm store would
   * satisfy `getBars` from the Tier-2 cache and never reach the source at all,
   * which would pass for the wrong reason.
   */
  describe('live OHLCV failover (#562) — from the composition root', () => {
    const EQUITIES_UNIVERSE = [{ asset: 'SPY', asset_class: 'stocks' as const }];
    const WINDOW = { timeframe: '1h', lookback: 2 } as const;

    /**
     * `START` is 08:00 ET on a Wednesday, so the newest bars completed by then
     * belong to TUESDAY's regular session (18:00Z/19:00Z opens = 14:00/15:00
     * ET). Picked in session on purpose: the fallback is session-normalized
     * against the same `UsEquityRegularHoursCalendar` the primary uses, so an
     * out-of-session fixture would be dropped and every case here would pass
     * for the wrong reason.
     */
    function fallbackBarAt(openTime: string): Bar {
      const open_time = new Date(openTime);
      return {
        instrument: 'SPY',
        timeframe: '1h',
        open_time,
        close_time: new Date(open_time.getTime() + 3_600_000),
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 1_000,
        source: 'polygon',
      };
    }

    const FALLBACK_BARS: readonly Bar[] = [
      fallbackBarAt('2026-07-28T18:00:00.000Z'),
      fallbackBarAt('2026-07-28T19:00:00.000Z'),
    ];
    const FALLBACK_BAR = FALLBACK_BARS[1] as Bar;

    /** An Alpaca market-data client that cannot answer — the stall being survived. */
    function stallingAlpacaClient(): NonNullable<ProductionConfig['alpacaDataClient']> {
      return {
        getBars: vi.fn(async (): Promise<AlpacaBar[]> => {
          throw new Error('alpaca 503');
        }),
        getLatestQuote: vi.fn(
          async (): Promise<AlpacaQuote> => ({ t: START.toISOString(), ap: 100, bp: 99 }),
        ),
      };
    }

    it('serves equities bars from the fallback vendor when the primary throws', async () => {
      const fallback = vi.fn(async () => [...FALLBACK_BARS]);
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          universe: EQUITIES_UNIVERSE,
          alpacaDataClient: stallingAlpacaClient(),
          equitiesFallbackBarFetcher: fallback,
          dataFailoverAlerts: { postDataFailoverAlert: vi.fn(async () => undefined) },
        }),
      );

      const bars = await orchestrator.marketData.getBars('SPY', WINDOW, START);

      expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    /**
     * The invariant #818 found missing: a bar reaching the store carries the
     * same SESSION semantics whichever vendor served it.
     *
     * The primary is a `NormalizingDataSource` and drops out-of-session
     * candles; the fallback vendor client applies no calendar and serves
     * ~16 `1h` bars a day over 08:00Z-23:00Z. Wired raw, a failover silently
     * replaced ~2 regular sessions of ATR window with ~1 extended-hours day,
     * and `failover-data-source.ts` never re-derives a fallback bar, so the
     * contamination outlived the stall.
     */
    it('drops out-of-session fallback bars instead of persisting them', async () => {
      const preMarket = fallbackBarAt('2026-07-28T09:00:00.000Z');
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          universe: EQUITIES_UNIVERSE,
          alpacaDataClient: stallingAlpacaClient(),
          equitiesFallbackBarFetcher: vi.fn(async () => [preMarket, ...FALLBACK_BARS]),
          dataFailoverAlerts: { postDataFailoverAlert: vi.fn(async () => undefined) },
        }),
      );

      const bars = await orchestrator.marketData.getBars('SPY', WINDOW, START);

      expect(bars.map((bar) => bar.open_time.toISOString())).toEqual(
        FALLBACK_BARS.map((bar) => bar.open_time.toISOString()),
      );

      // And the durable effect, not just the return value: nothing
      // out-of-session reached the `bars` table, which is what an ATR read on
      // a later tick would have been computed over.
      const stored = db
        .prepare('SELECT open_time, source FROM bars WHERE instrument = ? ORDER BY open_time')
        .all('SPY') as { open_time: string; source: string }[];
      expect(stored.map((row) => row.source)).toEqual(['polygon', 'polygon']);
      expect(
        stored.some((row) => new Date(row.open_time).getTime() === preMarket.open_time.getTime()),
      ).toBe(false);
    });

    it('raises the failover on the injected alert channel, not only the log', async () => {
      const posted: DataFailoverAlert[] = [];
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          universe: EQUITIES_UNIVERSE,
          alpacaDataClient: stallingAlpacaClient(),
          equitiesFallbackBarFetcher: vi.fn(async () => [FALLBACK_BAR]),
          dataFailoverAlerts: {
            postDataFailoverAlert: async (alert) => {
              posted.push(alert);
            },
          },
        }),
      );

      await orchestrator.marketData.getBars('SPY', WINDOW, START);

      // The channel, not stderr — `SAMURAI_ALERTS=telegram` binds
      // `tradeChannelAlert('dataFailoverAlerts', …)` into this exact slot
      // (alert-transport.ts), so reaching the port is what makes the alert
      // reachable from a phone during an unattended soak.
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        leg: 'equities',
        symbol: 'SPY',
        timeframe: '1h',
        primaryName: 'alpaca',
        fallbackName: 'polygon',
        primaryError: 'alpaca 503',
      });
    });

    it('threads ProductionConfig.fallbackPacing to the default Polygon fetcher, unresolved, at the real composition root (#822)', () => {
      // Not merely "the type accepts the field" — a malformed
      // `SAMURAI_PACING_POLYGON_*` is set, and `config.fallbackPacing` also
      // supplies a value. If the field reaches `buildFailoverDataSource`
      // (per its `deps.fallbackPacing ?? resolveFallbackPacing(...)`
      // wiring), `resolveFallbackPacing` never runs, so the malformed env
      // var is never read and no warn fires. If the field were merely
      // accepted by `ProductionConfig` but not threaded through
      // `production.ts`'s call site, `resolveFallbackPacing` would still run
      // against the malformed var and this test would catch that with a
      // warn.
      process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
      const logger = recordingLogger();

      try {
        buildProductionOrchestrator(
          stubConfig(db, {
            universe: EQUITIES_UNIVERSE,
            logger,
            fallbackPacing: { capacity: 9, refillPerSecond: 9, reserveForPriority: 0 },
            // No equitiesFallbackBarFetcher and no dataSource override — the
            // default Polygon branch is the one selected, which is exactly
            // where the eager resolution (or its absence) happens.
          }),
        );
      } finally {
        delete process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC;
      }

      const pacingWarns = logger.entries.filter((entry) =>
        entry.message.includes('SAMURAI_PACING_POLYGON'),
      );
      expect(pacingWarns).toHaveLength(0);
    });

    /**
     * #824 — the circuit breaker, asserted from the COMPOSITION ROOT for the
     * same reason the rest of this block is: `yarn smoke` injects
     * `config.dataSource` and therefore never reaches `buildFailoverDataSource`
     * at all, so this case (and the recovery one below) is the only proof that
     * a breaker exists on the path a live tick actually takes.
     *
     * Asserted on the ALPACA CLIENT's own call count, not on the fallback's:
     * the ticket's cost is the ~30s stalled primary read (three 10s attempts
     * plus backoff inside `AlpacaHttpDataClient`), so "the primary was never
     * called" is the claim. The rising fallback count is asserted alongside it
     * so the case cannot pass merely because the reads stopped happening.
     */
    const BREAKER_UNIVERSE = [
      { asset: 'SPY', asset_class: 'stocks' as const },
      { asset: 'QQQ', asset_class: 'stocks' as const },
      { asset: 'AAPL', asset_class: 'stocks' as const },
      { asset: 'TSLA', asset_class: 'stocks' as const },
    ];

    /** The fallback bars, stamped with whichever symbol was asked for. */
    function fallbackFetcherFor() {
      return vi.fn(async (symbol: string) =>
        FALLBACK_BARS.map((bar) => ({ ...bar, instrument: symbol })),
      );
    }

    it('stops paying the stalled primary once the leg circuit opens (#824)', async () => {
      const alpaca = stallingAlpacaClient();
      const fallback = fallbackFetcherFor();
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          universe: BREAKER_UNIVERSE,
          alpacaDataClient: alpaca,
          equitiesFallbackBarFetcher: fallback,
          dataFailoverAlerts: { postDataFailoverAlert: vi.fn(async () => undefined) },
        }),
      );

      for (const symbol of BREAKER_UNIVERSE.map((i) => i.asset)) {
        const bars = await orchestrator.marketData.getBars(symbol, WINDOW, START);
        expect(bars.map((bar) => bar.source)).toEqual(['polygon', 'polygon']);
      }

      // Every one of the four names was served, but only the first
      // FAILOVER_CIRCUIT_FAILURE_THRESHOLD of them paid Alpaca's timeout.
      expect(fallback).toHaveBeenCalledTimes(BREAKER_UNIVERSE.length);
      expect(alpaca.getBars).toHaveBeenCalledTimes(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);
    });

    it('re-probes the primary after the cooldown, on the orchestrator clock (#824)', async () => {
      // The unattended-soak property: no operator, no restart. The breaker
      // ages on the root's own `Clock` — which is why this drives a
      // `SimulatedClock` forward rather than waiting on wall time.
      const clock = new SimulatedClock(START);
      const alpaca = stallingAlpacaClient();
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          clock,
          universe: BREAKER_UNIVERSE,
          alpacaDataClient: alpaca,
          equitiesFallbackBarFetcher: fallbackFetcherFor(),
          dataFailoverAlerts: { postDataFailoverAlert: vi.fn(async () => undefined) },
        }),
      );

      for (const symbol of BREAKER_UNIVERSE.map((i) => i.asset)) {
        await orchestrator.marketData.getBars(symbol, WINDOW, START);
      }
      expect(alpaca.getBars).toHaveBeenCalledTimes(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);

      // Well past the cooldown, and a WHOLE BAR later: the clock moves a full
      // `1h` so the Tier-2 cache cannot satisfy the read from the rows the
      // first pass stored and make the assertion vacuous — a cache hit never
      // reaches the source at all, and would look exactly like a breaker that
      // stayed open.
      expect(60 * 60 * 1000).toBeGreaterThan(FAILOVER_CIRCUIT_COOLDOWN_MS);
      clock.advanceTo(new Date(START.getTime() + 60 * 60 * 1000));
      await orchestrator.marketData.getBars('SPY', WINDOW, clock.now());
      expect(alpaca.getBars).toHaveBeenCalledTimes(FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 1);
    });

    it('leaves an injected config.dataSource unwrapped', async () => {
      // The seam's own contract: a caller that brought its own source has
      // already decided where bars come from, and the root must not silently
      // put a second vendor behind it.
      const fallback = vi.fn(async () => [FALLBACK_BAR]);
      const injected = {
        fetchBars: vi.fn(async (): Promise<Bar[]> => [FALLBACK_BAR]),
        fetchMark: vi.fn(async () => {
          throw new Error('unreachable — this case never marks');
        }),
      };
      const orchestrator = buildProductionOrchestrator(
        stubConfig(db, {
          universe: EQUITIES_UNIVERSE,
          dataSource: injected,
          equitiesFallbackBarFetcher: fallback,
        }),
      );

      await orchestrator.marketData.getBars('SPY', WINDOW, START);

      expect(injected.fetchBars).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
    });
  });

  it('writes audit_log rows and clears current_tick through the real SQLite stores', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 100_000,
    });
    const orchestrator = buildProductionOrchestrator(config);

    // Drive the real SequentialTickRunner over stubbed steps so the audit /
    // current_tick side effects are the production SQLite ones, not fakes.
    const runner = new SequentialTickRunner({
      // #785: a quorum-skipped decision pass now runs the exit check itself
      // (no Trader entry point of its own to carry the flatten), so this is
      // reachable here — unlike debate/risk/verdict/execution, which stay
      // unreachable behind the quorum skip.
      exitCheck: async () => null,
      analysts: async () => [],
      debate: async () => {
        throw new Error('unreachable');
      },
      trader: async () => null,
      risk: async () => {
        throw new Error('unreachable');
      },
      verdict: async () => {
        throw new Error('unreachable');
      },
      execution: async () => {
        throw new Error('unreachable');
      },
    });

    await runner.runInstrument(
      { asset: 'BTC-USD', asset_class: 'crypto' },
      {
        clock: new SimulatedClock(START),
        trace_id: 'trace-audit',
        logger: recordingLogger(),
        auditLog: orchestrator.persistence.auditLog,
        currentTickStore: orchestrator.persistence.currentTickStore,
        // #743: a decision pass — this test exercises the quorum-skip audit
        // row, which only the decision chain writes.
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    // Two rows (#785): 'analysts' for the quorum skip, then 'position_check'
    // for the flatten evaluation the quorum-skip pass now also performs.
    const rows = orchestrator.persistence.auditLog.getByTraceId('trace-audit');
    expect(rows.map((row) => row.stage)).toEqual(['analysts', 'position_check']);
    expect(orchestrator.persistence.currentTickStore.get('BTC-USD')).toBeUndefined();
  });
});

/**
 * #957 — the risk critic, wired by the composition root, in `backtest` mode.
 *
 * `risk-manager-spec.md` ("Risk Critic", Testing Decisions) asks for this
 * assertion at exactly this altitude: *"backtest mode reads the logged
 * `debate_id`-keyed verdict, never calls the LLM (assert no network/LLM-client
 * call in a mock-clock backtest run)"*. `critic.test.ts` proves
 * `buildRiskCriticProducer` honours the mode branch; it CANNOT prove
 * `production.ts` passes the run's own mode rather than, say, a hard-coded
 * `'paper'` — which would hand a replayed path a live client and silently void
 * Stage 2's PBO/DSR statistics with every unit test still green.
 *
 * So: the REAL `buildProductionComponents`, a `SimulatedClock`, an `llmClient`
 * whose `complete` is a spy, and a verdict pre-written to `risk_critic_log`.
 * The replayed verdict BINDING the decision is what makes the no-call
 * assertion non-vacuous — a critic that was never consulted at all would
 * satisfy "made no call" just as well.
 */
describe('risk critic in backtest mode is replay-only at the composition root (#957)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('replays the logged verdict, binds the decision on it, and reaches neither the client nor the network', async () => {
    const clock = new SimulatedClock(START);
    const complete = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const intent = goVerdict().order as OrderIntent;
    // History the critic has already seen, keyed the way replay keys it.
    new SqliteRiskCriticStore(db).writeVerdict({
      debate_id: intent.metadata.debate_id,
      verdict: {
        verdict: 'reject',
        max_notional: null,
        reasoning: 'logged by the live run this backtest is replaying',
      },
      created_at: START,
    });

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      mode: 'backtest',
      clock,
      llmClient: { complete } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const { steps } = buildProductionComponents(config);

    const decision = await steps.risk({ trace_id: 'trace-957-backtest', intent, clock });

    // The logged verdict reached `evaluate()`, so step 7 genuinely ran.
    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('risk_critic:reject');
    expect(decision.reasons.join(' ')).toContain('logged by the live run');
    // And it ran without dialling anything: no client call, no socket, and no
    // billed row a replayed path has no business producing.
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 0 });

    fetchSpy.mockRestore();
  });

  it('#994: a logged BREACHED condition rejects at the composition root, under its own constraint', async () => {
    // The fold's enforcement assertion, driven through the real
    // `buildProductionComponents` rather than a unit fixture: the prose verdict
    // says `pass`, the measured predicate says the thesis was already falsified,
    // and `evaluate()` — not the producer — turns that into a reject. A
    // construction check would pass for a conditions half nothing acts on,
    // which is precisely this repo's dominant defect shape.
    const clock = new SimulatedClock(START);
    const intent = goVerdict().order as OrderIntent;
    new SqliteRiskCriticStore(db).writeVerdict({
      debate_id: intent.metadata.debate_id,
      verdict: {
        verdict: 'pass',
        max_notional: null,
        reasoning: 'no narrative risk in the book',
        conditions: [
          {
            condition: {
              id: 'thesis-needs-price-above-95',
              observable: { kind: 'mark' },
              comparator: '<',
              threshold: 95,
              rationale: 'below 95 the breakout that justified the entry has already failed',
            },
            state: 'breached',
            observed: 90,
          },
        ],
        dropped_conditions: [],
      },
      created_at: START,
    });

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      mode: 'backtest',
      clock,
      llmClient: { complete: vi.fn() } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const { steps } = buildProductionComponents(config);

    const decision = await steps.risk({ trace_id: 'trace-994-invalidated', intent, clock });

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('risk_critic:invalidated');
    expect(decision.binding_constraint).not.toBe('risk_critic:reject');
    expect(decision.reasons.join(' ')).toContain('breached');
  });

  it.each([
    ['an element with no fields at all', '[{}]'],
    ['a bare model-shaped state assertion', '[{"state":"breached"}]'],
  ])('#994: a persisted conditions column holding %s neither throws nor rejects on the replay path', async (_case, stored) => {
    // The threat is the storage layer, not the model: a TEXT column read
    // with a cast would hand `evaluate()` an object with no `observable`
    // (a TypeError inside the risk stage, i.e. a dead tick) or an
    // unmeasured `breached` (a hard reject with nothing behind it).
    const clock = new SimulatedClock(START);
    const intent = goVerdict().order as OrderIntent;
    db.prepare(
      `INSERT INTO risk_critic_log
           (debate_id, verdict, max_notional, reasoning, created_at, conditions_json)
         VALUES (?, 'pass', NULL, 'prose stands', ?, ?)`,
    ).run(intent.metadata.debate_id, START.toISOString(), stored);

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      mode: 'backtest',
      clock,
      llmClient: { complete: vi.fn() } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const { steps } = buildProductionComponents(config);

    const decision = await steps.risk({ trace_id: 'trace-994-corrupt', intent, clock });

    expect(decision.status).toBe('approved');
    expect(decision.binding_constraint).not.toBe('risk_critic:invalidated');
    expect(decision.reasons.join(' ')).toContain('no_conditions');
  });

  it('#994: drop reasons and `no_conditions` reach the PERSISTED `risk_log` row of an APPROVED decision', async () => {
    // Surfacing is what makes "the conditions half never fires" noticeable, and
    // an operator notices it by querying `risk_log`, not by holding the returned
    // `RiskDecision`. The rejecting case above would carry its reasons into the
    // row too — so this one deliberately APPROVES: the quiet path, where an
    // unsurfaced drop would otherwise leave no trace anywhere.
    const clock = new SimulatedClock(START);
    const intent = goVerdict().order as OrderIntent;
    new SqliteRiskCriticStore(db).writeVerdict({
      debate_id: intent.metadata.debate_id,
      verdict: {
        verdict: 'pass',
        max_notional: null,
        reasoning: 'no narrative risk in the book',
        conditions: [],
        dropped_conditions: [
          { id: 'rsi-over-140', raw: '{"id":"rsi-over-140"}', reason: 'threshold_out_of_range' },
        ],
      },
      created_at: START,
    });

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      mode: 'backtest',
      clock,
      llmClient: { complete: vi.fn() } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const { steps } = buildProductionComponents(config);

    const decision = await steps.risk({ trace_id: 'trace-994-surfaced', intent, clock });
    expect(decision.status).toBe('approved');

    const row = db
      .prepare('SELECT reasons_json FROM risk_log WHERE trace_id = ?')
      .get('trace-994-surfaced') as { reasons_json: string } | undefined;
    expect(row?.reasons_json).toContain('threshold_out_of_range');
    expect(row?.reasons_json).toContain('no_conditions');
  });

  it('replays UNSEEN history as no verdict rather than dialling — the mode branch, not the log hit', async () => {
    // The case above alone cannot catch a `production.ts` that passed a
    // hard-coded `'paper'`: the live producer reuses a logged verdict for the
    // same `debate_id` before it dials, so it would make no call either. This
    // one has NO row, which is every bar of a fresh backtest — the live
    // producer would call the model here, and the replay producer must not.
    const clock = new SimulatedClock(START);
    const complete = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const config = stubConfig(db, {
      ...REAL_CONFIGS,
      mode: 'backtest',
      clock,
      llmClient: { complete } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const { steps } = buildProductionComponents(config);

    const decision = await steps.risk({
      trace_id: 'trace-957-backtest-unseen',
      intent: goVerdict().order as OrderIntent,
      clock,
    });

    expect(decision.reasons).toContain(RISK_CRITIC_SKIPPED_REASON);
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 0 });
    // Nothing was invented for the log either — a replay writes no row.
    expect(db.prepare('SELECT COUNT(*) AS n FROM risk_critic_log').get()).toEqual({ n: 0 });

    fetchSpy.mockRestore();
  });
});

/**
 * #753 — falsifier arm 2, end to end through the REAL composition root.
 *
 * Three of the ticket's six acceptance criteria are properties of the whole
 * wired chain rather than of any unit, so they are proven here:
 *
 * - **AC1**: zero LLM calls against the control arm, asserted with a client that
 *   THROWS if it is ever called — while the same `buildProductionComponents`
 *   run has an LLM client wired for the live arm's debate.
 * - **AC2**: both arms' exit rule and stop come from ONE source. Asserted by
 *   perturbing a single `traderConfig` field and observing both arms move
 *   together, and by the two arms' `stop`/`target` being byte-identical on the
 *   same bar — a stronger statement than two constants that happen to agree.
 * - **AC6**: the control's trades are distinguishable by a real, queryable
 *   column: `SELECT ... FROM open_positions WHERE arm = 'control'`.
 *
 * In `production.test.ts` rather than a file of its own because the harness that
 * makes a full composed tick possible — `stubConfig`, `REAL_CONFIGS`,
 * `fixtureBars` — lives here, and duplicating it would be a second fixture to
 * keep in step with the composition root.
 */
describe('falsifier arm 2, through the composition root (#753)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const HOUR_MS = 60 * 60 * 1_000;

  /**
   * The default name for these cases. `LQQ3` — a real GBX-declared LSE 3x index
   * ETP, the same one the #706 window cases use — is the in-scope alternative,
   * reached through `subclassCase()` below.
   */
  const DEFAULT_INSTRUMENT = { asset: 'BTC-USD', asset_class: 'crypto' as const };

  function tapeFor(
    signal: { asset: string; asset_class: 'crypto' | 'stocks' } = DEFAULT_INSTRUMENT,
  ) {
    const bars = [
      ...fixtureBars(signal.asset, '5m', 60, 5 * 60_000),
      ...fixtureBars(signal.asset, '1h', 60, HOUR_MS),
      ...fixtureBars(signal.asset, '1m', 60, 60_000),
      ...fixtureBars(signal.asset, '1d', 40, 24 * HOUR_MS),
    ];
    return new FixtureDataSource(
      bars,
      { price: 160, observed_at: START, source: 'fixture' },
      signal.asset_class,
      { bid: 159.5, ask: 160.5, observed_at: START },
    );
  }

  function llmForOneDebate(): MockLlmClient {
    const client = new MockLlmClient();
    for (let i = 0; i < 40; i += 1) {
      client.enqueueText(
        JSON.stringify({ stance: 'bullish', rationale: 'fixture rationale', converged: true }),
      );
    }
    return client;
  }

  /**
   * One composed decision pass over one instrument, driving BOTH arms — the
   * live chain and, from inside the tick runner, the control arm.
   *
   * `traderConfig` is a parameter so a case can perturb exactly one field and
   * observe what moves.
   */
  async function runOneDecisionPass(options: {
    handle: StoreHandle;
    llmClient: NonNullable<ProductionConfig['llmClient']>;
    traderConfig?: ProductionConfig['traderConfig'];
    /** Defaults to BTC-USD; the D3-bracket case drives a real LSE ETP instead. */
    signal?: { asset: string; asset_class: 'crypto' | 'stocks' };
    /**
     * #1112: additional `ProductionConfig` fields (e.g. `capitalCeilingUsd`,
     * `riskConfig`) a case needs, applied AFTER `REAL_CONFIGS`/`traderConfig`
     * so a case can add a field neither of those carry, but BEFORE the fixed
     * `clock`/`dataSource`/`llmClient`/`broker` below so it cannot shadow the
     * wiring this harness's determinism depends on.
     */
    configOverrides?: Partial<ProductionConfig>;
  }) {
    const signal = options.signal ?? DEFAULT_INSTRUMENT;
    const clock = new SimulatedClock(START);
    const dataSource = tapeFor(signal);
    const costModel = new CostModelImpl(REAL_CONFIGS.costConfig as ProductionConfig['costConfig']);
    const marketDataForBroker = new MarketDataServiceImpl(
      dataSource,
      clock,
      'live',
      new SqliteMarketDataStore(options.handle),
    );

    const config = stubConfig(options.handle, {
      ...(REAL_CONFIGS as unknown as Partial<ProductionConfig>),
      ...(options.traderConfig === undefined ? {} : { traderConfig: options.traderConfig }),
      ...options.configOverrides,
      clock,
      dataSource,
      llmClient: options.llmClient,
      broker: new SimulatedBrokerAdapter({
        clock,
        costModel,
        marketData: marketDataForBroker,
        config: REAL_CONFIGS.executionConfig.simulated,
      }),
    });

    const { steps } = buildProductionComponents(config);
    const persistence = buildPersistence(options.handle);

    await new SequentialTickRunner(steps).runInstrument(signal, {
      clock,
      trace_id: 'trace-753',
      logger: recordingLogger(),
      auditLog: persistence.auditLog,
      currentTickStore: persistence.currentTickStore,
      decision_bar: {
        id: `${START.toISOString()}@3600000`,
        open_time: START,
        timeframe_ms: 3_600_000,
      },
    });

    return { persistence, steps, config };
  }

  function lotsByArm(handle: StoreHandle) {
    return handle
      .prepare(
        'SELECT arm, idempotency_key, instrument, side, stop, target, avg_entry_price, ' +
          'requested_size, decision_timestamp, conviction FROM open_positions ORDER BY arm',
      )
      .all() as {
      arm: string;
      idempotency_key: string;
      instrument: string;
      side: string;
      stop: number;
      target: number;
      avg_entry_price: number;
      requested_size: number;
      decision_timestamp: string;
      conviction: number;
    }[];
  }

  /**
   * AC1. Two halves, in one case.
   *
   * First: the client IS wired and IS reachable — the live arm's debate calls
   * it — while the control arm reaches Execution on the same tick. So this is a
   * statement about the control arm's path, not about a run with no LLM in it.
   *
   * Second: the control arm is driven ALONE against a client that THROWS on any
   * call. A model call anywhere between the axis vote and Execution would be
   * contained as a control-arm failure and leave the chain short, so the
   * six-stage assertion at the end is what proves the zero.
   */
  it('makes zero LLM calls from the axis vote through to Execution', async () => {
    const calls: unknown[] = [];
    const backing = llmForOneDebate();
    const countingClient = {
      complete: async (...args: unknown[]) => {
        calls.push(args);
        return (backing as unknown as { complete: (...a: unknown[]) => Promise<unknown> }).complete(
          ...args,
        );
      },
    } as unknown as NonNullable<ProductionConfig['llmClient']>;

    const { persistence } = await runOneDecisionPass({ handle: db, llmClient: countingClient });

    expect(calls.length).toBeGreaterThan(0);
    expect(persistence.auditLog.getByTraceId('trace-753:control').map((row) => row.stage)).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);

    const soloBar = new Date(START.getTime() + HOUR_MS);
    const clock = new SimulatedClock(START);
    const soloConfig = stubConfig(db, {
      ...(REAL_CONFIGS as unknown as Partial<ProductionConfig>),
      clock,
      dataSource: tapeFor(),
      llmClient: {
        complete: async () => {
          calls.push('control-arm made an LLM call');
          throw new Error('#753: the control arm must make no LLM call');
        },
      } as unknown as NonNullable<ProductionConfig['llmClient']>,
    });
    const components = buildProductionComponents(soloConfig);
    const soloPersistence = buildPersistence(db);
    const views = await components.steps.analysts({
      trace_id: 'trace-753-solo',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: soloBar,
    });
    expect(views.length).toBeGreaterThan(0);

    /**
     * The LIVE analysts step just made a model call — the
     * `MarketIntelligenceStore.getContext` path reaches the Nous/Grok ingest
     * agent — and that is exactly why the control arm RELAYS this view set
     * instead of re-running the step. A control arm that re-ran its analysts
     * would call a model in production while every unit test with a stubbed
     * analysts step stayed green. The baseline for the zero-call assertion is
     * therefore taken HERE, after the live stage, not before it.
     */
    expect(calls.length).toBeGreaterThan(0);
    const before = calls.length;

    // The hook is optional on `TickSteps` (see its doc), so an unbound one is
    // not a compile error — it is the #753 wiring defect, named here.
    expect(components.steps.controlArm).toBeDefined();

    await components.steps.controlArm?.({
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      ctx: {
        clock,
        trace_id: 'trace-753-solo',
        logger: recordingLogger(),
        auditLog: soloPersistence.auditLog,
        currentTickStore: soloPersistence.currentTickStore,
        decision_bar: {
          id: `${soloBar.toISOString()}@3600000`,
          open_time: soloBar,
          timeframe_ms: 3_600_000,
        },
      },
      views,
    });

    expect(calls.length).toBe(before);
    expect(
      soloPersistence.auditLog.getByTraceId('trace-753-solo:control').map((row) => row.stage),
    ).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);

    /**
     * The zero above must not be a vacuous zero. A control pass that decided
     * nothing would reach Execution with a skip and call no model either — the
     * same assertion, proving nothing. These two make the run non-vacuous:
     *
     * - a control LOT exists, so an intent really was produced, sized, gated and
     *   submitted while the only client in the process throws on any call;
     * - the control's `risk_log` row carries `risk_critic: skipped`, which is
     *   the record of the ONE remaining LLM seam in the control's path (#957's
     *   step 7) being absent by wiring rather than by luck. Restore
     *   `critic: deps.risk.critic` in `control-arm-wiring.ts` and this line goes
     *   from `skipped` to a thrown call.
     */
    const controlLots = db
      .prepare("SELECT idempotency_key FROM open_positions WHERE arm = 'control'")
      .all() as { idempotency_key: string }[];
    expect(controlLots.length).toBeGreaterThan(0);

    const controlRisk = db
      .prepare('SELECT reasons_json FROM risk_log WHERE trace_id = ?')
      .get('trace-753-solo:control') as { reasons_json: string } | undefined;
    expect(controlRisk?.reasons_json).toContain('risk_critic: skipped');
  });

  /**
   * The control arm's account state is its OWN (#753).
   *
   * `computeCurrentPortfolioAndBreakers` combines each arm's open positions with
   * its `AccountStateProvider`, and the control arm used to be handed the LIVE
   * arm's — which reads `GET /v2/account`, an account the control never trades
   * against. Its D5 sizing (a fraction of `portfolio.equity`) and its
   * drawdown-halt timing were therefore functions of the live arm's realized
   * cash, which is not an independent measurement over the same tape.
   *
   * `risk_log.equity` is where each arm's own valuation is recorded, so the two
   * rows from ONE tick are the proof. Both figures are on the same SCALE — the
   * control anchors its book to the live account once, at boot, because a
   * matched control has to start at the same capital (see the anchor tests in
   * `control-account-state.test.ts`, and the `rounds_to_zero_shares` failure
   * that a declared-£1,000 control produced under `yarn smoke`). What separates
   * them is the accounting: the control debits its OWN deployed cash and marks
   * its OWN lot, while the live arm reads the harness's fixed 100,000 stub.
   */
  it('sizes and halts off its own book, not the live arm’s account', async () => {
    await runOneDecisionPass({ handle: db, llmClient: llmForOneDebate() });

    const rows = db.prepare('SELECT trace_id, equity FROM risk_log ORDER BY trace_id').all() as {
      trace_id: string;
      equity: number;
    }[];
    const live = rows.find((row) => row.trace_id === 'trace-753');
    const control = rows.find((row) => row.trace_id === 'trace-753:control');

    expect(live?.equity).toBeDefined();
    expect(control?.equity).toBeDefined();
    // Matched scale: a control anchored at the declared £1,000 against this
    // 100,000 live account is the exact inertness the smoke gate caught.
    expect(live?.equity).toBeGreaterThan(50_000);
    expect(control?.equity).toBeGreaterThan(50_000);
    // Its own book all the same. The two figures agree on this FIRST tick and
    // only on it — both arms start flat at one anchor, and `risk_log` is
    // written before either lot fills — so the equality is not the property to
    // assert. What proves the arms are on different providers is the anchor
    // row: `CONTROL_BOOK_ANCHOR_KEY` exists in `account_state` only because
    // `ControlArmAccountStateProvider`'s resolver ran, and nothing on the live
    // path ever writes that key. Independence from there is
    // `control-account-state.test.ts`'s, which moves a live row and a control
    // row and watches which figures follow.
    const anchor = db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(CONTROL_BOOK_ANCHOR_KEY) as { peak_equity: number } | undefined;
    expect(anchor?.peak_equity).toBe(100_000);
    // And it actually traded — the condition the smoke gate exists to catch,
    // asserted here too so a control that silently stops sizing fails a unit
    // test first.
    expect(lotsByArm(db).map((lot) => lot.arm)).toEqual(['control', 'live']);
  });

  /**
   * #1180 — the anchor's FALLBACK is in the account's currency too, pinned at
   * the composition root.
   *
   * `control-account-state.test.ts` passes `fallbackBook` in, so it holds for
   * whatever the caller hands it and cannot see which value `production.ts`
   * actually wires. Reverting that argument to `LIVE_BOOK_GBP` therefore left
   * the whole suite green: the control arm would have anchored at 1,000
   * against a live arm clamped to the 1,270 ceiling — the scale mismatch the
   * anchor exists to avoid — with nothing to fail.
   *
   * The live provider is made to throw only under the CONTROL trace: the live
   * arm's own Risk stage reads the same provider (`direct-bind.ts`), so a stub
   * that always threw would take the live tick down and this case would be
   * measuring an aborted tick instead of the fallback.
   */
  it('falls back to the converted book, not the raw GBP one, when the live account is unreadable (#1180)', async () => {
    await runOneDecisionPass({
      handle: db,
      llmClient: llmForOneDebate(),
      configOverrides: {
        accountState: {
          getAccountState: async () => {
            if (currentTraceId()?.endsWith(':control') === true) {
              throw new Error('live account unreadable on this tick');
            }
            return {
              cash: 100_000,
              peak_equity: 100_000,
              daily_basis: {
                crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
                stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
                portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
              } as const,
              consecutive_losses: 0,
            };
          },
        },
      },
    });

    const control = db
      .prepare('SELECT equity FROM risk_log WHERE trace_id = ?')
      .get('trace-753:control') as { equity: number } | undefined;
    // Flat at Risk time, so the control's equity IS the resolved book.
    expect(control?.equity).toBe(LIVE_BOOK_SIZING_USD);
    // #972 fix 2: the fallback is this tick's answer and never the persisted
    // anchor. Its absence also proves the read really did fail — a successful
    // read writes this row.
    const anchor = db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(CONTROL_BOOK_ANCHOR_KEY) as { peak_equity: number } | undefined;
    expect(anchor).toBeUndefined();
  });

  /**
   * AC2, first half: on the same bar, over the same tape, the two arms' stop
   * and target are IDENTICAL — because both are computed by the same
   * `decide.ts` from the same `TraderConfig` and the same
   * `ADR_0018_SUBCLASS_BRACKETS`, not by two implementations that agree today.
   *
   * AC6 rides along: the control's row is selected by a real column.
   */
  it('gives both arms the same exit rule and stop, and marks the control row queryable', async () => {
    await runOneDecisionPass({ handle: db, llmClient: llmForOneDebate() });

    const lots = lotsByArm(db);
    expect(lots.map((lot) => lot.arm)).toEqual(['control', 'live']);
    const [control, live] = lots;

    // Same name, same bar, same side — the matched control's premise.
    expect(control?.instrument).toBe(live?.instrument);
    expect(control?.decision_timestamp).toBe(live?.decision_timestamp);
    expect(control?.side).toBe(live?.side);
    // Same exit rule and same stop, to the last bit. Nothing is configured twice.
    expect(control?.stop).toBe(live?.stop);
    expect(control?.target).toBe(live?.target);
    // AC6: a real, queryable property — not inferred from a key prefix.
    const queried = db
      .prepare('SELECT idempotency_key FROM open_positions WHERE arm = ?')
      .all('control') as { idempotency_key: string }[];
    expect(queried).toHaveLength(1);
    expect(queried[0]?.idempotency_key).toBe(control?.idempotency_key);
    expect(queried[0]?.idempotency_key).not.toBe(live?.idempotency_key);
  });

  /**
   * AC2, second half — the mutation the ticket asks for, run through the REAL
   * ADR-0018 D3 bracket rather than the pre-D3 `atr_k` fallback.
   *
   * The distinction is load-bearing. `REAL_CONFIGS.traderConfig.subclass_of` is
   * `{}`, which is `resolveSubclassBracket`'s "the per-subclass regime is not
   * armed" answer, so the `atr_k` case below it exercises the geometry the live
   * system will NOT use once the pool file lands. This case arms the regime with
   * a real in-scope name — `LQQ3`, a GBX-declared LSE 3x index ETP — and moves
   * the ONE field that selects a bracket row. Both arms must land on the new
   * row's frozen percentages together; a control arm with its own bracket table
   * would show the live arm moving alone.
   */
  it("moves both arms together across ADR-0018 D3's frozen bracket rows", async () => {
    const LSE_ETP = { asset: 'LQQ3', asset_class: 'stocks' as const };
    const configFor = (subclass: 'index_etp_3x' | 'single_stock_etp_3x') =>
      ({
        ...REAL_CONFIGS.traderConfig,
        subclass_of: { [LSE_ETP.asset]: subclass },
      }) as unknown as ProductionConfig['traderConfig'];

    /** D3's neutral pairs, read off the frozen table rather than restated here. */
    const indexBracket = ADR_0018_SUBCLASS_BRACKETS.index_etp_3x;
    const singleStockBracket = ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x;
    if (indexBracket === null || singleStockBracket === null) {
      throw new Error('ADR-0018 declares a bracket for both leveraged-ETP subclasses');
    }

    await runOneDecisionPass({
      handle: db,
      llmClient: llmForOneDebate(),
      signal: LSE_ETP,
      traderConfig: configFor('index_etp_3x'),
    });
    const asIndex = lotsByArm(db);
    expect(asIndex.map((lot) => lot.arm)).toEqual(['control', 'live']);

    const moved = openSharedStore(':memory:');
    try {
      await runOneDecisionPass({
        handle: moved,
        llmClient: llmForOneDebate(),
        signal: LSE_ETP,
        // The one field, changed once: the subclass this name is priced under.
        traderConfig: configFor('single_stock_etp_3x'),
      });
      const asSingleStock = lotsByArm(moved);
      expect(asSingleStock.map((lot) => lot.arm)).toEqual(['control', 'live']);

      /**
       * The bracket's own geometry, checked without needing the entry price —
       * `avg_entry_price` is 0 on a write-ahead row, and these lots have not
       * filled. For a long placed at `e`, `stop = e(1 − s)` and
       * `target = e(1 + t)`, so `target / stop = (1 + t) / (1 − s)`: a pure
       * function of the D3 row, and a different number for each subclass
       * (1.0221 index, 1.1307 single-stock).
       */
      const shape = (bracket: { take_profit_pct: number; stop_pct: number }) =>
        (1 + bracket.take_profit_pct) / (1 - bracket.stop_pct);
      for (const lot of asIndex) {
        expect(lot.target / lot.stop).toBeCloseTo(shape(indexBracket), 6);
      }
      for (const lot of asSingleStock) {
        expect(lot.target / lot.stop).toBeCloseTo(shape(singleStockBracket), 6);
      }

      // Both arms moved, and they still agree with each other — the invariant.
      expect(asSingleStock[0]?.stop).not.toBe(asIndex[0]?.stop);
      expect(asSingleStock[1]?.stop).not.toBe(asIndex[1]?.stop);
      expect(asSingleStock[0]?.stop).toBe(asSingleStock[1]?.stop);
      expect(asSingleStock[0]?.target).toBe(asSingleStock[1]?.target);
    } finally {
      moved.close();
    }
  });

  /**
   * #1112 finding 4 (code review of #1137) — an ABSOLUTE check, on top of the
   * scale-invariance one above.
   *
   * Scale-invariance (the "scales the requested size with the declared
   * ceiling" case below) passes even if every size this fix produces is off
   * by a constant factor — which is exactly what finding 2 of that review
   * found, and #1180 then fixed: `capitalCeilingUsd` used to carry a GBP
   * value into paper with no FX step, ~21% under what `LIVE_BOOK_GBP`
   * declares. A ratio test cannot see that. This one pins the single-stock entry's
   * NOTIONAL to ADR-0018 D5's formula against the declared ceiling, on both
   * arms, through the armed `subclass_of` path (not the pre-D3 `atr_k`
   * fallback) so it exercises the geometry the live system will actually run
   * once the pool file lands.
   *
   * **This is not a full-conviction entry, and forcing one is not attempted.**
   * `decide.ts`'s formula is
   * `size x entry = conviction_multiplier x non_converged_haircut x
   * cosine_multiplier x risk_fraction x equity`. `risk_fraction`
   * (`riskFractionFor`) is the piece ADR-0018 D5 states and this test exists
   * to pin; the other three multipliers are the debate engine's and the
   * cosine-precedent module's, already covered by their own unit tests
   * (`conviction-score.test.ts`, `cosine-precedent.test.ts`) and legitimately
   * data-dependent (the stocks desk's evidence-strength term is haircut by
   * `NO_DATA_MARKER` pinning with no Market Intelligence wired here). Rather
   * than reverse-engineer the debate-engine's confidence output to force it to
   * 1, this test reads the REAL confidence the fixture produced straight off
   * the persisted row (`conviction` — `debate.confidence` verbatim, per
   * `decide.ts`'s intent metadata) and derives `conviction_multiplier` from
   * it, so the assertion is exact rather than approximate. The other two
   * multipliers are pinned by the fixture's own construction:
   * `non_converged_haircut` is 1 because `llmForOneDebate` always emits
   * `converged: true`, and `cosine_multiplier` is `NO_PRECEDENT_MULTIPLIER`
   * because `db` is fresh in `beforeEach` — no prior setup for
   * `retrieveCosinePrecedent` to find.
   *
   * `entry` is derived from `stop` rather than read off `avg_entry_price`
   * (0 on a write-ahead row, per the D3 test above) via the single-stock
   * bracket's own `stop_pct`, the same technique the D3 test uses for
   * `target / stop`.
   *
   * **The full-conviction fraction is 0.225, not D5's bare 0.25.**
   * `riskFractionFor` (subclass-bracket.ts) sizes the FIRST tranche at
   * `deployment_fraction x (1 - headroom_reserve_fraction)` since #897
   * (2026-09-03) — 0.25 x (1 - 0.10) = 0.225. CLAUDE.md still states the
   * per-position cash as "£350 / £250" (the bare D5 fractions, pre-#897);
   * that line is stale against the shipped `riskFractionFor`, not this test —
   * see the code-review report for the discrepancy.
   */
  it('sizes a single-stock entry to D5’s formula against the declared ceiling, on both arms (#1112)', async () => {
    const LSE_ETP = { asset: 'LQQ3', asset_class: 'stocks' as const };
    const singleStockBracket = ADR_0018_SUBCLASS_BRACKETS.single_stock_etp_3x;
    if (singleStockBracket === null) {
      throw new Error('ADR-0018 declares a bracket for the single-stock-ETP subclass');
    }
    const convictionFloor = REAL_CONFIGS.traderConfig.conviction_floor;

    await runOneDecisionPass({
      handle: db,
      llmClient: llmForOneDebate(),
      signal: LSE_ETP,
      traderConfig: {
        ...REAL_CONFIGS.traderConfig,
        subclass_of: { [LSE_ETP.asset]: 'single_stock_etp_3x' },
      } as unknown as ProductionConfig['traderConfig'],
      configOverrides: { capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_GBP, 'LIVE_BOOK_GBP') },
    });

    const lots = lotsByArm(db);
    expect(lots.map((lot) => lot.arm)).toEqual(['control', 'live']);

    const riskFraction =
      singleStockBracket.deployment_fraction * (1 - singleStockBracket.headroom_reserve_fraction);

    for (const lot of lots) {
      expect(lot.side).toBe('buy');
      // Both arms debate independently but off the same fixture tape and the
      // same scripted LLM responses, so this is a real per-arm read, not an
      // assumed shared value.
      expect(lot.conviction).toBeGreaterThan(convictionFloor);
      const convictionMultiplier = (lot.conviction - convictionFloor) / (1 - convictionFloor);
      const expectedNotional =
        convictionMultiplier * NO_PRECEDENT_MULTIPLIER * riskFraction * LIVE_BOOK_GBP;

      // Long: stop = entry x (1 - stop_pct), so entry = stop / (1 - stop_pct).
      const entry = lot.stop / (1 - singleStockBracket.stop_pct);
      const notional = lot.requested_size * entry;
      expect(notional).toBeCloseTo(expectedNotional, 6);
    }
  });

  /**
   * The same mutation on the PRE-D3 fallback geometry, kept because
   * `subclass_of` is `{}` on every shipped profile until the pool file lands —
   * so `atr_k` is the width the two arms actually run on today.
   */
  it('moves both arms together when the shared stop config is perturbed', async () => {
    await runOneDecisionPass({ handle: db, llmClient: llmForOneDebate() });
    const baseline = lotsByArm(db);
    expect(baseline).toHaveLength(2);

    const widened = openSharedStore(':memory:');
    try {
      await runOneDecisionPass({
        handle: widened,
        llmClient: llmForOneDebate(),
        // `atr_k` is the stop's width in ATRs — the one field, changed once.
        traderConfig: {
          ...REAL_CONFIGS.traderConfig,
          atr_k: REAL_CONFIGS.traderConfig.atr_k * 2,
        } as unknown as ProductionConfig['traderConfig'],
      });
      const perturbed = lotsByArm(widened);

      expect(perturbed.map((lot) => lot.arm)).toEqual(['control', 'live']);
      // Both arms moved…
      expect(perturbed[0]?.stop).not.toBe(baseline[0]?.stop);
      expect(perturbed[1]?.stop).not.toBe(baseline[1]?.stop);
      // …and they still agree with each other, which is the invariant.
      expect(perturbed[0]?.stop).toBe(perturbed[1]?.stop);
      expect(perturbed[0]?.target).toBe(perturbed[1]?.target);
    } finally {
      widened.close();
    }
  });

  /**
   * #1112 AC1/AC2/AC6 — through the real composition root, on BOTH arms.
   *
   * The bug this regresses: the Trader sized off `REAL_CONFIGS`' stub account
   * equity (~100,000) because `capitalCeilingUsd` was `undefined` for paper,
   * so `sizingEquity` (direct-bind.ts) never clamped. Reproducing the exact
   * pre-fix notional would require reverse-engineering this fixture's debate
   * conviction and cosine-precedent haircut; instead this proves the
   * SCALE-INVARIANT property the fix is supposed to hold: sizing tracks the
   * declared ceiling, not the account's funded equity, on both arms at once,
   * because `capitalCeilingUsd` reaches the control arm by construction — its
   * `deps.trader` is the live arm's own, spread verbatim in
   * `control-arm-wiring.ts` — rather than by a second config that happens to
   * agree.
   *
   * A ceiling of exactly 100x produces a notional of exactly 100x on both
   * rows: that is "sized against the declared book, not funded equity" (AC1)
   * and "funded equity does not change position size" (AC2, since the stub
   * account's equity is IDENTICAL in both runs — only `capitalCeilingUsd`
   * moves) made falsifiable, and it exercises both arms end-to-end (AC6).
   * `REAL_CONFIGS.traderConfig` sets no `whole_share_sizing`, so BTC-USD's
   * fractional size is not floored and the ratio is exact rather than
   * integer-rounded.
   */
  it('scales the requested size with the declared ceiling, not with funded equity, on both arms (#1112)', async () => {
    await runOneDecisionPass({
      handle: db,
      llmClient: llmForOneDebate(),
      configOverrides: { capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_GBP, 'LIVE_BOOK_GBP') },
    });
    const clamped = lotsByArm(db);
    expect(clamped.map((lot) => lot.arm)).toEqual(['control', 'live']);
    for (const lot of clamped) {
      expect(lot.requested_size).toBeGreaterThan(0);
    }

    const unclamped = openSharedStore(':memory:');
    try {
      await runOneDecisionPass({
        handle: unclamped,
        llmClient: llmForOneDebate(),
        // Matches `stubConfig`'s default account equity exactly (100,000) —
        // a ceiling that never binds, which is what `capitalCeilingUsd ===
        // undefined` behaved like before this fix (`sizingEquity` is a
        // passthrough once the ceiling is >= equity).
        configOverrides: { capitalCeilingUsd: toCapitalCeilingUsd(LIVE_BOOK_GBP * 100, 'test') },
      });
      const raw = lotsByArm(unclamped);
      expect(raw.map((lot) => lot.arm)).toEqual(['control', 'live']);

      for (let i = 0; i < clamped.length; i += 1) {
        expect(raw[i]?.requested_size).toBeCloseTo((clamped[i]?.requested_size ?? 0) * 100, 6);
      }
    } finally {
      unclamped.close();
    }
  });

  /**
   * #1112 AC7 — the return-magnitude fix, without fabricating a local replay.
   *
   * No local paper-soak history exists at the corrected sizing to replay
   * "today's control-arm session" against, and inventing a `return_pct`
   * number would be worse than not answering. The defect was never in
   * `production.ts`'s `basis` — it hardcodes the declared book (converted to
   * the account's currency since #1180) regardless of this bug (see the AC3
   * case above) — it was in the Trader's sizing numerator:
   * `capitalCeilingUsd` was `undefined` for paper, so every
   * notional, and therefore every trade's realized pnl, ran ~100x too large
   * relative to the declared book. `return_pct = pnl / basis`
   * (`buildArmComparison`) with a FIXED, correct `basis` therefore reports a
   * return ~100x too large whenever the pnl feeding it came from a ~100x
   * oversized position — which is exactly today's pre-fix control-arm
   * session the issue reports at +13.5%.
   *
   * This runs both readings through the REAL `buildArmComparison` (not a
   * reimplementation of its division) and checks each one's `return_pct`
   * against `cumulative / basis` directly — not the ratio of the two
   * readings, which holds by algebra for any linear pnl scaling regardless
   * of whether `basis` itself is correct, so it could not have caught this
   * bug. The instantiation is the issue's own documented reading: the same
   * trade, re-run at this fix's ~100x-smaller sizing, reports a return on
   * the order of the 0.5pp divergence threshold rather than ~27x above it.
   */
  it("buildArmComparison's return_pct falls ~100x when the same trade is sized against the corrected book instead of broker equity (#1112 AC7)", () => {
    const CLOSED_AT = new Date(START.getTime() - 60_000);
    const window = { from: new Date(CLOSED_AT.getTime() - 3_600_000), to: START };
    const SIZING_INFLATION = 99_876 / LIVE_BOOK_GBP; // the issue's own ~100x figure.

    const tradeWith = (realized_pnl_net: number): ClosedTrade & { arm: TradingArm } => ({
      idempotency_key: 'ac7-fixture',
      debate_id: 'ac7-fixture',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      side: 'buy',
      entry: 100,
      stop: 90,
      filled_size: 1,
      realized_pnl_net,
      fees_total: 0,
      opened_at: new Date(CLOSED_AT.getTime() - 60_000),
      closed_at: CLOSED_AT,
      close_reason: 'target',
      modelled_cost_charged: true,
      arm: 'control',
    });

    // Today's reported reading: +13.5%, produced by a position sized off
    // broker equity — the pre-fix behaviour, held fixed at the CORRECT basis
    // (`production.ts` never divided by the wrong thing; only the numerator
    // was wrong).
    const preFixPnl = 0.135 * LIVE_BOOK_GBP;
    const preFix = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      trades: [tradeWith(preFixPnl)],
      ...window,
      basis: LIVE_BOOK_GBP,
    });
    // Same trade, sized against the declared book instead: the pnl this fix
    // produces is smaller by the same ratio the notional is.
    const postFixPnl = preFixPnl / SIZING_INFLATION;
    const postFix = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      trades: [tradeWith(postFixPnl)],
      ...window,
      basis: LIVE_BOOK_GBP,
    });

    expect(preFix.control.return_pct).toBeCloseTo(0.135, 10);
    // Against the real formula (`cumulative / basis`) at postFix's own pnl,
    // not `preFix.control.return_pct / postFix.control.return_pct` — that
    // ratio holds by algebra for ANY linear scaling once `postFixPnl` is
    // defined as `preFixPnl / SIZING_INFLATION`, for whatever `basis` the two
    // calls share, correct or not, so it cannot fail on the basis-swap bug
    // this ticket fixes. This instead re-derives the expectation from
    // `postFixPnl` and `LIVE_BOOK_GBP` directly, the same way the assertion
    // above does for `preFix`.
    expect(postFix.control.return_pct).toBeCloseTo(postFixPnl / LIVE_BOOK_GBP, 10);
    // Pre-fix: ~27x the 0.5pp divergence threshold — "two orders above" as
    // the acceptance criterion states.
    expect(Math.abs(preFix.control.return_pct)).toBeGreaterThan(ARM_DIVERGENCE_RETURN_GAP_PCT * 10);
    // Post-fix: same order as the threshold, not two above it.
    expect(Math.abs(postFix.control.return_pct)).toBeLessThan(ARM_DIVERGENCE_RETURN_GAP_PCT * 10);
    expect(Math.abs(postFix.control.return_pct)).toBeGreaterThan(
      ARM_DIVERGENCE_RETURN_GAP_PCT / 10,
    );
  });
});
