/**
 * The config-trial log (ticket #89) — `config_trials`, keyed by config hash.
 * See docs/specs/cost-model-backtest-spec.md ("Config-trial log — the
 * trial-count discipline (load-bearing)") and user story 18.
 *
 * This is what makes N real. DSR and MinBTL both deflate by N, so if N is
 * wrong every overfitting defence above it is theatre — and it can be wrong in
 * both directions. Undercount it (forget to log a config you tried) and a
 * fished-for strategy passes; overcount it (log every *run* rather than every
 * distinct config) and N grows without bound, so DSR/PBO/MinBTL start failing
 * healthy strategies for reasons that have nothing to do with overfitting.
 * The spec is explicit that the second failure would make the spec fight
 * itself.
 *
 * Hence the one rule this module exists to enforce:
 *
 *   **N = distinct configs evaluated *for selection*.** Not runs.
 *
 * Three consequences, all from the spec:
 *   - Re-running the same config adds no trial — dedup by hash.
 *   - FL's periodic revalidation of an already-selected config *reads* N and
 *     never appends: it monitors one frozen config, it is not a new search.
 *   - FL's in-bounds auto-tuning is not a new trial — the guardrail bounds
 *     were part of the config that was validated, so adapting inside them is
 *     not a new selection decision.
 */

import type { BacktestReport } from './types.js';

/**
 * The `config_trials` port. The spec homes the real table in the shared
 * SQLite store, which does not exist yet (no persistence layer is built, and
 * this repo has no runtime dependencies) — so the port is what ships, with
 * the in-memory implementation below. A SQLite-backed implementation of the
 * same port is a later ticket; nothing above this seam changes when it lands.
 */
export interface ConfigTrialLog {
  /**
   * Record one config evaluated **for selection**. Dedups by `config_hash`:
   * calling it again with a hash already logged is a no-op for N.
   *
   * Callers must not call this to revalidate or monitor an already-selected
   * config — see the module header. The dedup makes that harmless for a
   * re-run of the *same* config, but the rule is the caller's to honour: this
   * log cannot tell "evaluating a new config for selection" from "monitoring
   * one" by inspecting the hash.
   */
  recordTrial(config_hash: string, result: BacktestReport): void;

  /** N — the distinct-config count DSR and MinBTL deflate by. */
  distinctTrialCount(): number;

  /** The most recent report logged for a hash, if any. */
  getTrial(config_hash: string): BacktestReport | undefined;
}

/**
 * In-memory `ConfigTrialLog` — a concrete implementation of the port, not a
 * test-only mock, mirroring server/pipeline/trader/fixture-setup-store.ts and
 * server/providers/market-data-service/fixture-data-source.ts.
 */
export class InMemoryConfigTrialLog implements ConfigTrialLog {
  private readonly trials = new Map<string, BacktestReport>();

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

    // Overwrites rather than appends: the latest report for a hash is what a
    // reader wants, and the count is over distinct hashes either way. `set`
    // on an existing key leaves `this.trials.size` — N — untouched, which is
    // exactly the re-run-does-not-inflate-N rule.
    this.trials.set(config_hash, result);
  }

  distinctTrialCount(): number {
    return this.trials.size;
  }

  getTrial(config_hash: string): BacktestReport | undefined {
    return this.trials.get(config_hash);
  }
}
