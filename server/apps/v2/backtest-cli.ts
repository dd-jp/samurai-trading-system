import { readFileSync } from 'node:fs';
import type { MarketData } from '../../../contracts/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { readSeededFile, SystemClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { errorStack, runWhenInvoked } from '../../tools/cli-entrypoint.js';
import {
  VOL_TARGET_TRIAL_CANDIDATE_ID,
  VOL_TARGET_TRIAL_EMBARGO,
  VOL_TARGET_TRIAL_FOLDS,
  VOL_TARGET_TRIAL_FROM,
  VOL_TARGET_TRIAL_OUT_OF_SAMPLE_FROM,
  VOL_TARGET_TRIAL_SIZING,
  VOL_TARGET_TRIAL_START_CAPITAL_GBP,
  VOL_TARGET_TRIAL_TO,
  type VolTargetTrialArms,
  volTargetTrialArms,
} from './arm2-backtest.js';
import {
  ARM2_UK_POOL_CANDIDATE_ID,
  ARM2_UK_POOL_FROM,
  ARM2_UK_POOL_NAMES_AS_OF,
  ARM2_UK_POOL_OUT_OF_SAMPLE_FROM,
  ARM2_UK_POOL_START_CAPITAL_GBP,
  ARM2_UK_POOL_TO,
  type Arm2UkPoolArms,
  type Arm2UkPoolPassRule,
  type Arm2UkPoolVerdict,
  arm2UkPoolArms,
  arm2UkPoolPassRule,
  arm2UkPoolVerdict,
  assertArm2UkPoolRunReady,
  assertUkBarsReach,
  ukPoolCatalogue,
} from './arm2-uk-pool.js';
import {
  type BacktestInput,
  type BacktestResult,
  type BacktestTrial,
  backtestSessions,
  runBacktest,
  simulateBacktest,
} from './backtest.js';
import {
  type OneBarDelay,
  type RandomEntries,
  type TrialSeries,
  walkForwardRanges,
} from './backtest-verdict.js';
import { CanaryLog } from './canary-log.js';
import {
  baselinePicksAt,
  type CostStressed,
  type CostStressedResult,
  candidateOutcome,
  costStress,
  trialOutcome,
  withCostStress,
} from './cost-stress.js';
import {
  BarsMarketData,
  type BarsSource,
  CALENDAR_REFERENCE,
  CfdCatalogueArchive,
  calendarReferenceFor,
  currentConstituents,
  type DataSanityReport,
  dataSanity,
  loadCfdCatalogueArchive,
  MultiVenueBarsSource,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
  venueDataSanity,
} from './data/index.js';
import { minbtl, type RegimeSplit } from './evidence/index.js';
import {
  CONSTITUENTS_PATH,
  FX_PATH,
  halfSpreadLookup,
  SAXO_SPREADS_PATH,
  SPREADS_PATH,
  V2_STORE_PATH,
  venueOf,
} from './index.js';
import { delayedBars, delayedTrial } from './look-ahead-canary.js';
import {
  ARM2_UK_POOL_RUN_READY,
  CROSS_ASSET_TREND_CANDIDATE_ID,
  CROSS_ASSET_TREND_FROM,
  CROSS_ASSET_TREND_TIDMS,
  CROSS_ASSET_TREND_TO,
  createCrossAssetTrendBenchmarkSleeve,
  createCrossAssetTrendSleeve,
  createMeanReversionBenchmarkSleeve,
  createMeanReversionSleeve,
  createVolTargetIndexBenchmarkSleeve,
  createVolTargetIndexSleeve,
  MEAN_REVERSION_CANDIDATE_ID,
  MEAN_REVERSION_ENTRY_THRESHOLDS,
  MEAN_REVERSION_FROM,
  MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
  MEAN_REVERSION_TO,
  type Parameter,
  pooledUniverse,
  requireSet,
  UK_STOCK_SCREENS,
  VOL_TARGET_INDEX_ATR_WINDOW,
  VOL_TARGET_INDEX_CANDIDATE_ID,
  VOL_TARGET_INDEX_CEILINGS,
  VOL_TARGET_INDEX_FROM,
  VOL_TARGET_INDEX_LOOKBACK_BARS,
  VOL_TARGET_INDEX_TIDMS,
  VOL_TARGET_INDEX_TO,
  VOL_TARGET_INDEX_VOL_WINDOW,
} from './signal/index.js';
import { researchStorePath, sessionBLedger, TrialLedger } from './trial-ledger.js';
import { type VolTargetVerdict, volTargetVerdict } from './vol-target-verdict.js';

