import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICATOR_UNAVAILABLE_COUNTER } from '../../pipeline/analysts/index.js';
import { buildArmComparison, noCostBasisDrops } from '../../pipeline/control-arm/index.js';
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
import { FIRST_TICK_BAR_WINDOWS } from './production/bar-prefetch.js';
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

const { tryNousCredentialsMock } = vi.hoisted(() => ({ tryNousCredentialsMock: vi.fn() }));

vi.mock('../../shared/llm/nous-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/llm/nous-config.js')>();
  tryNousCredentialsMock.mockImplementation(actual.tryNousCredentials);
  return { ...actual, tryNousCredentials: tryNousCredentialsMock };
});

const { XSearchClientMock } = vi.hoisted(() => ({ XSearchClientMock: vi.fn() }));

vi.mock('../../providers/market-intelligence/grok/x-search-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../providers/market-intelligence/grok/x-search-client.js')
    >();
  return { ...actual, XSearchClient: XSearchClientMock };
});

const { startFillSyncSpy } = vi.hoisted(() => ({ startFillSyncSpy: vi.fn() }));

vi.mock('./fill-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fill-sync.js')>();
  startFillSyncSpy.mockImplementation(actual.startFillSync);
  return { ...actual, startFillSync: startFillSyncSpy };
});

const { MiIngestAgentMock } = vi.hoisted(() => ({ MiIngestAgentMock: vi.fn() }));

vi.mock('../../providers/market-intelligence/mi-ingest-agent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../providers/market-intelligence/mi-ingest-agent.js')>();
  // biome-ignore lint/complexity/useArrowFunction: must stay a `function` — an arrow here throws "is not a constructor" the moment production.ts calls `new MiIngestAgent(...)`.
  MiIngestAgentMock.mockImplementation(function (deps: unknown) {
    return new actual.MiIngestAgent(deps as ConstructorParameters<typeof actual.MiIngestAgent>[0]);
  });
  return { ...actual, MiIngestAgent: MiIngestAgentMock };
});

const START = new Date('2026-07-29T12:00:00.000Z');

const NO_FILL_POLL_MS = 20 * 24 * 60 * 60 * 1_000;

const NO_POLYMARKET_POLL_MS = 20 * 24 * 60 * 60 * 1_000;

function recordingLogger(): Logger & { entries: Parameters<Logger['log']>[0][] } {
  const entries: Parameters<Logger['log']>[0][] = [];
  return { entries, log: (entry) => entries.push(entry) };
}

type StubConfig = ProductionConfig &
  Required<Pick<ProductionConfig, 'alpacaBrokerClient' | 'heartbeatChannel'>>;

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

  return {
    db,
    clock: new SimulatedClock(START),
    mode: 'paper',
    alpacaBrokerClient: {
      submitOrder,
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
        async (_request: ApprovalRequest): Promise<ApprovalOutcome> => 'timeout',
      ),
    } as unknown as ProductionConfig['approvals'],
    orphanAlerts: { postOrphanAlert: vi.fn(async () => undefined) },
    ciiScoreProvider: { getCii: vi.fn(async () => null) },
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_basis: {
          crypto: { known: true, open_equity: 100_000, realized_pnl: 0 },
          stocks: { known: true, open_equity: 100_000, realized_pnl: 0 },
          portfolio: { known: true, open_equity: 100_000, realized_pnl: 0 },
        } as const,
        consecutive_losses: 0,
      })),
    },
    volatility: {
      getVolatilityReading: vi.fn(
        async (): Promise<VolatilityReading> => ({ crypto: 0.02, stocks: 0.01 }),
      ),
    },
    traderConfig: DEFAULT_TRADER_CONFIG,
    riskConfig: {} as ProductionConfig['riskConfig'],
    verdictConfig: {
      automation_level: { crypto: 'auto', stocks: 'auto' },
      max_mark_age: { crypto: 3_600_000, stocks: 3_600_000 },
    } as ProductionConfig['verdictConfig'],
    executionConfig: {} as ProductionConfig['executionConfig'],
    correlationConfig: {} as ProductionConfig['correlationConfig'],
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

