/**
 * Stage 2 trial grid execution (ticket #244) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Trial Execution")
 * and wayfinder map #154 (decisions #159, #160).
 *
 * Runs the 12-config grid (`buildTrialGrid`) through the replay driver (#243)
 * and `EvalExecutorImpl` (#90), logging every config exactly once in
 * `ConfigTrialLog` (#89) by its `config_hash` — the trial count the Verdict
 * module (#245) deflates DSR/PBO/MinBTL by. Nothing here computes a metric or
 * generates a split of its own: it calls the seams those tickets already ship
 * (`ReplayDriver.run`, `EvalExecutorImpl.evaluate`, `ConfigTrialLog.recordTrial`)
 * in the sequence the spec's Trial Execution module describes.
 *
 * **12 configs, not 12 reports.** `config_hash` is a function of
 * `ProxyStrategyConfig` alone — it does not fold in asset class — so N (the
 * distinct-trial count) stays 12 regardless of how many asset classes are
 * evaluated. `recordTrial` is therefore called exactly once per config,
 * whichever asset class loop iteration reaches it first; a re-run of the same
 * config for a second asset class would be a no-op for N anyway (the log's own
 * dedup-by-hash contract), but calling it twice per config is avoided here so
 * the "logged exactly once" acceptance criterion holds literally, not just by
 * the log tolerating it. The *report* count is `12 × (asset classes present)`
 * — a stock-only run yields exactly 12 `EvalReport`s, a stock+crypto run 24 —
 * because stock and crypto trades are annualized differently (252 vs 365
 * periods/year) and mixing them into one return series would misannualize
 * both (spec, "Module: Trial Execution").
 *
 * **A fresh `ReplayRunner` per (config, asset class) pair.** `ReplayDriver`
 * steps its injected `SimulatedClock` forward across a `run()` call and never
 * resets it (replay-driver.ts: `RunState` is rebuilt per run, but `clock`
 * lives on `deps` and is not). Re-running the *same* driver instance for a
 * second config over the same window would `advanceTo` backwards on step one
 * and throw. `TrialGridAssetClass.makeRunner` is therefore a factory, called
 * once per config, so every run gets a clock that starts fresh at the window.
 *
 * **All 12 configs, and every asset class, see identical inputs** — same
 * window, same `averageCapital`. PBO (#245) ranks configs against each other
 * on their fold Sharpes; a per-config denominator would make that ranking
 * arithmetic rather than a real comparison.
 */

import { digest } from '../orchestrator/index.js';
import type { ConfigTrialLog } from './config-trial-log.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { EvalExecutor, EvalReport } from './eval-types.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import type { ReplayRunResult } from './replay-driver.js';
import type { BacktestReport } from './types.js';
import type { DateRange } from './universe.js';

/** One bar's duration — the spec's `barMs`=1 day, fixed for the grid run. */
const DAY_MS = 86_400_000;

/** The spec's fixed embargo, in bars, for the 5-fold walk-forward split. */
const WALK_FORWARD_EMBARGO_BARS = 50;

/**
 * This path has no stochastic consumer (`types.ts`: the only seeded mode is
 * `CostModel`'s opt-in slippage, which #87 does not implement) — a fixed seed
 * is recorded for the trial's identity, not per-config, since nothing here
 * varies by it.
 */
const TRIAL_SEED = 0;

export const STOCK_PERIODS_PER_YEAR = 252;
export const CRYPTO_PERIODS_PER_YEAR = 365;

const FAST_WINDOWS = [10, 20] as const;
const SLOW_WINDOWS = [30, 50] as const;

/** The three paired risk:reward presets — stop:target multipliers of ATR. */
const RISK_REWARD_PRESETS: ReadonlyArray<
  Pick<ProxyStrategyConfig, 'atrStopMult' | 'atrTargetMult'>
> = [
  { atrStopMult: 2, atrTargetMult: 3 },
  { atrStopMult: 1.5, atrTargetMult: 2 },
  { atrStopMult: 3, atrTargetMult: 4 },
];

/** Fixed across all 12 configs (spec, "Module: Trial Execution"). */
const ATR_WINDOW = 14;
const ALLOW_SHORT = true;

/** One grid config, paired with its trial identity. */
export interface TrialGridEntry {
  config: ProxyStrategyConfig;
  /** Function of `config` alone — see this module's header on why. */
  config_hash: string;
}

/**
 * The documented 12-config cross-product: `fastWindow` × `slowWindow` × the
 * three paired risk:reward presets, `atrWindow`/`allowShort` fixed. See the
 * grid-generation test for the regression guard on this exact set (the spec's
 * testing decision: silently adding or dropping a config changes N without
 * anyone noticing).
 */
export function buildTrialGrid(): TrialGridEntry[] {
  const entries: TrialGridEntry[] = [];

  for (const fastWindow of FAST_WINDOWS) {
    for (const slowWindow of SLOW_WINDOWS) {
      for (const preset of RISK_REWARD_PRESETS) {
        const config: ProxyStrategyConfig = {
          fastWindow,
          slowWindow,
          atrWindow: ATR_WINDOW,
          atrStopMult: preset.atrStopMult,
          atrTargetMult: preset.atrTargetMult,
          allowShort: ALLOW_SHORT,
        };
        entries.push({ config, config_hash: digest(config) });
      }
    }
  }

  return entries;
}

