import { fundamentalAnalyst } from '../../../pipeline/analysts/index.js';
import { NOOP_ANALYST_TELEMETRY } from '../../../pipeline/analysts/types.js';
import type {
  AnalystView,
  AnthropicMessageRequest,
  AnthropicMessagesClient,
  DebateResult,
  LlmClient,
  LlmRequest,
  SpendCap,
  SpendCapVerdict,
} from '../../../pipeline/debate-engine/index.js';
import {
  AnthropicLlmClient,
  BUDGET_REMEDY,
  CORRUPT_LEDGER_REMEDY,
  computeDebateId,
  InMemoryDebateLogStore,
  LATENCY_BUDGET_MS,
  LlmAdmissionRefusedError,
  MAX_ROUNDS_BY_ASSET_CLASS,
  RateLimiter,
  READ_FAULT_REMEDY,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
  UNCAPPED_SPEND,
} from '../../../pipeline/debate-engine/index.js';
import { accumulateCredit } from '../../../pipeline/feedback-loop/index.js';
import { AlwaysOpenCalendar } from '../../../providers/market-data-service/index.js';
import { MarketIntelligenceStore } from '../../../providers/market-intelligence/index.js';
import type {
  AssetClass,
  Clock,
  ClosedTrade,
  DebateLog,
  DebateLogStore,
  LogEntry,
  Logger,
} from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import {
  buildDebateStep,
  type GateRefusalRateGuardDeps,
  type LlmFailureRateGuardDeps,
  persistDebateLog,
} from './debate-adapter.js';
import {
  type GateRefusalRateAlert,
  type GateRefusalRateAlertChannel,
  GateRefusalRateMonitor,
  type GateRefusalWindowCounts,
  type GateRefusalWindowSource,
  type LlmGateRefusalSink,
} from './gate-refusal-rate-guard.js';
import {
  type LlmFailureRateAlert,
  type LlmFailureRateAlertChannel,
  LlmFailureRateMonitor,
  type LlmFailureRateWindowSource,
} from './llm-failure-rate-guard.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

function unlimited(): RateLimiter {
  return new RateLimiter(CLOCK, {
    default: { windowMs: 60_000, maxLlmCalls: 10_000, maxDebates: 10_000 },
  });
}

class MutableClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advanceTo(at: Date): void {
    this.at = at;
  }
}

const ASSET_CLASS: AssetClass = 'stocks';

const NO_RETRY = { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 };

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

interface FakeLlmOptions {
  converged?: boolean;
  failOnMediator?: boolean;
  mediatorFailureValue?: unknown;
}