const REAL_CONFIGS = {
  traderConfig: {
    conviction_floor: 0.5,
    flatten_before_close_ms: 5 * 60 * 1_000,
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

function fixtureBars(instrument: string, timeframe: string, count: number, stepMs: number): Bar[] {
  const closes = buildTrendingCloses(count, 99 + count);

  return Array.from({ length: count }, (_, index) => {
    const close_time = new Date(START.getTime() - (count - index) * stepMs);
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

describe('universe resolution is a single site (#1167)', () => {
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

  const KNOWN_STRIPPER_DESYNCS = new Set([
    'shared/store/write-guard.ts',
    'tools/check-path-citations.ts',
  ]);

  function skipLineComment(source: string, i: number, n: number): number {
    i += 2;
    while (i < n && source[i] !== '\n') i++;
    return i;
  }

  function skipBlockComment(source: string, i: number, n: number): number {
    i += 2;
    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
    return i + 2;
  }

  function skipStringLiteral(source: string, i: number, n: number, quote: string): number {
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') i++;
      i++;
    }
    return i + 1;
  }

  function isQuoteChar(c: string): boolean {
    return c === "'" || c === '"' || c === '`';
  }

  function scanToken(source: string, i: number, n: number): { nextIndex: number; append: string } {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      return { nextIndex: skipLineComment(source, i, n), append: '' };
    }
    if (c === '/' && c2 === '*') {
      return { nextIndex: skipBlockComment(source, i, n), append: '' };
    }
    if (isQuoteChar(c)) {
      return { nextIndex: skipStringLiteral(source, i, n, c), append: ' ' };
    }
    return { nextIndex: i + 1, append: c };
  }

  function stripCommentsAndStrings(source: string): string {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
      const step = scanToken(source, i, n);
      out += step.append;
      i = step.nextIndex;
    }
    return out;
  }

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

  it('every KNOWN_STRIPPER_DESYNCS entry resolves to a server source file the walk finds', () => {
    const found = new Set(serverSourceFiles(SERVER_DIR).map((path) => relative(SERVER_DIR, path)));
    const stale = [...KNOWN_STRIPPER_DESYNCS].filter((entry) => !found.has(entry));
    expect(stale).toEqual([]);
  });

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
    const scanned = serverSourceFiles(SERVER_DIR).map((path) => {
      const raw = readFileSync(path, 'utf8');
      const code = KNOWN_STRIPPER_DESYNCS.has(relative(SERVER_DIR, path))
        ? raw
        : stripCommentsAndStrings(raw);
      return { path, code };
    });

    const matches = scanned.filter(({ code }) => /\?\?\s*SMOKE_TEST_UNIVERSE/.test(code));

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
  it('gives the live equity leg the LSE calendar (ADR-0015: Saxo GIA, LSE ETPs)', () => {
    const calendar = equityCalendarFor({ mode: 'live' } as unknown as ProductionConfig);

    expect(calendar.isOpen(new Date('2026-07-15T15:25:00Z'))).toBe(true);
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

  it('reports the cause of a quorum skip back through the steps it exposes (#1080)', async () => {
    const { steps } = buildProductionComponents(stubConfig(db));

    const views = await steps.analysts({
      trace_id: 'trace-skip',
      signal: { asset: 'AAPL', asset_class: 'stocks' },
      clock: new SimulatedClock(START),
      bar: START,
    });

    expect(views).toEqual([]);
    expect(steps.analystSkipKind?.('trace-skip')).toBe('fault');
  });

  it('binds the execution step onto the injected Alpaca client', async () => {
    const config = stubConfig(db);
    const { steps } = buildProductionComponents(config);

    await steps.execution(goVerdict());

    expect(config.alpacaBrokerClient.submitLimitOrder).toHaveBeenCalled();
    expect(config.alpacaBrokerClient.submitOrder).not.toHaveBeenCalled();
  });

  it('exposes the same broker instance the execution step submits through', async () => {
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
      const logger = recordingLogger();
      const config = stubConfig(db, { logger });
      const components = buildProductionComponents(config);

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

      config.alpacaBrokerClient.getOrder = vi.fn(async () => ({
        id: 'alpaca-order-1',
        client_order_id: 'idem-exec-stocks',
        status: 'filled',
        filled_qty: 'N/A',
        filled_avg_price: '100.02',
        filled_at: START.toISOString(),
        legs: [],
      })) as unknown as typeof config.alpacaBrokerClient.getOrder;

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

  it('logs the resolved sizing ceiling with the rate that produced it (#1180)', () => {
    const logger = recordingLogger();
    const profile = paperStartingProfile('paper');
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

        expect(logger.entries.some((entry) => entry.event === 'mi_agent_absent')).toBe(false);
        expect(XSearchClientMock).toHaveBeenCalledTimes(1);
        expect(XSearchClientMock).toHaveBeenCalledWith(
          expect.objectContaining({ maxSearchResults: 4 }),
        );
      },
    );

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
      expect(passedSpendCap.check().budget_usd).toBe(50);
    });
  });

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
        expect(() => buildProductionComponents(config)).toThrow(/16:30/);
        expect(() => buildProductionComponents(config)).toThrow(/#1387/);
        expect(() => buildProductionComponents(config)).not.toThrow(/#1378/);
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
      const unmodelledHalfDay = new Date(
        `${Number(LSE_TABLE_COVERAGE_END.slice(0, 4)) + 2}-12-24T12:00:00Z`,
      );
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
          realized_pnl_net: 200,
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
    process.env.NOUS_BASE_URL = 'https://nous.test/v1';
    process.env.NOUS_API_KEY = 'test-fake-nous-key';
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

  it('refuses a model with no rate in MODEL_RATES, because unpriced means uncapped', () => {
    process.env.NOUS_DEBATE_MODEL = 'vendor/not-a-real-model';

    expect(() => buildProductionComponents(configWithoutLlmClient())).toThrow(/MODEL_RATES/);
  });

  it('logs a startup warn and defaults to the debate role model when built live', () => {
    const logger = recordingLogger();

    buildProductionComponents(configWithoutLlmClient({ logger }));

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

    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(DEFAULT_LLM_CLIENT_CONFIG).toEqual({
      max_tokens: 1024,
      timeoutMs: 28_000,
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    });
  });

  it('cannot let one logical LLM call outlast the latency budget it runs inside', () => {
    expect(LATENCY_BUDGET_MS.stocks).toBe(112_000);

    const { maxAttempts, maxDelayMs } = DEFAULT_LLM_CLIENT_CONFIG.retry;
    const worstCaseLogicalCallMs =
      maxAttempts * DEFAULT_LLM_CLIENT_CONFIG.timeoutMs + (maxAttempts - 1) * maxDelayMs;

    expect(worstCaseLogicalCallMs).toBeLessThanOrEqual(112_000);
  });

  it('affords every sequential call a stocks debate issues (#1080)', () => {
    expect(MAX_ROUNDS_BY_ASSET_CLASS.stocks).toBe(1);
    expect(DEFAULT_LLM_CLIENT_CONFIG.timeoutMs).toBe(28_000);

    const worstCaseDebateMs =
      llmCallsPerDebate(MAX_ROUNDS_BY_ASSET_CLASS.stocks) * DEFAULT_LLM_CLIENT_CONFIG.timeoutMs;

    expect(worstCaseDebateMs).toBeLessThanOrEqual(112_000);
  });

  it('logs each retried LLM attempt through the client the composition root builds', async () => {
    const logger = recordingLogger();
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

    expect(retryLine?.payload).toMatchObject({ failure_cause: 'unparseable' });

    const failedLine = logger.entries.find((entry) => entry.event === 'llm_call_failed');
    expect(failedLine?.level).toBe('warn');
    expect(failedLine?.trace_id).toBe('trace-1');
    expect(failedLine?.payload).toMatchObject({
      failure_cause: 'unparseable',
      debate_id: 'debate-9',
      llm_stage: 'debate',
      model: DEFAULT_NOUS_MODELS.debate,
    });
    expect(logger.entries.filter((entry) => entry.event === 'llm_call_failed')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

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

    expect(views.some((view) => view.analyst_type === 'technical')).toBe(true);

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
    expect(counters[0]?.message).toContain(INDICATOR_UNAVAILABLE_COUNTER);
    expect(counters[0]?.trace_id).toBe('trace-745-root');
  });
});

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

    expect(components.marketIntelligenceCoverage.degraded).toBe(false);

    const views = await components.steps.analysts({
      trace_id: 'trace-752-root',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });

    expect(views.length).toBeGreaterThan(0);

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

    expect(alertsPosted).toHaveLength(1);
    expect(alertsPosted[0]).toMatchObject({ instrument: 'BTC-USD' });

    expect(components.marketIntelligenceCoverage.degraded).toBe(true);
    expect(components.marketIntelligenceCoverage.missingInstruments).toContain('BTC-USD');
  });
});

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

    await new Promise((resolve) => setImmediate(resolve));

    expect(alertsPosted).toHaveLength(1);
    expect(alertsPosted[0]).toMatchObject({ llm_failure_count: 2, total_count: 7 });
    expect((alertsPosted[0] as { rate: number }).rate).toBeCloseTo(2 / 7);
  });

  it('posts the gate-refusal-rate alert to its own injected channel, off the same store', async () => {
    const clock = new SimulatedClock(START);
    const bars = [
      ...fixtureBars('BTC-USD', '5m', 30, 5 * 60_000),
      ...fixtureBars('BTC-USD', '1h', 30, 60 * 60_000),
    ];
    const refusalAlerts: unknown[] = [];
    const truncationAlerts: unknown[] = [];
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
          truncationAlerts.push(alert);
        },
      },
      gateRefusalRateAlerts: {
        postGateRefusalRateAlert: (alert) => {
          refusalAlerts.push(alert);
        },
      },
    });

    const components = buildProductionComponents(config);

    for (let i = 0; i < 400; i += 1) {
      components.debateLog.recordGateRefusal(new Date(START.getTime() - (i + 1) * 60_000));
    }

    const views = await components.steps.analysts({
      trace_id: 'trace-1533-root',
      signal: { asset: 'BTC-USD', asset_class: 'crypto' },
      clock,
      bar: START,
    });
    expect(views.length).toBeGreaterThan(0);

    await components.steps.debate({
      trace_id: 'trace-1533-root',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views,
      clock,
      bar: START,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(refusalAlerts).toHaveLength(1);
    expect(refusalAlerts[0]).toMatchObject({ gate_refused_count: 400, decision_count: 401 });

    expect(truncationAlerts).toEqual([]);
  });
});

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
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledTimes(1);
    expect(tickSkipAlerts.postTickSkipAlert).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: 4, planned: 4 }),
    );

    releaseAll();
    await vi.advanceTimersByTimeAsync(0);
    await orchestrator.stop();
  });

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

