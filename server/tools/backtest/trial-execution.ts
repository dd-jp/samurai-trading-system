/**
 * Stage 2 trial grid execution — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Trial Execution").
 *
 * Runs the 12-config grid (`buildTrialGrid`) through the replay driver and
 * `EvalExecutorImpl`, logging every config exactly once in `ConfigTrialLog`
 * by its `config_hash` — the trial count the Verdict module deflates
 * DSR/PBO/MinBTL by. Nothing here computes a metric or generates a split of
 * its own: it calls the seams those tickets already ship
 * (`ReplayDriver.run`, `EvalExecutorImpl.evaluate`, `ConfigTrialLog.recordTrial`)
 * in the sequence the spec describes.
 *
 * 12 configs, not 12 reports: `config_hash` is a function of
 * `ProxyStrategyConfig` alone — it does not fold in asset class — so N (the
 * distinct-trial count) stays 12 regardless of how many asset classes are
 * evaluated. `recordTrial` is called exactly once per config, whichever
 * asset class loop iteration reaches it first. The report count is
 * `12 × (asset classes present)` — a stock-only run yields 12 `EvalReport`s,
 * a stock+crypto run 24 — because stock and crypto trades are annualized
 * differently (252 vs 365 periods/year) and mixing them into one return
 * series would misannualize both.
 *
 * A fresh `ReplayRunner` per (config, asset class) pair: `ReplayDriver`
 * steps its injected `SimulatedClock` forward across a `run()` call and
 * never resets it, so re-running the same driver instance for a second
 * config over the same window would `advanceTo` backwards on step one and
 * throw. `TrialGridAssetClass.makeRunner` is a factory, called once per
 * config, so every run gets a clock that starts fresh at the window.
 *
 * All 12 configs, and every asset class, see identical inputs — same
 * window, same `averageCapital`. PBO ranks configs against each other on
 * their fold Sharpes; a per-config denominator would make that ranking
 * arithmetic rather than a real comparison.
 */

import { digest } from '../../apps/orchestrator/index.js';
import { isDailyTimeframe, timeframeToMs } from '../../providers/market-data-service/index.js';
import type { ConfigTrialLog } from './config-trial-log.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { EvalExecutor, EvalReport } from './eval-types.js';
import { minbtl, windowYears } from './overfitting.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import type { ReplayRunResult } from './replay-driver.js';
import type { BacktestReport } from './types.js';
import type { DateRange } from './universe.js';

/** One bar's duration — the spec's `barMs`=1 day, fixed for the grid run */
const DAY_MS = 86_400_000;

/**
 * The spec's fixed embargo, in bars, for the 5-fold walk-forward split —
 * sized to the largest `slowWindow` in the grid. The CSCV pass purges with
 * the same number: it partitions the same window over the same bars, and a
 * second embargo would be a second, undocumented knob.
 */
const EMBARGO_BARS = 50;

/**
 * This path has no stochastic consumer (`types.ts`: the only seeded mode is
 * `CostModel`'s opt-in slippage, which this harness does not implement) — a
 * fixed seed is recorded for the trial's identity, not per-config, since
 * nothing here varies by it
 */
const TRIAL_SEED = 0;

export const STOCK_PERIODS_PER_YEAR = 252;
export const CRYPTO_PERIODS_PER_YEAR = 365;

/** US cash-session length in minutes — 09:30 to 16:00 ET */
const US_REGULAR_SESSION_MINUTES = 6.5 * 60;
const MINUTES_PER_DAY = 24 * 60;

/**
 * How many bars of `timeframe` an asset class prints in a year.
 *
 * `periodsPerYear` is the annualization base for every Sharpe, Sortino and
 * Calmar in the suite — `sharpe_annual = sharpe_per_period * sqrt(periodsPerYear)`.
 * The two constants above are daily bar counts; used unadjusted against a
 * non-daily timeframe they'd be wrong by ~sqrt(390) on a 1-minute replay,
 * silently understating every annualized metric rather than failing loudly.
 *
 * Regular hours only for stocks, deliberately: `FreeStackAggregatesClient`
 * requests no `feed`/extended-hours parameter, so what Alpaca serves for an
 * equity is the regular session. Overstating the bar count would overstate
 * the annualized Sharpe, the dangerous direction.
 */
