/**
 * `SqliteLlmSpendStore` against a real (`:memory:`) SQLite instance.
 *
 * The load-bearing case is the last one: a metering failure must never
 * propagate into the trading loop. The write is bookkeeping attached to a
 * call whose result the pipeline is waiting on, and turning a completed,
 * already-billed LLM response into a thrown error would trade a real answer
 * for an accounting detail.
 */

import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import type { LogEntry } from '../../shared/types.js';
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
  latency_ms: number | null;
  timestamp: string;
}

function rows(db: SharedStore): SpendRow[] {
  return db.prepare('SELECT * FROM llm_spend ORDER BY id').all() as SpendRow[];
}

describe('SqliteLlmSpendStore', () => {
  it('records tokens and a priced cost for a known model', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      latency_ms: 1_234,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.trace_id).toBe('trace-1');
    expect(row?.input_tokens).toBe(1_000_000);
    expect(row?.output_tokens).toBe(1_000_000);
    expect(row?.cost_usd).toBeCloseTo(6, 10);
    expect(row?.timestamp).toBe(NOW.toISOString());
  });

  it('defaults absent cache counts to 0 rather than leaving them null', () => {
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'claude-haiku-4-5',
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
      model: 'claude-unreleased-9',
      usage: { input_tokens: 4_242, output_tokens: 99 },
      latency_ms: 99,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.cost_usd).toBeNull();
    // Tokens are always exact — they come straight off the wire — so an
    // unpriceable model must not cost us the usage data too.
    expect(row?.input_tokens).toBe(4_242);
    expect(row?.output_tokens).toBe(99);
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
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
        timestamp: NOW,
      }),
    ).not.toThrow();

    // Logged rather than silent — a persistently broken meter should be
    // visible, not just render as a flat spend line.
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
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 10, output_tokens: 10 },
      latency_ms: 4_321,
      timestamp: NOW,
    });

    const [row] = rows(db);
    // The whole point of the ticket: latency reaches a column, not stdout.
    expect(row?.latency_ms).toBe(4_321);
    expect(row?.debate_id).toBe('debate-abc');
  });

  it('stores a 0ms call as 0, not NULL — a fast call is a measurement', () => {
    // `MockLlmClient` returns `latency_ms: 0` by design, and a local double can
    // genuinely round to 0. NULL is reserved for "never measured" (rows
    // predating migration 0012); conflating the two would let real
    // sub-millisecond calls vanish from the percentile sample.
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      debate_id: 'debate-abc',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 1, output_tokens: 1 },
      latency_ms: 0,
      timestamp: NOW,
    });

    const [row] = rows(db);
    expect(row?.latency_ms).toBe(0);
    expect(row?.latency_ms).not.toBeNull();
  });

  it('writes an unattributed call as NULL debate_id rather than losing the row', () => {
    // Regression guard with teeth: better-sqlite3 REFUSES to bind `undefined`,
    // so passing `entry.debate_id` straight through would throw into `record`'s
    // own swallowing catch — the row would silently never exist, and the meter
    // would under-report every call made outside a debate.
    const db = openSharedStore(':memory:');
    new SqliteLlmSpendStore(db).record({
      trace_id: 'trace-1',
      stage: 'debate',
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 7, output_tokens: 3 },
      latency_ms: 55,
      timestamp: NOW,
    });

    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.debate_id).toBeNull();
    expect(all[0]?.input_tokens).toBe(7);
  });

  it('does not require a logger to stay non-throwing', () => {
    const db = openSharedStore(':memory:');
    db.prepare('DROP TABLE llm_spend').run();
    const store = new SqliteLlmSpendStore(db);
    expect(() =>
      store.record({
        trace_id: 'trace-1',
        stage: 'debate',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 1, output_tokens: 1 },
        latency_ms: 1,
        timestamp: NOW,
      }),
    ).not.toThrow();
  });
});
