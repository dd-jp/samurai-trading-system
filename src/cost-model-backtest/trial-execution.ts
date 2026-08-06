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
import { minbtl, windowYears } from './overfitting.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import type { ReplayRunResult } from './replay-driver.js';
import type { BacktestReport } from './types.js';
import type { DateRange } from './universe.js';

/** One bar's duration — the spec's `barMs`=1 day, fixed for the grid run. */
const DAY_MS = 86_400_000;

/**
 * The spec's fixed embargo, in bars, for the 5-fold walk-forward split — sized
 * to the largest `slowWindow` in the grid. The CSCV pass (#406) purges with the
 * same number: it partitions the same window over the same bars, and a second
 * embargo would be a second, undocumented knob.
 */
const EMBARGO_BARS = 50;

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

/** What sizing the grid to the sample decided (#405). */
export interface TrialGridSizing {
  /** The configs that will actually be run. */
  selected: TrialGridEntry[];
  /** MinBTL's cap for this window — the most trials the sample can support. */
  limit: number;
  /** How many the full cross-product asked for. */
  requested: number;
  /** Effective sample length, for the positive statement in the report. */
  years: number;
}

/**
 * Cuts the grid to what the sample can actually support (#405).
 *
 * ## Why this is the binding constraint
 *
 * MinBTL caps the number of independent configurations a sample of a given
 * length can be searched over before the best in-sample Sharpe is expected to
 * be spurious. The 12-config grid was sized against an assumed 5-year sample
 * (cap ~45); the Polygon plan actually serves 2 years, which supports 7. Every
 * run so far reported `{"limit":7,"distinct_configs":12,"exceeded":true}`.
 *
 * The cap was computed at the END and reported as a verdict field, after all
 * 12 trials had run. That is the wrong order: the number exists to CONSTRAIN
 * the search, not to grade it afterwards. And it cut the wrong way once cost
 * calibration took passing configs from 2/24 to 12/24 — with 2 passing,
 * "pick the best" was not a live risk; with 12 on an over-budget grid, it is.
 *
 * ## The subset is spread, not truncated
 *
 * Taking the first N of the cross-product would keep every config from one
 * corner of the parameter space — all the shortest fast/slow windows — and
 * discard the rest. That is not a smaller search, it is a different and
 * narrower one, chosen by array order rather than by design.
 *
 * So the retained configs are sampled EVENLY across the ordered grid. The
 * selection is deterministic (no RNG, no seed) because a reproducible verdict
 * is the whole point of Stage 2: the same window must always yield the same
 * configs, or the gate cannot be re-run to check it.
 */
