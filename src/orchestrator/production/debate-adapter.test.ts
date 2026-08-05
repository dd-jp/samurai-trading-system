import type {
  AnalystView,
  AnthropicMessageRequest,
  AnthropicMessagesClient,
  LlmClient,
  LlmRequest,
} from '../../debate-engine/index.js';
import {
  AnthropicLlmClient,
  computeDebateId,
  InMemoryDebateLogStore,
  RateLimiter,
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
} from '../../debate-engine/index.js';
import { accumulateCredit } from '../../feedback-loop/index.js';
import type { AssetClass, Clock, ClosedTrade, LogEntry, Logger } from '../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { buildDebateStep } from './debate-adapter.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

/**
 * A budget large enough never to bite, for the tests in this file that are
 * about the debate itself rather than about admission. The refusal path has
 * its own tests in `rate-limit-wiring.test.ts`.
 */
function unlimited(): RateLimiter {
  return new RateLimiter(CLOCK, {
    default: { windowMs: 60_000, maxLlmCalls: 10_000, maxDebates: 10_000 },
  });
}

/** The asset class every fixture instrument in this file is treated as. */
const ASSET_CLASS: AssetClass = 'stocks';

/** Retries are orthogonal to attribution; one attempt keeps the spend row count exact. */
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
  /** false → the mediator never converges, so the debate runs to the 3-round hard cap. */
  converged?: boolean;
  /** Throws from the mediator call, standing in for a debate that fails partway. */
  failOnMediator?: boolean;
}

/** Routes by prompt content — mirrors what personas.ts's four prompt shapes actually say. */
function fakeLlmClient(options: FakeLlmOptions = {}): LlmClient {
  const { converged = true, failOnMediator = false } = options;
  return {
    async complete<T>(request: LlmRequest<T>) {
      let raw: string;
      if (request.prompt.includes('Bull persona')) {
        raw = JSON.stringify({ stance: 'bullish', rationale: 'strong momentum' });
      } else if (request.prompt.includes('Bear persona')) {
        raw = JSON.stringify({ stance: 'bearish', rationale: 'overbought risk' });
      } else if (request.prompt.includes('Mediator persona')) {
        if (failOnMediator) {
          throw new Error('llm transport blew up mid-debate');
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
    const step = buildDebateStep(fakeLlmClient(), new InMemoryDebateLogStore(), unlimited());
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    });

    expect(result.converged).toBe(true);
    expect(result.direction).toBe('bullish');
    expect(result.rounds_completed).toBe(1);
    expect(result.contributions).toHaveLength(1);
    // position is the one field this adapter derives rather than sources
    // from an existing computation (see debate-adapter.ts doc comment) —
    // assert it's populated, not a specific fabricated value.
    expect(result.position.length).toBeGreaterThan(0);
  });

  it('writes exactly one debate_log row for a completed debate (#364)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM debate_log WHERE debate_id = ?')
      .get(result.debate_id) as { n: number };
    expect(count.n).toBe(1);

    const row = store.getByDebateId(result.debate_id);
    expect(row).toBeDefined();
    expect(row?.instrument).toBe('AAPL');
    // The row's bar_timestamp must be the SAME bar that went into
    // debate_id's hash — otherwise the row claims a coordinate the id
    // does not encode.
    expect(row?.bar_timestamp.toISOString()).toBe(NOW.toISOString());
    expect(row?.direction).toBe('bullish');
    expect(row?.rounds).toBe(result.rounds_completed);
    expect(row?.contributions).toEqual(result.contributions);
  });

  it('writes a row for a debate that resolves WITHOUT converging (hard-cap termination)', async () => {
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(fakeLlmClient({ converged: false }), store, unlimited());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    });

    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(3);
    // A halted debate is at least as interesting as a converged one: the row
    // is written on the same path, no convergence branch.
    expect(store.getByDebateId(result.debate_id)?.rounds).toBe(3);
  });

  it('writes NO row when the debate throws partway, and logs the miss', async () => {
    const store = new InMemoryDebateLogStore();
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(
      fakeLlmClient({ failOnMediator: true }),
      store,
      unlimited(),
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
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    // debate_id is recomputable from (instrument, bar, views) even though the
    // debate produced no result — assert nothing was written under it, so the
    // eventual successful re-run can still claim the write-once key.
    expect(store.getByDebateId(computeDebateId('AAPL', NOW, views))).toBeUndefined();

    const missed = entries.find((entry) => entry.stage === 'debate' && entry.level === 'error');
    expect(missed).toBeDefined();
    expect(missed?.message).toContain('no debate_log row');
  });

  it('does not double-write when the same tick re-runs (same instrument, bar and views)', async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(fakeLlmClient(), store, unlimited(), logger);
    const input = {
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    };

    const first = await step(input);
    // Same clock, same views, same instrument → the same content-hash
    // debate_id, which is exactly what a retried tick produces.
    const second = await step({ ...input, trace_id: 'trace-1-retry' });
    expect(second.debate_id).toBe(first.debate_id);

    const count = db.prepare('SELECT COUNT(*) AS n FROM debate_log').get() as { n: number };
    expect(count.n).toBe(1);

    const duplicate = entries.find((entry) => entry.message.includes('already has a debate_log'));
    expect(duplicate).toBeDefined();
    expect(duplicate?.level).toBe('warn');
  });

  it("produces rows the Feedback Loop's attribution reader can consume end to end", async () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteDebateLogStore(db);
    const step = buildDebateStep(fakeLlmClient(), store, unlimited());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
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
    };

    const credits = accumulateCredit([trade], store, {
      shadow_credit: 0.1,
      shadow_influence_ceiling: 0.2,
    });

    // Before #364 this map was empty for every trade in the soak: no row, so
    // `getContributionsForAttribution` returned undefined and the trade was
    // skipped outright.
    const credit = credits.get('technical-1');
    expect(credit).toBeDefined();
    expect(credit?.trade_count).toBe(1);
    expect(credit?.total_credit).toBeGreaterThan(0);
  });
});

