
import { DEFAULT_ANALYST_TIMEOUT_MS } from '../../../pipeline/analysts/index.js';
import type { AnalystView, LlmClient, LlmRequest } from '../../../pipeline/debate-engine/index.js';
import {
  InMemoryDebateLogStore,
  LLM_CALLS_PER_ROUND,
  MAX_ROUNDS,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  type RateLimiterConfig,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { Bar, DataSource } from '../../../providers/market-data-service/index.js';
import {
  ALPACA_BARS_RETRY_CONFIG,
  ALPACA_BARS_TIMEOUT_MS,
  FixtureDataSource,
} from '../../../providers/market-data-service/index.js';
import type { AssetClass, Clock, LogEntry, Logger } from '../../../shared/index.js';
import {
  DEFAULT_VENUE_PACING,
  deriveAnalystDrainMs,
  deriveAnalystTimeoutMs,
  SimulatedClock,
  TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
  worstCaseFetchMs,
} from '../../../shared/index.js';
import {
  openSharedStore,
  SqliteLlmSpendCapStore,
  type StoreHandle,
} from '../../../shared/store/index.js';
import { DebateBarDecisionGate } from '../decision-bar-gate.js';
import { paperStartingProfile } from '../paper-profile.js';
import { buildProductionComponents, type ProductionConfig } from '../production.js';
import { DEFAULT_UNIVERSE } from '../scheduler.js';
import { runTickPlan } from '../tick-loop.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { AuditLog, CurrentTickStore, TickPlan, TickSteps } from '../types.js';
import {
  buildDebateStep,
  WORST_CASE_LLM_CALLS_PER_DEBATE,
  worstCaseLlmCallsForAssetClass,
} from './debate-adapter.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const NOW = new Date('2026-08-05T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

function countingLlmClient(options: { converged?: boolean } = {}): LlmClient & { calls: number } {
  const { converged = true } = options;
  const client = {
    calls: 0,
    async complete<T>(request: LlmRequest<T>) {
      client.calls += 1;
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'bull case wins', converged });
      } else {
        raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
      }
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) throw new Error(`fixture rejected: ${parsed.reason}`);
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
  return client;
}

function budget(overrides: Partial<RateLimiterConfig['default']> = {}): RateLimiterConfig {
  return {
    default: { windowMs: 300_000, maxLlmCalls: 10_000, maxDebates: 10_000, ...overrides },
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('the LLM rate limiter is in the production path (#388)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('meters every LLM call a debate makes, through the instance the root exposes', async () => {
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient }));

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(components.llmRateLimiter.snapshot().crypto).toEqual({
      debatesUsed: 1,
      llmCallsUsed: llmClient.calls,
    });
    expect(llmClient.calls).toBeGreaterThan(0);
  });

  it('bills the asset class the tick actually ran, not a fixed one', async () => {
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient() }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      asset_class: 'stocks',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    const snapshot = components.llmRateLimiter.snapshot();
    expect(snapshot.stocks?.debatesUsed).toBe(1);
    expect(snapshot.crypto).toBeUndefined();
  });

  it('refuses to build with a malformed rateLimiterConfig', () => {
    expect(() =>
      buildProductionComponents(
        stubConfig(db, {
          llmClient: countingLlmClient(),
          rateLimiterConfig: budget({ windowMs: 0 }),
        }),
      ),
    ).toThrow(/default\.windowMs must be a finite positive number/);
  });

  it('refuses before opening any store or wire client, not part-way through wiring', () => {
    const config = stubConfig(db, {
      llmClient: countingLlmClient(),
      rateLimiterConfig: budget({ windowMs: 0 }),
    });

    expect(() => buildProductionComponents(config)).toThrow();
    expect(config.alpacaBrokerClient.submitOrder).not.toHaveBeenCalled();
  });

  it('still constructs a finite budget when no rateLimiterConfig is supplied', async () => {
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient() }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(components.llmRateLimiter.snapshot().crypto?.llmCallsUsed).toBeGreaterThan(0);
  });

  it('builds the limiter from the injected rateLimiterConfig, not the compiled-in default', async () => {
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        rateLimiterConfig: budget({ maxDebates: 1 }),
      }),
    );

    const debate = (instrument: string) =>
      components.steps.debate({
        trace_id: 'trace-1',
        instrument,
        asset_class: 'crypto',
        views: [makeView()],
        clock: CLOCK,
        bar: NOW,
      });

    const first = await debate('BTC-USD');
    const second = await debate('ETH-USD');

    expect(first.rate_limited).toBeUndefined();
    expect(second.rate_limited?.reason).toMatch(/debate budget exhausted/);
  });
});

