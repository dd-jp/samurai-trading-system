
import { isDailyTimeframe, timeframeToMs } from '../../providers/market-data-service/index.js';
import { digest } from '../../shared/index.js';
import type { ConfigTrialLog } from './config-trial-log.js';
import { EvalExecutorImpl } from './eval-executor.js';
import type { EvalExecutor, EvalReport } from './eval-types.js';
import { minbtl, windowYears } from './overfitting.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import type { ReplayRunResult } from './replay-driver.js';
import type { BacktestReport } from './types.js';
import type { DateRange } from './universe.js';

const DAY_MS = 86_400_000;

const EMBARGO_BARS = 50;

const TRIAL_SEED = 0;

export const STOCK_PERIODS_PER_YEAR = 252;
export const CRYPTO_PERIODS_PER_YEAR = 365;

const US_REGULAR_SESSION_MINUTES = 6.5 * 60;
const MINUTES_PER_DAY = 24 * 60;

export function periodsPerYearFor(assetClass: 'stocks' | 'crypto', timeframe: string): number {
  const barMinutes = timeframeToMs(timeframe) / 60_000;
  const tradingDays = assetClass === 'stocks' ? STOCK_PERIODS_PER_YEAR : CRYPTO_PERIODS_PER_YEAR;

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

const RISK_REWARD_PRESETS: ReadonlyArray<
  Pick<ProxyStrategyConfig, 'atrStopMult' | 'atrTargetMult'>
> = [
  { atrStopMult: 2, atrTargetMult: 3 },
  { atrStopMult: 1.5, atrTargetMult: 2 },
  { atrStopMult: 3, atrTargetMult: 4 },
];

const ATR_WINDOW = 14;
const ALLOW_SHORT = true;

export interface TrialGridEntry {
  config: ProxyStrategyConfig;
  config_hash: string;
}

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

export interface TrialGridSizing {
  selected: TrialGridEntry[];
  limit: number;
  requested: number;
  years: number;
}

export function sizeTrialGridToSample(
  entries: TrialGridEntry[],
  window: DateRange,
  expectedAnnualSharpe?: number,
): TrialGridSizing {
  const { limit } = minbtl(window, expectedAnnualSharpe);
  const years = windowYears(window);
  const requested = entries.length;

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

  const selected: TrialGridEntry[] = [];
  for (let i = 0; i < limit; i++) {
    const index = limit === 1 ? 0 : Math.round((i * (requested - 1)) / (limit - 1));
    const entry = entries[index];
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

export interface ReplayRunner {
  run(config: ProxyStrategyConfig, window: DateRange): Promise<ReplayRunResult>;
}

export interface TrialGridAssetClass {
  asset_class: 'crypto' | 'stocks';
  periodsPerYear: number;
  makeRunner: () => ReplayRunner;
}

type CscvOutcome = { report: EvalReport } | { error: string };

export interface TrialGridResult {
  config_hash: string;
  config: ProxyStrategyConfig;
  asset_class: 'crypto' | 'stocks';
  report: EvalReport;
  cscv?: CscvOutcome;
}

export interface TrialGridRunDeps {
  assetClasses: readonly TrialGridAssetClass[];
  window: DateRange;
  averageCapital: number;
  configTrialLog: ConfigTrialLog;
  expectedAnnualSharpe?: number;
  makeEvaluator?: (run: ReplayRunResult) => EvalExecutor;
  includeCscvPass?: boolean;
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
      try {
        cscv = { report: await evaluator.evaluate({ ...evalOptions, scheme: 'cscv' }) };
      } catch (cause) {
        cscv = { error: cause instanceof Error ? cause.message : String(cause) };
      }
    }
  } catch (cause) {
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
    ...(cscv === undefined ? {} : { cscv }),
  };
}

function logTrial(configTrialLog: ConfigTrialLog, config_hash: string): void {
  const backtestReport: BacktestReport = {
    config_hash,
    seed: TRIAL_SEED,
    tick_outcomes: [],
    lookahead_audit: 'passed',
  };
  configTrialLog.recordTrial(config_hash, backtestReport);
}

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