function fakeLlmClient(options: FakeLlmOptions = {}): LlmClient {
  const { converged = true, failOnMediator = false, mediatorFailureValue } = options;
  return {
    async complete<T>(request: LlmRequest<T>) {
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        if (failOnMediator) {
          throw mediatorFailureValue ?? new Error('llm transport blew up mid-debate');
        }
        raw = JSON.stringify({ stance: 'bullish', rationale: 'bull case wins', converged });
      } else {
        raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
      }
      const parsed = request.parseResponse(raw);
      if (!parsed.valid) {
        throw new Error(`fakeLlmClient: parseResponse rejected fixture: ${parsed.reason}`);
      }
      return { data: parsed.data, raw_text: raw, latency_ms: 1 };
    },
  };
}

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('buildDebateStep', () => {
  it('presents the one-argument TickSteps.debate shape and returns a converged DebateResult', async () => {
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
    );
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(true);
    expect(result.direction).toBe('bullish');
    expect(result.rounds_completed).toBe(1);
    expect(result.contributions).toHaveLength(1);
    expect(result.position.length).toBeGreaterThan(0);
  });

  it('keys the debate to the PASSED bar, not a clock re-floor, even across a bar boundary (#743, was #393)', async () => {
    const straddled = new Date('2026-07-28T15:05:09Z');
    const bar = new Date('2026-07-28T14:00:00Z');

    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-mid-bar',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => straddled },
      bar,
    });

    expect(result.debate_id).toBe(computeDebateId('AAPL', bar, views));

    const row = store.getByDebateId(result.debate_id);
    expect(row?.bar_timestamp.toISOString()).toBe(bar.toISOString());
    expect(row?.created_at.toISOString()).toBe(straddled.toISOString());
    expect(row?.trace_id).toBe('trace-mid-bar');
    expect(result.bar_timestamp.toISOString()).toBe(bar.toISOString());
  });

  it('replays a persisted row with the ROWs bar_timestamp, not a fresh clock read (#687)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const bar = new Date('2026-07-28T14:00:00Z');

    const first = await step({
      trace_id: 'trace-first',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => new Date('2026-07-28T14:02:00Z') },
      bar,
    });

    const replayed = await step({
      trace_id: 'trace-replay',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: { now: () => new Date('2026-07-28T14:57:31Z') },
      bar,
    });

    expect(replayed.debate_id).toBe(first.debate_id);
    expect(replayed.bar_timestamp.toISOString()).toBe(bar.toISOString());
    expect(replayed.bar_timestamp).toEqual(store.getByDebateId(first.debate_id)?.bar_timestamp);
  });

  it('applies analyst weights to the resolved debate, and logs the WEIGHTED result (#435)', async () => {
    const views = [
      makeView({ analyst_id: 'bull-1', direction: 'bullish' }),
      makeView({ analyst_id: 'bear-1', direction: 'bearish' }),
    ];
    const run = (weights: Record<string, number>, store: InMemoryDebateLogStore) =>
      buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND, undefined, {
        getAnalystWeights: () => weights,
      })({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      });

    const seededStore = new InMemoryDebateLogStore();
    const seeded = await run({ 'bull-1': 1, 'bear-1': 1 }, seededStore);

    const movedStore = new InMemoryDebateLogStore();
    const moved = await run({ 'bull-1': 2, 'bear-1': 0.5 }, movedStore);

    expect(moved.confidence).toBeGreaterThan(seeded.confidence);

    expect(moved.debate_id).toBe(seeded.debate_id);

    expect(movedStore.getByDebateId(moved.debate_id)).toBeDefined();
  });

  it('writes exactly one debate_log row for a completed debate (#364)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM debate_log WHERE debate_id = ?')
      .get(result.debate_id) as { n: number };
    expect(count.n).toBe(1);

    const roundRows = db
      .prepare('SELECT round, direction FROM debate_round_log WHERE debate_id = ? ORDER BY round')
      .all(result.debate_id) as { round: number; direction: string }[];
    expect(roundRows.length).toBe(result.rounds_completed);
    expect(roundRows[roundRows.length - 1]?.direction).toBe(result.direction);

    const row = store.getByDebateId(result.debate_id);
    expect(row).toBeDefined();
    expect(row?.instrument).toBe('AAPL');
    expect(row?.bar_timestamp.toISOString()).toBe(NOW.toISOString());
    expect(row?.direction).toBe('bullish');
    expect(row?.rounds).toBe(result.rounds_completed);
    expect(row?.contributions).toEqual(result.contributions);
  });

  it('writes a row for a debate that resolves WITHOUT converging (hard-cap termination)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(
      fakeLlmClient({ converged: false }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(MAX_ROUNDS_BY_ASSET_CLASS[ASSET_CLASS]);
    expect(store.getByDebateId(result.debate_id)?.rounds).toBe(
      MAX_ROUNDS_BY_ASSET_CLASS[ASSET_CLASS],
    );
  });

  it('writes NO row when the debate throws partway, and logs the miss', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      fakeLlmClient({ failOnMediator: true }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );
    const views = [makeView()];

    await expect(
      step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    expect(store.getByDebateId(computeDebateId('AAPL', NOW, views))).toBeUndefined();

    const missed = entries.find((entry) => entry.stage === 'debate' && entry.level === 'error');
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('no debate_log row');
  });

  it('an unrenderable debate failure still logs debate_unresolved and still throws the ORIGINAL cause', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const hostile: Record<string, unknown> = {
      [Symbol.toPrimitive]: () => {
        throw new Error('render boom');
      },
    };
    hostile.self = hostile;
    const step = buildDebateStep(
      fakeLlmClient({ failOnMediator: true, mediatorFailureValue: hostile }),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );
    const views = [makeView()];

    let thrown: unknown;
    try {
      await step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(hostile);

    const missed = entries.find(
      (entry) => entry.stage === 'debate' && entry.event === 'debate_unresolved',
    );
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('[unrenderable error]');
  });

  it('replays the persisted debate when the same bar ticks again, spending nothing (#617)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();

    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      async complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const step = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND, logger);
    const input = {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    };

    const first = await step(input);
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await step({ ...input, trace_id: 'trace-1-retry' });

    expect(second.debate_id).toBe(first.debate_id);

    expect(llmCalls).toBe(callsAfterFirst);

    expect(second.confidence).toBe(first.confidence);
    expect(second.direction).toBe(first.direction);
    expect(second.confidence).toBe(store.getByDebateId(first.debate_id)?.confidence);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);

    const replayed = entries.find((entry) => entry.message.includes('replayed from debate_log'));
    expect(replayed).toBeDefined();
    expect(replayed?.level).toBe('info');
    expect(entries.some((entry) => entry.message.includes('already has a debate_log'))).toBe(false);
  });

  it('replays the bar even when re-entered with DRIFTED views — the bar axis #617 misses (#781)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();

    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const step = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND, logger);

    const first = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 61.2 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await step({
      trace_id: 'trace-1-reentry',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 63.8 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(llmCalls).toBe(callsAfterFirst);
    expect(second.debate_id).toBe(first.debate_id);
    expect(second.confidence).toBe(first.confidence);
    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
    expect(entries.some((entry) => entry.message.includes('already resolved to a debate'))).toBe(
      true,
    );

    const nextBar = new Date(NOW.getTime() + 3_600_000);
    const third = await step({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      views: [makeView({ key_points: ['RSI 55.0 on the 5m read'] })],
      asset_class: ASSET_CLASS,
      clock: { now: () => nextBar },
      bar: nextBar,
    });
    expect(llmCalls).toBeGreaterThan(callsAfterFirst);
    expect(third.debate_id).not.toBe(first.debate_id);
  });

  it('pays for one debate when an MI item ages out mid-bar across a restart (#782)', async () => {
    const bar = new Date('2026-07-28T14:00:00Z');
    const clock = new MutableClock(new Date('2026-07-28T14:01:00Z'));
    const intelligence = new MarketIntelligenceStore(clock);
    intelligence.ingest({
      agent_id: 'deepresearch',
      timestamp: new Date('2026-07-27T14:30:00Z'),
      asset_class: 'stocks',
      items: [
        {
          id: 'news-1',
          source: 'benzinga',
          type: 'news',
          timestamp: new Date('2026-07-27T14:30:00Z'),
          entity: 'AAPL',
          headline: 'Apple beats on revenue',
          sentiment: 1,
          confidence: 0.9,
        },
      ],
    });

    const marketData = {
      getMark: async () => ({
        price: 100,
        observed_at: bar,
        asset_class: 'stocks' as const,
        source: 'fixture',
      }),
    } as unknown as Parameters<typeof fundamentalAnalyst.run>[0]['market_data'];

    const viewsNow = async (trace_id: string): Promise<AnalystView[]> => [
      await fundamentalAnalyst.run({
        trace_id,
        signal: { asset: 'AAPL', asset_class: 'stocks' },
        clock,
        bar,
        market_intelligence: intelligence,
        market_data: marketData,
        calendar: new AlwaysOpenCalendar(),
        telemetry: NOOP_ANALYST_TELEMETRY,
      }),
    ];

    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    let llmCalls = 0;
    const counting = fakeLlmClient();
    const countingClient: LlmClient = {
      complete(request) {
        llmCalls++;
        return counting.complete(request);
      },
    };

    const beforeRestart = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND);
    const first = await beforeRestart({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: await viewsNow('trace-1'),
      asset_class: ASSET_CLASS,
      clock,
      bar,
    });
    const callsAfterFirst = llmCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    clock.advanceTo(new Date('2026-07-28T14:40:00Z'));

    const afterRestart = buildDebateStep(countingClient, store, unlimited(), UNCAPPED_SPEND);
    const second = await afterRestart({
      trace_id: 'trace-2',
      instrument: 'AAPL',
      views: await viewsNow('trace-2'),
      asset_class: ASSET_CLASS,
      clock,
      bar,
    });

    expect(llmCalls).toBe(callsAfterFirst);
    expect(second.debate_id).toBe(first.debate_id);
    expect(second.confidence).toBe(first.confidence);
    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('re-runs the debate when the persisted row predates the replay fields', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    db.prepare(
      `INSERT INTO debate_log (debate_id, instrument, bar_timestamp, contributions_json,
         direction, rounds, created_at)
       VALUES (?, 'AAPL', ?, '[]', 'bullish', 1, ?)`,
    ).run(debate_id, NOW.toISOString(), NOW.toISOString());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.debate_id).toBe(debate_id);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('re-runs the debate when the persisted row carries only SOME replay fields', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    db.prepare(
      `INSERT INTO debate_log (debate_id, instrument, bar_timestamp, contributions_json,
         direction, rounds, created_at, confidence)
       VALUES (?, 'AAPL', ?, '[]', 'bullish', 1, ?, 0.9)`,
    ).run(debate_id, NOW.toISOString(), NOW.toISOString());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.debate_id).toBe(debate_id);
    expect(result.confidence).not.toBe(0.9);
    expect(result.synthesis).not.toBe('');
  });

  it('returns the winner’s row when it loses the duplicate-write race', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();
    const views = [makeView()];
    const debate_id = computeDebateId('AAPL', NOW, views);

    const winner: DebateLog = {
      debate_id,
      instrument: 'AAPL',
      bar_timestamp: NOW,
      contributions: [],
      direction: 'bullish',
      rounds: 1,
      created_at: NOW,
      confidence: 0.4242,
      synthesis: 'the winner synthesis',
      position: 'the winner position',
      disagreement_summary: 'none',
      open_items: [],
      converged: true,
    };
    store.writeLog(winner);

    let reads = 0;
    const racing: DebateLogStore = {
      writeLog: (log) => {
        store.writeLog(log);
      },
      writeLogWithRounds: (log, entries) => {
        store.writeLogWithRounds(log, entries);
      },
      getByDebateId: (id) => {
        reads += 1;
        if (reads === 1) {
          return undefined;
        }
        return store.getByDebateId(id);
      },
    };

    const loser = await buildDebateStep(
      fakeLlmClient(),
      racing,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    )({
      trace_id: 'loser',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(loser.debate_id).toBe(debate_id);
    expect(loser.confidence).toBe(0.4242);
    expect(loser.synthesis).toBe('the winner synthesis');
    expect(entries.some((entry) => entry.message.includes('already has a debate_log'))).toBe(true);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("produces rows the Feedback Loop's attribution reader can consume end to end", async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const trade: ClosedTrade = {
      idempotency_key: 'AAPL-2026-07-28T14',
      debate_id: result.debate_id,
      instrument: 'AAPL',
      asset_class: 'stocks',
      side: 'buy',
      entry: 100,
      stop: 95,
      filled_size: 10,
      realized_pnl_net: 100,
      fees_total: 1,
      opened_at: NOW,
      closed_at: new Date('2026-07-29T14:00:00Z'),
      close_reason: 'target',
      modelled_cost_charged: true,
    };

    const credits = accumulateCredit([trade], store);

    const credit = credits.get('technical-1');
    expect(credit).toBeDefined();
    expect(credit?.trade_count).toBe(1);
    expect(credit?.total_credit).toBeGreaterThan(0);
  });
});

