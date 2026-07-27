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

import type { Clock } from '../shared/clock.js';
import { SystemClock } from '../shared/clock.js';
import type { SharedStore } from '../shared/store/open-shared-store.js';
import type { TuningStore } from '../shared/types.js';

interface AnalystWeightRow {
  analyst_id: string;
  weight: number;
}

interface StrategyParamRow {
  param_name: string;
  value: number;
}

interface RiskThresholdRow {
  threshold_name: string;
  value: number;
}

export class SqliteTuningStore implements TuningStore {
  constructor(
    private readonly db: SharedStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  getAnalystWeights(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT analyst_id, weight FROM analyst_weights')
      .all() as AnalystWeightRow[];
    return Object.fromEntries(rows.map((row) => [row.analyst_id, row.weight]));
  }

  setAnalystWeight(analyst_id: string, weight: number): void {
    this.db
      .prepare(
        `INSERT INTO analyst_weights (analyst_id, weight, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(analyst_id) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
      )
      .run(analyst_id, weight, this.clock.now().toISOString());
  }

  getStrategyParams(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT param_name, value FROM strategy_params')
      .all() as StrategyParamRow[];
    return Object.fromEntries(rows.map((row) => [row.param_name, row.value]));
  }

  setStrategyParam(name: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO strategy_params (param_name, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(param_name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, this.clock.now().toISOString());
  }

  getRiskThresholds(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT threshold_name, value FROM risk_thresholds')
      .all() as RiskThresholdRow[];
    return Object.fromEntries(rows.map((row) => [row.threshold_name, row.value]));
  }

  setRiskThreshold(name: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO risk_thresholds (threshold_name, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(threshold_name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, this.clock.now().toISOString());
  }
}
