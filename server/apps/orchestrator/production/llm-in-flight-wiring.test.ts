/**
 * The wiring proof for #1080's in-flight cap — every Nous-speaking client the
 * REAL composition root builds is behind the SAME gate, and that gate is the
 * one `ProductionComponents` exposes.
 *
 * A separate file from `in-flight-gate.test.ts`, the split
 * `rate-limit-wiring.test.ts` makes: that file tests what a gate does, this
 * one tests what the composition root does with one. The cap is worthless
 * unless every caller shares a single instance — Nous queues per ACCOUNT, so
 * two gates would cap two halves of one queue and cap neither.
 *
 * ## The mutations these kill
 *
 * 1. Build a second `NousAccountInFlightGate` for the sentiment client (or
 *    pass `UNGATED_LLM_IN_FLIGHT` to it). Every unit test stays green; the
 *    identity assertions here go red.
 * 2. Ignore `config.maxInFlightLlmCalls` and hard-code the default. The
 *    override case goes red.
 * 3. Hand the debate client `NousMessagesClientOptions.timeoutMs` as its gate
 *    budget instead of `AnthropicLlmClientConfig.timeoutMs` — the wider
 *    network backstop, which is not the clock a queue wait actually eats.
 */

import { DEFAULT_TRADER_CONFIG } from '../../../pipeline/trader/index.js';
import type { LogEntry, Logger } from '../../../shared/index.js';
import { SimulatedClock } from '../../../shared/index.js';
import { DEFAULT_NOUS_TIMEOUT_MS } from '../../../shared/llm/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  buildProductionComponents,
  DEFAULT_EXPECTED_NOUS_CALL_MS,
  DEFAULT_LLM_CLIENT_CONFIG,
  DEFAULT_MAX_IN_FLIGHT_LLM_CALLS,
  type ProductionConfig,
} from '../production.js';
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

/**
 * A fully typed broker stub, NOT a cast. `docs/coding-standards.md` bars `as`
 * on fixtures, and this site is why: the `as unknown as` that used to stand
 * here described a client with `listOrders` and `listFills` — two methods
 * `AlpacaBrokerClient` does not declare — while five it does declare were
 * missing, and the compiler was told not to look. Nothing here is ever called;
 * `buildProductionComponents` only wires it.
 */
function stubBrokerClient(): NonNullable<ProductionConfig['alpacaBrokerClient']> {
  return {
    submitOrder: vi.fn(),
    submitMarketOrder: vi.fn(),
    submitOcoOrder: vi.fn(),
    submitLimitOrder: vi.fn(),
    submitStopLimitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getPositions: vi.fn(async () => []),
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

/**
 * The narrowest `ProductionConfig` that builds — and deliberately WITHOUT
 * `llmClient`, because the default debate client is the thing under test.
 */
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
    // `nousCredentials` reads `process.env` directly, so the default debate
    // client (and the sentiment role) resolve from here rather than from
    // `ProductionConfig.processEnv`.
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

    // The OUTER race's clock, not the network backstop: `callWithTimeout`'s
    // timer starts before `createMessage`, so that is what a queue wait eats
    // into. Equal to it and not less, because the gate's queue timer fires a
    // full `expectedCallMs` earlier — `queue_deadline` is reachable by
    // construction, so no safety margin is subtracted here (an earlier revision
    // subtracted `LLM_GATE_BUDGET_MARGIN_MS`; the timer change retired it).
    expect(captured.debate[0]?.gateBudgetMs).toBe(DEFAULT_LLM_CLIENT_CONFIG.timeoutMs);
    // The mutation this kills: hand it `NousMessagesClientOptions.timeoutMs`,
    // the wider network backstop, which is not the clock a wait actually eats.
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
    // Behaviour first, so raising the default is killed by the queue actually
    // holding rather than by the constant's own value.
    expect(secondGranted).toBe(false);
    expect(DEFAULT_MAX_IN_FLIGHT_LLM_CALLS).toBe(1);

    held.release();
    (await queued).release();
    expect(secondGranted).toBe(true);
  });

  /**
   * The shipped trade, pinned as behaviour. At a cap of 1 and
   * `DEFAULT_EXPECTED_NOUS_CALL_MS` against the debate client's 28,000 ms
   * budget, the account admits ONE call in flight plus exactly ONE queued
   * caller; every further arrival is refused on the spot, at zero tokens and
   * zero burned deadline. Of the six instruments a pass runs concurrently,
   * two proceed and four get `gate_refused` — deliberately, because #1080
   * measured that a fast pass producing no synthesis is worth less than a slow
   * one that decides.
   */
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
    // A 30,000 ms expected call cannot fit a 28,000 ms budget even with an idle
    // queue ahead of it, so the FIRST caller behind a held slot is refused —
    // which the 13,000 ms default admits.
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