export function periodsPerYearFor(assetClass: 'stocks' | 'crypto', timeframe: string): number {
  const barMinutes = timeframeToMs(timeframe) / 60_000;
  const tradingDays = assetClass === 'stocks' ? STOCK_PERIODS_PER_YEAR : CRYPTO_PERIODS_PER_YEAR;

  // A day-grained bar is one bar per trading day whatever the venue's
  // session length — the arithmetic below would divide a 6.5-hour session
  // by a 24-hour bar and report 0.27 stock bars a year
  if (isDailyTimeframe(timeframe)) return tradingDays;

  const sessionMinutes = assetClass === 'stocks' ? US_REGULAR_SESSION_MINUTES : MINUTES_PER_DAY;

  if (barMinutes > sessionMinutes) {
    throw new Error(
      `periodsPerYearFor: a '${timeframe}' bar is longer than the ${assetClass} session ` +
        `(${sessionMinutes} minutes), so it cannot be counted per session. Use a day-grained ` +
        'timeframe, or state the annualization base explicitly.',
    );
  }

  return tradingDays * (sessionMinutes / barMinutes);
}

const FAST_WINDOWS = [10, 20] as const;
const SLOW_WINDOWS = [30, 50] as const;

/** The three paired risk:reward presets — stop:target multipliers of ATR */
const RISK_REWARD_PRESETS: ReadonlyArray<
  Pick<ProxyStrategyConfig, 'atrStopMult' | 'atrTargetMult'>
> = [
  { atrStopMult: 2, atrTargetMult: 3 },
  { atrStopMult: 1.5, atrTargetMult: 2 },
  { atrStopMult: 3, atrTargetMult: 4 },
];

/** Fixed across all 12 configs (spec, "Module: Trial Execution") */
const ATR_WINDOW = 14;
const ALLOW_SHORT = true;

/** One grid config, paired with its trial identity */
export interface TrialGridEntry {
  config: ProxyStrategyConfig;
  /** Function of `config` alone — see this module's header on why */
  config_hash: string;
}

/**
 * The documented 12-config cross-product: `fastWindow` × `slowWindow` × the
 * three paired risk:reward presets, `atrWindow`/`allowShort` fixed. See the
 * grid-generation test for the regression guard on this exact set —
 * silently adding or dropping a config changes N without anyone noticing.
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

/** What sizing the grid to the sample decided */
export interface TrialGridSizing {
  /** The configs that will actually be run */
  selected: TrialGridEntry[];
  /** MinBTL's cap for this window — the most trials the sample can support */
  limit: number;
  /** How many the full cross-product asked for */
  requested: number;
  /** Effective sample length, for the positive statement in the report */
  years: number;
}

/**
 * Cuts the grid to what the sample can actually support.
 *
 * MinBTL caps the number of independent configurations a sample of a given
 * length can be searched over before the best in-sample Sharpe is expected
 * to be spurious. The 12-config grid was sized against an assumed 5-year
 * sample (cap ~45); the Polygon plan actually serves 2 years, which
 * supports 7.
 *
 * The cap must constrain the search, not grade it afterwards — computing
 * it only at the end, after all 12 trials had run, let "pick the best"
 * become a live risk once cost calibration took passing configs from 2/24
 * to 12/24.
 *
 * The subset is spread, not truncated: taking the first N of the
 * cross-product would keep every config from one corner of the parameter
 * space and discard the rest — a narrower search chosen by array order,
 * not by design. So the retained configs are sampled evenly across the
 * ordered grid, deterministically (no RNG, no seed), since a reproducible
 * verdict is the whole point of Stage 2.
 */
