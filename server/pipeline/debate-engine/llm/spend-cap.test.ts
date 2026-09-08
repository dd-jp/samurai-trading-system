import { runWithTraceId } from '../../../shared/index.js';
import { openSharedStore, type SharedStore } from '../../../shared/store/index.js';
import type { LogEntry, Logger } from '../../../shared/types.js';
import { SqliteSpendCap, spendCapRefusalRemedy, UNCAPPED_SPEND } from './spend-cap.js';

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
     ) VALUES (?, 'debate', ?, 'openai/gpt-5.6-luna', 100, 100, 0, 0, ?, 10, ?)`,
  ).run(`trace-${id}`, `debate-${id}`, costUsd, new Date().toISOString());
}

/**
 * A store whose FIRST read throws `SQLITE_BUSY` and whose every later read
 * succeeds — a lock contended for one tick, then gone. Only `prepare` is
 * stubbed because that is the whole of the cap's contact with the store.
 */
function lockedOnce(db: SharedStore): SharedStore {
  let locked = true;
  return {
    prepare(sql: string) {
      if (locked) {
        locked = false;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return db.prepare(sql);
    },
  } as unknown as SharedStore;
}

/**
 * A store whose SUM read answers with a non-finite total — the corrupt
 * `cost_usd` row case `check()`'s second guard exists for, which no ordinary
 * INSERT can reach through the real `llm_spend` schema.
 */
function nonFiniteSum(): SharedStore {
  return {
    prepare: () => ({ get: () => ({ total: Number.NaN }) }),
  } as unknown as SharedStore;
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
    expect(verdict.kind).toBe('budget');
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
    expect(verdict.kind).toBe('fault');
    expect(entries.at(-1)?.level).toBe('error');
  });

  it('tags the non-finite-sum refusal (a corrupt cost_usd row) as fault too, not budget', () => {
    // The second `#refuse('fault', ...)` call site — distinct from the read
    // failure above, but `SpendCapVerdict.kind` deliberately collapses both to
    // the same 'fault' value (see the field doc: nothing on the verdict
    // distinguishes which of the two fired).
    const verdict = new SqliteSpendCap(nonFiniteSum(), 50).check();

    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toContain('not a finite number');
    expect(verdict.kind).toBe('fault');
  });

  it('escalates the breach ONCE, not on every subsequent refusal', () => {
    // The cap does not refill, so every tick after the breach refuses
    // identically. At a 15-minute cadence that is ~1,000 identical alerts over
    // the rest of a 14-day run, which is how an operator learns to mute the
    // channel that also carries kill-threshold breaches.
    spend(db, 60, 'over-budget');
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(db, 50, undefined, (v) => breaches.push(v.reason ?? ''));

    cap.check();
    cap.check();
    cap.check();

    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toContain('LLM spend cap reached');
  });

  it('escalates the fail-closed refusal too, not only a spent budget', () => {
    // An unreadable llm_spend also stops the system trading, and unlike a
    // spent budget it is not something the operator meant to happen. Silence
    // on this path would be worse, not better.
    db.prepare('DROP TABLE llm_spend').run();
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(db, 50, undefined, (v) => breaches.push(v.reason ?? ''));

    cap.check();

    expect(breaches).toEqual(['spend cap unreadable (fail-closed)']);
  });

  it('still refuses when the alert channel throws', () => {
    // The refusal is the load-bearing part and is already decided by the time
    // the alert fires. A transport that throws must not turn "the budget is
    // spent" into an unhandled rejection inside the tick.
    spend(db, 60, 'over-budget');
    const { logger, entries } = recordingLogger();
    const cap = new SqliteSpendCap(db, 50, logger, () => {
      throw new Error('telegram is down');
    });

    expect(cap.check().admitted).toBe(false);
    expect(entries.at(-1)?.message).toContain('nothing reached an operator');
  });

  it('does not let a transient read fault consume the budget breach alert', () => {
    // THE REGRESSION THIS PINS: one shared `#breachAnnounced` boolean for both
    // refusal kinds. A single SQLITE_BUSY — at boot or for one tick mid-run —
    // fired the fault alert, set the latch, and then the database recovered.
    // Ten days later spend crossed the ceiling, the refusal short-circuited on
    // the already-set latch, and NOTHING reached the operator: the soak stops
    // trading for its remaining days while the heartbeat keeps beating and
    // ticks keep completing with no trade. Indistinguishable from a quiet
    // market, which is the exact failure this escalation exists to prevent.
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(lockedOnce(db), 50, undefined, (v) =>
      breaches.push(v.reason ?? ''),
    );

    expect(cap.check().admitted).toBe(false);
    expect(breaches).toEqual(['spend cap unreadable (fail-closed)']);

    // The lock clears and the cap goes back to admitting.
    expect(cap.check().admitted).toBe(true);

    // Now the budget genuinely runs out. This alert must still fire.
    spend(db, 60, 'over-budget');

    expect(cap.check().admitted).toBe(false);
    expect(breaches).toHaveLength(2);
    expect(breaches[1]).toContain('LLM spend cap reached');
  });

  it('announces the opening total, escalating at boot if already breached', () => {
    // `startingTotal()` is `check()` under a name that says why the root calls
    // it, so a store that is already over the ceiling raises the alert at boot
    // rather than one tick later — the operator is most likely still watching,
    // and the run is about to spend a fortnight taking no trade. Safe to spend
    // the budget latch here precisely because the latches are per-kind: the
    // only thing it suppresses is the identical breach it just reported.
    spend(db, 60, 'over-budget');
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(db, 50, undefined, (v) => breaches.push(v.reason ?? ''));

    const opening = cap.startingTotal();

    expect(opening.admitted).toBe(false);
    expect(breaches).toHaveLength(1);
  });

  it('refuses a budget that could never admit anything, at construction', () => {
    // A zero or negative ceiling refuses every debate and reads as a dead
    // pipeline rather than as a misconfiguration. Fail at the point the
    // mistake was made.
    expect(() => new SqliteSpendCap(db, 0)).toThrow('positive, finite');
    expect(() => new SqliteSpendCap(db, -1)).toThrow('positive, finite');
    expect(() => new SqliteSpendCap(db, Number.NaN)).toThrow('positive, finite');
  });

  describe('trace_id (#1280)', () => {
    it('falls back to the spend-cap constant outside a tick — read failure', () => {
      const { logger, entries } = recordingLogger();
      db.prepare('DROP TABLE llm_spend').run();

      new SqliteSpendCap(db, 50, logger).check();

      expect(entries.at(-1)?.trace_id).toBe('spend-cap');
    });

    it('joins the read-failure line to the enclosing tick instead', () => {
      const { logger, entries } = recordingLogger();
      db.prepare('DROP TABLE llm_spend').run();

      runWithTraceId('tick-x', () => new SqliteSpendCap(db, 50, logger).check());

      expect(entries.at(-1)?.trace_id).toBe('tick-x');
    });

    it('falls back to the spend-cap constant outside a tick — breach-alert send failure', () => {
      spend(db, 60, 'over-budget');
      const { logger, entries } = recordingLogger();
      const cap = new SqliteSpendCap(db, 50, logger, () => {
        throw new Error('telegram is down');
      });

      cap.check();

      expect(entries.at(-1)?.trace_id).toBe('spend-cap');
    });

    it('joins the breach-alert-send-failure line to the enclosing tick instead', () => {
      spend(db, 60, 'over-budget');
      const { logger, entries } = recordingLogger();
      const cap = new SqliteSpendCap(db, 50, logger, () => {
        throw new Error('telegram is down');
      });

      runWithTraceId('tick-x', () => cap.check());

      expect(entries.at(-1)?.trace_id).toBe('tick-x');
    });
  });
});