/** The subset of `ReplayDriver`'s public API this module drives. */
export interface ReplayRunner {
  run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult>;
}

/** One asset class's replay universe and annualization base. */
export interface TrialGridAssetClass {
  asset_class: 'crypto' | 'stocks';
  /** 252 for stocks, 365 for crypto (`STOCK_PERIODS_PER_YEAR`/`CRYPTO_PERIODS_PER_YEAR`). */
  periodsPerYear: number;
  /**
   * Builds a fresh `ReplayRunner`, called once per config — see this module's
   * header on why a shared instance across configs is unsafe.
   */
  makeRunner: () => ReplayRunner;
}

/** One (config, asset class) pair's scored result. */
export interface TrialGridResult {
  config_hash: string;
  config: ProxyStrategyConfig;
  asset_class: 'crypto' | 'stocks';
  report: EvalReport;
}

export interface TrialGridRunDeps {
  /** Evaluated independently, in the order given — see this module's header. */
  assetClasses: readonly TrialGridAssetClass[];
  window: DateRange;
  averageCapital: number;
  configTrialLog: ConfigTrialLog;
  /**
   * Defaults to `EvalExecutorImpl` over the replay's own trade source and
   * timeline — the spec's "uses existing seams unchanged". Overridable only
   * so tests can isolate this module's wiring from a real replay+eval run.
   */
  makeEvaluator?: (run: ReplayRunResult) => EvalExecutor;
}

/**
 * Runs the full 12-config grid across every supplied asset class, scoring
 * each via `EvalExecutorImpl.evaluate` with the spec's fixed 5-fold
 * walk-forward split, and logs each config exactly once in `ConfigTrialLog`.
 *
 * Returns one `TrialGridResult` per (config × asset class) pair, in grid
 * order — the form #245 (Verdict) reads to build its configs×folds matrix,
 * per asset class.
 */
export async function runTrialGrid(deps: TrialGridRunDeps): Promise<TrialGridResult[]> {
  if (deps.assetClasses.length === 0) {
    throw new Error(
      'runTrialGrid: at least one asset-class universe is required — there is nothing to evaluate.',
    );
  }

  const makeEvaluator =
    deps.makeEvaluator ??
    ((run: ReplayRunResult) =>
      new EvalExecutorImpl({ source: run.trades, timeline: run.timeline }));

  const grid = buildTrialGrid();
  const results: TrialGridResult[] = [];

  for (const { config, config_hash } of grid) {
    let loggedForSelection = false;

    for (const assetClass of deps.assetClasses) {
      let report: EvalReport;
      try {
        const runner = assetClass.makeRunner();
        const run = await runner.run(config, deps.window);
        const evaluator = makeEvaluator(run);

        report = await evaluator.evaluate({
          window: deps.window,
          averageCapital: deps.averageCapital,
          periodsPerYear: assetClass.periodsPerYear,
          scheme: 'walk_forward',
          embargo: WALK_FORWARD_EMBARGO_BARS,
          barMs: DAY_MS,
        });
      } catch (cause) {
        // Deliberately fail-fast, not fail-soft: catching here and continuing
        // to the next config would silently shrink the grid below 12
        // configs/asset class, which #245 (Verdict) reads as the trial count
        // N it deflates DSR/PBO/MinBTL by. A shrunk N understates deflation —
        // an optimistic bias in the overfitting verdict — and a missing row
        // breaks the configs×folds matrix PBO ranks configs against each
        // other on (see this module's header). Swallowing `run()` failures
        // would also swallow `LookaheadViolationError`, the one error this
        // harness exists to surface, undermining the `lookahead_audit:
        // 'passed'` attestation below (which is only honest because `run()`
        // did not throw). What *is* a real gap in the thrown error — no
        // config identity — is fixed here: rethrow with that context
        // attached via `cause`, still aborting the whole grid.
        throw new Error(
          `runTrialGrid: failed on config_hash=${config_hash} ` +
            `(fastWindow=${config.fastWindow}, slowWindow=${config.slowWindow}, ` +
            `atrStopMult=${config.atrStopMult}, atrTargetMult=${config.atrTargetMult}), ` +
            `asset_class=${assetClass.asset_class} — aborting grid rather than ` +
            `returning a partial/misleading result set.`,
          { cause },
        );
      }

      results.push({ config_hash, config, asset_class: assetClass.asset_class, report });

      // Exactly once per config, regardless of how many asset classes it is
      // scored against — see this module's header ("12 configs, not 12
      // reports").
      if (!loggedForSelection) {
        const backtestReport: BacktestReport = {
          config_hash,
          seed: TRIAL_SEED,
          // No `TickOutcome`s: this path bypasses the Orchestrator's
          // Scheduler/TickRunner entirely (replay-driver.ts), so there is no
          // per-instrument-pass trace to carry. `ConfigTrialLog` only needs
          // the report to identify the trial and attest the run's honesty —
          // matching the log's own test fixture precedent
          // (config-trial-log.test.ts).
          tick_outcomes: [],
          // An attestation the auditor earned by not throwing: `run()` above
          // completed without a `LookaheadViolationError`.
          lookahead_audit: 'passed',
        };
        deps.configTrialLog.recordTrial(config_hash, backtestReport);
        loggedForSelection = true;
      }
    }
  }

  return results;
}
