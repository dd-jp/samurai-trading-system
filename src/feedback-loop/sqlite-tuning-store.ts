/**
 * SQLite-backed `TuningStore` over `analyst_weights`/`strategy_params`/
 * `risk_thresholds` (#193) — the real store behind `InMemoryTuningStore`
 * (#91). Three separate tables, one per dial, matching
 * shared-sqlite-store-spec.md's "every table's own consumer dictates its
 * key" principle — `analyst_id`/`param_name`/`threshold_name` are unrelated
 * keyspaces even when a name happens to collide across them.
 *
 * Each dial's current value is a plain upsert: `runDailyCycle` treats a dial
 * write as "this is now the value", never a history (`dial_adjustments`,
 * via `AdjustmentLog`, is the audit trail for that). `updated_at` is stamped
 * from the injected `Clock`, matching `SqliteConfigTrialLog`'s convention,
 * since the `TuningStore` port itself carries no timestamp parameter.
 */

import type { Clock, TuningStore } from '../shared/index.js';
import { SystemClock } from '../shared/index.js';
import type { SharedStore } from '../shared/store/index.js';

/**
 * The three dial tables share one shape — (name key, REAL value, updated_at)
 * — differing only in identifiers, so the getter/setter pairs collapse into
 * one KV helper per direction (code-review 2026-08-01, M8). Identifiers are
 * interpolated from these fixed literals only, never from caller input.
 */
interface DialTable {
  table: 'analyst_weights' | 'strategy_params' | 'risk_thresholds';
  keyColumn: 'analyst_id' | 'param_name' | 'threshold_name';
  valueColumn: 'weight' | 'value';
}

const ANALYST_WEIGHTS: DialTable = {
  table: 'analyst_weights',
  keyColumn: 'analyst_id',
  valueColumn: 'weight',
};
const STRATEGY_PARAMS: DialTable = {
  table: 'strategy_params',
  keyColumn: 'param_name',
  valueColumn: 'value',
};
const RISK_THRESHOLDS: DialTable = {
  table: 'risk_thresholds',
  keyColumn: 'threshold_name',
  valueColumn: 'value',
};

export class SqliteTuningStore implements TuningStore {
  constructor(
    private readonly db: SharedStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  getAnalystWeights(): Record<string, number> {
    return this.kvGetAll(ANALYST_WEIGHTS);
  }

  setAnalystWeight(analyst_id: string, weight: number): void {
    this.kvSet(ANALYST_WEIGHTS, analyst_id, weight);
  }

  /**
   * First-write-wins insert, atomic in SQLite rather than in the caller
   * (#371, PR review). `ON CONFLICT DO NOTHING` — deliberately NOT the
   * `DO UPDATE` every other write on this class uses, and the same choice
   * `SqliteVerdictLogStore.writeLog` makes for the same reason: the existing
   * row is the record.
   *
   * Two processes overlapping across a restart (#238) is the case a caller-side
   * "read the map, write the missing ones" cannot cover — both can observe an
   * absent row before either writes, and last-write-wins then resets a tuned
   * weight to its starting value. `DO NOTHING` makes that unrepresentable:
   * whoever inserts first owns the row, and every later seed is a no-op that
   * leaves both `weight` and `updated_at` untouched.
   *
   * `changes` is 0 on the conflict path and 1 on the insert, which is exactly
   * "did I seed it" — reported back so startup can log what it wrote without
   * a second read that would race all over again.
   */
  seedAnalystWeight(analyst_id: string, weight: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO ${ANALYST_WEIGHTS.table}
           (${ANALYST_WEIGHTS.keyColumn}, ${ANALYST_WEIGHTS.valueColumn}, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(${ANALYST_WEIGHTS.keyColumn}) DO NOTHING`,
      )
      .run(analyst_id, weight, this.clock.now().toISOString());
    return result.changes === 1;
  }

  getStrategyParams(): Record<string, number> {
    return this.kvGetAll(STRATEGY_PARAMS);
  }

  setStrategyParam(name: string, value: number): void {
    this.kvSet(STRATEGY_PARAMS, name, value);
  }

  getRiskThresholds(): Record<string, number> {
    return this.kvGetAll(RISK_THRESHOLDS);
  }

  setRiskThreshold(name: string, value: number): void {
    this.kvSet(RISK_THRESHOLDS, name, value);
  }

  private kvGetAll(dial: DialTable): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT ${dial.keyColumn} AS key, ${dial.valueColumn} AS value FROM ${dial.table}`)
      .all() as { key: string; value: number }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  private kvSet(dial: DialTable, key: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO ${dial.table} (${dial.keyColumn}, ${dial.valueColumn}, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(${dial.keyColumn}) DO UPDATE
           SET ${dial.valueColumn} = excluded.${dial.valueColumn}, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.clock.now().toISOString());
  }
}