// Backtest-only assumptions (doc 66 D8 exempts smoke.ts's SMOKE_* the same way): the actual
// yearly capital config David sets is not consulted here — a backtest run always sizes off a
// fixed, reproducible starting point
const BACKTEST_START_CAPITAL_GBP = 2_000;
// #1785 candidate 3 ruling (d), 2026-10-02: the £10,000 paper start capital of 2026-09-30
const VOL_TARGET_INDEX_START_CAPITAL_GBP = 10_000;
const BACKTEST_LOSS_CAP_GBP = 1_500;
const WALK_FORWARD_FOLDS = 16;
const COST_STRESS_MULTIPLE = 2;
const MINBTL_EXPECTED_ANNUAL_SHARPE = 0.6;

export interface BacktestCliOptions {
  readonly storePath?: string;
  readonly barStoreRoot?: string;
  readonly fxPath?: string;
  readonly spreadsPath?: string;
  readonly saxoSpreadsPath?: string;
  readonly constituentsPath?: string;
  readonly cfdSnapshotStorePath?: string;
  readonly logger?: Logger;
}

export interface CandidateRunReport {
  readonly baseline: CostStressedResult;
  readonly stressed: BacktestResult;
  readonly trialsCounted: number;
  readonly minbtlLimit: number;
  readonly windowYears: number;
  readonly signFlipped: boolean;
  readonly regimeSplit: RegimeSplit;
  readonly oneBarDelay: OneBarDelay | null;
  readonly randomEntries: RandomEntries | null;
  readonly dataSanity: DataSanityReport;
}
export type CrossAssetTrendRunReport = CandidateRunReport;
export type MeanReversionRunReport = CandidateRunReport;
export type VolTargetIndexRunReport = CandidateRunReport;

const SILENT_LOGGER: Logger = { log: (_entry: LogEntry) => undefined };

interface ResolvedCliOptions {
  readonly root: string;
  readonly fxPath: string;
  readonly spreadsPath: string;
  readonly saxoSpreadsPath: string;
  readonly constituentsPath: string;
  readonly storePath: string;
  readonly logger: Logger;
}

export function resolveCliOptions(options: BacktestCliOptions): ResolvedCliOptions {
  return {
    root: options.barStoreRoot ?? DEFAULT_BAR_STORE_ROOT,
    fxPath: options.fxPath ?? FX_PATH,
    spreadsPath: options.spreadsPath ?? SPREADS_PATH,
    saxoSpreadsPath: options.saxoSpreadsPath ?? SAXO_SPREADS_PATH,
    constituentsPath: options.constituentsPath ?? CONSTITUENTS_PATH,
    storePath: options.storePath ?? researchStorePath(),
    logger: options.logger ?? SILENT_LOGGER,
  };
}

export interface CandidateWindow {
  readonly from: string;
  readonly to: string;
}
export type CrossAssetTrendWindow = CandidateWindow;

const CROSS_ASSET_TREND_WINDOW: CandidateWindow = {
  from: CROSS_ASSET_TREND_FROM,
  to: CROSS_ASSET_TREND_TO,
};
const MEAN_REVERSION_WINDOW: CandidateWindow = {
  from: MEAN_REVERSION_FROM,
  to: MEAN_REVERSION_TO,
};
const VOL_TARGET_INDEX_WINDOW: CandidateWindow = {
  from: VOL_TARGET_INDEX_FROM,
  to: VOL_TARGET_INDEX_TO,
};

interface CandidateRunSpec {
  readonly candidate: string;
  readonly trials: (bars: BarsSource) => readonly BacktestTrial[];
  readonly benchmark: BacktestInput['benchmark'];
  readonly window: CandidateWindow;
  readonly calendarReference: string;
  readonly symbolsOn: (session: string) => readonly string[];
  readonly embargo?: number;
  readonly startCapitalGbp?: number;
}

