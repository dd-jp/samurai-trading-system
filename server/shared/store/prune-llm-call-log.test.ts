/**
 * `llm_call_log`'s row ceiling (#1045).
 *
 * Against a real (`:memory:`) SQLite instance rather than a fake, because
 * every property worth pinning here is a property of the STATEMENT — which
 * rows a `DELETE` with a correlated `OFFSET` subquery actually removes, and
 * what it does when there is nothing to remove. A double that answers
 * "delete(n)" would assume away exactly the thing under test.
 *
 * The load-bearing case is `leaves llm_spend completely alone`. Everything
 * else here costs diagnostics if it is wrong; that one costs the budget cap
 * its arithmetic, because `SqliteSpendCap` sums `llm_spend.cost_usd` all-time
 * on the trading path. A prune that reached across the join would let the
 * system trade past ADR-0008's cap while every dashboard looked normal.
 */
import { openSharedStore, type SharedStore } from './open-shared-store.js';
import { DEFAULT_MAX_LLM_CALL_ROWS, pruneLlmCallLog } from './prune-llm-call-log.js';
import { guardedStore } from './write-guard.js';

function insertCalls(db: SharedStore, count: number): void {
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

function remainingTraceIds(db: SharedStore): string[] {
  return (
    db.prepare('SELECT trace_id FROM llm_call_log ORDER BY id').all() as { trace_id: string }[]
  ).map((row) => row.trace_id);
}

describe('pruneLlmCallLog', () => {
  it('keeps the newest rows and drops the rest', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 10);

    expect(pruneLlmCallLog(db, 3)).toBe(7);
    // Newest by id, and the ORDER is asserted rather than just the count: a
    // statement that kept the OLDEST three would also delete seven rows.
    expect(remainingTraceIds(db)).toEqual(['trace-8', 'trace-9', 'trace-10']);
  });

  it('leaves llm_spend completely alone', () => {
    // The hazard the separate-table split in #1043 exists to make possible,
    // and the one that must never be traded away for tidiness. `llm_spend`
    // rows are the spend cap's arithmetic, not diagnostics.
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
    // The ordinary case — every sweep on every ordinary day — so it has to be
    // a genuine no-op rather than a delete that happens to match nothing
    // dangerous.
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
    // The off-by-one that an OFFSET subquery invites: with exactly `maxRows`
    // rows the subquery must find no (maxRows + 1)-th row and delete nothing.
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(pruneLlmCallLog(db, 5)).toBe(0);
    expect(remainingTraceIds(db)).toHaveLength(5);
  });

  it('is idempotent across runs, despite the id gaps it leaves behind', () => {
    // `id` is AUTOINCREMENT, so after the first prune the surviving ids are
    // non-contiguous and no longer count from 1. This is what rules out the
    // `id <= MAX(id) - maxRows` formulation, which would keep deleting live
    // rows on every subsequent sweep.
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
    // Survivors are the newest two overall, not the newest two of either batch.
    expect(remainingTraceIds(db)).toEqual(['trace-2', 'trace-3']);
  });

  it('ships a default sized against the measured capture rate', () => {
    // Pinned so a later edit to the constant is a deliberate act with a test
    // to update, not a silent change of retention. See the module doc for the
    // arithmetic (~78 days and ~39 MB at the measured rate, ~100 MB worst case).
    expect(DEFAULT_MAX_LLM_CALL_ROWS).toBe(5_000);
  });
});

describe('under the sole-writer guard (#1048)', () => {
  // The guard is default-permissive, so a prune on a RAW handle would pass
  // whether or not the stage attribution were right. These two cases pin the
  // attribution itself: `llm_call_log` belongs to the debate engine, and the
  // orchestrator — which is where both call sites live — is not entitled to
  // write records into it. Passing the owning stage is what makes the sweep
  // checkable rather than merely unchecked.
  it('is allowed through a debate-engine handle', () => {
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(pruneLlmCallLog(guardedStore(db, 'debate-engine', { enabled: true }), 2)).toBe(3);
    expect(remainingTraceIds(db)).toEqual(['trace-4', 'trace-5']);
  });

  it('is refused through an orchestrator handle', () => {
    // Not a limitation being worked around: an orchestrator-attributed write to
    // the debate engine's table is exactly the cross-stage write #1048 exists
    // to catch, and the production call sites therefore declare 'debate-engine'.
    const db = openSharedStore(':memory:');
    insertCalls(db, 5);

    expect(() => pruneLlmCallLog(guardedStore(db, 'orchestrator', { enabled: true }), 2)).toThrow(
      /llm_call_log/,
    );
    expect(remainingTraceIds(db)).toHaveLength(5);
  });
});