export function sizeTrialGridToSample(
  entries: TrialGridEntry[],
  window: DateRange,
): TrialGridSizing {
  const { limit } = minbtl(window);
  const years = windowYears(window);
  const requested = entries.length;

  // A window too short to support even ONE configuration must REFUSE, not
  // return an empty selection. `runTrialGrid` over zero configs completes
  // without error and yields zero trials, and a Stage 2 verdict rendered over
  // zero trials has no failing config to report — it reads as a pass. That is
  // the single worst outcome this whole function exists to prevent: the cap is
  // here to make the gate harder to pass, and a bug in it that makes the gate
  // pass vacuously inverts its purpose.
  //
  // Stated honestly: this is UNREACHABLE as `minbtl` is written today — it
  // starts its search at `limit = 1` and only ever increments
  // (overfitting.ts:195), so it cannot return less. The guard is here because
  // nothing in the `{ limit: number }` return type says that, the invariant is
  // one refactor away from being lost, and the failure mode it protects
  // against is silent rather than loud. `< 1` rather than `=== 0` for the same
  // reason: MinBTL is a continuous expression underneath.
  if (limit < 1) {
    throw new Error(
      `sizeTrialGridToSample: MinBTL supports ${limit} configs over a ` +
        `${years.toFixed(2)}-year window, so no grid can be run against it. ` +
        'Widen the window or ingest more history — a verdict over zero trials ' +
        'is not a pass.',
    );
  }

  if (requested <= limit) {
    return { selected: entries, limit, requested, years };
  }

  // Evenly spaced indices across the whole grid, endpoints included, so the
  // retained set spans the parameter space rather than clustering at one end.
  const selected: TrialGridEntry[] = [];
  for (let i = 0; i < limit; i++) {
    const index = limit === 1 ? 0 : Math.round((i * (requested - 1)) / (limit - 1));
    const entry = entries[index];
    // Provably in bounds — `i` runs to `limit - 1` and `limit < requested`
    // here, so `index` never exceeds `requested - 1`. Throwing rather than
    // skipping because a silent skip would make `selected` shorter than
    // `limit` with no signal, and `announceSizing` would then report a grid
    // size that is not the one that ran.
    if (entry === undefined) {
      throw new Error(
        `sizeTrialGridToSample: index ${index} is out of bounds for ${requested} configs ` +
          `at limit ${limit} — the even-spacing arithmetic is wrong.`,
      );
    }
    selected.push(entry);
  }

  return { selected, limit, requested, years };
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

/**
 * The CSCV pass's result for one (config, asset class) pair — the report, or
 * the reason it could not be produced.
 *
 * A refusal rather than a throw, and the one place in this module that does
 * not fail fast. The walk-forward pass answers the OOS-Sharpe kill line and
 * must abort the grid if it breaks (see the `catch` in `runTrialGrid`); the
 * CSCV pass only feeds PBO, and its extra fold is the window's *first* group
 * — the one the walk-forward scheme trains on and never tests. That group
 * carries the indicator warm-up (`slowWindow` up to 50 bars plus
 * `atrWindow`), so it can legitimately contain no closed trades, which makes
 * `computeMetrics` throw on a zero-variance return series. Losing PBO for one
 * asset class is a reportable gap; losing the whole gate run to it is not.
 */
export type CscvOutcome = { report: EvalReport } | { error: string };

/** One (config, asset class) pair's scored result. */
export interface TrialGridResult {
  config_hash: string;
  config: ProxyStrategyConfig;
  asset_class: 'crypto' | 'stocks';
  /** The walk-forward pass — the OOS-Sharpe kill line's source. Always present. */
  report: EvalReport;
  /** The CSCV pass — PBO's source. Present only when `includeCscvPass` was set. */
  cscv?: CscvOutcome;
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
  /**
   * Also score every pair under the `cscv` scheme, populating
   * `TrialGridResult.cscv` — the configs x folds matrix `pbo()` needs (#406).
   *
   * Opt-in, defaulting to off, because it costs a second `evaluate()` per
   * (config, asset class) pair. The Stage 2 gate run wants it; the cost
   * decomposition and its sensitivity ladder re-run the whole grid several
   * times over and read only `killLineChecks`, so paying for it there would
   * double that work for a number nothing reads.
   *
   * The replay is *not* re-run — both passes score the same
   * `ReplayRunResult`, so the strategy's trades are identical and only the
   * partitioning differs. That is what makes the two passes comparable.
   */
  includeCscvPass?: boolean;
  /**
   * Called once with the sizing this run ACTUALLY used, before any trial runs.
   *
   * A callback rather than letting the caller size the grid itself and print
   * from that: `run-stage2.ts` used to call `sizeTrialGridToSample` a second
   * time purely to build its log line, so the number an operator reads and the
   * number that constrained the search were two computations that agreed only
   * by convention. They are pure and take the same window, so they cannot
   * disagree today — but a verdict's audit trail should not rest on "cannot
   * disagree today", and the divergence would be silent if it ever did.
   */
  announceSizing?: (sizing: TrialGridSizing) => void;
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

  // #405: sized from the sample BEFORE any trial runs, not graded afterwards.
  const sizing = sizeTrialGridToSample(buildTrialGrid(), deps.window);
  deps.announceSizing?.(sizing);
  const grid = sizing.selected;
  const results: TrialGridResult[] = [];

  for (const { config, config_hash } of grid) {
    let loggedForSelection = false;

    for (const assetClass of deps.assetClasses) {
      let report: EvalReport;
      let cscv: CscvOutcome | undefined;
      try {
        const runner = assetClass.makeRunner();
        const run = await runner.run(config, deps.window);
        const evaluator = makeEvaluator(run);

        const evalOptions = {
          window: deps.window,
          averageCapital: deps.averageCapital,
          periodsPerYear: assetClass.periodsPerYear,
          embargo: EMBARGO_BARS,
          barMs: DAY_MS,
        };

        report = await evaluator.evaluate({ ...evalOptions, scheme: 'walk_forward' });

        if (deps.includeCscvPass === true) {
          // Refuse rather than throw — see `CscvOutcome`. Scoped tightly to
          // the second evaluate() so it cannot swallow a walk-forward or
          // replay failure, both of which must still abort the grid.
          try {
            cscv = { report: await evaluator.evaluate({ ...evalOptions, scheme: 'cscv' }) };
          } catch (cause) {
            cscv = { error: cause instanceof Error ? cause.message : String(cause) };
          }
        }
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

      results.push({
        config_hash,
        config,
        asset_class: assetClass.asset_class,
        report,
        // Spread rather than `cscv: cscv` — `exactOptionalPropertyTypes` makes
        // an explicit `undefined` a different thing from an absent key, and
        // "the pass was not requested" is absence.
        ...(cscv === undefined ? {} : { cscv }),
      });

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