export interface ResearchLogs {
  readonly ledger: TrialLedger;
  readonly canaries: CanaryLog;
  readonly randomCanaryRuns?: number | undefined;
}

function windowLength(window: CandidateWindow): { minbtlLimit: number; windowYears: number } {
  const start = new Date(`${window.from}T00:00:00.000Z`);
  const end = new Date(`${window.to}T00:00:00.000Z`);
  return {
    minbtlLimit: minbtl({ start, end }, MINBTL_EXPECTED_ANNUAL_SHARPE).limit,
    windowYears: (end.getTime() - start.getTime()) / (365.25 * 86_400_000),
  };
}

async function runCandidateAgainst(
  spec: CandidateRunSpec,
  market: MarketData,
  bars: BarsSource,
  halfSpreadBps: (instrument: string) => number,
  { ledger, canaries, randomCanaryRuns }: ResearchLogs,
  logger: Logger,
): Promise<CandidateRunReport> {
  const input = (costMultiple: number): BacktestInput => ({
    candidate: spec.candidate,
    trials: spec.trials(bars),
    benchmark: spec.benchmark,
    from: spec.window.from,
    to: spec.window.to,
    startCapitalGbp: spec.startCapitalGbp ?? BACKTEST_START_CAPITAL_GBP,
    lossCapGbp: BACKTEST_LOSS_CAP_GBP,
    market,
    halfSpreadBps,
    ledger,
    logger,
    folds: WALK_FORWARD_FOLDS,
    embargo: spec.embargo,
    calendarReference: spec.calendarReference,
    costMultiple,
  });
  const baseline = await runBacktest({
    ...input(1),
    shiftCanary: { trials: spec.trials(delayedBars(bars)).map(delayedTrial), log: canaries },
    randomCanary: { log: canaries, runs: randomCanaryRuns },
  });
  const stressed = await runBacktest(input(COST_STRESS_MULTIPLE));
  const sessions = backtestSessions(
    market,
    spec.window.from,
    spec.window.to,
    spec.calendarReference,
  );
  const stress = costStress(
    candidateOutcome(baseline),
    candidateOutcome(stressed),
    baselinePicksAt(
      baseline,
      stressed,
      walkForwardRanges(stressed.dates.length, WALK_FORWARD_FOLDS, spec.embargo),
    ),
  );
  const signFlipped = stress.flipped.length > 0;
  return {
    baseline: { ...baseline, verdict: withCostStress(baseline.verdict, stress) },
    stressed,
    trialsCounted: ledger.count(),
    ...windowLength(spec.window),
    signFlipped,
    regimeSplit: baseline.verdict.regimeSplit,
    oneBarDelay: baseline.verdict.oneBarDelay,
    randomEntries: baseline.verdict.randomEntries,
    dataSanity: dataSanity(bars, spec.symbolsOn, sessions),
  };
}

async function openMultiVenueMarket(
  options: ResolvedCliOptions,
): Promise<{ market: MarketData; bars: BarsSource }> {
  const fx = parseBoeGbpUsdCsv(readSeededFile(options.fxPath));
  const alpaca = new ParquetBarsSource(options.root, 'alpaca', { optional: true });
  const saxo = new ParquetBarsSource(options.root, 'saxo');
  await alpaca.prime();
  await saxo.prime();
  const bars = new MultiVenueBarsSource([alpaca, saxo]);
  const market = new BarsMarketData(bars, fx);
  return { market, bars };
}

export async function runCrossAssetTrendAgainst(
  market: MarketData,
  bars: BarsSource,
  halfSpreadBps: (instrument: string) => number,
  research: ResearchLogs,
  logger: Logger,
  window: CandidateWindow = CROSS_ASSET_TREND_WINDOW,
): Promise<CrossAssetTrendRunReport> {
  const trials = (source: BarsSource) =>
    [100, 200].map((sma) => ({
      config: { sma_window: sma },
      sleeve: createCrossAssetTrendSleeve(source, sma as 100 | 200),
    }));
  const benchmark = {
    config: { benchmark: true },
    sleeve: createCrossAssetTrendBenchmarkSleeve(bars),
  };
  return runCandidateAgainst(
    {
      candidate: CROSS_ASSET_TREND_CANDIDATE_ID,
      trials,
      benchmark,
      window,
      calendarReference: calendarReferenceFor('saxo'),
      symbolsOn: () => CROSS_ASSET_TREND_TIDMS,
    },
    market,
    bars,
    halfSpreadBps,
    research,
    logger,
  );
}

