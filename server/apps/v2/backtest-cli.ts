import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { MarketData } from '../../../contracts/index.js';
import { DEFAULT_BAR_STORE_ROOT } from '../../providers/bar-store/index.js';
import type { LogEntry, Logger } from '../../shared/index.js';
import { SystemClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { minbtl } from '../../tools/backtest/index.js';
import { type BacktestInput, type BacktestResult, runBacktest } from './backtest.js';
import {
  BarsMarketData,
  type BarsSource,
  calendarReferenceFor,
  currentConstituents,
  MultiVenueBarsSource,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import {
  CONSTITUENTS_PATH,
  FX_PATH,
  halfSpreadLookup,
  SAXO_SPREADS_PATH,
  SPREADS_PATH,
} from './index.js';
import {
  CROSS_ASSET_TREND_CANDIDATE_ID,
  CROSS_ASSET_TREND_FROM,
  CROSS_ASSET_TREND_TO,
  createCrossAssetTrendBenchmarkSleeve,
  createCrossAssetTrendSleeve,
  createMeanReversionBenchmarkSleeve,
  createMeanReversionSleeve,
  MEAN_REVERSION_CANDIDATE_ID,
  MEAN_REVERSION_ENTRY_THRESHOLDS,
  MEAN_REVERSION_FROM,
  MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
  MEAN_REVERSION_TO,
} from './signal/index.js';
import { researchStorePath, sessionBLedger, TrialLedger } from './trial-ledger.js';

// Backtest-only assumptions (doc 66 D8 exempts smoke.ts's SMOKE_* the same way): the actual
// yearly capital config David sets is not consulted here — a backtest run always sizes off a
// fixed, reproducible starting point
const BACKTEST_START_CAPITAL_GBP = 2_000;
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
  readonly logger?: Logger;
}

export interface CandidateRunReport {
  readonly baseline: BacktestResult;
  readonly stressed: BacktestResult;
  readonly trialsCounted: number;
  readonly minbtlLimit: number;
  readonly windowYears: number;
  readonly signFlipped: boolean;
}
export type CrossAssetTrendRunReport = CandidateRunReport;
export type MeanReversionRunReport = CandidateRunReport;

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

interface CandidateRunSpec {
  readonly candidate: string;
  readonly trials: BacktestInput['trials'];
  readonly benchmark: BacktestInput['benchmark'];
  readonly window: CandidateWindow;
  readonly calendarReference: string;
  readonly embargo?: number;
}

async function runCandidateAgainst(
  spec: CandidateRunSpec,
  market: MarketData,
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
): Promise<CandidateRunReport> {
  const input = (costMultiple: number): BacktestInput => ({
    candidate: spec.candidate,
    trials: spec.trials,
    benchmark: spec.benchmark,
    from: spec.window.from,
    to: spec.window.to,
    startCapitalGbp: BACKTEST_START_CAPITAL_GBP,
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
  const baseline = await runBacktest(input(1));
  const stressed = await runBacktest(input(COST_STRESS_MULTIPLE));
  const start = new Date(`${spec.window.from}T00:00:00.000Z`);
  const end = new Date(`${spec.window.to}T00:00:00.000Z`);
  const minbtlLimit = minbtl({ start, end }, MINBTL_EXPECTED_ANNUAL_SHARPE).limit;
  return {
    baseline,
    stressed,
    trialsCounted: ledger.count(),
    minbtlLimit,
    windowYears: (end.getTime() - start.getTime()) / (365.25 * 86_400_000),
    signFlipped:
      baseline.verdict.checks.beatsBenchmarkAfterHaircut !==
      stressed.verdict.checks.beatsBenchmarkAfterHaircut,
  };
}

async function openMultiVenueMarket(
  options: ResolvedCliOptions,
): Promise<{ market: MarketData; bars: BarsSource }> {
  const alpaca = new ParquetBarsSource(options.root, 'alpaca', { optional: true });
  const saxo = new ParquetBarsSource(options.root, 'saxo');
  await alpaca.prime();
  await saxo.prime();
  const bars = new MultiVenueBarsSource([alpaca, saxo]);
  const market = new BarsMarketData(bars, parseBoeGbpUsdCsv(readFileSync(options.fxPath, 'utf8')));
  return { market, bars };
}

export async function runCrossAssetTrendAgainst(
  market: MarketData,
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
  window: CandidateWindow = CROSS_ASSET_TREND_WINDOW,
): Promise<CrossAssetTrendRunReport> {
  const trials = [100, 200].map((sma) => ({
    config: { sma_window: sma },
    sleeve: createCrossAssetTrendSleeve(sma as 100 | 200),
  }));
  const benchmark = { config: { benchmark: true }, sleeve: createCrossAssetTrendBenchmarkSleeve() };
  return runCandidateAgainst(
    {
      candidate: CROSS_ASSET_TREND_CANDIDATE_ID,
      trials,
      benchmark,
      window,
      calendarReference: calendarReferenceFor('saxo'),
    },
    market,
    halfSpreadBps,
    ledger,
    logger,
  );
}

export async function runCrossAssetTrendCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<CrossAssetTrendRunReport> {
  const options = resolveCliOptions(cliOptions);
  const { market } = await openMultiVenueMarket(options);
  const halfSpreadBps = halfSpreadLookup(options.spreadsPath, options.saxoSpreadsPath);
  const db = openSharedStore(options.storePath);
  try {
    const ledger = new TrialLedger(db, new SystemClock(), sessionBLedger());
    return await runCrossAssetTrendAgainst(market, halfSpreadBps, ledger, options.logger);
  } finally {
    db.close();
  }
}

export async function runMeanReversionAgainst(
  market: MarketData,
  bars: BarsSource,
  constituentsFor: (tradingDate: string) => readonly string[],
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
  window: CandidateWindow = MEAN_REVERSION_WINDOW,
): Promise<MeanReversionRunReport> {
  const trials = MEAN_REVERSION_ENTRY_THRESHOLDS.map((threshold) => ({
    config: { rsi_entry_threshold: threshold },
    sleeve: createMeanReversionSleeve(bars, constituentsFor, threshold),
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
      embargo: MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
    },
    market,
    halfSpreadBps,
    ledger,
    logger,
  );
}

export async function runMeanReversionCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<MeanReversionRunReport> {
  const options = resolveCliOptions(cliOptions);
  const { market, bars } = await openMultiVenueMarket(options);
  const halfSpreadBps = halfSpreadLookup(options.spreadsPath, options.saxoSpreadsPath);
  const constituentsCsv = readFileSync(options.constituentsPath, 'utf8');
  const constituentsFor = (tradingDate: string): readonly string[] =>
    currentConstituents(constituentsCsv, tradingDate);
  const db = openSharedStore(options.storePath);
  try {
    const ledger = new TrialLedger(db, new SystemClock(), sessionBLedger());
    return await runMeanReversionAgainst(
      market,
      bars,
      constituentsFor,
      halfSpreadBps,
      ledger,
      options.logger,
    );
  } finally {
    db.close();
  }
}

const CANDIDATE_RUNNERS: Record<string, (options: BacktestCliOptions) => Promise<unknown>> = {
  [CROSS_ASSET_TREND_CANDIDATE_ID]: runCrossAssetTrendCandidate,
  [MEAN_REVERSION_CANDIDATE_ID]: runMeanReversionCandidate,
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const candidateArg = process.argv[2] ?? CROSS_ASSET_TREND_CANDIDATE_ID;
  const runCandidate = CANDIDATE_RUNNERS[candidateArg];
  if (runCandidate === undefined) {
    process.stderr.write(
      `backtest-cli: unknown candidate "${candidateArg}" (expected one of ${Object.keys(CANDIDATE_RUNNERS).join(', ')})\n`,
    );
    process.exit(1);
  } else {
    runCandidate({
      logger: { log: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`) },
    })
      .then((report) => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        process.exit(0);
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        process.exit(1);
      });
  }
}
