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
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number | null;
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
        timestamp: NOW,
      }),
    ).not.toThrow();

    // Logged rather than silent — a persistently broken meter should be
    // visible, not just render as a flat spend line.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('warn');
    expect(logged[0]?.trace_id).toBe('trace-1');
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
        timestamp: NOW,
      }),
    ).not.toThrow();
  });
});