interface ResearchRun {
  readonly market: MarketData;
  readonly bars: BarsSource;
  readonly halfSpreadBps: (instrument: string) => number;
  readonly research: ResearchLogs;
  readonly options: ResolvedCliOptions;
}

async function withResearchLedger<T>(
  cliOptions: BacktestCliOptions,
  run: (research: ResearchRun) => Promise<T>,
): Promise<T> {
  const options = resolveCliOptions(cliOptions);
  const { market, bars } = await openMultiVenueMarket(options);
  const halfSpreadBps = halfSpreadLookup(options.spreadsPath, options.saxoSpreadsPath);
  const db = openSharedStore(options.storePath);
  try {
    const clock = new SystemClock();
    const research = {
      ledger: new TrialLedger(db, clock, sessionBLedger()),
      canaries: new CanaryLog(db, clock),
    };
    return await run({ market, bars, halfSpreadBps, research, options });
  } finally {
    db.close();
  }
}

export function runCrossAssetTrendCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<CrossAssetTrendRunReport> {
  return withResearchLedger(cliOptions, ({ market, bars, halfSpreadBps, research, options }) =>
    runCrossAssetTrendAgainst(market, bars, halfSpreadBps, research, options.logger),
  );
}

export async function runMeanReversionAgainst(
  market: MarketData,
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
  halfSpreadBps: (instrument: string) => number,
  research: ResearchLogs,
  logger: Logger,
  window: CandidateWindow = MEAN_REVERSION_WINDOW,
): Promise<MeanReversionRunReport> {
  const trials = (source: BarsSource) =>
    MEAN_REVERSION_ENTRY_THRESHOLDS.map((threshold) => ({
      config: { rsi_entry_threshold: threshold },
      sleeve: createMeanReversionSleeve(source, constituentsFor, threshold),
    }));
  const benchmark = {
    config: { benchmark: true },
    sleeve: createMeanReversionBenchmarkSleeve(bars, constituentsFor),
  };
  return runCandidateAgainst(
    {
      candidate: MEAN_REVERSION_CANDIDATE_ID,
      trials,
      benchmark,
      window,
      calendarReference: calendarReferenceFor('alpaca'),
      symbolsOn: constituentsFor,
      embargo: MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
    },
    market,
    bars,
    halfSpreadBps,
    research,
    logger,
  );
}

function constituentsReader(path: string): (tradingDate: string) => readonly string[] {
  const csv = readFileSync(path, 'utf8');
  return (tradingDate) => currentConstituents(csv, tradingDate);
}

export function runMeanReversionCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<MeanReversionRunReport> {
  return withResearchLedger(cliOptions, ({ market, bars, halfSpreadBps, research, options }) =>
    runMeanReversionAgainst(
      market,
      bars,
      constituentsReader(options.constituentsPath),
      halfSpreadBps,
      research,
      options.logger,
    ),
  );
}

export async function runVolTargetIndexAgainst(
  market: MarketData,
  bars: BarsSource,
  halfSpreadBps: (instrument: string) => number,
  research: ResearchLogs,
  logger: Logger,
  window: CandidateWindow = VOL_TARGET_INDEX_WINDOW,
): Promise<VolTargetIndexRunReport> {
  const trials = (source: BarsSource) =>
    VOL_TARGET_INDEX_CEILINGS.map((ceiling) => ({
      config: {
        vol_ceiling: ceiling,
        universe: VOL_TARGET_INDEX_TIDMS,
        vol_window: VOL_TARGET_INDEX_VOL_WINDOW,
        atr_window: VOL_TARGET_INDEX_ATR_WINDOW,
        lookback_bars: VOL_TARGET_INDEX_LOOKBACK_BARS,
      },
      sleeve: createVolTargetIndexSleeve(source, ceiling),
    }));
  const benchmark = {
    config: { benchmark: true },
    sleeve: createVolTargetIndexBenchmarkSleeve(bars),
  };
  return runCandidateAgainst(
    {
      candidate: VOL_TARGET_INDEX_CANDIDATE_ID,
      trials,
      benchmark,
      window,
      calendarReference: calendarReferenceFor('saxo'),
      symbolsOn: () => VOL_TARGET_INDEX_TIDMS,
      embargo: VOL_TARGET_INDEX_VOL_WINDOW,
      startCapitalGbp: VOL_TARGET_INDEX_START_CAPITAL_GBP,
    },
    market,
    bars,
    halfSpreadBps,
    research,
    logger,
  );
}

