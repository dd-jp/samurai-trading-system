/**
 * SQLite-backed `DebateLogStore` over the `debate_log` table (#193) — the
 * real store behind `InMemoryDebateLogStore` (#63). Debate Engine calls
 * `writeLog` once per completed debate; Feedback Loop calls `getByDebateId`
 * for attribution (`debate-attribution-lookup.ts`). See
 * docs/specs/shared-sqlite-store-spec.md ("Debate Engine" schema section)
 * and docs/specs/debate-engine-spec.md ("Debate log write").
 *
 * Append-only, write-once/read-by-key: unlike `SqliteSetupStore`/
 * `SqliteConfigTrialLog`, `DebateLog` has no later update step, so there is
 * only a write and a read here. A duplicate write for an already-logged
 * `debate_id` is surfaced as a named error (mirroring `SqliteSetupStore
 * .writeSetup`) rather than silently overwritten, since a repeat write means
 * the same debate resolved twice — a bug, not a legitimate re-run.
 */

import type { DebateLog, DebateLogStore } from '../shared/index.js';
import { isUniqueConstraintError, type SharedStore } from '../shared/store/index.js';
import type { AnalystContribution, Direction } from './types.js';

interface DebateLogRow {
  debate_id: string;
  instrument: string;
  bar_timestamp: string;
  contributions_json: string;
  direction: Direction;
  rounds: number;
  created_at: string;
}

export class SqliteDebateLogStore implements DebateLogStore {
  constructor(private readonly db: SharedStore) {}

  writeLog(entry: DebateLog): void {
    try {
      this.db
        .prepare(
          `INSERT INTO debate_log (
             debate_id, instrument, bar_timestamp, contributions_json, direction, rounds, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.debate_id,
          entry.instrument,
          entry.bar_timestamp.toISOString(),
          JSON.stringify(entry.contributions),
          entry.direction,
          entry.rounds,
          entry.created_at.toISOString(),
        );
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
      bar_timestamp: new Date(row.bar_timestamp),
      contributions: JSON.parse(row.contributions_json) as AnalystContribution[],
      direction: row.direction,
      rounds: row.rounds,
      created_at: new Date(row.created_at),
    };
  }
}