describe('buildDebateStep latency budget (#374)', () => {
  function stallingLlmClient(options: { stallAfterCalls: number; converged?: boolean }): {
    client: LlmClient;
    callCount: () => number;
  } {
    const { stallAfterCalls, converged = false } = options;
    const inner = fakeLlmClient({ converged });
    let calls = 0;

    return {
      callCount: () => calls,
      client: {
        async complete<T>(request: LlmRequest<T>) {
          calls++;
          if (calls > stallAfterCalls) {
            return await new Promise<never>((_resolve, reject) => {
              request.signal?.addEventListener('abort', () =>
                reject(request.signal?.reason ?? new Error('aborted')),
              );
            });
          }
          return await inner.complete(request);
        },
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns on budget instead of waiting for a debate that never answers', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited(), UNCAPPED_SPEND);

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    const result = await pending;

    expect(result.timed_out).toEqual({
      budget_ms: LATENCY_BUDGET_MS.stocks,
      elapsed_ms: LATENCY_BUDGET_MS.stocks,
      cause: 'budget',
    });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.contributions).toEqual([]);
  });

  it('degrades to the fallback when the single round stalls before it closes', async () => {
    const { client, callCount } = stallingLlmClient({ stallAfterCalls: 2 });
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(client, store, unlimited(), UNCAPPED_SPEND);
    const views = [makeView()];

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    const result = await pending;

    expect(result.timed_out).toEqual({
      budget_ms: LATENCY_BUDGET_MS.stocks,
      elapsed_ms: LATENCY_BUDGET_MS.stocks,
      cause: 'budget',
    });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);

    expect(store.getByDebateId(result.debate_id)).toBeDefined();

    const atTimeout = callCount();
    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    expect(callCount()).toBe(atTimeout);
  });

  it('uses the crypto budget for a crypto instrument', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited(), UNCAPPED_SPEND);

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: 'crypto',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(result.timed_out).toEqual({ budget_ms: 30_000, elapsed_ms: 30_000, cause: 'budget' });
  });

  it('logs the timeout on the debate stage so an operator can see the budget fire', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      client,
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
      bar: NOW,
    });

    await vi.advanceTimersByTimeAsync(LATENCY_BUDGET_MS.stocks);
    await pending;

    const timeout = entries.find((entry) => entry.message === 'debate.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.stage).toBe('debate');
    expect(timeout?.trace_id).toBe('trace-1');
  });
});

