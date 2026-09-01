/**
 * The `debate_id`-keyed critic log (#957) — the persistence half of ADR-0003
 * §2's replay-from-log determinism shape.
 *
 * Two implementations, and the split is not a convenience:
 *
 * - `SqliteRiskCriticStore` over `risk_critic_log` (migration 0032) is the one
 *   the composition root wires in every mode. It has to be durable and
 *   cross-process, because the whole point is that a `backtest` run months
 *   later reads what a `live`/`paper` run wrote — an in-memory map cannot
 *   satisfy that, and `risk-manager-spec.md`'s "in-memory implementation,
 *   SQLite deferred" line predates the store existing at all.
 * - `InMemoryRiskCriticStore` is for tests and for a programmatic root with no
 *   shared store, matching the optional-store posture the rest of this stage
 *   takes.
 *
 * Writes are idempotent on `debate_id` (`DO NOTHING`), like every other
 * decision-record store here: a re-run of the same decision must not
 * accumulate a second, possibly different verdict for one debate. The FIRST
 * verdict is the one the replay will see, so it is the one that must stand.
 */

import type { SharedStore as Db } from '../../shared/store/index.js';
import { fromStoredTimestamp, toStoredTimestamp } from '../../shared/store/sqlite-utils.js';
import type { RiskCriticLog, RiskCriticStore, RiskCriticVerdict } from './types.js';

export class InMemoryRiskCriticStore implements RiskCriticStore {
  readonly #rows = new Map<string, RiskCriticLog>();

  writeVerdict(entry: RiskCriticLog): void {
    if (this.#rows.has(entry.debate_id)) return;
    this.#rows.set(entry.debate_id, entry);
  }

  getByDebateId(debate_id: string): RiskCriticLog | undefined {
    return this.#rows.get(debate_id);
  }
}

interface RiskCriticRow {
  debate_id: string;
  verdict: RiskCriticVerdict['verdict'];
  max_notional: number | null;
  reasoning: string;
  created_at: string;
}

export class SqliteRiskCriticStore implements RiskCriticStore {
  constructor(private readonly db: Db) {}

  writeVerdict(entry: RiskCriticLog): void {
    this.db
      .prepare(
        `INSERT INTO risk_critic_log (debate_id, verdict, max_notional, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(debate_id) DO NOTHING`,
      )
      .run(
        entry.debate_id,
        entry.verdict.verdict,
        entry.verdict.max_notional,
        entry.verdict.reasoning,
        toStoredTimestamp(entry.created_at),
      );
  }

  getByDebateId(debate_id: string): RiskCriticLog | undefined {
    const row = this.db
      .prepare(
        'SELECT debate_id, verdict, max_notional, reasoning, created_at FROM risk_critic_log WHERE debate_id = ?',
      )
      .get(debate_id) as RiskCriticRow | undefined;
    if (row === undefined) return undefined;
    return {
      debate_id: row.debate_id,
      verdict: {
        verdict: row.verdict,
        max_notional: row.max_notional,
        reasoning: row.reasoning,
      },
      created_at: fromStoredTimestamp(row.created_at),
    };
  }
}
