import { openSharedStore, type StoreHandle } from './open-shared-store.js';
import { DEFAULT_MAX_LLM_CALL_ROWS, pruneLlmCallLog } from './prune-llm-call-log.js';
import { guardedStore } from './write-guard.js';

function insertCalls(db: StoreHandle, count: number): void {
  const insert = db.prepare(
    `INSERT INTO llm_call_log (spend_id, trace_id, stage, debate_id, model, prompt, response, timestamp)
     VALUES (?, ?, 'debate', ?, 'anthropic/claude-haiku-4.5', ?, 'answer', ?)`,
  );
  for (let i = 1; i <= count; i += 1) {
    insert.run(
      i,
      `trace-${i}`,
      `debate-${i}`,
      `prompt ${i}`,
      `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
    );
  }
}

function remainingTraceIds(db: StoreHandle): string[] {
  return (
    db.prepare('SELECT trace_id FROM llm_call_log ORDER BY id').all() as { trace_id: string }[]
  ).map((row) => row.trace_id);
}

describe('pruneLlmCallLog', () => {
  it('keeps the newest rows and drops the rest', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 10);

    expect(pruneLlmCallLog(db, 3)).toBe(7);
    expect(remainingTraceIds(db)).toEqual(['trace-8', 'trace-9', 'trace-10']);
  });

  it('leaves llm_spend completely alone', () => {
    const db = openSharedStore(':memory:');
    db.prepare(
      `INSERT INTO llm_spend (
         trace_id, stage, debate_id, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_read_input_tokens, cost_usd,
         server_tool_calls, latency_ms, ttfb_ms, timestamp
       ) VALUES ('trace-1', 'debate', 'debate-1', 'm', 10, 5, 0, 0, 0.004, 0, 100, NULL,
                 '2026-09-01T00:00:00.000Z')`,
    ).run();
    insertCalls(db, 10);

    pruneLlmCallLog(db, 1);

    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_spend').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_call_log').get()).toEqual({ n: 1 });
  });

  it('does nothing when the table is under the ceiling', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 4);

    expect(pruneLlmCallLog(db, 100)).toBe(0);
    expect(remainingTraceIds(db)).toHaveLength(4);
  });

  it('does nothing on an empty table', () => {
    const db = openSharedStore(':memory:');
    expect(pruneLlmCallLog(db, 10)).toBe(0);
  });

  it('keeps exactly the ceiling when the count sits on it', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(pruneLlmCallLog(db, 5)).toBe(0);
    expect(remainingTraceIds(db)).toHaveLength(5);
  });

  it('is idempotent across runs, despite the id gaps it leaves behind', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 10);

    expect(pruneLlmCallLog(db, 3)).toBe(7);
    expect(pruneLlmCallLog(db, 3)).toBe(0);
    expect(pruneLlmCallLog(db, 3)).toBe(0);
    expect(remainingTraceIds(db)).toEqual(['trace-8', 'trace-9', 'trace-10']);
  });

  it('prunes again correctly after new rows arrive post-prune', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 6);
    pruneLlmCallLog(db, 2);
    insertCalls(db, 3);

    expect(pruneLlmCallLog(db, 2)).toBe(3);
    expect(remainingTraceIds(db)).toEqual(['trace-2', 'trace-3']);
  });

  it('ships a default sized against the measured capture rate', () => {
    expect(DEFAULT_MAX_LLM_CALL_ROWS).toBe(5_000);
  });
});

describe('under the sole-writer guard (#1048)', () => {
  it('is allowed through a debate-engine handle', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(pruneLlmCallLog(guardedStore(db, 'debate-engine', { enabled: true }), 2)).toBe(3);
    expect(remainingTraceIds(db)).toEqual(['trace-4', 'trace-5']);
  });

  it('is refused through an orchestrator handle', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(() => pruneLlmCallLog(guardedStore(db, 'orchestrator', { enabled: true }), 2)).toThrow(
      /llm_call_log/,
    );
    expect(remainingTraceIds(db)).toHaveLength(5);
  });
});