describe('raising maxConcurrentInstruments no longer removes the only throttle (#388)', () => {
  it.each([1, 6])('caps debates at the budget with max_concurrent_instruments=%i', async (cap) => {
    const llmClient = countingLlmClient();
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 2 }));
    const { runner } = tickRunnerOver(llmClient, rateLimiter);

    const outcomes = await runTickPlan(sixInstrumentPlan(), runner, CLOCK, {
      max_concurrent_instruments: cap,
      logger: recordingLogger().logger,
      auditLog: noopAuditLog(),
      currentTickStore: noopCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(rateLimiter.snapshot().crypto?.debatesUsed).toBe(2);
    expect(outcomes).toHaveLength(6);
    expect(llmClient.calls).toBe(2 * (LLM_CALLS_PER_ROUND + 1));
  });

  it('bills each instrument against ITS OWN class through the real runner', async () => {
    const rateLimiter = new RateLimiter(CLOCK, budget());
    const { runner } = tickRunnerOver(countingLlmClient(), rateLimiter);

    await runTickPlan(
      {
        tick_time: NOW,
        instruments: [
          { asset: 'BTC-USD', asset_class: 'crypto' },
          { asset: 'AAPL', asset_class: 'stocks' },
        ],
      },
      runner,
      CLOCK,
      {
        max_concurrent_instruments: 1,
        logger: recordingLogger().logger,
        auditLog: noopAuditLog(),
        currentTickStore: noopCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      },
    );

    const snapshot = rateLimiter.snapshot();
    expect(snapshot.crypto?.debatesUsed).toBe(1);
    expect(snapshot.stocks?.debatesUsed).toBe(1);
  });

  it('degrades the refused instruments instead of failing the whole tick', async () => {
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 2 }));
    const { runner, results } = tickRunnerOver(countingLlmClient(), rateLimiter);

    await expect(
      runTickPlan(sixInstrumentPlan(), runner, CLOCK, {
        max_concurrent_instruments: 6,
        logger: recordingLogger().logger,
        auditLog: noopAuditLog(),
        currentTickStore: noopCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      }),
    ).resolves.toHaveLength(6);

    const refused = results.filter((result) => result.rate_limited !== undefined);
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      expect(result.confidence).toBe(0);
      expect(result.direction).toBe('neutral');
      expect(result.rounds_completed).toBe(0);
    }
  });
});

describe('what a refused debate does', () => {
  it('makes no LLM call, writes no debate_log row, and says why', async () => {
    const llmClient = countingLlmClient();
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const rateLimiter = new RateLimiter(CLOCK, budget({ maxDebates: 0 }));
    const step = buildDebateStep(llmClient, store, rateLimiter, UNCAPPED_SPEND, logger);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toMatch(/debate budget exhausted/);
    expect(store.getByDebateId(result.debate_id)).toBeUndefined();

    const warned = entries.find((entry) => entry.stage === 'debate' && entry.level === 'warn');
    expect(warned?.message).toContain('not started');
  });

  it('refuses on the CALL budget too, before a debate can be cut off mid-round', async () => {
    const llmClient = countingLlmClient();
    const rateLimiter = new RateLimiter(
      CLOCK,
      budget({ maxDebates: 10, maxLlmCalls: worstCaseLlmCallsForAssetClass('crypto') - 1 }),
    );
    const step = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      rateLimiter,
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toMatch(/LLM call budget insufficient/);
  });
});