describe('spendCapRefusalRemedy (#1372)', () => {
  // The regression this pins: every refusal log line asserted "the budget
  // does not refill" even on the fault paths, where it is false — a
  // transient `llm_spend` read failure clears on its own. Swapping which
  // branch below returns which string must redden both assertions.
  it('claims permanence only for a budget refusal', () => {
    expect(spendCapRefusalRemedy('budget')).toContain('does not refill');
    expect(spendCapRefusalRemedy('budget')).not.toContain('SPEND-LEDGER FAULT');
  });

  it('never claims the fault refusal is permanent, and names it a ledger fault', () => {
    expect(spendCapRefusalRemedy('fault')).not.toContain('does not refill');
    expect(spendCapRefusalRemedy('fault')).toContain('SPEND-LEDGER FAULT');
  });

  it('claims neither permanence nor a ledger fault for a refusal with no reported kind', () => {
    const remedy = spendCapRefusalRemedy(undefined);

    expect(remedy).not.toContain('does not refill');
    expect(remedy).not.toContain('SPEND-LEDGER FAULT');
    expect(remedy).toContain('NAMES NO KIND');
  });
});

describe('UNCAPPED_SPEND', () => {
  it('admits, and says the budget is infinite rather than claiming a number', () => {
    const verdict = UNCAPPED_SPEND.check();

    expect(verdict.admitted).toBe(true);
    expect(verdict.budget_usd).toBe(Number.POSITIVE_INFINITY);
  });
});
