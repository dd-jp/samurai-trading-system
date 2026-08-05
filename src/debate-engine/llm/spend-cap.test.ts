import { openSharedStore, type SharedStore } from '../../shared/store/index.js';
import type { LogEntry, Logger } from '../../shared/types.js';
import { SqliteSpendCap, UNCAPPED_SPEND } from './spend-cap.js';

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

/** One priced call, straight into the table `SqliteLlmSpendStore` writes. */
function spend(db: SharedStore, costUsd: number, id: string): void {
  db.prepare(
    `INSERT INTO llm_spend (
       trace_id, stage, debate_id, model,
       input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       cost_usd, latency_ms, timestamp
     ) VALUES (?, 'debate', ?, 'claude-haiku-4-5-20251001', 100, 100, 0, 0, ?, 10, ?)`,
  ).run(`trace-${id}`, `debate-${id}`, costUsd, new Date().toISOString());
}

describe('SqliteSpendCap', () => {
  let db: SharedStore;

  beforeEach(() => {
    db = openSharedStore(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('admits while cumulative spend is under the budget', () => {
    spend(db, 10, 'a');
    spend(db, 5, 'b');

    const verdict = new SqliteSpendCap(db, 50).check();

    expect(verdict.admitted).toBe(true);
    expect(verdict.spent_usd).toBeCloseTo(15, 10);
    expect(verdict.budget_usd).toBe(50);
  });

  it('admits on an empty table rather than treating no rows as unreadable', () => {
    // A fresh soak database has no `llm_spend` rows at all. `SUM` over zero
    // rows is SQL NULL, and a cap that read that as "cannot answer" would fail
    // closed on the first tick of every run.
    expect(new SqliteSpendCap(db, 50).check()).toMatchObject({ admitted: true, spent_usd: 0 });
  });

  it('refuses once cumulative spend REACHES the budget, not only past it', () => {
    // `>=`, not `>`. At exactly the budget the money is gone; admitting one
    // more debate there spends past a figure the operator was promised.
    spend(db, 50, 'a');

    const verdict = new SqliteSpendCap(db, 50).check();

    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain('$50.00 of $50.00');
  });

  it('sums across many rows, which is the only way the real breach arrives', () => {
    // The breach never comes from one expensive call — it comes from ~5,000
    // small ones over a fortnight. A cap that only looked at the latest row
    // would pass every test written against a single call and never fire.
    for (let i = 0; i < 60; i++) spend(db, 1, `row-${i}`);

    expect(new SqliteSpendCap(db, 50).check().admitted).toBe(false);
  });

  it('fails CLOSED when llm_spend cannot be read', () => {
    // The mirror image of `SqliteLlmSpendStore.record`, which swallows its own
    // failures because it is bookkeeping after the fact. This is a control
    // read BEFORE money is spent, so an unanswerable read must refuse — the
    // alternative is a locked database silently removing the only ceiling on
    // an unattended run.
    const { logger, entries } = recordingLogger();
    db.prepare('DROP TABLE llm_spend').run();

    const verdict = new SqliteSpendCap(db, 50, logger).check();

    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain('fail-closed');
    expect(entries.at(-1)?.level).toBe('error');
  });

  it('refuses a budget that could never admit anything, at construction', () => {
    // A zero or negative ceiling refuses every debate and reads as a dead
    // pipeline rather than as a misconfiguration. Fail at the point the
    // mistake was made.
    expect(() => new SqliteSpendCap(db, 0)).toThrow('positive, finite');
    expect(() => new SqliteSpendCap(db, -1)).toThrow('positive, finite');
    expect(() => new SqliteSpendCap(db, Number.NaN)).toThrow('positive, finite');
  });
});

describe('UNCAPPED_SPEND', () => {
  it('admits, and says the budget is infinite rather than claiming a number', () => {
    const verdict = UNCAPPED_SPEND.check();

    expect(verdict.admitted).toBe(true);
    expect(verdict.budget_usd).toBe(Number.POSITIVE_INFINITY);
  });
});