describe('persistDebateLog with a partial/timed-out result (#1558 review)', () => {
  function makePartialResult(overrides: Partial<DebateResult> = {}): DebateResult {
    return {
      synthesis: 'Round 1 leaned bullish before the budget fired.',
      position: 'Hold — insufficient debate to act.',
      confidence: 0.4,
      contributions: [],
      disagreement_summary: 'Bear had not yet rebutted round 1 when the budget fired.',
      open_items: ['debate did not complete within latency budget'],
      converged: false,
      rounds_completed: 1,
      latency_ms: LATENCY_BUDGET_MS.stocks,
      direction: 'bullish',
      round_verdicts: [{ round: 1, direction: 'bullish', confidence: 0.4 }],
      debate_id: 'debate-partial-1',
      bar_timestamp: NOW,
      read: true,
      timed_out: {
        budget_ms: LATENCY_BUDGET_MS.stocks,
        elapsed_ms: LATENCY_BUDGET_MS.stocks,
        cause: 'budget',
      },
      ...overrides,
    };
  }

  it('writes the round 1 verdict alongside the degraded debate_log row', () => {
    const store = new SqliteDebateLogStore(openSharedStore(':memory:'));

    persistDebateLog({
      store,
      result: makePartialResult(),
      instrument: 'AAPL',
      clock: CLOCK,
      trace_id: 'trace-1',
      logger: undefined,
    });

    const log = store.getByDebateId('debate-partial-1');
    expect(log).toBeDefined();
    expect(log?.rounds).toBe(1);

    const rounds = store.listRoundVerdicts(
      new Date('2026-07-28T00:00:00Z'),
      new Date('2026-07-29T00:00:00Z'),
    );
    expect(rounds).toEqual([
      {
        debate_id: 'debate-partial-1',
        round: 1,
        direction: 'bullish',
        confidence: 0.4,
        created_at: NOW,
      },
    ]);
  });
});

