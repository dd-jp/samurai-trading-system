/**
 * `SqliteLlmSpendStore` against a real (`:memory:`) SQLite instance.
 *
 * The load-bearing case is the last one: a metering failure must never
 * propagate into the trading loop. The write is bookkeeping attached to a
 * call whose result the pipeline is waiting on, and turning a completed,
 * already-billed LLM response into a thrown error would trade a real answer
 * for an accounting detail.
 */

import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { LogEntry } from '../../../shared/types.js';
import type { PromptTierAlert, PromptTierAlertChannel } from './prompt-tier-alert.js';
import { PromptTierCrossingThrottle } from './prompt-tier-alert.js';
import { SqliteLlmSpendStore } from './spend-sink.js';

const NOW = new Date('2026-08-05T12:00:00Z');

interface SpendRow {
  trace_id: string;
  stage: string;
  debate_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number | null;
  server_tool_calls: number;
  latency_ms: number | null;
  ttfb_ms: number | null;
  timestamp: string;
  prompt_template_hash: string | null;
}

function rows(db: StoreHandle): SpendRow[] {
  return db.prepare('SELECT * FROM llm_spend ORDER BY id').all() as SpendRow[];
}

describe('SqliteLlmSpendStore', () => {
  it('records tokens and a priced cost for a known model', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      latency_ms: 1_234,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.trace_id).toBe('trace-1');
    expect(row?.input_tokens).toBe(1_000_000);
    expect(row?.output_tokens).toBe(1_000_000);
    expect(row?.cost_usd).toBeCloseTo(0.7, 10);
    expect(row?.timestamp).toBe(NOW.toISOString());
  });

  it('defaults absent cache counts to 0 rather than leaving them null', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.cache_creation_input_tokens).toBe(0);
    expect(row?.cache_read_input_tokens).toBe(0);
  });

  it('stores NULL cost — not 0 — for a model missing from the rate table, keeping the token counts', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'vendor/unreleased-9',
      usage: { input_tokens: 4_242, output_tokens: 99 },
      latency_ms: 99,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.cost_usd).toBeNull();
    // Tokens are always exact — they come straight off the wire — so an
    // unpriceable model must not cost us the usage data too
    expect(row?.input_tokens).toBe(4_242);
    expect(row?.output_tokens).toBe(99);
  });

  it('persists the prompt template hash (#1514) when the record carries one', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 10,
      timestamp: NOW,
      prompt_template_hash: 'abc123',
    });

    const [row] = rows(db);
    expect(row?.prompt_template_hash).toBe('abc123');
  });

  it('leaves the prompt template hash NULL when the record carries none', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.prompt_template_hash).toBeNull();
  });

  it('swallows a write failure to a warn instead of throwing into the caller', () => {
    // A store whose table does not exist stands in for a locked DB or schema
    // drift. The contract under test is that `record` returns normally.
    const db = openSharedStore(':memory:');
    db.prepare('DROP TABLE llm_spend').run();
    const logged: LogEntry[] = [];

    const store = new SqliteLlmSpendStore(db, { log: (entry) => logged.push(entry) });

    expect(() =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'openai/gpt-5.6-luna',
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
        timestamp: NOW,
      }),
    ).not.toThrow();

    // Logged rather than silent — a persistently broken meter should be
    // visible, not just render as a flat spend line
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('warn');
    expect(logged[0]?.trace_id).toBe('trace-1');
  });

  it('persists per-call latency and the debate it belongs to (#326)', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 4_321,
      timestamp: NOW,
    });

    const [row] = rows(db);
    // The whole point of the ticket: latency reaches a column, not stdout
    expect(row?.latency_ms).toBe(4_321);
    expect(row?.debate_id).toBe('debate-abc');
  });

  it('stores a 0ms call as 0, not NULL — a fast call is a measurement', () => {
    // `MockLlmClient` returns `latency_ms: 0` by design, and a local double can
    // genuinely round to 0. NULL is reserved for "never measured" (rows
    // predating migration 0012); conflating the two would let real
    // sub-millisecond calls vanish from the percentile sample
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 1, output_tokens: 1 },
      latency_ms: 0,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.latency_ms).toBe(0);
    expect(row?.latency_ms).not.toBeNull();
  });

  it('persists ttfb_ms alongside latency_ms (#1012)', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 6_441,
      ttfb_ms: 6_200,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.latency_ms).toBe(6_441);
    expect(row?.ttfb_ms).toBe(6_200);
  });

  it('stores NULL ttfb_ms — not 0 — for a wire client that does not report it', () => {
    // `AnthropicMessageResponse.ttfb_ms` is optional (any structural
    // `AnthropicMessagesClient` may omit it) — an absent measurement must
    // read as "never measured", not as an impossibly fast zero
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.ttfb_ms).toBeNull();
  });

  it('writes an unattributed call as NULL debate_id rather than losing the row', () => {
    // Regression guard with teeth: better-sqlite3 REFUSES to bind `undefined`,
    // so passing `entry.debate_id` straight through would throw into `record`'s
    // own swallowing catch — the row would silently never exist, and the meter
    // would under-report every call made outside a debate
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'openai/gpt-5.6-luna',
      usage: { input_tokens: 7, output_tokens: 3 },
      latency_ms: 55,
      timestamp: NOW,
    });

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.debate_id).toBeNull();
    expect(all[0]?.input_tokens).toBe(7);
  });

  it('adds the server-side tool charge on top of tokens (#476)', () => {
    // "Tool requests are priced based on two components: token usage and tool
    // invocations." This stopped being a hand-exercised hypothetical in #969:
    // `nous-responses.ts` reports a real count from the `x_search` path, and
    // the rate is now Nous's published $4.00/1,000 rather than the
    // unconfirmable third-party $5.00 figure it read against before
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'market_intelligence',
      model: 'x-ai/grok-4.5',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      server_tool_calls: 4,
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    // 1M input tokens is PAST the 200k large-prompt threshold, so the whole
    // request prices at the tier's $4.00/M, not the base $1.60/M: $4.00 plus
    // 4 invocations at $0.004 = $0.016
    //
    // This assertion read $1.62 before #969, and the difference is the point
    // A retrieval call's prompt carries its search results, so crossing that
    // threshold is a routine event on this path rather than an exotic one —
    // and pricing a crossed request at the base rate under-counts it by 2.5x
    // against a cap whose whole job is to stop an unattended run
    expect(row?.cost_usd).toBeCloseTo(4.016, 10);
    expect(row?.server_tool_calls).toBe(4);
  });

  it('prices below the tier at the base rate', () => {
    // The other side of the same threshold, so the tier cannot silently
    // become unconditional: 100k input at $1.60/M = $0.16, plus 4 invocations
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'market_intelligence',
      model: 'x-ai/grok-4.5',
      usage: { input_tokens: 100_000, output_tokens: 0 },
      server_tool_calls: 4,
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(rows(db)[0]?.cost_usd).toBeCloseTo(0.176, 10);
  });

  it('records the tool cost even when the model is unpriced, and warns', () => {
    // THE case #476 was filed for. Discarding a charge we know exactly, because
    // a different charge is missing from the rate table, would under-count the
    // cap — and a NULL is not diagnosable, whereas a small cost beside a
    // non-zero invocation count is
    const db = openSharedStore(':memory:');
    const entries: LogEntry[] = [];
    new SqliteLlmSpendStore(db, { log: (entry) => void entries.push(entry) }).record({
      trace_id: 'trace-1',
      stage: 'market_intelligence',
      model: 'x-ai/grok-from-the-future',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      server_tool_calls: 2,
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    // 2 invocations at the published $4.00/1,000. The token half is unknown
    // and stays unknown; the tool half is knowable and is recorded
    expect(row?.cost_usd).toBeCloseTo(0.008, 10);
    expect(row?.server_tool_calls).toBe(2);

    const warn = entries.find((entry) => entry.level === 'warn');
    expect(warn?.message).toContain('not in MODEL_RATES');
    expect(warn?.message).toContain('understates the true cost');
  });

  it('leaves cost null for an unpriced model that used no tool', () => {
    // The pre-existing semantic is preserved: unpriced stays NULL rather than
    // becoming a 0 indistinguishable from a genuinely free call
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'anthropic/claude-unreleased-9',
      usage: { input_tokens: 500, output_tokens: 500 },
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(rows(db)[0]?.cost_usd).toBeNull();
  });

  it('defaults a plain completion to zero tool invocations', () => {
    // A completion invokes no server-side tool, so it incurs no such charge
    // Zero is the honest value, not a placeholder
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'anthropic/claude-haiku-4.5',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
      latency_ms: 10,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.server_tool_calls).toBe(0);
    expect(row?.cost_usd).toBeCloseTo(0.8, 10);
  });

  it('does not require a logger to stay non-throwing', () => {
    const db = openSharedStore(':memory:');
    db.prepare('DROP TABLE llm_spend').run();
    const store = new SqliteLlmSpendStore(db);
    expect(() =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'openai/gpt-5.6-luna',
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
        timestamp: NOW,
      }),
    ).not.toThrow();
  });
});

