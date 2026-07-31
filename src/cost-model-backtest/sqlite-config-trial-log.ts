/**
 * SQLite-backed `ConfigTrialLog` over the `config_trials` table (#196) — the
 * real store behind `InMemoryConfigTrialLog`, unblocked by the shared store
 * (#193). See docs/specs/shared-sqlite-store-spec.md ("Cost-Model / Backtest
 * Harness" schema section) and docs/specs/cost-model-backtest-spec.md
 * ("Config-trial log — the trial-count discipline").
 *
 * `config_hash` is the table's PRIMARY KEY, so `distinctTrialCount()` is a
 * plain `COUNT(*)` and `recordTrial` is the upsert the spec names
 * (`INSERT ... ON CONFLICT(config_hash) DO UPDATE`) — a re-run of an
 * already-logged config overwrites `result_json`/`seed`/`recorded_at` in
 * place rather than adding a row, which is what keeps N (distinct configs)
 * correct under re-runs per the module header on `config-trial-log.ts`.
 *
 * **`config_json` gap:** the migration's column comment calls it "full
 * BacktestConfig, verbatim", but the `ConfigTrialLog` port `recordTrial`
 * implements (`recordTrial(config_hash, result: BacktestReport)`) is never
 * given a `BacktestConfig` — only its hash and the resulting report. No
 * caller in this codebase holds both today (`eval-executor.ts` does not call
 * this port at all; see `index.ts`'s ticket-by-ticket note on why
 * `BacktestReport.metrics` isn't wired yet). Rather than widen the shared
 * port for a caller that doesn't exist yet, this stores the identity fields
 * the port *does* have (`config_hash`, `seed`) as `config_json`, matching
 * `SqliteSetupStore`'s precedent of documenting a port/schema gap instead of
 * inventing data. Revisit when a real caller (an offline research runner)
 * exists and can supply the full config.
 */

import type { Clock } from '../shared/index.js';
import { SystemClock } from '../shared/index.js';
import type { SharedStore } from '../shared/store/index.js';
import type { ConfigTrialLog } from './config-trial-log.js';
import type { BacktestReport } from './types.js';

interface ConfigTrialRow {
  result_json: string;
}

export class SqliteConfigTrialLog implements ConfigTrialLog {
  constructor(
    private readonly db: SharedStore,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  recordTrial(config_hash: string, result: BacktestReport): void {
    if (config_hash.length === 0) {
      throw new Error('recordTrial: config_hash must not be empty — it is the trial identity.');
    }

    if (result.config_hash !== config_hash) {
      throw new Error(
        `recordTrial: report config_hash '${result.config_hash}' does not match the key ` +
          `'${config_hash}'. A trial logged under the wrong key corrupts N.`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO config_trials (config_hash, seed, config_json, result_json, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(config_hash) DO UPDATE SET
           seed = excluded.seed,
           config_json = excluded.config_json,
           result_json = excluded.result_json,
           recorded_at = excluded.recorded_at`,
      )
      .run(
        config_hash,
        result.seed,
        JSON.stringify({ config_hash, seed: result.seed }),
        JSON.stringify(result),
        this.clock.now().toISOString(),
      );
  }

  /** N — a plain COUNT(*), distinct by construction via the `config_hash` PK. */
  distinctTrialCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM config_trials').get() as {
      count: number;
    };
    return row.count;
  }

  /**
   * Read-only lookup — FL's revalidation path (spec: "must read `config_trials`
   * directly ... and must never call `recordTrial`") calls exactly this.
   */
  getTrial(config_hash: string): BacktestReport | undefined {
    const row = this.db
      .prepare('SELECT result_json FROM config_trials WHERE config_hash = ?')
      .get(config_hash) as ConfigTrialRow | undefined;

    return row === undefined ? undefined : (JSON.parse(row.result_json) as BacktestReport);
  }
}