/**
 * The latency budget at the composition point (#374). `enforceLatencyBudget`
 * had no production caller, so a debate that never came back held the tick for
 * as long as the provider took — unbounded, on a 14-day unattended soak.
 *
 * These tests drive the STEP, not the budget module (which has its own unit
 * tests): the thing #374 was about is that the two were never connected, and
 * only a test through `buildDebateStep` can fail if they come apart again.
 */
describe('buildDebateStep latency budget (#374)', () => {
  /**
   * Answers normally for the first `stallAfterCalls` calls, then hangs until
   * the debate's `AbortSignal` fires — a provider that accepted the request
   * and stopped answering, which is the shape the budget exists for.
   */
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
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited());

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
    });

    // Nothing completed a round, so this is the low-confidence fallback —
    // deliberately unactionable: confidence 0 is under any conviction floor,
    // so the tick short-circuits at Trader with no_trade.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.timed_out).toEqual({ budget_ms: 60_000, elapsed_ms: 60_000 });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.contributions).toEqual([]);
  });

  it('returns the partial synthesis, not the bare fallback, when a round completed', async () => {
    // Round 1 completes without converging (3 calls: bull, bear, mediator);
    // round 2's bull then stalls. Without `getCurrentState` exposed through
    // the persona closure, that round-1 synthesis would be thrown away and
    // this would come back as the empty fallback above.
    const { client, callCount } = stallingLlmClient({ stallAfterCalls: 3 });
    const store = new InMemoryDebateLogStore();
    const step = buildDebateStep(client, store, unlimited());
    const views = [makeView()];

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: 'stocks',
      clock: CLOCK,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(result.timed_out).toEqual({ budget_ms: 60_000, elapsed_ms: 60_000 });
    expect(result.converged).toBe(false);
    expect(result.rounds_completed).toBe(1);
    expect(result.synthesis).toBe('bull case wins');
    expect(result.direction).toBe('bullish');
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]?.analyst_id).toBe('technical-1');
    // Non-converged results must carry a reason downstream can act on; the
    // once-per-debate disagreement call never ran, so the summary is empty
    // and the adapter names the actual cause instead.
    expect(result.open_items).toEqual(['debate did not converge before the latency budget fired']);

    // The timed-out debate is still a resolved debate, so it gets its row.
    expect(store.getByDebateId(result.debate_id)).toBeDefined();

    // Cancellation, not just abandonment (#347): no further persona call is
    // issued after the budget fires.
    const atTimeout = callCount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callCount()).toBe(atTimeout);
  });

  it('uses the crypto budget for a crypto instrument', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited());

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
      asset_class: 'crypto',
      clock: CLOCK,
    });

    // 15s, not 60s — the per-asset-class lookup #374 called out as the
    // reason this could not be a one-line wire.
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;

    expect(result.timed_out).toEqual({ budget_ms: 15_000, elapsed_ms: 15_000 });
  });

  it('logs the timeout on the debate stage so an operator can see the budget fire', async () => {
    const { client } = stallingLlmClient({ stallAfterCalls: 0 });
    const { logger, entries } = recordingLogger();
    const step = buildDebateStep(client, new InMemoryDebateLogStore(), unlimited(), logger);

    const pending = step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
      asset_class: 'stocks',
      clock: CLOCK,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    const timeout = entries.find((entry) => entry.message === 'debate.timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.stage).toBe('debate');
    expect(timeout?.trace_id).toBe('trace-1');
  });
});

