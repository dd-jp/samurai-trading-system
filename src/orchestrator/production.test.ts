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
import type { MetricsSuite } from '../cost-model-backtest/index.js';
import { CostModelImpl } from '../cost-model-backtest/index.js';
import {
  AnthropicLlmClient,
  DEFAULT_ANTHROPIC_MODEL,
  MockLlmClient,
  SqliteDebateLogStore,
} from '../debate-engine/index.js';
import { SimulatedBrokerAdapter, SqliteExecutionStore } from '../execution/index.js';
import type { DailyMetricsSample, FeedbackConfig } from '../feedback-loop/index.js';
import { SqliteTuningStore } from '../feedback-loop/index.js';
import type { AlpacaBar, AlpacaQuote, Bar } from '../market-data-service/index.js';
import {
  AlpacaDataSource,
  AssetClassRoutingDataSource,
  FixtureDataSource,
  MarketDataServiceImpl,
  SqliteMarketDataStore,
  UsEquityRegularHoursCalendar,
} from '../market-data-service/index.js';
import type { VolatilityReading } from '../risk-manager/index.js';
import type { OrderIntent } from '../shared/index.js';
import { SimulatedClock } from '../shared/index.js';
import { openSharedStore, type SharedStore as SqliteHandle } from '../shared/store/index.js';
import { SqliteSetupStore } from '../trader/index.js';
import type { ApprovalOutcome, ApprovalRequest, VerdictDecision } from '../verdict/index.js';
import { paperStartingProfile } from './paper-profile.js';
import { MIN_RETURN_OBSERVATIONS } from './production/daily-equity-metrics-source.js';
import { buildPersistence } from './production/direct-bind.js';
import {
  buildAlpacaDataSource,
  buildDefaultLlmClient,
  buildProductionComponents,
  buildProductionOrchestrator,
  buildProductionTickRunner,
  type DailyMetricsConfig,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  type FeedbackCycleConfig,
  type ProductionConfig,
  SMOKE_TEST_UNIVERSE,
  startTickLoop,
  universeAssetClasses,
} from './production.js';
import { DEFAULT_UNIVERSE } from './scheduler.js';
import { SqliteDailyEquityStore } from './sqlite-daily-equity-store.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { Logger, Scheduler, TickOutcome, TickPlan, TickRunner } from './types.js';

const START = new Date('2026-07-29T12:00:00.000Z');

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

function stubConfig(db: SqliteHandle, overrides: Partial<ProductionConfig> = {}): StubConfig {
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
    traderConfig: {} as ProductionConfig['traderConfig'],
    riskConfig: {} as ProductionConfig['riskConfig'],
    verdictConfig: {} as ProductionConfig['verdictConfig'],
    executionConfig: {} as ProductionConfig['executionConfig'],
    correlationConfig: {} as ProductionConfig['correlationConfig'],
    breakerConfig: {} as ProductionConfig['breakerConfig'],
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
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: order.idempotency_key,
    timestamp: START,
  };
}