export function sizeTrialGridToSample(
  entries: TrialGridEntry[],
  window: DateRange,
  /**
   * E[SR] for the MinBTL cap — see `overfitting.ts`'s
   * `MINBTL_TARGET_ANNUAL_SHARPE` doc comment. Defaults to that constant
   * (1.0); pass a different value to size the grid against a different
   * stated assumption. Which E[SR] is operative is a judgement call
   * reserved for the repo owner — this parameter only makes the choice
   * explicit rather than hardcoded.
   */
  expectedAnnualSharpe?: number,
): TrialGridSizing {
  const { limit } = minbtl(window, expectedAnnualSharpe);
  const years = windowYears(window);
  const requested = entries.length;

  // A window too short to support even ONE configuration must REFUSE, not
  // return an empty selection: a Stage 2 verdict over zero trials has no
  // failing config to report, so it reads as a pass — the one outcome this
  // function exists to prevent. This branch is unreachable as `minbtl` is
  // written today (its search starts at `limit = 1` and only increments), but
  // nothing in the `{ limit: number }` return type guarantees that, and this
  // function is exported, so an empty input grid is a real path to the same
  // failure
  if (requested < 1) {
    throw new Error(
      'sizeTrialGridToSample: an empty grid cannot be sized — there is nothing to run, ' +
        'and a Stage 2 verdict over zero trials has no failing config to report, so it ' +
        'reads as a pass.',
    );
  }

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
  // retained set spans the parameter space rather than clustering at one end
  const selected: TrialGridEntry[] = [];
  for (let i = 0; i < limit; i++) {
    const index = limit === 1 ? 0 : Math.round((i * (requested - 1)) / (limit - 1));
    const entry = entries[index];
    // Provably in bounds (`i < limit < requested`), so this should never
    // fire. Throwing rather than skipping: a silent skip would make
    // `selected` shorter than `limit` with no signal, and `announceSizing`
    // would report a grid size that is not the one that ran
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

/** The subset of `ReplayDriver`'s public API this module drives */
export interface ReplayRunner {
  run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult>;
}

/** One asset class's replay universe and annualization base */
export interface TrialGridAssetClass {
  asset_class: 'crypto' | 'stocks';
  /** 252 for stocks, 365 for crypto (`STOCK_PERIODS_PER_YEAR`/`CRYPTO_PERIODS_PER_YEAR`) */
  periodsPerYear: number;
  /**
   * Builds a fresh `ReplayRunner`, called once per config — see this module's
   * header on why a shared instance across configs is unsafe
   */
  makeRunner: () => ReplayRunner;
}

/**
 * The CSCV pass's result for one (config, asset class) pair — the report, or
 * the reason it could not be produced.
 *
 * A refusal rather than a throw, unlike the walk-forward pass (which must
 * abort the grid — see the `catch` in `runTrialGrid`): CSCV's extra fold is
 * the window's first group, which the walk-forward scheme never tests and
 * which can legitimately hold no closed trades during indicator warm-up,
 * making `computeMetrics` throw on a zero-variance series. Losing PBO for one
 * asset class is a reportable gap, not grounds to lose the whole gate run.
 */
type CscvOutcome = { report: EvalReport } | { error: string };

/** One (config, asset class) pair's scored result */
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
  /** Evaluated independently, in the order given — see this module's header */
  assetClasses: readonly TrialGridAssetClass[];
  window: DateRange;
  averageCapital: number;
  configTrialLog: ConfigTrialLog;
  /**
   * E[SR] for the MinBTL grid-sizing cap, forwarded to
   * `sizeTrialGridToSample`. Defaults to `MINBTL_TARGET_ANNUAL_SHARPE` (1.0)
   * if omitted — see that constant's doc comment in `overfitting.ts`. Which
   * E[SR] is operative is the repo owner's call; this only makes the
   * assumption a stated one instead of a hardcoded one.
   */
  expectedAnnualSharpe?: number;
  /**
   * Defaults to `EvalExecutorImpl` over the replay's own trade source and
   * timeline — the spec's "uses existing seams unchanged". Overridable only
   * so tests can isolate this module's wiring from a real replay+eval run.
   */
  makeEvaluator?: (run: ReplayRunResult) => EvalExecutor;
  /**
   * Also score every pair under the `cscv` scheme, populating
   * `TrialGridResult.cscv` — the configs x folds matrix `pbo()` needs.
   *
   * Opt-in, defaulting to off, because it costs a second `evaluate()` per
   * (config, asset class) pair — worth paying for the Stage 2 gate run, but
   * not for the cost decomposition and its sensitivity ladder, which re-run
   * the whole grid several times over and read only `killLineChecks`.
   *
   * The replay is not re-run: both passes score the same `ReplayRunResult`,
   * so the strategy's trades are identical and only the partitioning
   * differs — that is what makes the two passes comparable.
   */
  includeCscvPass?: boolean;
  /**
   * Called once with the sizing this run actually used, before any trial runs.
   *
   * A callback rather than letting the caller size the grid itself and print
   * from that: a second, separate call to `sizeTrialGridToSample` for a log
   * line would let the number an operator reads and the number that
   * constrained the search silently diverge — a verdict's audit trail
   * should not rest on the two staying in sync by convention.
   */
  announceSizing?: (sizing: TrialGridSizing) => void;
}

async function runOneAssetClassTrial(
  config: ProxyStrategyConfig,
  config_hash: string,
  assetClass: TrialGridAssetClass,
  deps: TrialGridRunDeps,
  makeEvaluator: (run: ReplayRunResult) => EvalExecutor,
): Promise<TrialGridResult> {
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
      // replay failure, both of which must still abort the grid
      try {
        cscv = { report: await evaluator.evaluate({ ...evalOptions, scheme: 'cscv' }) };
      } catch (cause) {
        cscv = { error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
  } catch (cause) {
    // Deliberately fail-fast, not fail-soft: catching here and continuing to
    // the next config would silently shrink the grid below 12 configs/asset
    // class, the trial count N that Verdict deflates DSR/PBO/MinBTL by — a
    // shrunk N understates deflation, and a missing row breaks the
    // configs×folds matrix PBO ranks configs on. Swallowing `run()` failures
    // would also swallow `LookaheadViolationError`, the one error this
    // harness exists to surface, undermining the `lookahead_audit: 'passed'`
    // attestation below. Rethrow with config identity attached via `cause`,
    // still aborting the whole grid
    throw new Error(
      `runTrialGrid: failed on config_hash=${config_hash} ` +
        `(fastWindow=${config.fastWindow}, slowWindow=${config.slowWindow}, ` +
        `atrStopMult=${config.atrStopMult}, atrTargetMult=${config.atrTargetMult}), ` +
        `asset_class=${assetClass.asset_class} — aborting grid rather than ` +
        `returning a partial/misleading result set.`,
      { cause },
    );
  }

  return {
    config_hash,
    config,
    asset_class: assetClass.asset_class,
    report,
    // Spread rather than `cscv: cscv` — `exactOptionalPropertyTypes` makes
    // an explicit `undefined` a different thing from an absent key, and
    // "the pass was not requested" is absence
    ...(cscv === undefined ? {} : { cscv }),
  };
}

/**
 * Logs `config_hash` in `ConfigTrialLog` — called exactly once per config,
 * regardless of how many asset classes it is scored against (see this
 * module's header, "12 configs, not 12 reports")
 */
function logTrial(configTrialLog: ConfigTrialLog, config_hash: string): void {
  const backtestReport: BacktestReport = {
    config_hash,
    seed: TRIAL_SEED,
    // No `TickOutcome`s: this path bypasses the Orchestrator's
    // Scheduler/TickRunner entirely (replay-driver.ts), so there is no
    // per-instrument-pass trace to carry — `ConfigTrialLog` only needs the
    // report to identify the trial and attest the run's honesty
    tick_outcomes: [],
    // An attestation the auditor earned by not throwing: `run()` above
    // completed without a `LookaheadViolationError`
    lookahead_audit: 'passed',
  };
  configTrialLog.recordTrial(config_hash, backtestReport);
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

  // Sized from the sample before any trial runs, not graded afterwards
  const sizing = sizeTrialGridToSample(buildTrialGrid(), deps.window, deps.expectedAnnualSharpe);
  deps.announceSizing?.(sizing);
  const grid = sizing.selected;
  const results: TrialGridResult[] = [];

  for (const { config, config_hash } of grid) {
    let loggedForSelection = false;

    for (const assetClass of deps.assetClasses) {
      const result = await runOneAssetClassTrial(
        config,
        config_hash,
        assetClass,
        deps,
        makeEvaluator,
      );
      results.push(result);

      if (!loggedForSelection) {
        logTrial(deps.configTrialLog, config_hash);
        loggedForSelection = true;
      }
    }
  }

  return results;
}