export function runVolTargetIndexCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<VolTargetIndexRunReport> {
  return withResearchLedger(cliOptions, ({ market, bars, halfSpreadBps, research, options }) =>
    runVolTargetIndexAgainst(market, bars, halfSpreadBps, research, options.logger),
  );
}

export interface VolTargetTrialReport {
  readonly verdict: CostStressed<VolTargetVerdict>;
  readonly stressed: VolTargetVerdict;
  readonly signFlipped: boolean;
  readonly dataSanity: DataSanityReport;
}

export interface VolTargetTrialWindow extends CandidateWindow {
  readonly outOfSampleFrom: string;
}

const VOL_TARGET_TRIAL_WINDOW: VolTargetTrialWindow = {
  from: VOL_TARGET_TRIAL_FROM,
  to: VOL_TARGET_TRIAL_TO,
  outOfSampleFrom: VOL_TARGET_TRIAL_OUT_OF_SAMPLE_FROM,
};

interface VolTargetTrialRun {
  readonly arms: VolTargetTrialArms;
  readonly market: MarketData;
  readonly halfSpreadBps: (instrument: string) => number;
  readonly ledger: TrialLedger;
  readonly logger: Logger;
  readonly window: VolTargetTrialWindow;
  readonly cfdCatalogues: CfdCatalogueArchive;
}

async function volTargetTrialPass(
  run: VolTargetTrialRun,
  costMultiple: number,
): Promise<{ dates: readonly string[]; verdict: VolTargetVerdict }> {
  const { arms, window, ledger } = run;
  const simulation = await simulateBacktest({
    candidate: VOL_TARGET_TRIAL_CANDIDATE_ID,
    trials: [arms.trial],
    benchmark: arms.baseline,
    from: window.from,
    to: window.to,
    startCapitalGbp: VOL_TARGET_TRIAL_START_CAPITAL_GBP,
    lossCapGbp: BACKTEST_LOSS_CAP_GBP,
    market: run.market,
    halfSpreadBps: run.halfSpreadBps,
    ledger,
    logger: run.logger,
    folds: VOL_TARGET_TRIAL_FOLDS,
    embargo: VOL_TARGET_TRIAL_EMBARGO,
    calendarReference: CALENDAR_REFERENCE,
    costMultiple,
    volTarget: VOL_TARGET_TRIAL_SIZING,
    cfdCatalogues: run.cfdCatalogues,
  });
  const verdict = volTargetVerdict({
    dates: simulation.dates,
    trial: simulation.trials[0] as TrialSeries,
    baseline: simulation.benchmark,
    outOfSampleFrom: window.outOfSampleFrom,
    trialsCounted: ledger.count(),
    lossCapGbp: BACKTEST_LOSS_CAP_GBP * simulation.trialsShare,
    folds: VOL_TARGET_TRIAL_FOLDS,
    embargo: VOL_TARGET_TRIAL_EMBARGO,
  });
  return { dates: simulation.dates, verdict };
}

// David 2026-10-08 (#1860): doc 67's 2x modelled-cost rerun runs as it does for candidates, on
// the same trial hash. The run holds one trial, so the 1x pick priced at 2x is the 2x run's own
export async function runVolTargetTrialAgainst(
  market: MarketData,
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
  window: VolTargetTrialWindow = VOL_TARGET_TRIAL_WINDOW,
  cfdCatalogues: CfdCatalogueArchive = new CfdCatalogueArchive([]),
): Promise<VolTargetTrialReport> {
  const arms = volTargetTrialArms({ bars, constituents: constituentsFor, cfdCatalogues });
  const run = { arms, market, halfSpreadBps, ledger, logger, window, cfdCatalogues };
  const base = await volTargetTrialPass(run, 1);
  const stressed = await volTargetTrialPass(run, COST_STRESS_MULTIPLE);
  const atDoubledCost = trialOutcome(stressed.verdict);
  const stress = costStress(trialOutcome(base.verdict), atDoubledCost, atDoubledCost);
  const signFlipped = stress.flipped.length > 0;
  return {
    verdict: withCostStress(base.verdict, stress),
    stressed: stressed.verdict,
    signFlipped,
    dataSanity: dataSanity(bars, constituentsFor, base.dates),
  };
}

