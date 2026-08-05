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
  SqliteDebateLogStore,
  SqliteLlmSpendStore,
} from '../../debate-engine/index.js';
import { accumulateCredit } from '../../feedback-loop/index.js';
import type { Clock, ClosedTrade, LogEntry, Logger } from '../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import { buildDebateStep } from './debate-adapter.js';

const NOW = new Date('2026-07-28T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };

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
    const step = buildDebateStep(fakeLlmClient(), new InMemoryDebateLogStore());
    const views = [makeView()];

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views,
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
    const step = buildDebateStep(fakeLlmClient(), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
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
    const step = buildDebateStep(fakeLlmClient({ converged: false }), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'BTC-USD',
      views: [makeView()],
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
    const step = buildDebateStep(fakeLlmClient({ failOnMediator: true }), store, logger);
    const views = [makeView()];

    await expect(
      step({ trace_id: 'trace-1', instrument: 'AAPL', views, clock: CLOCK }),
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
    const step = buildDebateStep(fakeLlmClient(), store, logger);
    const input = { trace_id: 'trace-1', instrument: 'AAPL', views: [makeView()], clock: CLOCK };

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
    const step = buildDebateStep(fakeLlmClient(), store);

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView()],
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
    return buildDebateStep(llm, new SqliteDebateLogStore(db));
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

    await meteredStep(db)({ trace_id: 'trace-1', instrument: 'AAPL', views, clock: CLOCK });

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

    const result = await step({ trace_id: 'trace-1', instrument: 'AAPL', views, clock: CLOCK });

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
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db));

    const result = await step({
      trace_id: 'trace-1',
      instrument: 'AAPL',
      views: [makeView(), makeView({ analyst_id: 'sentiment-1', direction: 'bearish' })],
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
    const step = buildDebateStep(llm, new SqliteDebateLogStore(db));

    await expect(
      step({ trace_id: 'trace-1', instrument: 'AAPL', views, clock: CLOCK }),
    ).rejects.toThrow('llm transport blew up mid-debate');

    const rows = spendRows(db);
    expect(rows).toHaveLength(2); // bull + bear; the mediator call threw
    expect(rows.every((row) => row.debate_id === computeDebateId('AAPL', NOW, views))).toBe(true);
  });
});
