/**
 * In-memory `DebateLogStore` for #63 — a concrete implementation of the
 * port (not a test-only mock), mirroring src/trader/fixture-setup-store.ts's
 * `FixtureSetupStore`. See docs/specs/debate-engine-spec.md
 * ("Debate log write"). The real SQLite-backed store is
 * `SqliteDebateLogStore` (#200, src/debate-engine/sqlite-debate-log-store.ts).
 */
import type { DebateLog, DebateLogStore } from '../shared/index.js';
import type { DebateResult } from './types.js';

/**
 * Constructs the persisted `DebateLog` row from a resolved `DebateResult`.
 * `instrument`/`bar_timestamp` aren't carried on `DebateResult` (its shape is
 * the Trader-facing contract, not the log record), so the caller — the
 * component that ran the debate and knows the tick's instrument/bar —
 * supplies them.
 */
export function buildDebateLog(
  result: DebateResult,
  instrument: string,
  bar_timestamp: Date,
  created_at: Date,
): DebateLog {
  return {
    debate_id: result.debate_id,
    instrument,
    bar_timestamp,
    contributions: result.contributions,
    direction: result.direction,
    rounds: result.rounds_completed,
    created_at,
  };
}

export class InMemoryDebateLogStore implements DebateLogStore {
  private readonly rows = new Map<string, DebateLog>();

  writeLog(entry: DebateLog): void {
    this.rows.set(entry.debate_id, entry);
  }

  getByDebateId(debate_id: string): DebateLog | undefined {
    return this.rows.get(debate_id);
  }
}