export function runVolTargetTrial(
  cliOptions: BacktestCliOptions = {},
): Promise<VolTargetTrialReport> {
  return withResearchLedger(cliOptions, ({ market, bars, halfSpreadBps, research, options }) =>
    runVolTargetTrialAgainst(
      market,
      bars,
      constituentsReader(options.constituentsPath),
      halfSpreadBps,
      research.ledger,
      options.logger,
      VOL_TARGET_TRIAL_WINDOW,
      loadCfdCatalogueArchive(cliOptions.cfdSnapshotStorePath ?? V2_STORE_PATH),
    ),
  );
}

export interface Arm2UkPoolTrialReport {
  readonly verdict: Arm2UkPoolVerdict;
  readonly stressed: Arm2UkPoolVerdict;
  readonly passRule: Arm2UkPoolPassRule;
  readonly minbtlLimit: number;
  readonly windowYears: number;
  readonly dataSanity: DataSanityReport;
}

const ARM2_UK_POOL_WINDOW: VolTargetTrialWindow = {
  from: ARM2_UK_POOL_FROM,
  to: ARM2_UK_POOL_TO,
  outOfSampleFrom: ARM2_UK_POOL_OUT_OF_SAMPLE_FROM,
};

interface Arm2UkPoolRun {
  readonly arms: Arm2UkPoolArms;
  readonly market: MarketData;
  readonly halfSpreadBps: (instrument: string) => number;
  readonly ledger: TrialLedger;
  readonly logger: Logger;
  readonly window: VolTargetTrialWindow;
  readonly cfdCatalogues: CfdCatalogueArchive;
}

async function arm2UkPoolPass(
  run: Arm2UkPoolRun,
  costMultiple: number,
): Promise<{ dates: readonly string[]; verdict: Arm2UkPoolVerdict }> {
  const { arms, window, ledger } = run;
  const simulation = await simulateBacktest({
    candidate: ARM2_UK_POOL_CANDIDATE_ID,
    trials: [arms.trial],
    benchmark: arms.baseline,
    from: window.from,
    to: window.to,
    startCapitalGbp: ARM2_UK_POOL_START_CAPITAL_GBP,
    lossCapGbp: BACKTEST_LOSS_CAP_GBP,
    market: run.market,
    halfSpreadBps: run.halfSpreadBps,
    ledger,
    logger: run.logger,
    calendarReference: CALENDAR_REFERENCE,
    costMultiple,
    cfdCatalogues: run.cfdCatalogues,
    ukStockCfdOpen: arms.ukStockCfdOpen,
  });
  const verdict = arm2UkPoolVerdict({
    dates: simulation.dates,
    trial: simulation.trials[0] as TrialSeries,
    baseline: simulation.benchmark,
    outOfSampleFrom: window.outOfSampleFrom,
    trialsCounted: ledger.count(),
    lossCapGbp: BACKTEST_LOSS_CAP_GBP * simulation.trialsShare,
    folds: VOL_TARGET_TRIAL_FOLDS,
    embargo: VOL_TARGET_TRIAL_EMBARGO,
  });
  return { dates: simulation.dates, verdict };
}

function arm2UkPoolSanity(
  market: MarketData,
  bars: BarsSource,
  pool: Parameters<typeof pooledUniverse>[0],
  window: CandidateWindow,
  usSessions: readonly string[],
): DataSanityReport {
  const pooled = new Map<string, readonly string[]>();
  const pooledOn = (session: string): readonly string[] => {
    const held = pooled.get(session) ?? pooledUniverse(pool, session).pooled;
    pooled.set(session, held);
    return held;
  };
  const onVenue = (venue: 'alpaca' | 'saxo') => (session: string) =>
    pooledOn(session).filter((symbol) => venueOf(symbol) === venue);
  return venueDataSanity(bars, [
    { symbolsOn: onVenue('alpaca'), sessions: usSessions },
    {
      symbolsOn: onVenue('saxo'),
      sessions: backtestSessions(market, window.from, window.to, calendarReferenceFor('saxo')),
    },
  ]);
}

