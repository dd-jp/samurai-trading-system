
import type { Clock, TuningStore } from '../../shared/index.js';
import { assertThresholdWithinBounds, SystemClock } from '../../shared/index.js';
import type { StoreHandle } from '../../shared/store/index.js';
import { toStoredTimestamp } from '../../shared/store/index.js';

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
    private readonly db: StoreHandle,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  getAnalystWeights(): Record<string, number> {
    return this.kvGetAll(ANALYST_WEIGHTS);
  }

  setAnalystWeight(analyst_id: string, weight: number): void {
    this.kvSet(ANALYST_WEIGHTS, analyst_id, weight);
  }

  seedAnalystWeight(analyst_id: string, weight: number): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO ${ANALYST_WEIGHTS.table}
           (${ANALYST_WEIGHTS.keyColumn}, ${ANALYST_WEIGHTS.valueColumn}, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(${ANALYST_WEIGHTS.keyColumn}) DO NOTHING`,
      )
      .run(analyst_id, weight, toStoredTimestamp(this.clock.now()));
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
    assertThresholdWithinBounds(name, value, 'SqliteTuningStore.setRiskThreshold');
    this.kvSet(RISK_THRESHOLDS, name, value);
  }

  seedRiskThreshold(name: string, value: number): boolean {
    assertThresholdWithinBounds(name, value, 'SqliteTuningStore.seedRiskThreshold');
    const result = this.db
      .prepare(
        `INSERT INTO ${RISK_THRESHOLDS.table}
           (${RISK_THRESHOLDS.keyColumn}, ${RISK_THRESHOLDS.valueColumn}, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(${RISK_THRESHOLDS.keyColumn}) DO NOTHING`,
      )
      .run(name, value, toStoredTimestamp(this.clock.now()));
    return result.changes === 1;
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
      .run(key, value, toStoredTimestamp(this.clock.now()));
  }
}