/** Real per-stage config values (same shapes direct-bind.test.ts pins). */
const REAL_CONFIGS = {
  traderConfig: {
    conviction_floor: 0.5,
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
  },
  riskConfig: {
    max_position_size: 100_000,
    per_asset_cap: 100_000,
    per_asset_class_cap: { crypto: 100_000, stocks: 100_000 },
    portfolio_gross_cap: 200_000,
    concentration: { cap: 100_000, threshold: 0.9 },
    min_viable_size: 0.0001,
    cii_threshold: 80,
  },
  verdictConfig: {
    automation_level: { crypto: 'auto', stocks: 'auto' },
    max_signal_age: { crypto: 3_600_000, stocks: 3_600_000 },
    drift_tolerance_pct: { crypto: 0.5, stocks: 0.5 },
    human_timeout: 60_000,
    allow_extended_hours: true,
    flag_thresholds: { size_over: 1_000_000 },
  },
  executionConfig: {
    simulated: {
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 15 },
      adv_window: { timeframe: '1d', lookback: 20 },
    },
  },
  correlationConfig: { window: { timeframe: '1d', lookback: 30 }, min_bars: 5 },
  breakerConfig: {
    daily_loss_pct: 0.05,
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

/** An hourly bar series long enough for the ATR/ADV lookbacks the chain reads. */
function fixtureBars(instrument: string, timeframe: string, count: number, stepMs: number): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const close_time = new Date(START.getTime() - (count - index) * stepMs);
    const price = 100 + index;
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

describe('buildProductionComponents', () => {
  let db: SqliteHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('binds all six TickSteps as callables', () => {
    const { steps } = buildProductionComponents(stubConfig(db));

    for (const stage of ['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution'] as const) {
      expect(typeof steps[stage]).toBe('function');
    }
  });

  it('binds the execution step onto the injected Alpaca client', async () => {
    const config = stubConfig(db);
    const { steps } = buildProductionComponents(config);

    await steps.execution(goVerdict());

    expect(config.alpacaBrokerClient.submitOrder).toHaveBeenCalled();
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

  it('buildProductionTickRunner returns a SequentialTickRunner', () => {
    expect(buildProductionTickRunner(stubConfig(db))).toBeInstanceOf(SequentialTickRunner);
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

      await components.executionStore.writeClosedTrade({
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
 * the built `AnthropicHttpMessagesClient` itself never has `createMessage`
 * called, so no `fetch` stub is needed.
 */
describe('buildProductionComponents (default llmClient fallback)', () => {
  let db: SqliteHandle;
  let previousApiKey: string | undefined;
  let previousModel: string | undefined;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    previousApiKey = process.env.ANTHROPIC_API_KEY;
    previousModel = process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    db.close();
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = previousModel;
  });

  function configWithoutLlmClient(overrides: Partial<ProductionConfig> = {}): ProductionConfig {
    const { llmClient: _llmClient, ...rest } = stubConfig(db, overrides);
    return rest;
  }

  it('throws when ANTHROPIC_API_KEY is unset and llmClient is omitted', () => {
    delete process.env.ANTHROPIC_API_KEY;

    expect(() => buildProductionComponents(configWithoutLlmClient())).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('logs a startup warn and defaults to DEFAULT_ANTHROPIC_MODEL when built live', () => {
    process.env.ANTHROPIC_API_KEY = 'test-fake-anthropic-key';
    delete process.env.ANTHROPIC_MODEL;
    const logger = recordingLogger();

    buildProductionComponents(configWithoutLlmClient({ logger }));

    // Found by CONTENT, not by being the first warn: the root emits several
    // startup warnings (the spend cap adds one), and position is not a
    // property this test is about.
    const warning = logger.entries.find((entry) =>
      entry.message.includes('AnthropicHttpMessagesClient'),
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.payload).toMatchObject({ model: DEFAULT_ANTHROPIC_MODEL });
  });

  it('honors ANTHROPIC_MODEL as an override in the logged payload', () => {
    process.env.ANTHROPIC_API_KEY = 'test-fake-anthropic-key';
    process.env.ANTHROPIC_MODEL = 'claude-custom-model';
    const logger = recordingLogger();

    buildProductionComponents(configWithoutLlmClient({ logger }));

    const warning = logger.entries.find((entry) =>
      entry.message.includes('AnthropicHttpMessagesClient'),
    );
    expect(warning?.payload).toMatchObject({ model: 'claude-custom-model' });
  });

  it('builds a real AnthropicLlmClient wrapping the live client, not just a log side effect', () => {
    process.env.ANTHROPIC_API_KEY = 'test-fake-anthropic-key';
    delete process.env.ANTHROPIC_MODEL;
    const logger = recordingLogger();

    const client = buildDefaultLlmClient(logger);

    // Instance type + retry/timeout budget, not only the model threaded
    // through the startup warn log's payload (kimi-3-review on #284).
    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(DEFAULT_LLM_CLIENT_CONFIG).toEqual({
      max_tokens: 1024,
      timeoutMs: 30_000,
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    });
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
describe('composed tick chain (integration)', () => {
  let db: SqliteHandle;

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
    expect(logger.entries.map((entry) => entry.stage)).toEqual(stages);
    expect(logger.entries.every((entry) => entry.trace_id === 'trace-composed')).toBe(true);

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
      },
    );

    const stages = persistence.auditLog.getByTraceId('trace-vol-trip').map((row) => row.stage);

    // Risk is reached and is where it ends: no verdict, no execution.
    expect(stages).toEqual(['analysts', 'debate', 'trader', 'risk']);
    expect(outcome.final_stage).toBe('risk');
    expect(outcome.execution_result).toBeUndefined();
  });
});

describe('startTickLoop', () => {
  let db: SqliteHandle;

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

  it('logs and survives a tick that throws', async () => {
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
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logger.entries.some((entry) => entry.message === 'tick failed')).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runInstrument).toHaveBeenCalledTimes(2);

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
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 1,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runInstrument).toHaveBeenCalledTimes(1);
  });
});

describe('buildProductionOrchestrator', () => {
  let db: SqliteHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('runs the orphan scan exactly once, at startup, before any tick', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
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
        approvals: { requestLoosenApproval: vi.fn() } as never,
      },
    });
    const orchestrator = buildProductionOrchestrator(config);

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const cycleEntries = logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle');
    expect(cycleEntries).toHaveLength(2);

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
    expect(logger.entries.filter((entry) => entry.trace_id === 'feedback-cycle')).toHaveLength(2);
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
        // Narrowed back to one asset class on purpose (#381). The profile now
        // carries `DEFAULT_UNIVERSE`, which spans crypto AND stocks — and
        // `stubConfig` injects a single `alpacaDataClient`, which
        // `buildAlpacaDataSource` correctly REFUSES for a mixed universe (one
        // wire client cannot serve both Alpaca path roots). These cases are
        // about the feedback cycle, so they hold the market-data wiring at the
        // shape they were written against; the widened universe and its
        // routing source are asserted directly, elsewhere in this file.
        universe: SMOKE_TEST_UNIVERSE,
        logger,
        tickIntervalMs: QUIET,
        heartbeatIntervalMs: QUIET,
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

      // ...and the cycle really ran, rather than merely not warning.
      expect(
        logger.entries.filter((entry) => entry.message === 'daily feedback cycle complete'),
      ).toHaveLength(1);

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
      // cover. `SqliteDailyEquityMetricsSource` never supplies a revalidation
      // snapshot, so pbo/oos-sharpe/dsr are un-run on every cycle — wiring
      // `metrics` must not turn that from stated into merely true.
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
      });

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
     * The fail-closed property, asserted where it actually lives: the store.
     *
     * The profile declares no `risk_thresholds` dial (nothing writes that
     * table yet), so this case adds one and seeds a value — otherwise the
     * gated path is unreachable and the test would be vacuous.
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
        // Raising a loss-bounding cap: the move the loop may never make on
        // its own authority.
        proposals: [{ kind: 'risk_threshold', name: 'max_position_size', target: 6_000 }],
      };

      const { config, logger } = paperProfileConfig({ feedback, ...overrides });

      return { config, feedback, logger, tuning };
    }

    it('refuses to loosen a risk threshold nobody approved — the dial does not move', async () => {
      const { config, logger, tuning } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      // THE assertion. No approval transport in this repo can deliver a "yes"
      // back to the process, so a proposed loosening must expire unapplied
      // rather than fall through to the value it asked for.
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_000);
      // ...and it is not written to the audit log either: nothing happened,
      // so nothing is recorded as having happened.
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM dial_adjustments WHERE dial_name = ?')
          .get('max_position_size'),
      ).toEqual({ n: 0 });

      const cycle = logger.entries.find(
        (entry) => entry.message === 'daily feedback cycle complete',
      );
      expect(cycle?.payload).toMatchObject({
        loosen_pending_approval: ['max_position_size'],
        applied: false,
      });

      await orchestrator.stop();
    });

    it('falls back to the log-only channel and says the threshold stayed put', async () => {
      const { config, logger } = loosenConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      // Nothing supplied `loosenApprovals`, so the composition root's own
      // stand-in is what the cycle reached — the same default shape
      // `breachAlerts` has.
      const entry = logger.entries.find((e) => e.message.includes('LOOSENING proposed'));
      expect(entry?.level).toBe('warn');
      expect(entry?.payload).toMatchObject({ name: 'max_position_size', applied: false });

      await orchestrator.stop();
    });

    it('uses the transport SAMURAI_ALERTS selected when one is supplied', async () => {
      const requestLoosenApproval = vi.fn();
      const { config, tuning } = loosenConfig({ loosenApprovals: { requestLoosenApproval } });
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(requestLoosenApproval).toHaveBeenCalledTimes(1);
      expect(requestLoosenApproval.mock.calls[0]?.[0]).toMatchObject({
        name: 'max_position_size',
        from: 5_000,
        // The BOUNDED value a human would be approving, not the raw target —
        // one `max_step`, not the 6,000 the proposal asked for.
        to: 5_500,
      });
      // Notifying is not applying, whichever channel carries it.
      expect(tuning.getRiskThresholds().max_position_size).toBe(5_000);

      await orchestrator.stop();
    });

    it('still lets an explicit per-cycle approvals override win', async () => {
      const perCycle = vi.fn();
      const topLevel = vi.fn();
      const { config, feedback } = loosenConfig({
        loosenApprovals: { requestLoosenApproval: topLevel },
      });
      const orchestrator = buildProductionOrchestrator({
        ...config,
        feedback: { ...feedback, approvals: { requestLoosenApproval: perCycle } },
      });

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(1_500);

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

        await new SqliteExecutionStore(db).writeClosedTrade({
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

        // Seeded before the first cycle, for every analyst the root builds —
        // including the two this debate never mentions.
        expect(tuning.getAnalystWeights()).toEqual({
          technical: 1,
          fundamental: 1,
          sentiment: 1,
        });

        await vi.advanceTimersByTimeAsync(1_500);

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
        await vi.advanceTimersByTimeAsync(1_500);
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
        // stopped — a second step, not a repeat of the first.
        await vi.advanceTimersByTimeAsync(1_500);
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
      db: SqliteHandle,
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
          approvals: { requestLoosenApproval: vi.fn() },
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
      await vi.advanceTimersByTimeAsync(1_500);

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
      await vi.advanceTimersByTimeAsync(CYCLE_MS + 500);

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
      await new SqliteExecutionStore(db).writeClosedTrade({
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
      });
      const { config, logger, tuning, postBreachAlert } = armedConfig();
      const orchestrator = buildProductionOrchestrator(config);

      await orchestrator.start();
      await vi.advanceTimersByTimeAsync(CYCLE_MS + 500);

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

      expect(
        logger.entries.filter((e) => e.message.includes('insufficient observations')),
      ).toHaveLength(3);
      // The orchestrator's own "nothing to check this cycle" line keeps the
      // same cadence — one per cycle, never per tick.
      expect(
        logger.entries.filter((e) => e.message.includes('no daily MetricsSuite this cycle')),
      ).toHaveLength(3);

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
    const orchestrator = buildProductionOrchestrator(stubConfig(db));
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
      const source = buildAlpacaDataSource({}, DEFAULT_UNIVERSE, calendar);

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
      expect(universeAssetClasses(DEFAULT_UNIVERSE)).toEqual(['crypto', 'stocks']);
      expect(universeAssetClasses([])).toEqual([]);
    });

    it('refuses a single alpacaDataClient for a mixed universe instead of misrouting half of it', () => {
      // One wire client is built against one path root. Silently applying it to
      // both halves is exactly the #358 outage, so this fails loudly at
      // construction — before any order or any tick.
      expect(() =>
        buildAlpacaDataSource(
          { alpacaDataClient: { getBars: vi.fn(), getLatestQuote: vi.fn() } },
          DEFAULT_UNIVERSE,
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

  it('writes audit_log rows and clears current_tick through the real SQLite stores', async () => {
    const config = stubConfig(db, {
      tickIntervalMs: 1_000,
      heartbeatIntervalMs: 100_000,
    });
    const orchestrator = buildProductionOrchestrator(config);

    // Drive the real SequentialTickRunner over stubbed steps so the audit /
    // current_tick side effects are the production SQLite ones, not fakes.
    const runner = new SequentialTickRunner({
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
      },
    );

    expect(orchestrator.persistence.auditLog.getByTraceId('trace-audit')).toHaveLength(1);
    expect(orchestrator.persistence.currentTickStore.get('BTC-USD')).toBeUndefined();
  });
});
