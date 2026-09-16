/**
 * SQLite-backed `DebateLogStore` over the `debate_log` table (#193) — the
 * real store behind `InMemoryDebateLogStore` (#63). Debate Engine calls
 * `writeLog` once per completed debate; Feedback Loop calls `getByDebateId`
 * for attribution (`debate-attribution-lookup.ts`). See
 * docs/specs/shared-sqlite-store-spec.md ("Debate Engine" schema section)
 * and docs/specs/debate-engine-spec.md ("Debate log write").
 *
 * Append-only, write-once/read-by-key: unlike `SqliteSetupStore`, `DebateLog`
 * has no later update step, so there is only a write and a read here. A
 * duplicate write for an already-logged
 * `debate_id` is surfaced as a named error (mirroring `SqliteSetupStore
 * .writeSetup`) rather than silently overwritten, since a repeat write means
 * the same debate resolved twice — a bug, not a legitimate re-run.
 */

import type {
  DebateLog,
  DebateLogStore,
  DebateRoundLogEntry,
  DebateTermination,
  DebateTerminationCause,
} from '../../shared/index.js';
import {
  fromStoredTimestamp,
  isUniqueConstraintError,
  type StoreHandle,
  toStoredTimestamp,
} from '../../shared/store/index.js';
import type { AnalystContribution, Direction } from './types.js';

interface DebateLogRow {
  debate_id: string;
  instrument: string;
  bar_timestamp: string;
  contributions_json: string;
  direction: Direction;
  rounds: number;
  created_at: string;
  /** #426. Null for a row written before the column existed. */
  trace_id: string | null;
  /** #617 replay fields (migration 0026). Null for a row written before them. */
  confidence: number | null;
  synthesis: string | null;
  position: string | null;
  disagreement_summary: string | null;
  open_items_json: string | null;
  /** SQLite has no boolean — 1/0, or null on a pre-0026 row */
  converged: number | null;
  /** #1081 (migration 0041). Null on a pre-migration row — genuinely indeterminate. */
  termination: DebateTermination | null;
  /**
   * #1380 (migration 0051). Null unless `termination === 'latency_truncated'`
   * — see `DebateTerminationCause`'s own doc.
   */
  termination_cause: DebateTerminationCause | null;
}

/** The `debate_log` INSERT's positional params, in column order — see `SqliteDebateLogStore.writeLog`'s statement */
function debateLogInsertParams(entry: DebateLog): unknown[] {
  return [
    entry.debate_id,
    entry.instrument,
    toStoredTimestamp(entry.bar_timestamp),
    JSON.stringify(entry.contributions),
    entry.direction,
    entry.rounds,
    toStoredTimestamp(entry.created_at),
    // #426. Null rather than absent when the caller has no trace: the
    // column is nullable precisely because pre-#426 rows have none, and
    // a retried tick's fresh trace must not overwrite the one that
    // actually ran the debate (the PK conflict below is what enforces
    // that — first write wins)
    entry.trace_id ?? null,
    // #617 replay fields. Null when the caller supplies none, which keeps
    // the pre-0026 callers (tests, backtest) writing valid rows; the
    // replay path reads a null `confidence` as "cannot replay this" and
    // re-runs the debate rather than trading on a reconstructed blank
    entry.confidence ?? null,
    entry.synthesis ?? null,
    entry.position ?? null,
    entry.disagreement_summary ?? null,
    entry.open_items === undefined ? null : JSON.stringify(entry.open_items),
    entry.converged === undefined ? null : entry.converged ? 1 : 0,
    // #1081. Null when the caller supplies none, same convention as
    // every other optional column here — a pre-0041 caller (tests, a
    // fixture) still writes a valid row, and the column's own NULL is
    // the honest "not recorded" rather than a guessed classification
    entry.termination ?? null,
    // #1380. Same convention as `termination` immediately above — a
    // caller that supplies no cause (every pre-0051 caller, and a
    // 'converged'/'non_converged' row that has none to give) writes
    // NULL
    entry.termination_cause ?? null,
  ];
}

