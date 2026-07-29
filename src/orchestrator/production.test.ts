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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostModelImpl } from '../cost-model-backtest/cost-model.js';
import { MockLlmClient } from '../debate-engine/llm/mock-client.js';
import { SimulatedBrokerAdapter } from '../execution/simulated-adapter.js';
import { FixtureDataSource } from '../market-data-service/fixture-data-source.js';
import { MarketDataServiceImpl } from '../market-data-service/service.js';
import type { AlpacaBar, AlpacaQuote } from '../market-data-service/sources/alpaca-source.js';
import { SqliteMarketDataStore } from '../market-data-service/sqlite-market-data-store.js';
import type { Bar } from '../market-data-service/types.js';
import type { VolatilityReading } from '../risk-manager/breakers.js';
import { SimulatedClock } from '../shared/clock.js';
import {
  openSharedStore,
  type SharedStore as SqliteHandle,
} from '../shared/store/open-shared-store.js';
import type { OrderIntent } from '../shared/types.js';
import type { ApprovalOutcome, ApprovalRequest, VerdictDecision } from '../verdict/types.js';
import { buildPersistence } from './production/direct-bind.js';
import {
  buildProductionComponents,
  buildProductionOrchestrator,
  buildProductionTickRunner,
  type ProductionConfig,
  SMOKE_TEST_UNIVERSE,
  startTickLoop,
} from './production.js';
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
function stubConfig(db: SqliteHandle, overrides: Partial<ProductionConfig> = {}): ProductionConfig {
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
      getBars: vi.fn(async (): Promise<AlpacaBar[]> => []),
      getLatestQuote: vi.fn(
        async (): Promise<AlpacaQuote> => ({ t: START.toISOString(), ap: 100, bp: 99 }),
      ),
    },
    llmClient: { complete: vi.fn() } as unknown as ProductionConfig['llmClient'],
    heartbeatChannel: { postHeartbeat: vi.fn(async () => undefined) },
    approvals: {
      requestApproval: vi.fn(
        async (_request: ApprovalRequest): Promise<ApprovalOutcome> => ({ status: 'timeout' }),
      ),
    } as unknown as ProductionConfig['approvals'],
    orphanAlerts: { postOrphanAlert: vi.fn(async () => undefined) },
    ciiScoreProvider: { getCii: vi.fn(async () => null) },
    accountState: {
      getAccountState: vi.fn(async () => ({
        cash: 100_000,
        peak_equity: 100_000,
        daily_pnl_pct: 0,
        consecutive_losses: 0,
      })),
    },
    volatility: {
      getVolatilityReading: vi.fn(
        async (): Promise<VolatilityReading> => ({ atr_percentile: 0.5 }) as VolatilityReading,
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
  };
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
    drift_tolerance: 100,
    human_timeout: 60_000,
    allow_extended_hours: true,
    flag_thresholds: { size_over: 1_000_000 },
  },
  executionConfig: {
    simulated: {
      volatility_indicator: { indicator: 'atr', params: { period: 14 }, lookback: 14 },
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
      { bid: 159.5, ask: 160.5, observed_at: START, source: 'fixture' },
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
    expect(logger.entries.filter((entry) => entry.stage === 'feedback-loop')).toHaveLength(0);
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
        config: {} as never,
        approvals: { requestLoosenApproval: vi.fn() } as never,
      },
    });
    const orchestrator = buildProductionOrchestrator(config);

    await orchestrator.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const cycleEntries = logger.entries.filter((entry) => entry.stage === 'feedback-loop');
    expect(cycleEntries).toHaveLength(2);

    await orchestrator.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logger.entries.filter((entry) => entry.stage === 'feedback-loop')).toHaveLength(2);
  });

  it('schedules the narrow smoke universe by default', () => {
    const orchestrator = buildProductionOrchestrator(stubConfig(db));
    const tickPlan = orchestrator.scheduler.nextTick(new SimulatedClock(START));
    expect(tickPlan.instruments).toEqual([{ asset: 'BTC-USD', asset_class: 'crypto' }]);
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