/**
 * The instrumentation half of #326, exercised end to end rather than at the
 * seam: a REAL `AnthropicLlmClient` over a fake wire client, writing through a
 * REAL `SqliteLlmSpendStore` into a real (`:memory:`) database, driven by
 * `buildDebateStep`.
 *
 * Testing this at the adapter is the point. Every unit below it passes with
 * attribution threaded through only SOME of the four calls a debate makes —
 * three personas plus the once-per-debate disagreement call — and the failure
 * that produces (a per-decision cost quietly missing a fixed slice) looks
 * exactly like a cheap debate. Only a whole debate can show that all of its
 * spend lands on one `debate_id`.
 */
describe('buildDebateStep LLM spend attribution (#326)', () => {
  interface SpendRow {
    trace_id: string;
    stage: string;
    debate_id: string | null;
    latency_ms: number | null;
    cost_usd: number | null;
  }

  /** Wire-level double: same prompt routing as `fakeLlmClient`, plus a usage block. */
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
        // Fake timers make the measured latency exact instead of flaky.
        vi.advanceTimersByTime(latencyMs);
        return {
          content: [{ type: 'text', text: raw }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    };
  }

  function meteredStep(db: SharedStore, latencyMs = 1_500) {
    const llm = new AnthropicLlmClient(
      fakeWire(latencyMs),
      { model: 'claude-haiku-4-5', max_tokens: 100, timeoutMs: 60_000, retry: NO_RETRY },
      new SqliteLlmSpendStore(db),
    );
    return buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited());
  }

  function spendRows(db: SharedStore): SpendRow[] {
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
    // Two views, so `detectDisagreements` actually issues its LLM call — below
    // two it short-circuits to the directional fallback and this test would
    // silently stop covering the call most likely to be left unattributed.
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })];

    const result = await meteredStep(db)({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    });

    const rows = spendRows(db);
    // bull + bear + mediator + disagreement.
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
    });

    // The acceptance criterion, expressed as the SQL an operator would write:
    // per-decision cost and LLM time, joined to the decision itself.
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
    // The ticket's hard constraint: instrumentation must never fail a debate.
    // Dropping the table stands in for a locked database or schema drift — the
    // sink's own catch is what has to hold, and this proves the debate that
    // resolved correctly is still recorded and still returned.
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
    });

    expect(result.direction).toBe('bullish');
    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('does not fail a debate when the sink itself throws, not just the SQL underneath it', async () => {
    // `LlmSpendSink` is a public interface; a caller's own implementation may
    // throw where `SqliteLlmSpendStore` would not. The guarantee has to hold at
    // the client boundary, not rest on one implementation's good manners.
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
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited());

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
      asset_class: ASSET_CLASS,
      clock: CLOCK,
    });

    expect(result.converged).toBe(true);
    expect(new SqliteDebateLogStore(db).getByDebateId(result.debate_id)).toBeDefined();
  });

  it('meters a debate that FAILS partway, attributed to the id its re-run will reuse', async () => {
    // No `debate_log` row is written for a failed debate (see
    // `persistDebateLog`) — but the calls it made were still billed. Keyed on
    // the deterministic `debate_id`, that spend stays attributable, and the
    // eventual successful re-run's spend lands on the same key rather than
    // looking like a second, cheaper debate.
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
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db), unlimited());

    await expect(
      step({
        trace_id: 'trace-1',
        instrument: 'AAPL',
        views,
        asset_class: ASSET_CLASS,
        clock: CLOCK,
      }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    const rows = spendRows(db);
    expect(rows).toHaveLength(2); // bull + bear; the mediator call threw
    expect(rows.every((row) => row.debate_id === computeDebateId('AAPL', NOW, views))).toBe(true);
  });
});
