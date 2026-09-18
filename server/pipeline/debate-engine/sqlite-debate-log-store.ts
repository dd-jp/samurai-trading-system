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
  trace_id: string | null;
  confidence: number | null;
  synthesis: string | null;
  position: string | null;
  disagreement_summary: string | null;
  open_items_json: string | null;
  converged: number | null;
  termination: DebateTermination | null;
  termination_cause: DebateTerminationCause | null;
}

function debateLogInsertParams(entry: DebateLog): unknown[] {
  return [
    entry.debate_id,
    entry.instrument,
    toStoredTimestamp(entry.bar_timestamp),
    JSON.stringify(entry.contributions),
    entry.direction,
    entry.rounds,
    toStoredTimestamp(entry.created_at),
    entry.trace_id ?? null,
    entry.confidence ?? null,
    entry.synthesis ?? null,
    entry.position ?? null,
    entry.disagreement_summary ?? null,
    entry.open_items === undefined ? null : JSON.stringify(entry.open_items),
    entry.converged === undefined ? null : entry.converged ? 1 : 0,
    entry.termination ?? null,
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
      ...(row.trace_id === null || row.trace_id === undefined ? {} : { trace_id: row.trace_id }),
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
    const llm_failure = row.llm_failure ?? 0;
    const non_failure = row.non_failure ?? 0;
    return { llm_failure, total: llm_failure + non_failure };
  }

  recordGateRefusal(occurred_at: Date): void {
    this.db
      .prepare('INSERT INTO llm_gate_refusals (occurred_at) VALUES (?)')
      .run(toStoredTimestamp(occurred_at));
  }

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

function nullableField<K extends string, V>(
  key: K,
  value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