export class SqliteDebateLogStore implements DebateLogStore {
  constructor(private readonly db: StoreHandle) {}

  writeLog(entry: DebateLog): void {
    try {
      this.db
        .prepare(
          `INSERT INTO debate_log (
             debate_id, instrument, bar_timestamp, contributions_json, direction, rounds,
             created_at, trace_id, confidence, synthesis, position, disagreement_summary,
             open_items_json, converged, termination, termination_cause
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...debateLogInsertParams(entry));
    } catch (cause) {
      if (isUniqueConstraintError(cause)) {
        throw new Error(
          `SqliteDebateLogStore.writeLog: a debate log already exists for debate_id ` +
            `'${entry.debate_id}' — one row per debate (debate_log PK); a repeat write ` +
            'means the same debate resolved twice.',
          { cause },
        );
      }
      throw cause;
    }
  }

  /**
   * Persists this debate's per-round verdicts (#1517), one row per entry.
   * NOT part of the `DebateLogStore` port (#1558 review round 2 — nothing
   * outside this class and `InMemoryDebateLogStore`'s discard called it
   * through the port; same off-port-but-public precedent as
   * `getTerminationCauseWindowCounts` below, kept public rather than
   * `private` so this file's own tests can exercise it directly). Called
   * only by `writeLogWithRounds`, which wraps this and `writeLog` in one
   * transaction — the FK on `debate_round_log.debate_id` (migration 0064)
   * therefore always resolves, since the owning `debate_log` row lands
   * first in the same transaction. A mid-loop failure leaves none of a
   * debate's rounds written rather than a truncated prefix a flip-rate
   * query would silently misread as the whole debate.
   */
  writeRoundLog(entries: DebateRoundLogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const insert = this.db.prepare(
      `INSERT INTO debate_round_log (debate_id, round, direction, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.transaction((rows: DebateRoundLogEntry[]) => {
      for (const row of rows) {
        insert.run(
          row.debate_id,
          row.round,
          row.direction,
          row.confidence,
          toStoredTimestamp(row.created_at),
        );
      }
    })(entries);
  }

  /**
   * `writeLog` + `writeRoundLog` under one `better-sqlite3` transaction
   * (`writeRoundLog`'s own transaction nests as a SAVEPOINT): a throw from
   * either leaves neither the `debate_log` row nor any `debate_round_log`
   * rows, so a crash never strands a debate past `persistDebateLog`'s
   * first-write-wins guard with its round rows unwritable forever
   */
  writeLogWithRounds(entry: DebateLog, rounds: DebateRoundLogEntry[]): void {
    this.db.transaction(() => {
      this.writeLog(entry);
      this.writeRoundLog(rounds);
    })();
  }

  getByDebateId(debate_id: string): DebateLog | undefined {
    const row = this.db.prepare('SELECT * FROM debate_log WHERE debate_id = ?').get(debate_id) as
      | DebateLogRow
      | undefined;

    if (row === undefined) {
      return undefined;
    }

    return {
      debate_id: row.debate_id,
      instrument: row.instrument,
      bar_timestamp: fromStoredTimestamp(row.bar_timestamp),
      contributions: JSON.parse(row.contributions_json) as AnalystContribution[],
      direction: row.direction,
      rounds: row.rounds,
      created_at: fromStoredTimestamp(row.created_at),
      // Absent rather than null on the domain object (#426): `DebateLog
      // .trace_id` is optional, and a pre-#426 row genuinely has no trace
      // rather than a null one
      ...(row.trace_id === null || row.trace_id === undefined ? {} : { trace_id: row.trace_id }),
      // Same convention for the #617 replay fields — a pre-0026 row genuinely
      // has no confidence, and the replay path distinguishes "absent" from
      // "zero" to decide whether it may skip the LLM calls
      ...nullableField('confidence', row.confidence),
      ...nullableField('synthesis', row.synthesis),
      ...nullableField('position', row.position),
      ...nullableField('disagreement_summary', row.disagreement_summary),
      ...parseOpenItems(row.open_items_json),
      ...(row.converged === null || row.converged === undefined
        ? {}
        : { converged: row.converged === 1 }),
      ...nullableField('termination', row.termination),
      ...nullableField('termination_cause', row.termination_cause),
    };
  }

  /**
   * Aggregate `termination_cause` counts over `(from, to]` among TRUNCATED
   * rows only (#1396, review round 1 F2) — the llm-failure-rate alert's
   * window read, never called from `writeLog`'s hot path. NOT part of the
   * `DebateLogStore` port: #785 already declined widening that shared port
   * for a comparable (by-bar) accessor, on the reasoning that every other
   * implementer (`InMemoryDebateLogStore`, feedback-loop's fixtures) would
   * have to grow a matching method for a capability only the orchestrator's
   * alert guard needs. The guard is handed this concrete store directly
   * instead.
   *
   * `total` is truncations (`termination = 'latency_truncated'`), not every
   * `debate_log` row — a converged or non-converged debate never had a
   * cause to classify, and diluting the rate with them would make
   * `LLM_FAILURE_RATE_THRESHOLD`'s "one in four truncations" rationale
   * (llm-failure-rate-guard.ts) false: a stream that is mostly converged
   * debates could never cross 0.25 no matter how many of its FEW
   * truncations were outright failures. A pre-migration-0041 row (whose
   * `termination` is itself NULL — genuinely unknown whether it was ever
   * truncated, migration 0041's "NULL means INDETERMINATE" invariant) is
   * excluded the same way a converged row is.
   *
   * Within that truncated set, NULL-safe pair matching `getAttribution`'s
   * `termination IS NOT 'latency_truncated'` convention
   * (`sqlite-query-store.ts`): `= 'llm_failure'` counts an explicit failure,
   * `IS NOT 'llm_failure'` counts every other truncated row INCLUDING a
   * pre-migration-0051 NULL cause — a truncation this build cannot classify
   * must not skew the rate toward "failing" just because it predates the
   * cause column.
   */
  getTerminationCauseWindowCounts(from: Date, to: Date): { llm_failure: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT
            SUM(CASE WHEN termination_cause = 'llm_failure' THEN 1 ELSE 0 END) AS llm_failure,
            SUM(CASE WHEN termination_cause IS NOT 'llm_failure' THEN 1 ELSE 0 END) AS non_failure
           FROM debate_log
          WHERE termination = 'latency_truncated' AND created_at > ? AND created_at <= ?`,
      )
      .get(toStoredTimestamp(from), toStoredTimestamp(to)) as {
      llm_failure: number | null;
      non_failure: number | null;
    };
    // `SUM` over zero matched rows is NULL, not 0 — an empty window
    const llm_failure = row.llm_failure ?? 0;
    const non_failure = row.non_failure ?? 0;
    return { llm_failure, total: llm_failure + non_failure };
  }

  /**
   * Records one gate-refused debate (#1533) so `GateRefusalRateMonitor`
   * (orchestrator `production/gate-refusal-rate-guard.ts`) has something to
   * count — see migration 0065's header for why this is a standalone
   * append-only table rather than a `debate_log` column.
   *
   * Never throws on a malformed input: `occurred_at` is always a fresh
   * `clock.now()` from the call site (`debate-adapter.ts`), so there is
   * nothing here to validate. A `better-sqlite3` failure (SQLITE_BUSY, a
   * closed handle) DOES propagate — the call site wraps this call in its own
   * try/catch, so one bad write logs a warning rather than crashing a tick
   * that has already degraded to `gateRefusedDebateResult`.
   */
  recordGateRefusal(occurred_at: Date): void {
    this.db
      .prepare('INSERT INTO llm_gate_refusals (occurred_at) VALUES (?)')
      .run(toStoredTimestamp(occurred_at));
  }

  /**
   * The gate-refusal-rate window read over `(from, to]` (#1533, review round 1
   * F1) — a SEPARATE aggregate from `getTerminationCauseWindowCounts` above,
   * feeding a separate signal with its own threshold, and deliberately not a
   * widening of it: that method's `total` is truncations only, chosen so a
   * healthy mostly-converged stream can never cross
   * `LLM_FAILURE_RATE_THRESHOLD`, and folding a per-pass-constant refusal
   * count into it would make that rate ~1.0 on every healthy window.
   *
   * `debates_logged` is EVERY `debate_log` row in the window, not the truncated
   * subset — a gate refusal displaces a whole debate, so the population it is
   * measured against is debates that ran, whatever they terminated as. A
   * spend-cap (`debate_refused_spend_cap`) or rate-limiter
   * (`debate_refused_rate_limit`) refusal writes neither a `debate_log` row nor
   * an `llm_gate_refusals` row, so it is absent from both counts; the ratio is
   * therefore "of the debates the gate decided", not "of every pass attempt".
   */
  getGateRefusalWindowCounts(
    from: Date,
    to: Date,
  ): { gate_refused: number; debates_logged: number } {
    const refused = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM llm_gate_refusals WHERE occurred_at > ? AND occurred_at <= ?',
      )
      .get(toStoredTimestamp(from), toStoredTimestamp(to)) as { count: number };
    const logged = this.db
      .prepare('SELECT COUNT(*) AS count FROM debate_log WHERE created_at > ? AND created_at <= ?')
      .get(toStoredTimestamp(from), toStoredTimestamp(to)) as { count: number };
    return { gate_refused: refused.count, debates_logged: logged.count };
  }

  /**
   * Every round-verdict row over `(from, to]`, in `debate_id`/`round` order —
   * the raw feed `server/tools/report-debate-round-flip-rate.ts` groups by
   * `debate_id` (#1517). Not part of the `DebateLogStore` port, same #785
   * precedent as `getTerminationCauseWindowCounts` immediately above: a
   * read-only aggregate for one report tool, not a capability every
   * implementer needs.
   */
  listRoundVerdicts(from: Date, to: Date): DebateRoundLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT debate_id, round, direction, confidence, created_at
           FROM debate_round_log
          WHERE created_at > ? AND created_at <= ?
          ORDER BY debate_id, round`,
      )
      .all(toStoredTimestamp(from), toStoredTimestamp(to)) as {
      debate_id: string;
      round: number;
      direction: Direction;
      confidence: number;
      created_at: string;
    }[];

    return rows.map((row) => ({
      debate_id: row.debate_id,
      round: row.round,
      direction: row.direction,
      confidence: row.confidence,
      created_at: fromStoredTimestamp(row.created_at),
    }));
  }
}

/**
 * `open_items`, or absent when the column is null OR unreadable.
 *
 * Degrading rather than throwing is the point. Since #617 `getByDebateId` runs
 * **before** the debate on every tick, so an unparseable row would throw out of
 * the read and fail the debate stage for every remaining tick of that bar. The
 * whole reason the replay path exists is that a same-bar tick should reuse the
 * stored debate or re-run it — never that it should take the tick down. Absent
 * is exactly the "no replay fields, run the debate" case the caller already
 * handles.
 *
 * The `as string[]` was also unchecked: `JSON.parse` returns whatever the column
 * holds, so a row containing `{}` or `"x"` would have been handed to a caller
 * expecting an array.
 */
function parseOpenItems(
  raw: string | null | undefined,
): { open_items: string[] } | Record<string, never> {
  if (raw === null || raw === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    return {};
  }

  return { open_items: parsed };
}

/** `{ key: value }` when the column has a value, `{}` when it is null/absent */
function nullableField<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