// David 2026-10-15 (#2143 (f)): arm 2's own counted trial over the UK pool and 6 slots, beside
// the ETF-only arm 2 it replaces as paper's band. That baseline is the run's benchmark, never a
// counted trial but pinned in the trial's hash, as the vol-target trial's is. Doc 67's 2x cost
// rerun runs on the same hash
export async function runArm2UkPoolTrialAgainst(
  market: MarketData,
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
  cfdCatalogues: CfdCatalogueArchive,
  window: VolTargetTrialWindow = ARM2_UK_POOL_WINDOW,
  runReady: Parameter<boolean> = ARM2_UK_POOL_RUN_READY,
): Promise<Arm2UkPoolTrialReport> {
  assertArm2UkPoolRunReady(runReady);
  const today = ukPoolCatalogue(cfdCatalogues, ARM2_UK_POOL_NAMES_AS_OF);
  assertUkBarsReach(bars, today, window);
  const arms = arm2UkPoolArms({
    bars,
    constituents: constituentsFor,
    cfdCatalogues,
    today,
    screens: requireSet(UK_STOCK_SCREENS),
    outOfSampleFrom: window.outOfSampleFrom,
  });
  const run = { arms, market, halfSpreadBps, ledger, logger, window, cfdCatalogues };
  const base = await arm2UkPoolPass(run, 1);
  const stressed = await arm2UkPoolPass(run, COST_STRESS_MULTIPLE);
  const pool = { bars, constituents: constituentsFor, ukStocks: arms.ukStocks };
  return {
    verdict: base.verdict,
    stressed: stressed.verdict,
    passRule: arm2UkPoolPassRule(base.verdict, stressed.verdict),
    ...windowLength(window),
    dataSanity: arm2UkPoolSanity(market, bars, pool, window, base.dates),
  };
}

export async function runArm2UkPoolTrial(
  cliOptions: BacktestCliOptions = {},
  runReady: Parameter<boolean> = ARM2_UK_POOL_RUN_READY,
): Promise<Arm2UkPoolTrialReport> {
  assertArm2UkPoolRunReady(runReady);
  return withResearchLedger(cliOptions, ({ market, bars, halfSpreadBps, research, options }) =>
    runArm2UkPoolTrialAgainst(
      market,
      bars,
      constituentsReader(options.constituentsPath),
      halfSpreadBps,
      research.ledger,
      options.logger,
      loadCfdCatalogueArchive(cliOptions.cfdSnapshotStorePath ?? V2_STORE_PATH),
      ARM2_UK_POOL_WINDOW,
      runReady,
    ),
  );
}

const CANDIDATE_RUNNERS: Record<string, (options: BacktestCliOptions) => Promise<unknown>> = {
  [CROSS_ASSET_TREND_CANDIDATE_ID]: runCrossAssetTrendCandidate,
  [MEAN_REVERSION_CANDIDATE_ID]: runMeanReversionCandidate,
  [VOL_TARGET_INDEX_CANDIDATE_ID]: runVolTargetIndexCandidate,
  [VOL_TARGET_TRIAL_CANDIDATE_ID]: runVolTargetTrial,
  [ARM2_UK_POOL_CANDIDATE_ID]: runArm2UkPoolTrial,
};

async function runNamedCandidate(candidateArg: string): Promise<number> {
  const runCandidate = CANDIDATE_RUNNERS[candidateArg];
  if (runCandidate === undefined) {
    process.stderr.write(
      `backtest-cli: unknown candidate "${candidateArg}" (expected one of ${Object.keys(CANDIDATE_RUNNERS).join(', ')})\n`,
    );
    return 1;
  }
  const report = await runCandidate({
    logger: { log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`) },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

void runWhenInvoked(
  import.meta.url,
  () => runNamedCandidate(process.argv[2] ?? CROSS_ASSET_TREND_CANDIDATE_ID),
  errorStack,
);
