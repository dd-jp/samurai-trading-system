
import type { AnalystView } from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  InMemoryDebateLogStore,
  RateLimiter,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import { NousMessagesClient } from '../../../pipeline/debate-engine/llm/nous-messages-client.js';
import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { DEFAULT_NOUS_TIMEOUT_MS, NousAccountInFlightGate } from '../../../shared/llm/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { DecisionGate } from '../decision-bar-gate.js';
import { DebateBarDecisionGate } from '../decision-bar-gate.js';
import {
  buildProductionComponents,
  DEFAULT_EXPECTED_NOUS_CALL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  DEFAULT_LLM_RATE_LIMIT_CONFIG,
  DEFAULT_MAX_IN_FLIGHT_LLM_CALLS,
  type ProductionConfig,
} from '../production.js';
import { SqliteCurrentTickStore } from '../sqlite-current-tick-store.js';
import { runTickPlan } from '../tick-loop.js';
import { SequentialTickRunner } from '../tick-runner.js';
import type { AuditLog, DecisionBar, TickSteps } from '../types.js';
import { buildDebateStep } from './debate-adapter.js';
import {
  makeWiringCiiConsumerConfig,
  makeWiringCorrelationConfig,
  makeWiringCostConfig,
  makeWiringExecutionConfig,
  makeWiringRiskConfig,
  makeWiringVerdictConfig,
} from './wiring-config-fixtures.js';

const captured = vi.hoisted(() => ({
  debate: [] as Array<{ gate: unknown; gateBudgetMs?: number | undefined }>,
  sentiment: [] as Array<{ gate: unknown }>,
  xSearch: [] as Array<{ gate: unknown }>,
}));

vi.mock('../../../pipeline/debate-engine/llm/nous-messages-client.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../pipeline/debate-engine/llm/nous-messages-client.js')
    >();
  return {
    ...actual,
    NousMessagesClient: class extends actual.NousMessagesClient {
      constructor(options: ConstructorParameters<typeof actual.NousMessagesClient>[0]) {
        captured.debate.push(options);
        super(options);
      }
    },
  };
});

vi.mock(
  '../../../providers/market-intelligence/grok/nous-sentiment-client.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../providers/market-intelligence/grok/nous-sentiment-client.js')
      >();
    return {
      ...actual,
      NousSentimentClient: class extends actual.NousSentimentClient {
        constructor(options: ConstructorParameters<typeof actual.NousSentimentClient>[0]) {
          captured.sentiment.push(options);
          super(options);
        }
      },
    };
  },
);

vi.mock(
  '../../../providers/market-intelligence/grok/x-search-client.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../providers/market-intelligence/grok/x-search-client.js')
      >();
    return {
      ...actual,
      XSearchClient: class extends actual.XSearchClient {
        constructor(options: ConstructorParameters<typeof actual.XSearchClient>[0]) {
          captured.xSearch.push(options);
          super(options);
        }
      },
    };
  },
);

const NOW = new Date('2026-09-14T13:40:00Z');

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

function stubBrokerClient(): NonNullable<ProductionConfig['alpacaBrokerClient']> {
  return {
    submitOrder: vi.fn(),
    submitMarketOrder: vi.fn(),
    submitOcoOrder: vi.fn(),
    submitLimitOrder: vi.fn(),
    submitStopLimitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getPositions: vi.fn(async () => []),
    listOpenOrders: vi.fn(async () => []),
    getOrder: vi.fn(),
    getOrderByClientOrderId: vi.fn(async () => null),
    getAccount: vi.fn(),
  };
}

function stubAccountState(): NonNullable<ProductionConfig['accountState']> {
  const basis = { known: true, open_equity: 100_000, realized_pnl: 0 } as const;
  return {
    getAccountState: vi.fn(async () => ({
      cash: 100_000,
      peak_equity: 100_000,
      daily_basis: { crypto: basis, stocks: basis, portfolio: basis },
      consecutive_losses: 0,
    })),
  };
}

function stubConfig(db: StoreHandle, overrides: Partial<ProductionConfig>): ProductionConfig {
  return {
    db,
    clock: new SimulatedClock(NOW),
    mode: 'paper',
    universe: [{ asset: 'SPY', asset_class: 'stocks' }],
    alpacaBrokerClient: stubBrokerClient(),
    alpacaDataClient: {
      getBars: vi.fn(async () => []),
      getLatestQuote: vi.fn(async () => ({ t: NOW.toISOString(), ap: 100, bp: 99 })),
    },
    accountState: stubAccountState(),
    polymarketClient: {
      fetchEventMarket: vi.fn(async () => undefined),
      fetchPriceHistory: vi.fn(async () => []),
    },
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
    },
    costConfig: makeWiringCostConfig(),
    ciiConsumerConfig: makeWiringCiiConsumerConfig(),
    ...overrides,
  };
}