describe('SqliteLlmSpendStore — prompt-tier crossing warning (#1155)', () => {
  function recordingChannel(): PromptTierAlertChannel & { alerts: PromptTierAlert[] } {
    const alerts: PromptTierAlert[] = [];
    return {
      alerts,
      postPromptTierAlert: (alert) => {
        alerts.push(alert);
      },
    };
  }

  // Crosses x-ai/grok-4.5's published 200,000-token large-prompt tier
  // (pricing.ts) by one token — the same fixture pricing.test.ts uses to pin
  // `crossesPromptTier`'s own answer
  const CROSSING_USAGE = { input_tokens: 200_001, output_tokens: 1_000 };
  const UNDER_TIER_USAGE = { input_tokens: 200_000, output_tokens: 1_000 };

  it('warns on the FIRST call that crosses a model tier', () => {
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    new SqliteLlmSpendStore(db, undefined, false, channel).record({
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      model: 'x-ai/grok-4.5',
      usage: CROSSING_USAGE,
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(channel.alerts).toHaveLength(1);
    expect(channel.alerts[0]).toMatchObject({
      model: 'x-ai/grok-4.5',
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      prompt_tokens: 200_001,
      above_prompt_tokens: 200_000,
      consecutive_crossings: 1,
    });
  });

  it('does not warn for a call that stays at or under the tier', () => {
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    new SqliteLlmSpendStore(db, undefined, false, channel).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'x-ai/grok-4.5',
      usage: UNDER_TIER_USAGE,
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(channel.alerts).toHaveLength(0);
  });

  it('does not warn for a model with no published tier, however large the prompt', () => {
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    new SqliteLlmSpendStore(db, undefined, false, channel).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'anthropic/claude-haiku-4.5',
      usage: { input_tokens: 5_000_000, output_tokens: 1 },
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(channel.alerts).toHaveLength(0);
  });

  it('suppresses a repeat crossing on the very next call for the same model', () => {
    // Otherwise a run of retrieval-heavy calls on the same model — the
    // realistic case a tiered call recurs — pages on every single one
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    const store = new SqliteLlmSpendStore(db, undefined, false, channel);
    const call = () =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage: CROSSING_USAGE,
        latency_ms: 10,
        timestamp: NOW,
      });

    call();
    call();

    expect(channel.alerts).toHaveLength(1);
  });

  it('fires again once the model drops back under the tier and crosses it a second time', () => {
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    const store = new SqliteLlmSpendStore(db, undefined, false, channel);
    const record = (usage: { input_tokens: number; output_tokens: number }) =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage,
        latency_ms: 10,
        timestamp: NOW,
      });

    record(CROSSING_USAGE);
    record(UNDER_TIER_USAGE);
    record(CROSSING_USAGE);

    expect(channel.alerts).toHaveLength(2);
    expect(channel.alerts.map((alert) => alert.consecutive_crossings)).toEqual([1, 1]);
  });

  it('tracks crossings per model independently', () => {
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    const store = new SqliteLlmSpendStore(db, undefined, false, channel);
    const record = (model: string) =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model,
        usage: CROSSING_USAGE,
        latency_ms: 10,
        timestamp: NOW,
      });

    record('x-ai/grok-4.5');
    record('~x-ai/grok-latest');

    expect(channel.alerts).toHaveLength(2);
  });

  it('still writes the spend row and never throws when the alert channel itself throws', () => {
    const db = openSharedStore(':memory:');
    const logged: LogEntry[] = [];
    const throwingChannel: PromptTierAlertChannel = {
      postPromptTierAlert: () => {
        throw new Error('telegram unreachable');
      },
    };
    const store = new SqliteLlmSpendStore(
      db,
      { log: (entry) => logged.push(entry) },
      false,
      throwingChannel,
    );

    expect(() =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage: CROSSING_USAGE,
        latency_ms: 10,
        timestamp: NOW,
      }),
    ).not.toThrow();

    const [row] = rows(db);
    expect(row?.cost_usd).toBeCloseTo(0.812_004, 6);
    expect(logged.some((entry) => entry.level === 'error' || entry.level === 'warn')).toBe(true);
  });

  it('does not require a promptTierAlerts channel to stay non-throwing', () => {
    const db = openSharedStore(':memory:');
    const store = new SqliteLlmSpendStore(db);
    expect(() =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'x-ai/grok-4.5',
        usage: CROSSING_USAGE,
        latency_ms: 10,
        timestamp: NOW,
      }),
    ).not.toThrow();
  });

  it('shares one throttle across two stores the way production.ts wires the debate and sentiment sinks', () => {
    // production.ts constructs SqliteLlmSpendStore twice against the same
    // db (the debate stage's default llmClient, and the sentiment
    // GrokAgent's spendSink) and hoists ONE PromptTierCrossingThrottle,
    // passed to both — because NOUS_MODEL alone can route both roles
    // through the same tiered model (nous-config.ts), with no code change
    // Two independent throttles would then count that model's consecutive
    // crossings twice: up to two "first crossing" alerts and roughly double
    // the repeat cadence against the one-then-every-8 contract
    const db = openSharedStore(':memory:');
    const channel = recordingChannel();
    const sharedThrottle = new PromptTierCrossingThrottle();
    const debateStore = new SqliteLlmSpendStore(db, undefined, false, channel, sharedThrottle);
    const sentimentStore = new SqliteLlmSpendStore(db, undefined, false, channel, sharedThrottle);

    debateStore.record({
      trace_id: 'trace-debate',
      stage: 'debate',
      model: 'x-ai/grok-4.5',
      usage: CROSSING_USAGE,
      latency_ms: 10,
      timestamp: NOW,
    });
    sentimentStore.record({
      trace_id: 'trace-sentiment',
      stage: 'sentiment',
      model: 'x-ai/grok-4.5',
      usage: CROSSING_USAGE,
      latency_ms: 10,
      timestamp: NOW,
    });

    expect(channel.alerts).toHaveLength(1);
    expect(channel.alerts[0]?.consecutive_crossings).toBe(1);
  });
});