describe("the spend cap's breach payload is wired by the composition root (#1280)", () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it("files the breach it posts under the spend cap's own stage, not the daily cycle's", () => {
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
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    const stages = persistence.auditLog.getByTraceId('trace-composed').map((row) => row.stage);

    expect(stages).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(outcome.final_stage).toBe('execution');
    expect(outcome.verdict_status).toBe('go');
    expect(outcome.execution_result?.status).toBe('submitted');
    expect(outcome.execution_result?.broker_order_ids).toHaveLength(3);

    expect(persistence.currentTickStore.get('BTC-USD')).toBeUndefined();
    expect(
      logger.entries
        .filter((entry) => entry.trace_id === 'trace-composed')
        .map((entry) => entry.stage),
    ).toEqual(stages);

    const controlStages = persistence.auditLog
      .getByTraceId('trace-composed:control')
      .map((row) => row.stage);
    expect(controlStages).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);

    const armRows = db
      .prepare('SELECT arm, idempotency_key FROM open_positions ORDER BY arm')
      .all() as { arm: string; idempotency_key: string }[];
    expect(armRows.map((row) => row.arm)).toEqual(['control', 'live']);
    expect(armRows[0]?.idempotency_key).not.toEqual(armRows[1]?.idempotency_key);

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
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    const stages = persistence.auditLog.getByTraceId('trace-vol-trip').map((row) => row.stage);

    expect(stages).toEqual(['analysts', 'debate', 'trader', 'risk']);
    expect(outcome.final_stage).toBe('risk');
    expect(outcome.execution_result).toBeUndefined();
  });

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

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

    release();
    await loop.stop();
  });

  it('records the failure and keeps ticking when the tick throws an unrenderable value (#1262)', async () => {
    const logger = recordingLogger();
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
    const failure = logger.entries.find((entry) => entry.message === 'tick failed');
    expect(failure?.payload).toEqual({ error: '[unrenderable error]' });

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
    expect(logger.entries.some((entry) => entry.message === 'instrument failed: BTC-USD')).toBe(
      true,
    );
    expect(logger.entries.some((entry) => entry.message === 'tick failed')).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it('never re-enters an instrument still in flight, even when a sibling already threw (#507, #669)', async () => {
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
    expect(callsFor('FAST')).toBe(1);
    expect(callsFor('SLOW')).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(callsFor('SLOW')).toBe(1);
    expect(callsFor('FAST')).toBeGreaterThan(1);

    releaseSlow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(callsFor('SLOW')).toBeGreaterThan(1);

    releaseSlow();
    await loop.stop();
  });

  it('a slow pass settling does not release an instrument a newer pass re-claimed', async () => {
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

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fastCallCount).toBe(2);

    gates.SLOW?.();
    await vi.advanceTimersByTimeAsync(0);

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

    const stopping = loop.stop();
    release();

    await expect(stopping).resolves.toBeUndefined();
  });

  it('reports a duplicated instrument as a scheduler fault, not as a slow previous pass (#692)', async () => {
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

    expect(runInstrument).toHaveBeenCalledTimes(1);
    expect(logger.entries.some((entry) => entry.message.includes('duplicate instrument'))).toBe(
      true,
    );
    expect(
      logger.entries.some((entry) => entry.message.includes('still running from a previous pass')),
    ).toBe(false);
  });

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

      expect(started).toEqual(['FLAT_A', 'HELD', 'FLAT_B']);
      expect(
        logger.entries.some((entry) => entry.message.includes('held-position lookup failed')),
      ).toBe(true);
    });

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

      await vi.advanceTimersByTimeAsync(1_000);

      await loop.stop();

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

      await vi.advanceTimersByTimeAsync(1_000);
      expect(runInstrument).toHaveBeenCalledTimes(4);
      expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();

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
        scheduler: planScheduler(plan),
        runner: { runInstrument } as TickRunner,
        clock: new SimulatedClock(START),
        logger,
        persistence: persistence() as never,
        decisionGate: new DebateBarDecisionGate(),
        tickIntervalMs: 1_000,
        maxConcurrentInstruments: 1,
        tickSkipAlerts,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(tickSkipAlerts.postTickSkipAlert).not.toHaveBeenCalled();
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

    await components.executionStore.writeAheadPosition(openLot('AAPL', 'live-lot'));
    await components.controlArmWiring.store.writeAheadPosition(openLot('QQQ', 'control-lot'));

    const heldAssets = await buildHeldAssetsReader(components)();

    expect(heldAssets).toEqual(new Set(['AAPL', 'QQQ']));

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

  it('warms the bar store before the tick loop is armed (#1543)', async () => {
    const fetched: string[] = [];
    let releaseFetch!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let firstFetch = true;
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      tradingCalendar: new AlwaysOpenCalendar(),
      dataSource: {
        fetchBars: async (_instrument, window) => {
          fetched.push(`${window.timeframe}/${window.lookback}`);
          if (firstFetch) {
            firstFetch = false;
            await held;
          }
          return [];
        },
        fetchMark: async () => ({
          price: 100,
          observed_at: START,
          source: 'fixture',
          asset_class: 'crypto' as const,
        }),
      },
    });
    const orchestrator = buildProductionOrchestrator(config);
    const runSpy = vi
      .spyOn(orchestrator.tickRunner, 'runInstrument')
      .mockResolvedValue({ trace_id: 't', final_stage: 'analysts' });

    const started = orchestrator.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetched).toHaveLength(1);
    expect(runSpy).not.toHaveBeenCalled();

    releaseFetch();
    await started;

    expect(fetched).toEqual(
      orchestrator.universe.flatMap(() =>
        FIRST_TICK_BAR_WINDOWS.map((window) => `${window.timeframe}/${window.lookback}`),
      ),
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runSpy).toHaveBeenCalled();

    await orchestrator.stop();
  });

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

  describe('the equity tick window reaches the flatten (#706)', () => {
    const WEDNESDAY_16_26 = new Date('2026-08-19T16:26:00+01:00');
    const WEDNESDAY_16_00 = new Date('2026-08-19T16:00:00+01:00');

    const windowedConfig = (now: Date, pinLse: boolean) =>
      stubConfig(db, {
        clock: new SimulatedClock(now),
        ...(pinLse ? { tradingCalendar: new LseRegularHoursCalendar() } : {}),
        stocksTradingWindow: londonEntryWindow(),
        universe: [{ asset: 'LQQ3', asset_class: 'stocks', subclass: 'index_etp_3x' }],
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
      if (config.traderConfig.flatten_before_close_ms !== 5 * 60_000) {
        throw new Error(
          `expected flatten_before_close_ms to be 300000, got ${config.traderConfig.flatten_before_close_ms}`,
        );
      }

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
      expect(await ranAt(WEDNESDAY_16_26)).toBe(true);
    });

    it('still does not tick equities at 16:00, outside both spans', async () => {
      expect(await ranAt(WEDNESDAY_16_00)).toBe(false);
    });

    it('resolves the tail through the mode-selected calendar, not a pinned venue', async () => {
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
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15 * 60_000);

    const config = stubConfig(db, { tickIntervalMs: 100_000 });
    expect(config.heartbeatIntervalMs).toBeUndefined();
    const orchestrator = buildProductionOrchestrator(config);
    vi.spyOn(orchestrator.tickRunner, 'runInstrument').mockResolvedValue({
      trace_id: 't',
      final_stage: 'analysts',
    });

    await orchestrator.start();
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
    await vi.advanceTimersByTimeAsync(47 * 60 * 60 * 1_000);
    expect(logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle')).toHaveLength(0);

    const startupWarns = logger.entries.filter(
      (entry) => entry.stage === 'feedback-loop' && entry.trace_id === 'startup',
    );
    expect(startupWarns).toHaveLength(1);
    expect(startupWarns[0]?.level).toBe('warn');
    expect(startupWarns[0]?.message).toContain('ProductionConfig.feedback');
    expect(startupWarns[0]?.message).toContain('pbo_over_max');
    await orchestrator.stop();
  });

  it('REFUSES TO BOOT when a kill line is configured past its in-code clamp (#638)', () => {
    const config = stubConfig(db, {
      feedback: {
        intervalMs: 1_000,
        config: {
          weights: { max_step: 0.05, floor: 0.5, ceiling: 1.5, tighten_is: 'decrease' },
          kill_thresholds: {
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
    expect(cycleEntries).toHaveLength(3);

    const metricsWarn = logger.entries.filter(
      (entry) =>
        entry.trace_id === 'startup' && entry.stage === 'feedback-loop' && entry.level === 'warn',
    );
    expect(metricsWarn).toHaveLength(1);
    expect(metricsWarn[0]?.level).toBe('warn');
    expect(metricsWarn[0]?.message).toContain('FeedbackCycleConfig.metrics');

    await orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle')).toHaveLength(3);
  });

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
      expect(computed).toHaveLength(2);
      const payload = computed[0]?.payload as {
        live: { return_pct: number; max_drawdown_pct: number };
        control: { return_pct: number; max_drawdown_pct: number };
      };
      expect(payload.live.max_drawdown_pct).toBeTypeOf('number');
      expect(payload.control.max_drawdown_pct).toBeTypeOf('number');

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

    it('the arm comparison basis and the paper sizing ceiling are the same value (#1112)', async () => {
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

  describe('the outside benchmarks run on the daily feedback cycle (#981)', () => {
    const DAY_MS = 24 * 60 * 60 * 1_000;

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
      expect(rows.every((row) => Number.isFinite(row.max_drawdown_pct))).toBe(true);
      expect(rows.every((row) => row.max_drawdown_pct > 0)).toBe(true);

      const armWindows = db
        .prepare('SELECT window_from, window_to FROM arm_comparison_samples')
        .all() as { window_from: string; window_to: string }[];
      expect(armWindows).toHaveLength(1);
      for (const row of rows) {
        expect(row.window_from).toBe(armWindows[0]?.window_from);
        expect(row.window_to).toBe(armWindows[0]?.window_to);
      }

      expect(
        logger.entries.filter((entry) => entry.message === 'outside benchmarks computed'),
      ).toHaveLength(2);
    });
  });

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

    function buildDailyBars(start: Date, end: Date) {
      const bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];
      let close = 100;
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
      return bars;
    }

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
        const bars = buildDailyBars(new Date(startParam), new Date(endParam));
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
      expect(rows.find((row) => row.benchmark === 'spy')?.max_drawdown_pct).toBeGreaterThan(0);

      expect(
        logger.entries.filter((entry) => entry.message === 'outside benchmarks computed'),
      ).toHaveLength(2);
    });
  });

  describe('the daily cycle survives process restarts (#1110)', () => {
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

    function feedbackScheduleLastBoundary(): string | null {
      const row = db
        .prepare("SELECT last_boundary FROM feedback_cycle_schedule WHERE key = 'default'")
        .get() as { last_boundary: string } | undefined;
      return row?.last_boundary ?? null;
    }

    function feedbackScheduleAttemptedBoundary(): string | null {
      const row = db
        .prepare("SELECT last_boundary FROM feedback_cycle_schedule WHERE key = 'attempt'")
        .get() as { last_boundary: string } | undefined;
      return row?.last_boundary ?? null;
    }

    async function advanceBoth(clock: SimulatedClock, ms: number): Promise<void> {
      clock.advanceTo(new Date(clock.now().getTime() + ms));
      await vi.advanceTimersByTimeAsync(ms);
    }

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

      const first = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await first.start();
      expect(sampleRows()).toHaveLength(1);
      await first.stop();

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

      await advanceBoth(clock, 10_000);
      const fourth = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));
      await fourth.start();
      expect(sampleRows()).toHaveLength(2);
      await fourth.stop();
    });

    it('one sample per day, each carrying its own window, over a multi-day run restarted more often than the interval', async () => {
      const DAY_MS = 24 * 60 * 60 * 1_000;
      const DAY0 = new Date('2026-08-01T00:00:00.000Z');
      vi.setSystemTime(DAY0);
      const clock = new SimulatedClock(DAY0);

      const RESTART_GAP_MS = 5 * 60 * 60 * 1_000;
      const RESTARTS = 15;

      for (let i = 0; i < RESTARTS; i += 1) {
        const orchestrator = buildProductionOrchestrator(
          restartDurableConfig(clock, DAY_MS, { logger: recordingLogger() }),
        );
        await orchestrator.start();

        if (i === 3) {
          expect(sampleRows()).toHaveLength(1);
        }

        await advanceAcrossBoundaries(clock, RESTART_GAP_MS, DAY_MS);
        await orchestrator.stop();
      }

      const rows = sampleRows();
      expect(rows).toHaveLength(4);

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
      await orchestrator.start();
      expect(sampleRows()).toHaveLength(1);

      db.exec('DROP TABLE feedback_cycle_schedule');
      await advanceBoth(clock, intervalMs);

      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'feedback-cycle' &&
            entry.level === 'error' &&
            entry.message.includes('feedback cycle pass failed'),
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(sampleRows()).toHaveLength(1);

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

      db.exec('DROP TABLE feedback_cycle_schedule');

      await expect(orchestrator.start()).resolves.toBeDefined();

      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'startup' &&
            entry.level === 'error' &&
            entry.message.includes('could not read the feedback cycle schedule store at startup'),
        ).length,
      ).toBe(1);

      expect(
        logger.entries.filter(
          (entry) =>
            entry.trace_id === 'feedback-cycle' &&
            entry.level === 'error' &&
            entry.message.includes('feedback cycle pass failed'),
        ).length,
      ).toBeGreaterThanOrEqual(1);

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

      const hostile: Record<string, unknown> = {
        [Symbol.toPrimitive]: () => {
          throw new Error('render boom');
        },
      };
      hostile.self = hostile;

      const recordAttemptSpy = vi
        .spyOn(SqliteFeedbackCycleScheduleStore.prototype, 'recordAttempt')
        .mockImplementationOnce(() => {
          throw hostile;
        });

      const orchestrator = buildProductionOrchestrator(
        restartDurableConfig(clock, intervalMs, { logger }),
      );
      await orchestrator.start();

      expect(sampleRows()).toHaveLength(1);
      expect(feedbackScheduleLastBoundary()).not.toBeNull();

      const attemptFailure = logger.entries.find(
        (entry) =>
          entry.trace_id === 'feedback-cycle' && entry.event === 'feedback_attempt_marker_failed',
      );
      expect(attemptFailure?.payload).toEqual({ error: '[unrenderable error]' });

      recordAttemptSpy.mockRestore();
      await orchestrator.stop();
    });

    const RISK_DIAL_NAME = 'max_position_size_fraction_of_equity';
    const RISK_DIAL_SHIPPED = 0.05;

    function dialAdjustmentValues(dialName: string): number[] {
      return (
        db
          .prepare(
            "SELECT to_value FROM dial_adjustments WHERE dial_type = 'risk_threshold' AND dial_name = ? ORDER BY id",
          )
          .all(dialName) as { to_value: number }[]
      ).map((row) => row.to_value);
    }

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

        db.exec('DROP TRIGGER block_schedule_write');
        clock.advanceTo(new Date(clock.now().getTime() + 500));
        const secondLogger = recordingLogger();
        const second = buildProductionOrchestrator(
          restartDurableConfigWithDial(clock, intervalMs, { logger: secondLogger }),
        );
        await second.start();

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

      await advanceBoth(clock, 10_000);
      const beforeSecondStart = sampleRows().length;
      await orchestrator.start();
      expect(sampleRows().length).toBeGreaterThan(beforeSecondStart);

      const beforeNextTick = sampleRows().length;
      await advanceBoth(clock, intervalMs);
      expect(sampleRows().length).toBeGreaterThan(beforeNextTick);

      await orchestrator.stop();
    });

    it.each([
      [0, /FeedbackCycleConfig\.intervalMs must be positive, got 0/],
      [Number.NaN, /FeedbackCycleConfig\.intervalMs must be positive, got NaN/],
      [Number.POSITIVE_INFINITY, /FeedbackCycleConfig\.intervalMs must be positive, got Infinity/],
    ])(
      'refuses to start with a non-finite or non-positive FeedbackCycleConfig.intervalMs ' +
        '(%p), naming the cause (#1110)',
      async (intervalMs, expectedMessage) => {
        const clock = new SimulatedClock(START);
        const orchestrator = buildProductionOrchestrator(restartDurableConfig(clock, intervalMs));

        await expect(orchestrator.start()).rejects.toThrow(expectedMessage);
      },
    );
  });

  describe('feedback cycle wiring for a paper soak (#366)', () => {
    const QUIET = 48 * 60 * 60 * 1_000;

    const QUIET_FLATTEN_WINDOW = MIN_TICKS_INSIDE_FLATTEN_WINDOW * QUIET;

    function paperProfileConfig(overrides: Partial<ProductionConfig> = {}): {
      config: ProductionConfig;
      logger: ReturnType<typeof recordingLogger>;
    } {
      const logger = recordingLogger();
      const config = stubConfig(db, {
        ...paperStartingProfile('paper'),
        universe: SMOKE_TEST_UNIVERSE,
        logger,
        tickIntervalMs: QUIET,
        heartbeatIntervalMs: QUIET,
        traderConfig: {
          ...paperStartingProfile('paper').traderConfig,
          flatten_before_close_ms: QUIET_FLATTEN_WINDOW,
          flatten_after_close_ms: QUIET,
        },
        verdictConfig: {
          ...paperStartingProfile('paper').verdictConfig,
          max_mark_age: { crypto: QUIET, stocks: QUIET },
        },
        fillPollIntervalMs: NO_FILL_POLL_MS,
        ...overrides,
      });
      return { config, logger };
    }

    it('starts the daily cycle, with neither not_started nor a missing-feedback warn', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1_000);

      expect(
        logger.entries.filter(
          (entry) => (entry.payload as { feedback_cycle?: string } | undefined)?.feedback_cycle,
        ),
      ).toHaveLength(0);
      expect(
        logger.entries.filter((entry) => entry.message.includes('ProductionConfig.feedback')),
      ).toHaveLength(0);

      expect(
        logger.entries.filter((entry) => entry.message === 'daily feedback cycle complete'),
      ).toHaveLength(2);

      await orchestrator.stop();
    });

    it('no longer warns that metrics is unset — the profile supplies it (#379)', async () => {
      const { config, logger } = paperProfileConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();

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
      await vi.advanceTimersByTimeAsync(3 * 25 * 60 * 60 * 1_000);

      const inert = logger.entries.filter((entry) =>
        entry.message.includes('live_backtest_divergence_over_max is INERT'),
      );
      expect(inert).toHaveLength(1);
      expect(inert[0]?.level).toBe('warn');
      expect(inert[0]?.trace_id).toBe('startup');
      expect(inert[0]?.payload).toMatchObject({ backtest_reference_sharpe: 0 });

      await orchestrator.stop();
    });

    function loosenConfig(overrides: Partial<ProductionConfig> = {}): {
      config: ProductionConfig;
      feedback: FeedbackCycleConfig;
      logger: ReturnType<typeof recordingLogger>;
      tuning: SqliteTuningStore;
    } {
      const profileFeedback = paperStartingProfile('paper').feedback;
      if (profileFeedback === undefined) {
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
        proposals: [{ kind: 'risk_threshold', name: 'max_position_size', target: 6_000 }],
      };

      const { config, logger } = paperProfileConfig({ feedback, ...overrides });

      return { config, feedback, logger, tuning };
    }

    it('APPLIES the loosening in paper mode and records it as reversible', async () => {
      const { config, logger, tuning } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(tuning.getRiskThresholds().max_position_size).toBe(5_500);
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
      expect(cycle?.payload).not.toHaveProperty('loosen_pending_approval');

      await orchestrator.stop();
    });

    it('falls back to the log-only channel and says the threshold MOVED', async () => {
      const { config, logger } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

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
      await vi.advanceTimersByTimeAsync(500);

      expect(notifyLoosenApplied).toHaveBeenCalledTimes(1);
      expect(notifyLoosenApplied.mock.calls[0]?.[0]).toMatchObject({
        name: 'max_position_size',
        from: 5_000,
        to: 5_500,
      });
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
      await vi.advanceTimersByTimeAsync(500);

      expect(perCycle).toHaveBeenCalledTimes(1);
      expect(topLevel).not.toHaveBeenCalled();

      await orchestrator.stop();
    });

    describe('analyst weight seeding (#371)', () => {
      const DEBATE_ID = 'debate-371';
      const ONE_STEP = 0.05;

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

        expect(tuning.getAnalystWeights()).toEqual({
          technical: 1 + ONE_STEP,
          fundamental: 1,
          sentiment: 1,
        });

        await vi.advanceTimersByTimeAsync(500);

        const weights = tuning.getAnalystWeights();
        expect(weights.technical).toBeCloseTo(1 + ONE_STEP, 10);
        expect(weights.fundamental).toBe(1);
        expect(weights.sentiment).toBe(1);

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

      it('refuses to start at all when the store cannot take the seed', async () => {
        const { config } = paperProfileConfig({
          feedback: { config: paperStartingProfile('paper').feedback?.config as FeedbackConfig },
          tickIntervalMs: 100,
          heartbeatIntervalMs: 100,
        });
        db.prepare('DROP TABLE analyst_weights').run();

        const orchestrator = buildProductionOrchestrator(config);

        await expect(orchestrator.start()).rejects.toThrow(/analyst_weights/);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(config.heartbeatChannel?.postHeartbeat).not.toHaveBeenCalled();

        await orchestrator.stop();
      });

      it('does not reset a tuned weight when the process restarts', async () => {
        await seedRealTradeAndDebate();

        const first = buildProductionOrchestrator(paperConfigWithFastCycle().config);
        await first.start();
        await vi.advanceTimersByTimeAsync(500);
        await first.stop();

        const tuning = new SqliteTuningStore(db, new SimulatedClock(START));
        const tuned = tuning.getAnalystWeights().technical;
        expect(tuned).toBeCloseTo(1 + ONE_STEP, 10);

        const { config, logger } = paperConfigWithFastCycle();
        const second = buildProductionOrchestrator(config);
        await second.start();

        expect(tuning.getAnalystWeights().technical).toBe(tuned);
        expect(
          logger.entries.find(
            (entry) => entry.message === 'analyst weight rows ready for the daily cycle',
          )?.payload,
        ).toEqual({
          seeded: [],
          already_tuned: ['technical', 'fundamental', 'sentiment'],
        });

        await vi.advanceTimersByTimeAsync(500);
        expect(tuning.getAnalystWeights().technical).toBeCloseTo(1 + 2 * ONE_STEP, 10);

        await second.stop();
      });
    });
  });

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
              getDailyMetrics: () => ('sample' in overrides ? overrides.sample : { daily: SUITE }),
            },
            backtest_reference_sharpe: overrides.backtest_reference_sharpe ?? 1.5,
          },
        },
      });

      return { config, logger, postBreachAlert, tuning };
    }

    it('calls computeMetrics from the daily timer: a breaching suite alerts AND auto-tightens', async () => {
      const { config, logger, postBreachAlert, tuning } = metricsConfig(db);
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(500);

      expect(postBreachAlert).toHaveBeenCalledTimes(1);
      expect(postBreachAlert.mock.calls[0]?.[0]).toMatchObject({
        breaches: ['live_backtest_divergence_over_max'],
      });
      expect(tuning.getRiskThresholds().max_position_size).toBeCloseTo(0.75);

      const breachLog = logger.entries.find((e) => e.message.includes('KILL-THRESHOLD BREACH'));
      expect(breachLog?.level).toBe('error');

      await orchestrator.stop();
    });

    it('records revalidation-skipped lines rather than reporting a clean bill of health', async () => {
      const { config, logger, postBreachAlert } = metricsConfig(db, {
        backtest_reference_sharpe: 0.2,
      });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(postBreachAlert).not.toHaveBeenCalled();
      const metricsLog = logger.entries.find((e) => e.message === 'daily metrics computed');
      expect(metricsLog).toBeDefined();
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
      await vi.advanceTimersByTimeAsync(3_500);

      const inertWarns = logger.entries.filter((e) =>
        e.message.includes('live_backtest_divergence_over_max is INERT'),
      );
      expect(inertWarns).toHaveLength(1);
      expect(inertWarns[0]?.level).toBe('warn');

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

      await orchestrator.start();
      feedback.config.kill_thresholds.max_pbo = 0.5;

      await vi.advanceTimersByTimeAsync(1_500);

      expect(
        logger.entries.filter((e) => e.message === 'daily feedback cycle failed').length,
      ).toBeGreaterThanOrEqual(1);
      expect(postThresholdClampAlert).toHaveBeenCalled();
      expect(postThresholdClampAlert.mock.calls[0]?.[0]).toMatchObject({
        where: 'daily-kill-line-check',
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

  describe('kill-line detector armed from the paper profile (#379)', () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1_000;
    const SERIES_START = Date.UTC(2026, 0, 1);
    const CYCLE_MS = 1_000;

    function seedDailyEquity(count: number): void {
      const store = new SqliteDailyEquityStore(db);
      for (let i = 0; i < count; i += 1) {
        const at = new Date(SERIES_START + i * MS_PER_DAY);
        store.append(at, 100_000 + (i % 7) * 250 - i * 3, at, true);
      }
    }

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

    function autoTightenRows(): number {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM dial_adjustments WHERE reason = ?')
        .get('breach_auto_tighten') as { n: number };
      return row.n;
    }

    it('below the gate: no suite, no autoTighten, no AdjustmentLog row', async () => {
      seedDailyEquity(MIN_RETURN_OBSERVATIONS);
      const { config, logger, tuning, postBreachAlert } = armedConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(500);

      const refusal = logger.entries.filter((e) => e.message.includes('insufficient observations'));
      expect(refusal).toHaveLength(1);
      expect(refusal[0]?.level).toBe('warn');
      expect(refusal[0]?.payload).toMatchObject({
        usable_returns: MIN_RETURN_OBSERVATIONS - 1,
        required: MIN_RETURN_OBSERVATIONS,
      });
      expect(logger.entries.filter((e) => e.message === 'daily metrics computed')).toHaveLength(0);
      expect(postBreachAlert).not.toHaveBeenCalled();
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_000);
      expect(autoTightenRows()).toBe(0);

      await orchestrator.stop();
    });

    it('at the gate: computeMetrics runs, and a breach reaches the real stores', async () => {
      seedDailyEquity(MIN_RETURN_OBSERVATIONS + 1);
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
      await vi.advanceTimersByTimeAsync(500);

      const computed = logger.entries.find((e) => e.message.includes('daily metrics computed'));
      if (computed === undefined) throw new Error('computeMetrics did not run');
      const daily = (computed.payload as { daily: MetricsSuite }).daily;
      expect(Number.isFinite(daily.sharpe)).toBe(true);
      expect(daily.turnover).toBeGreaterThan(0);
      expect(logger.entries.filter((e) => e.message.includes('insufficient observations'))).toEqual(
        [],
      );

      expect(postBreachAlert).toHaveBeenCalledTimes(1);
      expect(postBreachAlert.mock.calls[0]?.[0]).toMatchObject({
        breaches: ['live_backtest_divergence_over_max'],
      });
      expect(tuning.getRiskThresholds().max_position_size).toBe(4_500);
      expect(autoTightenRows()).toBe(1);

      await orchestrator.stop();
    });

    it('builds the source ONCE, at construction, so a bad one fails the start', () => {
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
      const orchestrator = buildProductionOrchestrator({ ...config, tickIntervalMs: 100 });

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(3 * CYCLE_MS + 500);

      expect(
        logger.entries.filter((e) => e.message.includes('insufficient observations')),
      ).toHaveLength(4);
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
        feedback: { ...profileFeedback, intervalMs: CYCLE_MS },
      });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(CYCLE_MS + 500);

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
    const orchestrator = buildProductionOrchestrator(
      stubConfig(db, { tradingCalendar: new AlwaysOpenCalendar() }),
    );
    const tickPlan = orchestrator.scheduler.nextTick(new SimulatedClock(START));
    expect(tickPlan.instruments).toEqual([{ asset: 'BTC-USD', asset_class: 'crypto' }]);
  });

  describe('buildAlpacaDataSource — mixed-universe market data', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const MIXED_UNIVERSE = [
      ...DEFAULT_UNIVERSE,
      { asset: 'BTC-USD', asset_class: 'crypto' as const },
    ];

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
      const source = buildAlpacaDataSource({}, SMOKE_TEST_UNIVERSE, calendar);

      expect(source).toBeInstanceOf(AlpacaDataSource);
    });

    it('serves an all-equity universe from the STOCKS source, not the crypto default', async () => {
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
      expect(universeAssetClasses([{ asset: 'SPY', asset_class: 'stocks' }])).toEqual(['stocks']);
      expect(universeAssetClasses(MIXED_UNIVERSE)).toEqual(['crypto', 'stocks']);
      expect(universeAssetClasses([])).toEqual([]);
    });

    it('refuses a single alpacaDataClient for a mixed universe instead of misrouting half of it', () => {
      expect(() =>
        buildAlpacaDataSource(
          { alpacaDataClient: { getBars: vi.fn(), getLatestQuote: vi.fn() } },
          MIXED_UNIVERSE,
          calendar,
        ),
      ).toThrow(/#358|both/);
    });

    it('refuses a dataSourceAssetClass that contradicts the universe', () => {
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
      expect(() =>
        buildAlpacaDataSource({ dataSourceAssetClass: 'stocks' }, [], calendar),
      ).not.toThrow();
    });

    it('still honours an injected client for a single-asset-class universe', () => {
      expect(() =>
        buildAlpacaDataSource(
          { alpacaDataClient: { getBars: vi.fn(), getLatestQuote: vi.fn() } },
          SMOKE_TEST_UNIVERSE,
          calendar,
        ),
      ).not.toThrow();
    });
  });

  describe('buildAlpacaDataSource — the LSE equity leg (#734)', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const LSE_UNIVERSE = [
      { asset: 'LQQ3', asset_class: 'stocks' as const },
      { asset: '3SPY', asset_class: 'stocks' as const },
    ];
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
      expect(() =>
        buildAlpacaDataSource(
          { lseMarkClient: lseClient() },
          [...LSE_UNIVERSE, { asset: 'SPY', asset_class: 'stocks' as const }],
          calendar,
        ),
      ).toThrow(/mixes LSE leveraged ETPs/);
    });

    it('refuses at boot — not mid-tick — a universe holding a USD-declared pool row', () => {
      expect(() =>
        buildAlpacaDataSource(
          { lseMarkClient: lseClient() },
          [{ asset: '3USL', asset_class: 'stocks' as const }],
          calendar,
        ),
      ).toThrow(/3USL \(USD\)/);
    });

    it('leaves every universe without an lse_ticker on exactly the path it had', () => {
      expect(buildAlpacaDataSource({}, DEFAULT_UNIVERSE, calendar)).toBeInstanceOf(
        AlpacaDataSource,
      );
      expect(buildAlpacaDataSource({}, SMOKE_TEST_UNIVERSE, calendar)).toBeInstanceOf(
        AlpacaDataSource,
      );
    });

    it('will not mark an lse_ticker off its screening_instrument, through the built source', async () => {
      const source = buildAlpacaDataSource({ lseMarkClient: lseClient() }, LSE_UNIVERSE, calendar);

      await expect(source.fetchMark('SPY', START, 'live')).rejects.toThrow(/SCREENING INSTRUMENT/);
    });

    it('serves a GBP mark stamped at the vendor observation time', async () => {
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

  describe('buildBenchmarkDataSource — benchmarks outlive the LSE cutover (#981)', () => {
    const calendar = new UsEquityRegularHoursCalendar();
    const DAY_MS = 24 * 60 * 60 * 1_000;
    const WINDOW_TO = START;
    const WINDOW_FROM = new Date(START.getTime() - 30 * DAY_MS);
    const LSE_UNIVERSE = [
      { asset: 'LQQ3', asset_class: 'stocks' as const },
      { asset: '3SPY', asset_class: 'stocks' as const },
    ];

    const lseClient = (): LseMarkClient => ({
      vendor: 'fake-lse-vendor',
      getBars: vi.fn(async () => ({ currency: 'GBp', candles: [] })),
      getLatestQuote: vi.fn(async () => ({ price: 31_240, currency: 'GBp', observed_at: START })),
    });

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
      const live = seriesOver(
        buildAlpacaDataSource({ lseMarkClient: lseClient() }, LSE_UNIVERSE, calendar),
      );

      await expect(live.getDailyCloses('SPY', WINDOW_FROM, WINDOW_TO)).rejects.toThrow(
        /SCREENING INSTRUMENT/,
      );
      await expect(live.getDailyCloses('AGG', WINDOW_FROM, WINDOW_TO)).rejects.toThrow(
        /not an lse_ticker/,
      );
    });

    it('serves SPY and AGG closes with an LSE-only universe configured', async () => {
      const series = seriesOver(buildBenchmarkDataSource({ dataClient: benchmarkClient() }));

      for (const instrument of ['SPY', 'AGG']) {
        const closes = await series.getDailyCloses(instrument, WINDOW_FROM, WINDOW_TO);

        expect(closes.length).toBeGreaterThan(0);
        expect(closes.every((observation) => Number.isFinite(observation.close))).toBe(true);
        expect(closes[0]?.close_time.getTime()).toBeLessThanOrEqual(WINDOW_FROM.getTime());
      }
    });

    it('cannot be handed the live session calendar, which is LSE in live mode', () => {
      expect(() =>
        buildBenchmarkDataSource({
          // @ts-expect-error — no `calendar` option: the US equities session is
          calendar: new LseRegularHoursCalendar(),
          dataClient: benchmarkClient(),
        }),
      ).not.toThrow();
    });

    it('builds its Alpaca client on first read, so a missing key cannot fail a boot', async () => {
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

  describe('live OHLCV failover (#562) — from the composition root', () => {
    const EQUITIES_UNIVERSE = [{ asset: 'SPY', asset_class: 'stocks' as const }];
    const WINDOW = { timeframe: '1h', lookback: 2 } as const;

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
      process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
      const logger = recordingLogger();

      try {
        buildProductionOrchestrator(
          stubConfig(db, {
            universe: EQUITIES_UNIVERSE,
            logger,
            fallbackPacing: { capacity: 9, refillPerSecond: 9, reserveForPriority: 0 },
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

    const BREAKER_UNIVERSE = [
      { asset: 'SPY', asset_class: 'stocks' as const },
      { asset: 'QQQ', asset_class: 'stocks' as const },
      { asset: 'AAPL', asset_class: 'stocks' as const },
      { asset: 'TSLA', asset_class: 'stocks' as const },
    ];

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

      expect(fallback).toHaveBeenCalledTimes(BREAKER_UNIVERSE.length);
      expect(alpaca.getBars).toHaveBeenCalledTimes(FAILOVER_CIRCUIT_FAILURE_THRESHOLD);
    });

    it('re-probes the primary after the cooldown, on the orchestrator clock (#824)', async () => {
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

      expect(60 * 60 * 1000).toBeGreaterThan(FAILOVER_CIRCUIT_COOLDOWN_MS);
      clock.advanceTo(new Date(START.getTime() + 60 * 60 * 1000));
      await orchestrator.marketData.getBars('SPY', WINDOW, clock.now());
      expect(alpaca.getBars).toHaveBeenCalledTimes(FAILOVER_CIRCUIT_FAILURE_THRESHOLD + 1);
    });

    it('leaves an injected config.dataSource unwrapped', async () => {
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

    const runner = new SequentialTickRunner({
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
        decision_bar: {
          id: `${START.toISOString()}@3600000`,
          open_time: START,
          timeframe_ms: 3_600_000,
        },
      },
    );

    const rows = orchestrator.persistence.auditLog.getByTraceId('trace-audit');
    expect(rows.map((row) => row.stage)).toEqual(['analysts', 'position_check']);
    expect(orchestrator.persistence.currentTickStore.get('BTC-USD')).toBeUndefined();
  });
});

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

    expect(decision.status).toBe('rejected');
    expect(decision.binding_constraint).toBe('risk_critic:reject');
    expect(decision.reasons.join(' ')).toContain('logged by the live run');
    expect(complete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 0 });

    fetchSpy.mockRestore();
  });

  it('#994: a logged BREACHED condition rejects at the composition root, under its own constraint', async () => {
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
  ])(
    '#994: a persisted conditions column holding %s neither throws nor rejects on the replay path',
    async (_case, stored) => {
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
    },
  );

  it('#994: drop reasons and `no_conditions` reach the PERSISTED `risk_log` row of an APPROVED decision', async () => {
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM risk_critic_log').get()).toEqual({ n: 0 });

    fetchSpy.mockRestore();
  });
});

describe('falsifier arm 2, through the composition root (#753)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const HOUR_MS = 60 * 60 * 1_000;

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

  async function runOneDecisionPass(options: {
    handle: StoreHandle;
    llmClient: NonNullable<ProductionConfig['llmClient']>;
    traderConfig?: ProductionConfig['traderConfig'];
    signal?: { asset: string; asset_class: 'crypto' | 'stocks' };
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

  function controlAndLive<T>(lots: readonly T[]): [T, T] {
    const [control, live] = lots;
    if (control === undefined || live === undefined || lots.length !== 2) {
      throw new Error(`expected exactly a control and a live lot, got ${lots.length}`);
    }
    return [control, live];
  }

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

    expect(calls.length).toBeGreaterThan(0);
    const before = calls.length;

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

    const controlLots = db
      .prepare("SELECT idempotency_key FROM open_positions WHERE arm = 'control'")
      .all() as { idempotency_key: string }[];
    expect(controlLots.length).toBeGreaterThan(0);

    const controlRisk = db
      .prepare('SELECT reasons_json FROM risk_log WHERE trace_id = ?')
      .get('trace-753-solo:control') as { reasons_json: string } | undefined;
    expect(controlRisk?.reasons_json).toContain('risk_critic: skipped');
  });

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
    expect(live?.equity).toBeGreaterThan(50_000);
    expect(control?.equity).toBeGreaterThan(50_000);
    const anchor = db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(CONTROL_BOOK_ANCHOR_KEY) as { peak_equity: number } | undefined;
    expect(anchor?.peak_equity).toBe(100_000);
    expect(lotsByArm(db).map((lot) => lot.arm)).toEqual(['control', 'live']);
  });

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
    expect(control?.equity).toBe(LIVE_BOOK_SIZING_USD);
    const anchor = db
      .prepare('SELECT peak_equity FROM account_state WHERE key = ?')
      .get(CONTROL_BOOK_ANCHOR_KEY) as { peak_equity: number } | undefined;
    expect(anchor).toBeUndefined();
  });

  it('gives both arms the same exit rule and stop, and marks the control row queryable', async () => {
    await runOneDecisionPass({ handle: db, llmClient: llmForOneDebate() });

    const lots = lotsByArm(db);
    expect(lots.map((lot) => lot.arm)).toEqual(['control', 'live']);
    const [control, live] = controlAndLive(lots);

    expect(control.instrument).toBe(live.instrument);
    expect(control.decision_timestamp).toBe(live.decision_timestamp);
    expect(control.side).toBe(live.side);
    expect(control.stop).toBe(live.stop);
    expect(control.target).toBe(live.target);
    const queried = db
      .prepare('SELECT idempotency_key FROM open_positions WHERE arm = ?')
      .all('control') as { idempotency_key: string }[];
    expect(queried.map((row) => row.idempotency_key)).toEqual([control.idempotency_key]);
    expect(control.idempotency_key).not.toBe(live.idempotency_key);
  });

  it("moves both arms together across ADR-0018 D3's frozen bracket rows", async () => {
    const LSE_ETP = { asset: 'LQQ3', asset_class: 'stocks' as const };
    const configFor = (subclass: 'index_etp_3x' | 'single_stock_etp_3x') =>
      ({
        ...REAL_CONFIGS.traderConfig,
        subclass_of: { [LSE_ETP.asset]: subclass },
      }) as unknown as ProductionConfig['traderConfig'];

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
        traderConfig: configFor('single_stock_etp_3x'),
      });
      const asSingleStock = lotsByArm(moved);
      expect(asSingleStock.map((lot) => lot.arm)).toEqual(['control', 'live']);

      const shape = (bracket: { take_profit_pct: number; stop_pct: number }) =>
        (1 + bracket.take_profit_pct) / (1 - bracket.stop_pct);
      for (const lot of asIndex) {
        expect(lot.target / lot.stop).toBeCloseTo(shape(indexBracket), 6);
      }
      for (const lot of asSingleStock) {
        expect(lot.target / lot.stop).toBeCloseTo(shape(singleStockBracket), 6);
      }

      const [indexControl, indexLive] = controlAndLive(asIndex);
      const [singleControl, singleLive] = controlAndLive(asSingleStock);
      expect(singleControl.stop).not.toBe(indexControl.stop);
      expect(singleLive.stop).not.toBe(indexLive.stop);
      expect(singleControl.stop).toBe(singleLive.stop);
      expect(singleControl.target).toBe(singleLive.target);
    } finally {
      moved.close();
    }
  });

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
      expect(lot.conviction).toBeGreaterThan(convictionFloor);
      const convictionMultiplier = (lot.conviction - convictionFloor) / (1 - convictionFloor);
      const expectedNotional =
        convictionMultiplier * NO_PRECEDENT_MULTIPLIER * riskFraction * LIVE_BOOK_GBP;

      const entry = lot.stop / (1 - singleStockBracket.stop_pct);
      const notional = lot.requested_size * entry;
      expect(notional).toBeCloseTo(expectedNotional, 6);
    }
  });

  it('moves both arms together when the shared stop config is perturbed', async () => {
    await runOneDecisionPass({ handle: db, llmClient: llmForOneDebate() });
    const baseline = lotsByArm(db);
    expect(baseline).toHaveLength(2);

    const widened = openSharedStore(':memory:');
    try {
      await runOneDecisionPass({
        handle: widened,
        llmClient: llmForOneDebate(),
        traderConfig: {
          ...REAL_CONFIGS.traderConfig,
          atr_k: REAL_CONFIGS.traderConfig.atr_k * 2,
        } as unknown as ProductionConfig['traderConfig'],
      });
      const perturbed = lotsByArm(widened);

      expect(perturbed.map((lot) => lot.arm)).toEqual(['control', 'live']);
      expect(perturbed[0]?.stop).not.toBe(baseline[0]?.stop);
      expect(perturbed[1]?.stop).not.toBe(baseline[1]?.stop);
      expect(perturbed[0]?.stop).toBe(perturbed[1]?.stop);
      expect(perturbed[0]?.target).toBe(perturbed[1]?.target);
    } finally {
      widened.close();
    }
  });

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

  it("buildArmComparison's return_pct falls ~100x when the same trade is sized against the corrected book instead of broker equity (#1112 AC7)", () => {
    const CLOSED_AT = new Date(START.getTime() - 60_000);
    const window = { from: new Date(CLOSED_AT.getTime() - 3_600_000), to: START };
    const SIZING_INFLATION = 99_876 / LIVE_BOOK_GBP;

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

    const preFixPnl = 0.135 * LIVE_BOOK_GBP;
    const preFix = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      trades: [tradeWith(preFixPnl)],
      ...window,
      basis: LIVE_BOOK_GBP,
    });
    const postFixPnl = preFixPnl / SIZING_INFLATION;
    const postFix = buildArmComparison({
      refused_passes: { live: 0, control: 0 },
      cost_basis_drops: { live: noCostBasisDrops(), control: noCostBasisDrops() },
      trades: [tradeWith(postFixPnl)],
      ...window,
      basis: LIVE_BOOK_GBP,
    });

    expect(preFix.control.return_pct).toBeCloseTo(0.135, 10);
    expect(postFix.control.return_pct).toBeCloseTo(postFixPnl / LIVE_BOOK_GBP, 10);
    expect(Math.abs(preFix.control.return_pct)).toBeGreaterThan(ARM_DIVERGENCE_RETURN_GAP_PCT * 10);
    expect(Math.abs(postFix.control.return_pct)).toBeLessThan(ARM_DIVERGENCE_RETURN_GAP_PCT * 10);
    expect(Math.abs(postFix.control.return_pct)).toBeGreaterThan(
      ARM_DIVERGENCE_RETURN_GAP_PCT / 10,
    );
  });
});