describe('in-flight gate wiring (#1080)', () => {
  let db: StoreHandle;

  beforeEach(() => {
    captured.debate.length = 0;
    captured.sentiment.length = 0;
    captured.xSearch.length = 0;
    vi.stubEnv('NOUS_BASE_URL', 'https://nous.test/v1');
    vi.stubEnv('NOUS_API_KEY', 'test-fake-nous-key');
    vi.stubEnv('NOUS_MODEL', 'anthropic/claude-haiku-4.5');
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  it('hands the debate client and the sentiment client the SAME exposed gate', () => {
    const { logger } = recordingLogger();

    const components = buildProductionComponents(
      stubConfig(db, { logger, sentimentEnabled: true, sentimentRetrieval: false }),
    );

    expect(captured.debate).toHaveLength(1);
    expect(captured.sentiment).toHaveLength(1);
    expect(captured.debate[0]?.gate).toBe(components.llmInFlightGate);
    expect(captured.sentiment[0]?.gate).toBe(components.llmInFlightGate);
  });

  it('hands the X retrieval client the same gate when retrieval is on', () => {
    const { logger } = recordingLogger();

    const components = buildProductionComponents(
      stubConfig(db, { logger, sentimentEnabled: true, sentimentRetrieval: true }),
    );

    expect(captured.sentiment).toHaveLength(0);
    expect(captured.xSearch).toHaveLength(1);
    expect(captured.xSearch[0]?.gate).toBe(components.llmInFlightGate);
  });

  it("budgets the debate client's gate wait against the outer race, not the network backstop", () => {
    const { logger } = recordingLogger();

    buildProductionComponents(stubConfig(db, { logger }));

    expect(captured.debate[0]?.gateBudgetMs).toBe(DEFAULT_LLM_CLIENT_CONFIG.timeoutMs);
    expect(captured.debate[0]?.gateBudgetMs).toBeLessThan(DEFAULT_NOUS_TIMEOUT_MS);
  });

  it('caps the exposed gate at one call in flight by default', async () => {
    const components = buildProductionComponents(stubConfig(db, {}));

    const held = await components.llmInFlightGate.acquire({ budgetMs: 28_000 });
    let secondGranted = false;
    const queued = components.llmInFlightGate.acquire({ budgetMs: 28_000 }).then((slot) => {
      secondGranted = true;
      return slot;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    expect(DEFAULT_MAX_IN_FLIGHT_LLM_CALLS).toBe(1);

    held.release();
    (await queued).release();
    expect(secondGranted).toBe(true);
  });

  it('admits exactly one queued caller per debate budget at the shipped default', async () => {
    const components = buildProductionComponents(stubConfig(db, {}));
    const budgetMs = DEFAULT_LLM_CLIENT_CONFIG.timeoutMs;

    const held = await components.llmInFlightGate.acquire({ budgetMs });
    const queued = await Promise.race([
      components.llmInFlightGate.acquire({ budgetMs }).then(() => 'granted' as const),
      Promise.resolve('pending' as const),
    ]);
    expect(queued).toBe('pending');

    await expect(components.llmInFlightGate.acquire({ budgetMs })).rejects.toThrow(
      /refused admission/,
    );
    expect(DEFAULT_EXPECTED_NOUS_CALL_MS).toBe(13_000);

    held.release();
  });

  it('honours an explicit expectedLlmCallMs', async () => {
    const components = buildProductionComponents(stubConfig(db, { expectedLlmCallMs: 30_000 }));

    const held = await components.llmInFlightGate.acquire({ budgetMs: 28_000 });
    await expect(components.llmInFlightGate.acquire({ budgetMs: 28_000 })).rejects.toThrow(
      /refused admission/,
    );
    held.release();
  });

  it('honours an explicit maxInFlightLlmCalls', async () => {
    const components = buildProductionComponents(stubConfig(db, { maxInFlightLlmCalls: 3 }));

    const slots = await Promise.all([
      components.llmInFlightGate.acquire({ budgetMs: 28_000 }),
      components.llmInFlightGate.acquire({ budgetMs: 28_000 }),
      components.llmInFlightGate.acquire({ budgetMs: 28_000 }),
    ]);
    expect(slots).toHaveLength(3);
    for (const slot of slots) slot.release();
  });
});

describe('a gate refusal degrades the pass instead of crashing it (#1080)', () => {
  const RETRIEVAL_LIKE_CALL_MS = 26_000;

  let store: StoreHandle;

  beforeEach(() => {
    store = openSharedStore(':memory:');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
  });

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

  function recordingAuditLog(): AuditLog & { records: Parameters<AuditLog['record']>[0][] } {
    return {
      records: [],
      record(entry) {
        this.records.push(entry);
      },
    };
  }

  it('lands as not_admitted with no error line, no crashed row and no rescind', async () => {
    const clock = new SimulatedClock(NOW);
    const { logger, entries } = recordingLogger();

    const gate = new NousAccountInFlightGate({
      maxInFlight: 1,
      expectedCallMs: DEFAULT_EXPECTED_NOUS_CALL_MS,
    });
    const held = await gate.acquire({
      budgetMs: DEFAULT_NOUS_TIMEOUT_MS,
      expectedCallMs: RETRIEVAL_LIKE_CALL_MS,
    });

    const fetchMock = vi.fn(async () => {
      throw new Error('unreachable: a refused call must never reach the wire');
    });
    vi.stubGlobal('fetch', fetchMock);

    const llmClient = new AnthropicLlmClient(
      new NousMessagesClient({
        apiKey: 'test-fake-nous-key',
        baseUrl: 'https://nous.test/v1',
        timeoutMs: DEFAULT_NOUS_TIMEOUT_MS,
        gate,
        gateBudgetMs: DEFAULT_LLM_CLIENT_CONFIG.timeoutMs,
      }),
      { ...DEFAULT_LLM_CLIENT_CONFIG, model: 'anthropic/claude-haiku-4.5' },
    );

    const debate = buildDebateStep(
      llmClient,
      new InMemoryDebateLogStore(),
      new RateLimiter(clock, DEFAULT_LLM_RATE_LIMIT_CONFIG),
      UNCAPPED_SPEND,
      logger,
    );
    const debated: Awaited<ReturnType<TickSteps['debate']>>[] = [];
    const steps: TickSteps = {
      exitCheck: async () => null,
      analysts: async () => [
        makeView(),
        makeView({ analyst_id: 'sentiment-1', direction: 'bearish' }),
      ],
      debate: async (input) => {
        const result = await debate(input);
        debated.push(result);
        return result;
      },
      trader: async () => null,
      risk: async () => {
        throw new Error('unreachable: the trader declines a refused debate');
      },
      verdict: async () => {
        throw new Error('unreachable');
      },
      execution: async () => {
        throw new Error('unreachable');
      },
    };

    const inner = new DebateBarDecisionGate();
    const rescind = vi.fn((instrument: string, bar: DecisionBar) => inner.rescind(instrument, bar));
    const decisionGate: DecisionGate = {
      claim: (instrument, tickTime) => inner.claim(instrument, tickTime),
      rescind,
    };
    const auditLog = recordingAuditLog();

    const outcomes = await runTickPlan(
      { tick_time: NOW, instruments: [{ asset: 'SPY', asset_class: 'stocks' }] },
      new SequentialTickRunner(steps),
      clock,
      {
        max_concurrent_instruments: 1,
        logger,
        auditLog,
        currentTickStore: new SqliteCurrentTickStore(store),
        decisionGate,
      },
    );

    expect(outcomes[0]?.error).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const result = debated[0];
    expect(result?.rate_limited?.reason).toMatch(/refused admission/);
    expect(result?.confidence).toBe(0);
    expect(result?.confidence).toBeLessThan(DEFAULT_TRADER_CONFIG.conviction_floor);
    expect(result?.direction).toBe('neutral');

    const refusal = entries.find((entry) => entry.event === 'debate_refused_gate');
    expect(refusal?.level).toBe('warn');
    expect(refusal?.payload).toMatchObject({
      instrument: 'SPY',
      reason: 'admission',
      in_flight: 1,
    });

    expect(entries.map((entry) => entry.event)).not.toContain('debate_unresolved');
    expect(entries.map((entry) => entry.event)).not.toContain('instrument_pass_failed');
    expect(auditLog.records.map((row) => row.decision)).not.toContain('crashed');
    expect(rescind).not.toHaveBeenCalled();

    const debateRow = auditLog.records.find((row) => row.stage === 'debate');
    expect(debateRow?.decision).toBe('not_admitted');

    held.release();
  });
});
