import { runWithTraceId } from '../../../shared/index.js';
import { openSharedStore, type StoreHandle } from '../../../shared/store/index.js';
import type { LogEntry, Logger } from '../../../shared/types.js';
import {
  BUDGET_REMEDY,
  CORRUPT_LEDGER_REMEDY,
  READ_FAULT_REMEDY,
  type SpendCapVerdict,
  SqliteSpendCap,
  spendCapRefusalRemedy,
  UNCAPPED_SPEND,
} from './spend-cap.js';

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

/** Narrows a verdict to its refusing arm — `kind` and `reason` only exist there */
function assertRefused(
  verdict: SpendCapVerdict,
): asserts verdict is Extract<SpendCapVerdict, { admitted: false }> {
  if (verdict.admitted) throw new Error('expected a refusal, got an admitted verdict');
}

/** One priced call, straight into the table `SqliteLlmSpendStore` writes */
function spend(db: StoreHandle, costUsd: number, id: string): void {
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
function lockedOnce(db: StoreHandle): StoreHandle {
  let locked = true;
  return {
    prepare(sql: string) {
      if (locked) {
        locked = false;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return db.prepare(sql);
    },
  } as unknown as StoreHandle;
}

/**
 * A store whose SUM read answers with a non-finite total — the corrupt
 * `cost_usd` row case `check()`'s second guard exists for, which no ordinary
 * INSERT can reach through the real `llm_spend` schema
 */
function nonFiniteSum(): StoreHandle {
  return {
    prepare: () => ({ get: () => ({ total: Number.NaN }) }),
  } as unknown as StoreHandle;
}

/**
 * A store whose FIRST read throws `SQLITE_BUSY` (a `'read_fault'`) and whose
 * every later read answers with a non-finite total (a `'corrupt_ledger'`) —
 * two DIFFERENT fault kinds from the same store, to pin that `#faultAnnounced`
 * is one latch across both, not one per kind
 */
function readFaultThenCorruptLedger(): StoreHandle {
  let threw = false;
  return {
    prepare() {
      if (!threw) {
        threw = true;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return { get: () => ({ total: Number.NaN }) };
    },
  } as unknown as StoreHandle;
}

describe('SqliteSpendCap', () => {
  let db: StoreHandle;

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
    // closed on the first tick of every run
    expect(new SqliteSpendCap(db, 50).check()).toMatchObject({ admitted: true, spent_usd: 0 });
  });

  it('refuses once cumulative spend REACHES the budget, not only past it', () => {
    // `>=`, not `>`. At exactly the budget the money is gone; admitting one
    // more debate there spends past a figure the operator was promised
    spend(db, 50, 'a');

    const verdict = new SqliteSpendCap(db, 50).check();

    assertRefused(verdict);
    expect(verdict.reason).toContain('$50.00 of $50.00');
    expect(verdict.kind).toBe('budget');
  });

  it('sums across many rows, which is the only way the real breach arrives', () => {
    // The breach never comes from one expensive call — it comes from ~5,000
    // small ones over a fortnight. A cap that only looked at the latest row
    // would pass every test written against a single call and never fire
    for (let i = 0; i < 60; i++) spend(db, 1, `row-${i}`);

    expect(new SqliteSpendCap(db, 50).check().admitted).toBe(false);
  });

  it('fails CLOSED when llm_spend cannot be read', () => {
    // The mirror image of `SqliteLlmSpendStore.record`, which swallows its own
    // failures because it is bookkeeping after the fact. This is a control
    // read BEFORE money is spent, so an unanswerable read must refuse — the
    // alternative is a locked database silently removing the only ceiling on
    // an unattended run
    const { logger, entries } = recordingLogger();
    db.prepare('DROP TABLE llm_spend').run();

    const verdict = new SqliteSpendCap(db, 50, logger).check();

    assertRefused(verdict);
    expect(verdict.reason).toContain('fail-closed');
    expect(verdict.kind).toBe('read_fault');
    expect(entries.at(-1)?.level).toBe('error');
  });

  it('tags the non-finite-sum refusal (a corrupt cost_usd row) as corrupt_ledger, not budget', () => {
    // The `#refuse('corrupt_ledger', ...)` call site — distinct from the read
    // failure above, which is `#refuse('read_fault', ...)`: unlike a read
    // fault, a corrupt row does not clear on its own
    const verdict = new SqliteSpendCap(nonFiniteSum(), 50).check();

    assertRefused(verdict);
    expect(verdict.reason).toContain('not a finite number');
    expect(verdict.kind).toBe('corrupt_ledger');
  });

  it('escalates the breach ONCE, not on every subsequent refusal', () => {
    // The cap does not refill, so every tick after the breach refuses
    // identically. At a 15-minute cadence that is ~1,000 identical alerts over
    // the rest of a 14-day run, which is how an operator learns to mute the
    // channel that also carries kill-threshold breaches
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
    // on this path would be worse, not better
    db.prepare('DROP TABLE llm_spend').run();
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(db, 50, undefined, (v) => breaches.push(v.reason ?? ''));

    cap.check();

    expect(breaches).toEqual(['spend cap unreadable (fail-closed)']);
  });

  describe('kind on the latched (post-escalation) return (#1372 review round 1, M1)', () => {
    // THE REGRESSION THIS PINS: `#refuse` stamps `kind` before checking the
    // latch, but only the FIRST refusal of a latch group reaches `onBreach` —
    // every later one takes the short-circuit `return refused;`. A prior
    // round of this ticket tested `kind` only on the escalating (first) call,
    // so a mutation that stamped the SHORT-CIRCUIT return with the raw,
    // kind-less `verdict` instead of `refused` passed every test — yet almost
    // every refusal `debate-adapter.ts` logs across a soak takes this path
    it('keeps kind: budget on the second refusal, after the budget latch is set', () => {
      spend(db, 60, 'over-budget');
      const cap = new SqliteSpendCap(db, 50);

      cap.check();
      const second = cap.check();

      assertRefused(second);
      expect(second.kind).toBe('budget');
    });

    it('keeps kind: read_fault on the second refusal, after the fault latch is set', () => {
      db.prepare('DROP TABLE llm_spend').run();
      const cap = new SqliteSpendCap(db, 50);

      cap.check();
      const second = cap.check();

      assertRefused(second);
      expect(second.kind).toBe('read_fault');
    });

    it('keeps kind: corrupt_ledger on the second refusal, after the fault latch is set', () => {
      const cap = new SqliteSpendCap(nonFiniteSum(), 50);

      cap.check();
      const second = cap.check();

      assertRefused(second);
      expect(second.kind).toBe('corrupt_ledger');
    });

    it('fires the fault alert once across two different fault kinds — one latch for the group', () => {
      // A per-kind latch would fire onBreach twice; the shared fault latch
      // fires once
      const breaches: Extract<SpendCapVerdict, { admitted: false }>[] = [];
      const cap = new SqliteSpendCap(readFaultThenCorruptLedger(), 50, undefined, (v) =>
        breaches.push(v),
      );

      const first = cap.check();
      const second = cap.check();

      assertRefused(first);
      assertRefused(second);
      expect(first.kind).toBe('read_fault');
      expect(second.kind).toBe('corrupt_ledger');
      expect(breaches).toHaveLength(1);
    });
  });

  it('still refuses when the alert channel throws', () => {
    // The refusal is the load-bearing part and is already decided by the time
    // the alert fires. A transport that throws must not turn "the budget is
    // spent" into an unhandled rejection inside the tick
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
    // fired the fault alert, set the latch, and then the database recovered
    // Ten days later spend crossed the ceiling, the refusal short-circuited on
    // the already-set latch, and NOTHING reached the operator: the soak stops
    // trading for its remaining days while the heartbeat keeps beating and
    // ticks keep completing with no trade. Indistinguishable from a quiet
    // market, which is the exact failure this escalation exists to prevent
    const breaches: string[] = [];
    const cap = new SqliteSpendCap(lockedOnce(db), 50, undefined, (v) =>
      breaches.push(v.reason ?? ''),
    );

    expect(cap.check().admitted).toBe(false);
    expect(breaches).toEqual(['spend cap unreadable (fail-closed)']);

    // The lock clears and the cap goes back to admitting
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
    // the budget latch here precisely because the latches are per latch
    // group: the only thing it suppresses is the identical breach it just
    // reported
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
    // mistake was made
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
  // does not refill" even on the fault paths, where it is false. Asserting
  // against the exported constants, not literal substrings, means a swap of
  // which case returns which constant still reddens every one of these — the
  // constants themselves do not move — while a wording-only edit to a
  // constant's text does not touch this file at all
  it('maps each kind to its own constant', () => {
    expect(spendCapRefusalRemedy('budget')).toBe(BUDGET_REMEDY);
    expect(spendCapRefusalRemedy('read_fault')).toBe(READ_FAULT_REMEDY);
    expect(spendCapRefusalRemedy('corrupt_ledger')).toBe(CORRUPT_LEDGER_REMEDY);
  });

  it('claims permanence only for the budget remedy', () => {
    expect(BUDGET_REMEDY).toContain('does not refill');
    expect(READ_FAULT_REMEDY).not.toContain('does not refill');
    expect(CORRUPT_LEDGER_REMEDY).not.toContain('does not refill');
  });

  it('never claims a fault remedy is a spent budget, and each names its own fault', () => {
    expect(READ_FAULT_REMEDY).toContain('READ FAULT');
    expect(READ_FAULT_REMEDY).not.toContain('CORRUPT SPEND LEDGER');
    expect(CORRUPT_LEDGER_REMEDY).toContain('CORRUPT SPEND LEDGER');
    expect(CORRUPT_LEDGER_REMEDY).not.toContain('READ FAULT');
  });

  it('only the read-fault remedy promises a self-clearing outcome', () => {
    expect(READ_FAULT_REMEDY).toContain('recovers on its own');
    expect(BUDGET_REMEDY).not.toContain('recovers on its own');
    expect(CORRUPT_LEDGER_REMEDY).not.toContain('recovers on its own');
  });
});

describe('UNCAPPED_SPEND', () => {
  it('admits, and says the budget is infinite rather than claiming a number', () => {
    const verdict = UNCAPPED_SPEND.check();

    expect(verdict.admitted).toBe(true);
    expect(verdict.budget_usd).toBe(Number.POSITIVE_INFINITY);
  });
});