describe('the reserved worst case matches what a debate can actually spend', () => {
  it('is derived from MAX_ROUNDS rather than hard-coded', () => {
    expect(WORST_CASE_LLM_CALLS_PER_DEBATE).toBe(MAX_ROUNDS * LLM_CALLS_PER_ROUND + 1);
  });

  it('is not exceeded by a debate that runs to the hard round cap', async () => {
    const llmClient = countingLlmClient({ converged: false });
    const rateLimiter = new RateLimiter(CLOCK, budget());
    const step = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      rateLimiter,
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'SPY',
      asset_class: 'stocks',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.rounds_completed).toBe(MAX_ROUNDS_BY_ASSET_CLASS.stocks);
    expect(llmClient.calls).toBeLessThanOrEqual(worstCaseLlmCallsForAssetClass('stocks'));
    expect(llmClient.calls).toBeLessThanOrEqual(WORST_CASE_LLM_CALLS_PER_DEBATE);
    expect(rateLimiter.snapshot().stocks?.llmCallsUsed).toBe(llmClient.calls);
  });

  it('caps a crypto debate at one round and still runs disagreement detection (#581)', async () => {
    const llmClient = countingLlmClient({ converged: false });
    const rateLimiter = new RateLimiter(CLOCK, budget());
    const step = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      rateLimiter,
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.rounds_completed).toBe(1);
    expect(result.converged).toBe(false);
    expect(llmClient.calls).toBe(4);
    expect(llmClient.calls).toBeLessThanOrEqual(worstCaseLlmCallsForAssetClass('crypto'));
    expect(rateLimiter.snapshot().crypto?.llmCallsUsed).toBe(llmClient.calls);
  });

  it('reserves the per-asset-class worst case, not the global one (#581)', () => {
    expect(worstCaseLlmCallsForAssetClass('crypto')).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS.crypto * LLM_CALLS_PER_ROUND + 1,
    );
    expect(worstCaseLlmCallsForAssetClass('stocks')).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS.stocks * LLM_CALLS_PER_ROUND + 1,
    );
    expect(worstCaseLlmCallsForAssetClass('stocks')).toBeLessThan(WORST_CASE_LLM_CALLS_PER_DEBATE);
  });
});

describe('the composition root paces the broker from ops config (#299)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('honours an injected venue pacing rather than a compiled-in default', async () => {
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        venuePacing: {
          alpaca: { capacity: 1, refillPerSecond: 0.001 },
          ccxt: { capacity: 1, refillPerSecond: 1 },
          ibkr: { capacity: 5, refillPerSecond: 5 },
          saxo: { capacity: 2, refillPerSecond: 1 },
        },
      }),
    );

    const first = components.broker.submitBracket(bracketRequest('key-1'));
    const second = components.broker.submitBracket(bracketRequest('key-2'));
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    await first;
    await vi.advanceTimersByTimeAsync(200);

    expect(secondSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000_000);
    await second;
  });
});

describe('the composition root wires wait telemetry onto the shared Alpaca bucket (#1083)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('logs a wait on the real broker path once the shared bucket parks a caller', async () => {
    const { logger, entries } = recordingLogger();
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        logger,
        venuePacing: {
          alpaca: { capacity: 1, refillPerSecond: 0.001 },
          ccxt: { capacity: 1, refillPerSecond: 1 },
          ibkr: { capacity: 5, refillPerSecond: 5 },
          saxo: { capacity: 2, refillPerSecond: 1 },
        },
      }),
    );

    await components.broker.submitBracket(bracketRequest('key-1'));
    const second = components.broker.submitBracket(bracketRequest('key-2'));

    await vi.advanceTimersByTimeAsync(1_000_000);
    await second;

    const waits = entries.filter((entry) => entry.event === 'token_bucket_wait');
    expect(waits).toHaveLength(1);
    const [wait] = waits;
    if (wait === undefined) throw new Error('unreachable — length asserted above');
    expect(wait.payload).toMatchObject({ bucket: 'alpaca', lane: 'priority' });
    expect((wait.payload as { wait_ms: number }).wait_ms).toBeGreaterThanOrEqual(
      TOKEN_BUCKET_WAIT_LOG_THRESHOLD_MS,
    );
  });
});

