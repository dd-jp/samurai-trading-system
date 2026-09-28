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
  calendarReferenceFor,
  MultiVenueBarsSource,
  ParquetBarsSource,
  parseBoeGbpUsdCsv,
} from './data/index.js';
import { FX_PATH, halfSpreadLookup, SAXO_SPREADS_PATH, SPREADS_PATH } from './index.js';
import {
  CROSS_ASSET_TREND_CANDIDATE_ID,
  CROSS_ASSET_TREND_FROM,
  CROSS_ASSET_TREND_TO,
  createCrossAssetTrendBenchmarkSleeve,
  createCrossAssetTrendSleeve,
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
  readonly logger?: Logger;
}

export interface CrossAssetTrendRunReport {
  readonly baseline: BacktestResult;
  readonly stressed: BacktestResult;
  readonly trialsCounted: number;
  readonly minbtlLimit: number;
  readonly windowYears: number;
  readonly signFlipped: boolean;
}

const SILENT_LOGGER: Logger = { log: (_entry: LogEntry) => undefined };

interface ResolvedCliOptions {
  readonly root: string;
  readonly fxPath: string;
  readonly spreadsPath: string;
  readonly saxoSpreadsPath: string;
  readonly storePath: string;
  readonly logger: Logger;
}

export function resolveCliOptions(options: BacktestCliOptions): ResolvedCliOptions {
  return {
    root: options.barStoreRoot ?? DEFAULT_BAR_STORE_ROOT,
    fxPath: options.fxPath ?? FX_PATH,
    spreadsPath: options.spreadsPath ?? SPREADS_PATH,
    saxoSpreadsPath: options.saxoSpreadsPath ?? SAXO_SPREADS_PATH,
    storePath: options.storePath ?? researchStorePath(),
    logger: options.logger ?? SILENT_LOGGER,
  };
}

export interface CrossAssetTrendWindow {
  readonly from: string;
  readonly to: string;
}

const CANDIDATE_WINDOW: CrossAssetTrendWindow = {
  from: CROSS_ASSET_TREND_FROM,
  to: CROSS_ASSET_TREND_TO,
};

export async function runCrossAssetTrendAgainst(
  market: MarketData,
  halfSpreadBps: (instrument: string) => number,
  ledger: TrialLedger,
  logger: Logger,
  window: CrossAssetTrendWindow = CANDIDATE_WINDOW,
): Promise<CrossAssetTrendRunReport> {
  const trials = [100, 200].map((sma) => ({
    config: { sma_window: sma },
    sleeve: createCrossAssetTrendSleeve(sma as 100 | 200),
  }));
  const benchmark = { config: { benchmark: true }, sleeve: createCrossAssetTrendBenchmarkSleeve() };
  const input = (costMultiple: number): BacktestInput => ({
    candidate: CROSS_ASSET_TREND_CANDIDATE_ID,
    trials,
    benchmark,
    from: window.from,
    to: window.to,
    startCapitalGbp: BACKTEST_START_CAPITAL_GBP,
    lossCapGbp: BACKTEST_LOSS_CAP_GBP,
    market,
    halfSpreadBps,
    ledger,
    logger,
    folds: WALK_FORWARD_FOLDS,
    calendarReference: calendarReferenceFor('saxo'),
    costMultiple,
  });
  const baseline = await runBacktest(input(1));
  const stressed = await runBacktest(input(COST_STRESS_MULTIPLE));
  const start = new Date(`${window.from}T00:00:00.000Z`);
  const end = new Date(`${window.to}T00:00:00.000Z`);
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

export async function runCrossAssetTrendCandidate(
  cliOptions: BacktestCliOptions = {},
): Promise<CrossAssetTrendRunReport> {
  const options = resolveCliOptions(cliOptions);
  const alpaca = new ParquetBarsSource(options.root, 'alpaca', { optional: true });
  const saxo = new ParquetBarsSource(options.root, 'saxo');
  await alpaca.prime();
  await saxo.prime();
  const bars = new MultiVenueBarsSource([alpaca, saxo]);
  const market = new BarsMarketData(bars, parseBoeGbpUsdCsv(readFileSync(options.fxPath, 'utf8')));
  const halfSpreadBps = halfSpreadLookup(options.spreadsPath, options.saxoSpreadsPath);
  const db = openSharedStore(options.storePath);
  try {
    const ledger = new TrialLedger(db, new SystemClock(), sessionBLedger());
    return await runCrossAssetTrendAgainst(market, halfSpreadBps, ledger, options.logger);
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCrossAssetTrendCandidate({
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