describe('buildDebateStep LLM spend attribution (#326)', () => {
  interface SpendRow {
    trace_id: string;
    stage: string;
    debate_id: string | null;
    latency_ms: number | null;
    cost_usd: number | null;
  }

  function fakeWire(latencyMs: number): AnthropicMessagesClient {
    return {
      async createMessage(request: AnthropicMessageRequest) {
        const content = request.messages[0]?.content ?? '';
        let raw: string;
        if (content.includes('Bull persona')) {
          raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
        } else if (content.includes('Bear persona')) {
          raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
        } else if (content.includes('Mediator persona')) {
          raw = JSON.stringify({ stance: 'bullish', rationale: 'bull wins', converged: true });
        } else {
          raw = JSON.stringify({ summary: 'no material disagreement', conflicts: [] });
        }
        vi.advanceTimersByTime(latencyMs);
        return {
          content: [{ type: 'text', text: raw }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
  }

  function meteredStep(db: StoreHandle, latencyMs = 1_500) {
    const llm = new AnthropicLlmClient(
      fakeWire(latencyMs),
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      new SqliteLlmSpendStore(db),
    );
    return buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);
  }

  function spendRows(db: StoreHandle): SpendRow[] {
    return db
      .prepare('SELECT trace_id, stage, debate_id, latency_ms, cost_usd FROM llm_spend ORDER BY id')
      .all() as SpendRow[];
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bills every call a debate makes to that debate, including the disagreement call', async () => {
    const db = openSharedStore(':memory:');
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    const result = await meteredStep(db)({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const rows = spendRows(db);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.debate_id === result.debate_id)).toBe(true);
    expect(rows.every((row) => row.latency_ms === 1_500)).toBe(true);
    expect(rows.every((row) => row.trace_id === 'trace-1')).toBe(true);
  });

  it('stamps spend with the same debate_id the debate_log row is keyed on, so the join resolves', async () => {
    const db = openSharedStore(':memory:');
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    await meteredStep(db)({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const joined = db
      .prepare(
        `SELECT debate_log.instrument      AS instrument,
                COUNT(*)                   AS calls,
                SUM(llm_spend.latency_ms)  AS llm_latency_ms
           FROM debate_log
           JOIN llm_spend USING (debate_id)
          GROUP BY debate_log.debate_id`,
      )
      .all() as Array<{ instrument: string; calls: number; llm_latency_ms: number }>;

    expect(joined).toHaveLength(1);
    expect(joined[0]?.instrument).toBe('AAPL');
    expect(joined[0]?.calls).toBe(4);
    expect(joined[0]?.llm_latency_ms).toBe(6_000);
  });

  it('completes the debate and writes its log row even when EVERY metering write fails', async () => {
    const db = openSharedStore(':memory:');
    const step = meteredStep(db);
    db.prepare('DROP TABLE llm_spend').run();
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.direction).toBe('bullish');
    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('does not fail a debate when the sink itself throws, not just the SQL underneath it', async () => {
    const db = openSharedStore(':memory:');
    const llm = new AnthropicLlmClient(
      fakeWire(10),
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      {
        record: () => {
          throw new Error('metrics backend exploded');
        },
      },
    );
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('meters a debate that FAILS partway, attributed to the id its re-run will reuse', async () => {
    const db = openSharedStore(':memory:');
    const failing: AnthropicMessagesClient = {
      async createMessage(request: AnthropicMessageRequest) {
        const content = request.messages[0]?.content ?? '';
        if (content.includes('Mediator persona')) {
          throw new Error('llm transport blew up mid-debate');
        }
        const raw = content.includes('Bull persona')
          ? JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' })
          : JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
        return {
          content: [{ type: 'text', text: raw }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
    const llm = new AnthropicLlmClient(
      failing,
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      new SqliteLlmSpendStore(db),
    );
    const views = [makeView()];
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited(), UNCAPPED_SPEND);

    await expect(
      step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
        bar: NOW,
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    const rows = spendRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.debate_id === computeDebateId('AAPL', NOW, views))).toBe(true);
  });
});

describe('buildDebateStep spend-cap refusal wording (#1372)', () => {
  function refusingSpendCap(verdict: Extract<SpendCapVerdict, { admitted: false }>): SpendCap {
    return { check: () => verdict };
  }

  it('states the budget remedy on a budget refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: 50,
      budget_usd: 50,
      reason: 'LLM spend cap reached: $50.00 of $50.00 spent',
      kind: 'budget',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    expect(result.confidence).toBe(0);
    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
    expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'budget' });
  });

  it('states the read-fault remedy on a read-fault refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: Number.NaN,
      budget_usd: 50,
      reason: 'spend cap unreadable (fail-closed)',
      kind: 'read_fault',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(READ_FAULT_REMEDY);
    expect(refusal?.message).not.toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'read_fault' });
  });

  it('states the corrupt-ledger remedy on a corrupt-ledger refusal, and its kind in the payload', async () => {
    const { logger, entries } = recordingLogger();
    const spendCap = refusingSpendCap({
      admitted: false,
      spent_usd: Number.NaN,
      budget_usd: 50,
      reason: 'llm_spend total is not a finite number (fail-closed)',
      kind: 'corrupt_ledger',
    });
    const step = buildDebateStep(
      fakeLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      spendCap,
      logger,
    );

    await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
      bar: NOW,
    });

    const refusal = entries.find((entry) => entry.event === 'debate_refused_spend_cap');
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(CORRUPT_LEDGER_REMEDY);
    expect(refusal?.message).not.toContain(BUDGET_REMEDY);
    expect(refusal?.message).not.toContain(READ_FAULT_REMEDY);
    expect(refusal?.payload).toMatchObject({ kind: 'corrupt_ledger' });
  });
});

describe('buildDebateStep gate refusal feeds its OWN refusal-rate guard (#1533)', () => {
  function gateRefusingLlmClient(): LlmClient {
    return {
      async complete() {
        throw new LlmAdmissionRefusedError({
          message: 'admission refused: 1 in flight, budget 5000ms',
          reason: 'admission',
          queue_depth: 3,
          in_flight: 1,
          budget_ms: 5000,
          waited_ms: 0,
        });
      },
    };
  }

  function capturingRefusalChannel(): {
    channel: GateRefusalRateAlertChannel;
    posted: GateRefusalRateAlert[];
  } {
    const posted: GateRefusalRateAlert[] = [];
    return {
      channel: {
        postGateRefusalRateAlert: (alert) => {
          posted.push(alert);
        },
      },
      posted,
    };
  }

  function spySink(options: { throws?: boolean } = {}): {
    sink: LlmGateRefusalSink;
    recorded: Date[];
  } {
    const recorded: Date[] = [];
    return {
      sink: {
        recordGateRefusal: (occurred_at) => {
          if (options.throws === true) throw new Error('sink write failed');
          recorded.push(occurred_at);
        },
      },
      recorded,
    };
  }

  function refusalGuard(
    counts: GateRefusalWindowCounts,
    channel: GateRefusalRateAlertChannel | undefined,
    sink: LlmGateRefusalSink,
  ): GateRefusalRateGuardDeps {
    const windowSource: GateRefusalWindowSource = {
      getGateRefusalWindowCounts: () => counts,
    };
    return {
      windowSource,
      monitor: new GateRefusalRateMonitor(),
      alertChannel: channel,
      gateRefusalSink: sink,
    };
  }

  const REFUSED_STEP_INPUT = {
    trace_id: 'trace-1',
    instrument: 'AAPL',
    views: [makeView()],
    asset_class: ASSET_CLASS,
    clock: CLOCK,
    bar: NOW,
  };

  it('records the refusal on the sink and still returns a no-position, no-debate_log-row result', async () => {
    const { logger, entries } = recordingLogger();
    const store = new InMemoryDebateLogStore();
    const { sink, recorded } = spySink();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      store,
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 0, debates_logged: 0 }, undefined, sink),
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    expect(store.getByDebateId(result.debate_id)).toBeUndefined();
    expect(recorded).toEqual([NOW]);

    const refusal = entries.find((entry) => entry.event === 'debate_refused_gate');
    expect(refusal).toBeDefined();
    expect(refusal?.level).toBe('warn');
  });

  it('alerts on a window that is entirely gate refusals, where debate_log reports nothing at all', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const { channel, posted } = capturingRefusalChannel();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 40, debates_logged: 0 }, channel, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.rate).toBe(1);
    expect(posted[0]).toMatchObject({ gate_refused_count: 40, decision_count: 40 });
  });

  it('stays silent at the designed four-of-six refusal ratio, however large the volume', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const { channel, posted } = capturingRefusalChannel();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 384, debates_logged: 192 }, channel, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(posted).toHaveLength(0);
  });

  it('never touches the llm-failure-rate guard on the refusal path', async () => {
    const { logger } = recordingLogger();
    const { sink } = spySink();
    const truncationWindowReads: Array<{ from: Date; to: Date }> = [];
    const truncationSource: LlmFailureRateWindowSource = {
      getTerminationCauseWindowCounts: (from, to) => {
        truncationWindowReads.push({ from, to });
        return { llm_failure: 9, total: 10 };
      },
    };
    const truncationPosted: LlmFailureRateAlert[] = [];
    const truncationChannel: LlmFailureRateAlertChannel = {
      postLlmFailureRateAlert: (alert) => {
        truncationPosted.push(alert);
      },
    };
    const failureRateGuard: LlmFailureRateGuardDeps = {
      windowSource: truncationSource,
      monitor: new LlmFailureRateMonitor(),
      alertChannel: truncationChannel,
    };
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      failureRateGuard,
      refusalGuard({ gate_refused: 40, debates_logged: 0 }, undefined, sink),
    );

    await step(REFUSED_STEP_INPUT);

    expect(truncationWindowReads).toEqual([]);
    expect(truncationPosted).toEqual([]);
  });

  it('does not crash the tick when the sink itself throws, and logs llm_gate_refusal_record_failed instead', async () => {
    const { logger, entries } = recordingLogger();
    const { sink } = spySink({ throws: true });
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
      undefined,
      undefined,
      refusalGuard({ gate_refused: 0, debates_logged: 0 }, undefined, sink),
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    const failure = entries.find((entry) => entry.event === 'llm_gate_refusal_record_failed');
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('error');
  });

  it('degrades cleanly with no guard supplied at all, touching no sink', async () => {
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      gateRefusingLlmClient(),
      new InMemoryDebateLogStore(),
      unlimited(),
      UNCAPPED_SPEND,
      logger,
    );

    const result = await step(REFUSED_STEP_INPUT);

    expect(result.position).toContain('No position');
    expect(entries.some((entry) => entry.event === 'llm_gate_refusal_record_failed')).toBe(false);
  });
});