describe('the composition root ties the analyst deadline to the resolved Alpaca pacing (#1542)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const stallingDataSource: DataSource = {
    fetchBars: () => new Promise<Bar[]>(() => {}),
    fetchMark: async () => ({
      price: 100,
      observed_at: NOW,
      source: 'fixture',
      asset_class: 'stocks',
    }),
  };

  it('waits past DEFAULT_ANALYST_TIMEOUT_MS under a widened override, and settles at the derived deadline', async () => {
    const overriddenAlpacaPacing = { capacity: 1, refillPerSecond: 0.05, reserveForPriority: 0 };
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        dataSource: stallingDataSource,
        venuePacing: {
          alpaca: overriddenAlpacaPacing,
          ccxt: DEFAULT_VENUE_PACING.ccxt,
          ibkr: DEFAULT_VENUE_PACING.ibkr,
          saxo: DEFAULT_VENUE_PACING.saxo,
        },
      }),
    );

    const alpacaFetchBoundMs = worstCaseFetchMs(ALPACA_BARS_TIMEOUT_MS, ALPACA_BARS_RETRY_CONFIG);
    const derivedTimeoutMs = deriveAnalystTimeoutMs(
      overriddenAlpacaPacing,
      components.universe.length,
      alpacaFetchBoundMs,
    );
    expect(derivedTimeoutMs).toBeGreaterThan(DEFAULT_ANALYST_TIMEOUT_MS);

    let result: Awaited<ReturnType<typeof components.analysts.runAnalysts>> | undefined;
    void components.analysts
      .runAnalysts('trace-1542', { asset: 'AAPL', asset_class: 'stocks' }, CLOCK, NOW)
      .then((settled) => {
        result = settled;
      });

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYST_TIMEOUT_MS);
    expect(result, 'the compiled-in default deadline must not fire under the widened pacing').toBe(
      undefined,
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_ANALYST_TIMEOUT_MS);
    expect(
      result,
      'a root ignoring the override would have exhausted both attempts by 2x the default deadline',
    ).toBe(undefined);

    await vi.advanceTimersByTimeAsync(2 * derivedTimeoutMs - 2 * DEFAULT_ANALYST_TIMEOUT_MS + 1);

    expect(result?.skipped).toBe(true);
    expect(result?.failures.some((failure) => failure.kind === 'timeout')).toBe(true);
  });

  it('floors the deadline at the real fetch bound rather than 0ms when the resolved drain is already covered by headroom', async () => {
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        dataSource: stallingDataSource,
      }),
    );

    expect(deriveAnalystDrainMs(DEFAULT_VENUE_PACING.alpaca, components.universe.length)).toBe(0);

    const alpacaFetchBoundMs = worstCaseFetchMs(ALPACA_BARS_TIMEOUT_MS, ALPACA_BARS_RETRY_CONFIG);

    let result: Awaited<ReturnType<typeof components.analysts.runAnalysts>> | undefined;
    void components.analysts
      .runAnalysts('trace-1542-saxo', { asset: 'BTC-USD', asset_class: 'crypto' }, CLOCK, NOW)
      .then((settled) => {
        result = settled;
      });

    await vi.advanceTimersByTimeAsync(1);
    expect(result, 'a 0ms-floored deadline would already have settled here').toBe(undefined);

    await vi.advanceTimersByTimeAsync(2 * alpacaFetchBoundMs + 1);

    expect(result?.skipped).toBe(true);
    expect(result?.failures.some((failure) => failure.kind === 'timeout')).toBe(true);
  });
});

describe('the composition root wires market-data fetch telemetry (#1082)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function bar(closeTime: string, close: number): Bar {
    const closeDate = new Date(closeTime);
    return {
      instrument: 'AAPL',
      timeframe: '1h',
      open_time: new Date(closeDate.getTime() - 60 * 60 * 1000),
      close_time: closeDate,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100,
      source: 'fixture',
    };
  }

  it('logs a market_data_fetch line on a cold-store bar fetch reached through the real composition root', async () => {
    const { logger, entries } = recordingLogger();
    const dataSource = new FixtureDataSource(
      [bar('2026-08-05T12:00:00Z', 100), bar('2026-08-05T13:00:00Z', 101)],
      { price: 101, observed_at: NOW, source: 'fixture-live' },
      'stocks',
    );
    const components = buildProductionComponents(
      stubConfig(db, {
        llmClient: countingLlmClient(),
        logger,
        dataSource,
      }),
    );

    await components.marketData.getBars('AAPL', { timeframe: '1h', lookback: 2 }, NOW);

    const events = entries.filter((entry) => entry.event === 'market_data_fetch');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      instrument: 'AAPL',
      timeframe: '1h',
      lookback: 2,
      cache: 'miss',
      outcome: 'ok',
    });
  });
});

describe("Alpaca's burst covers one fill-poll sweep of the configured universe (#299)", () => {
  it('has capacity for a getOrder per open bracket plus a concurrent submit', () => {
    const worstCaseSweep = DEFAULT_UNIVERSE.length + 1;

    expect(DEFAULT_VENUE_PACING.alpaca.capacity).toBeGreaterThanOrEqual(worstCaseSweep);
  });

  it('keeps the sustained rate under the documented account ceiling', () => {
    expect(DEFAULT_VENUE_PACING.alpaca.refillPerSecond).toBeLessThanOrEqual(200 / 60);
  });

  it('has capacity for a cold-start bar sweep alongside the order path', () => {
    const coldStart = DEFAULT_UNIVERSE.length + DEFAULT_UNIVERSE.length + 1;

    expect(DEFAULT_VENUE_PACING.alpaca.capacity).toBeGreaterThanOrEqual(coldStart);
  });

  it("affords the analyst deadline the deduped warm sweep's drain at this pacing (#1080)", () => {
    const drainMs = deriveAnalystDrainMs(DEFAULT_VENUE_PACING.alpaca, DEFAULT_UNIVERSE.length);

    expect(drainMs).toBe(30_000);
    expect(DEFAULT_ANALYST_TIMEOUT_MS).toBeGreaterThanOrEqual(drainMs);
  });

  it('the real composition root deadline (#1542) is at least this drain, plus the bounded-fetch floor', () => {
    const drainMs = deriveAnalystDrainMs(DEFAULT_VENUE_PACING.alpaca, DEFAULT_UNIVERSE.length);
    const alpacaFetchBoundMs = worstCaseFetchMs(ALPACA_BARS_TIMEOUT_MS, ALPACA_BARS_RETRY_CONFIG);
    const deadlineMs = deriveAnalystTimeoutMs(
      DEFAULT_VENUE_PACING.alpaca,
      DEFAULT_UNIVERSE.length,
      alpacaFetchBoundMs,
    );

    expect(deadlineMs).toBe(drainMs + alpacaFetchBoundMs);
    expect(deadlineMs).toBeGreaterThan(drainMs);
  });

  it('reserves enough for the order path to complete a full sweep under a data burst', () => {
    const reserve = DEFAULT_VENUE_PACING.alpaca.reserveForPriority ?? 0;

    expect(reserve).toBeGreaterThanOrEqual(DEFAULT_UNIVERSE.length);
    expect(reserve).toBeLessThan(DEFAULT_VENUE_PACING.alpaca.capacity);
  });
});

describe('paperStartingProfile supplies the budget (#388)', () => {
  it('carries a per-asset-class budget with the call budget tied to the worst case', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');

    for (const assetClass of ['crypto', 'stocks'] as const) {
      const entry = rateLimiterConfig.perAssetClass?.[assetClass];
      expect(entry).toBeDefined();
      expect(entry?.maxDebates).toBeGreaterThan(0);
      expect(entry?.maxLlmCalls).toBe((entry?.maxDebates ?? 0) * WORST_CASE_LLM_CALLS_PER_DEBATE);
    }
  });

  it('leaves headroom over the measured cadence rather than sitting on it', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');
    const perMinute = (entry: { windowMs: number; maxDebates: number } | undefined) =>
      ((entry?.maxDebates ?? 0) / (entry?.windowMs ?? 1)) * 60_000;

    expect(perMinute(rateLimiterConfig.perAssetClass?.crypto)).toBeGreaterThan(1.33 * 2);
    expect(perMinute(rateLimiterConfig.perAssetClass?.stocks)).toBeGreaterThan(1.6 * 1.5);
  });

  it('keeps `default` at or below every per-class budget', () => {
    const { rateLimiterConfig } = paperStartingProfile('paper');
    const perClass = Object.values(rateLimiterConfig.perAssetClass ?? {});

    expect(perClass.length).toBeGreaterThan(0);
    for (const entry of perClass) {
      expect(rateLimiterConfig.default.maxDebates).toBeLessThanOrEqual(entry.maxDebates);
      expect(rateLimiterConfig.default.maxLlmCalls).toBeLessThanOrEqual(entry.maxLlmCalls);
    }
  });

  it('still refuses to be a live profile', () => {
    expect(() => paperStartingProfile('live')).toThrow(/SAMURAI_MODE=live/);
  });
});

describe('the LLM spend cap is in the production path (ADR-0008)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function spend(costUsd: number, id: string): void {
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model,
         input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens,
         cost_usd, latency_ms, timestamp
       ) VALUES (?, 'debate', ?, 'claude-haiku-4-5-20251001', 100, 100, 0, 0, ?, 10, ?)`,
    ).run(`trace-${id}`, `debate-${id}`, costUsd, NOW.toISOString());
  }

  it('refuses a debate through the composition root once the budget is spent', async () => {
    spend(60, 'over-budget');
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient, llmBudgetUsd: 50 }));

    const result = await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmClient.calls).toBe(0);
    expect(result.rate_limited?.reason).toContain('LLM spend cap reached');
    expect(result.rounds_completed).toBe(0);
  });

  it('does not book rate-limit budget for a debate the cap refuses', async () => {
    spend(60, 'over-budget');
    const components = buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient(), llmBudgetUsd: 50 }),
    );

    await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(components.llmRateLimiter.snapshot().crypto).toBeUndefined();
  });

  it('admits normally while under budget, so the cap is not a blanket refusal', async () => {
    spend(1, 'under-budget');
    const llmClient = countingLlmClient();
    const components = buildProductionComponents(stubConfig(db, { llmClient, llmBudgetUsd: 50 }));

    const result = await components.steps.debate({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      views: [makeView()],
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmClient.calls).toBeGreaterThan(0);
    expect(result.rate_limited).toBeUndefined();
  });

  it('warns loudly, at startup, when no budget is configured', () => {
    const { logger, entries } = recordingLogger();

    buildProductionComponents(stubConfig(db, { llmClient: countingLlmClient(), logger }));

    const warning = entries.find((entry) => entry.message.includes('llmBudgetUsd is not set'));
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain('UNCAPPED');
  });

  it('publishes the budget it armed the cap with, whatever the config says', () => {
    buildProductionComponents(
      stubConfig(db, { llmClient: countingLlmClient(), llmBudgetUsd: 275 }),
    );

    expect(new SqliteLlmSpendCapStore(db).read().budgetUsd).toBe(275);
  });

  it('publishes a null cap for the uncapped run it warned about, but still records that it armed', () => {
    buildProductionComponents(stubConfig(db, { llmClient: countingLlmClient() }));

    const state = new SqliteLlmSpendCapStore(db).read();
    expect(state.budgetUsd).toBeNull();
    expect(state.armedAt).not.toBeNull();
  });

  it('is what the checked-in paper profile actually carries', () => {
    const profile = paperStartingProfile('paper');

    expect(profile.llmBudgetUsd).toBe(50);
    expect(profile.tickIntervalMs).toBe(2 * 60_000);
  });
});

function bracketRequest(client_order_id: string) {
  return {
    client_order_id,
    instrument: 'BTC-USD',
    asset_class: 'crypto' as const,
    side: 'buy' as const,
    size: 1,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'gtc',
  };
}

function sixInstrumentPlan(): TickPlan {
  return {
    tick_time: NOW,
    instruments: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOT-USD', 'XRP-USD'].map(
      (asset): { asset: string; asset_class: AssetClass } => ({ asset, asset_class: 'crypto' }),
    ),
  };
}

function tickRunnerOver(llmClient: LlmClient, rateLimiter: RateLimiter) {
  const results: Awaited<ReturnType<TickSteps['debate']>>[] = [];
  const debate = buildDebateStep(
    llmClient,
    new InMemoryDebateLogStore(),
    rateLimiter,
    UNCAPPED_SPEND,
  );
  const steps: TickSteps = {
    exitCheck: async () => null,
    analysts: async () => [
      makeView(),
      makeView({ analyst_id: 'sentiment-1', direction: 'bearish' }),
    ],
    debate: async (input) => {
      const result = await debate(input);
      results.push(result);
      return result;
    },
    trader: async () => null,
    risk: async () => {
      throw new Error('unreachable: trader always returns null in this harness');
    },
    verdict: async () => {
      throw new Error('unreachable');
    },
    execution: async () => {
      throw new Error('unreachable');
    },
  };
  return { runner: new SequentialTickRunner(steps), results };
}

function noopAuditLog(): AuditLog {
  return { record: vi.fn() };
}

function noopCurrentTickStore(): CurrentTickStore {
  return {
    upsert: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
  } as unknown as CurrentTickStore;
}

type StubConfig = ProductionConfig & Required<Pick<ProductionConfig, 'alpacaBrokerClient'>>;

function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig>): StubConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    logger: recordingLogger().logger,
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
