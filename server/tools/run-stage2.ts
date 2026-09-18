import { isDailyTimeframe } from '../providers/market-data-service/index.js';
import { openSharedStore, sharedStorePath } from '../shared/store/index.js';
import {
  type CostConfig,
  CostModelImpl,
  type DateRange,
  DEFAULT_STAGE2_TIMEFRAME,
  InMemoryConfigTrialLog,
  type PolygonClient,
  periodsPerYearFor,
  renderStage2Verdict,
  runTrialGrid,
  SAXO_COMMISSION_RATE,
  SqliteStage2SelectionStore,
  Stage2HistoricalStore,
  type Stage2Selection,
  type Stage2Verdict,
  selectionsFrom,
  type TrialGridAssetClass,
  type TrialGridResult,
} from './backtest/index.js';
import { resolveStage2Source } from './stage2-source.js';
import { makeAssetClass } from './stage2-support.js';

export const STOCK_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'TSLA'] as const;
export const CRYPTO_SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;

const FIVE_YEARS_MS = 5 * 365 * 86_400_000;
export const DEFAULT_CAPITAL_PER_TRADE = 10_000;
export const DEFAULT_AVERAGE_CAPITAL = 10_000;

export const PESSIMISTIC_COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.5,
    commissionRate: 0.001,
    slippageCoefficient: 0.2,
    impactK: 0.1,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.0005,
    slippageCoefficient: 0.05,
    impactK: 0.05,
  },
};

export const CALIBRATED_COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.028,
    commissionRate: 0.0025,
    slippageCoefficient: 0.007,
    impactK: 0.1,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.0037,
    commissionRate: 0,
    slippageCoefficient: 0.000925,
    impactK: 0.05,
  },
};

export const CALIBRATED_INTRADAY_COST_CONFIG: CostConfig = {
  crypto: PESSIMISTIC_COST_CONFIG.crypto,
  stocks: {
    spreadVolatilityCoefficient: 0.0697,
    commissionRate: 0,
    slippageCoefficient: 0.017425,
    impactK: 0.05,
  },
  venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
};

export function costConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CostConfig {
  return env.SAMURAI_STAGE2_COST_CONFIG?.trim() === 'pessimistic'
    ? PESSIMISTIC_COST_CONFIG
    : CALIBRATED_COST_CONFIG;
}

export function costConfigFor(timeframe: string, env: NodeJS.ProcessEnv = process.env): CostConfig {
  const fromEnv = costConfigFromEnv(env);
  if (fromEnv === PESSIMISTIC_COST_CONFIG) return fromEnv;
  return isDailyTimeframe(timeframe) ? CALIBRATED_COST_CONFIG : CALIBRATED_INTRADAY_COST_CONFIG;
}

export function defaultFiveYearWindow(now: Date = new Date()): DateRange {
  return { start: new Date(now.getTime() - FIVE_YEARS_MS), end: now };
}

export { STAGE2_PINNED_WINDOW } from './stage2-source.js';

export const STAGE2_SCRATCH_DB_PATH = 'data/stage2-bars.sqlite';

export interface RunStage2Deps {
  polygonClient: PolygonClient;
  window?: DateRange;
  dbPath?: string;
  capitalPerTrade?: number;
  averageCapital?: number;
  timeframe?: string;
  costConfig?: CostConfig;
  print?: (line: string) => void;
  selections?: { record(selection: Stage2Selection): void };
  now?: () => Date;
}

interface ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

export function universeFor(timeframe: string): readonly string[] {
  return isDailyTimeframe(timeframe) ? [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS] : [...STOCK_SYMBOLS];
}

function firstAndLastBar(
  bars: readonly { close_time: Date }[],
): { first: Date; last: Date } | undefined {
  let first: Date | undefined;
  let last: Date | undefined;
  for (const bar of bars) {
    if (first === undefined || bar.close_time.getTime() < first.getTime()) first = bar.close_time;
    if (last === undefined || bar.close_time.getTime() > last.getTime()) last = bar.close_time;
  }
  if (first === undefined || last === undefined) return undefined;
  return { first, last };
}

export function effectiveWindow(
  store: { bars: (symbol: string, window: DateRange) => Array<{ close_time: Date }> },
  requested: DateRange,
  symbols: readonly string[] = [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS],
): DateRange {
  let start = requested.start;
  let end = requested.end;

  for (const symbol of symbols) {
    const bars = store.bars(symbol, requested);
    const bounds = firstAndLastBar(bars);
    if (bounds === undefined) {
      throw new Error(
        `runStage2: ${symbol} has no bars in ${requested.start.toISOString()} .. ` +
          `${requested.end.toISOString()}, so the 12-config grid cannot be evaluated over the ` +
          'MVP universe. Check the symbol is served by this Polygon plan before reading any ' +
          'verdict — a grid missing a symbol is not the grid the Stage 2 gate is defined on.',
      );
    }

    if (bounds.first.getTime() > start.getTime()) start = bounds.first;
    if (bounds.last.getTime() < end.getTime()) end = bounds.last;
  }

  if (start.getTime() >= end.getTime()) {
    throw new Error(
      `runStage2: the MVP universe has no window every symbol covers — the intersection of ` +
        `per-symbol coverage across ${requested.start.toISOString()} .. ` +
        `${requested.end.toISOString()} collapsed to ${start.toISOString()} .. ` +
        `${end.toISOString()}. At least one symbol's history ends before another's begins, so ` +
        'there is no sample the 12-config grid can be evaluated on. Widen the requested window ' +
        'or check which symbol this Polygon plan is serving short.',
    );
  }

  return { start, end };
}

function resolveRunStage2Config(deps: RunStage2Deps): {
  window: DateRange;
  print: (line: string) => void;
  capitalPerTrade: number;
  averageCapital: number;
  timeframe: string;
  dbPath: string;
  costConfig: CostConfig;
} {
  return {
    window: deps.window ?? defaultFiveYearWindow(),
    print: deps.print ?? console.log,
    capitalPerTrade: deps.capitalPerTrade ?? DEFAULT_CAPITAL_PER_TRADE,
    averageCapital: deps.averageCapital ?? DEFAULT_AVERAGE_CAPITAL,
    timeframe: deps.timeframe ?? DEFAULT_STAGE2_TIMEFRAME,
    dbPath: deps.dbPath ?? ':memory:',
    costConfig: deps.costConfig ?? PESSIMISTIC_COST_CONFIG,
  };
}

async function ingestUniverse(
  store: Stage2HistoricalStore,
  symbols: readonly string[],
  window: DateRange,
  timeframe: string,
  print: (line: string) => void,
): Promise<void> {
  print(
    `Stage 2: ingesting ${symbols.length} MVP-universe symbols at ${timeframe} ` +
      `over ${window.start.toISOString()} .. ${window.end.toISOString()}`,
  );
  if (!isDailyTimeframe(timeframe)) {
    print(
      'Stage 2: WARNING — this is an INTRADAY run. The spread/ATR ratio IS now fitted at ' +
        '1-minute resolution (#875, CALIBRATED_INTRADAY_COST_CONFIG), so the resolution ' +
        'mismatch #874 warned about is closed. THREE residuals are not: (1) the charged ' +
        'half-spread sits at the 1bp STRUCTURAL FLOOR for every symbol measured, at both ' +
        'resolutions and under both configs, so what a fill is charged is governed by the ' +
        'floor and not by this calibration; (2) one per-asset-class coefficient UNDER-charges ' +
        'the wide names — TSLA measured 3.3x the cross-symbol median; (3) the fit is a ' +
        'US-EQUITY PROXY (SPY/QQQ/AAPL/TSLA on Alpaca SIP), while the live universe is LSE ' +
        'leveraged ETPs with no free quote source. Do not read these numbers as a Stage 2 ' +
        'verdict. See docs/research/53-intraday-cost-calibration.md.',
    );
  }
  for (const symbol of symbols) {
    await store.ingest(symbol, window);
    const barCount = store.bars(symbol, window).length;
    print(`  ingested ${symbol}: ${barCount} bars`);
  }
}

function warnIfWindowNarrowed(
  requested: DateRange,
  effective: DateRange,
  print: (line: string) => void,
): void {
  const narrowedStart = effective.start.getTime() > requested.start.getTime();
  const narrowedEnd = effective.end.getTime() < requested.end.getTime();
  if (narrowedStart || narrowedEnd) {
    const narrowing: string[] = [];
    if (narrowedStart) {
      narrowing.push(
        `requested a start of ${requested.start.toISOString().slice(0, 10)} but the data starts ` +
          `${effective.start.toISOString().slice(0, 10)}`,
      );
    }
    if (narrowedEnd) {
      narrowing.push(
        `requested an end of ${requested.end.toISOString().slice(0, 10)} but the data ends ` +
          `${effective.end.toISOString().slice(0, 10)}`,
      );
    }
    print('');
    print(
      `Stage 2: WARNING — ${narrowing.join('; ')}. Running on the ` +
        `${((effective.end.getTime() - effective.start.getTime()) / (365 * 86_400_000)).toFixed(2)}` +
        '-year sample the provider actually served. MinBTL below is computed on THAT window, so ' +
        'a tighter trial cap here is a real constraint of the sample, not a spec change.',
    );
    print('');
  }
}

function buildAssetClasses(ctx: ReplayContext, timeframe: string): TrialGridAssetClass[] {
  const stocks = makeAssetClass(
    ctx,
    'stocks',
    STOCK_SYMBOLS,
    periodsPerYearFor('stocks', timeframe),
    isDailyTimeframe(timeframe) ? undefined : 'saxo',
  );
  return isDailyTimeframe(timeframe)
    ? [
        stocks,
        makeAssetClass(ctx, 'crypto', CRYPTO_SYMBOLS, periodsPerYearFor('crypto', timeframe)),
      ]
    : [stocks];
}

function freezeSelections(
  deps: RunStage2Deps,
  verdict: Stage2Verdict,
  results: readonly TrialGridResult[],
  effective: DateRange,
  print: (line: string) => void,
): void {
  if (deps.selections !== undefined) {
    const frozen = selectionsFrom({
      verdict,
      results,
      window: effective,
      selectedAt: deps.now?.() ?? new Date(),
    });
    for (const selection of frozen) deps.selections.record(selection);
    print(
      frozen.length === 0
        ? 'Stage 2: nothing to freeze — no config was evaluated, so the kill-lines stay inert.'
        : `Stage 2: froze ${frozen.length} selection(s) — the Feedback Loop can now evaluate ` +
            'the divergence and revalidation kill-lines against this run.',
    );
  }
}

export async function runStage2(deps: RunStage2Deps): Promise<Stage2Verdict> {
  const { window, print, capitalPerTrade, averageCapital, timeframe, dbPath, costConfig } =
    resolveRunStage2Config(deps);
  const symbols = universeFor(timeframe);

  const store = new Stage2HistoricalStore(deps.polygonClient, { timeframe, dbPath });

  await ingestUniverse(store, symbols, window, timeframe, print);

  const effective = effectiveWindow(store, window, symbols);
  warnIfWindowNarrowed(window, effective, print);

  const costModel = new CostModelImpl(costConfig);
  const configTrialLog = new InMemoryConfigTrialLog();
  const ctx: ReplayContext = { store, costModel, window: effective, capitalPerTrade };

  const assetClasses = buildAssetClasses(ctx, timeframe);

  const results = await runTrialGrid({
    assetClasses,
    window: effective,
    averageCapital,
    configTrialLog,
    announceSizing: (sizing) =>
      print(
        `Stage 2: grid sized to N=${sizing.selected.length} from a ` +
          `${sizing.years.toFixed(1)}-year effective sample (the full cross-product asks ` +
          `for ${sizing.requested}; MinBTL supports ${sizing.limit}). ` +
          'Running across stocks + crypto...',
      ),
    includeCscvPass: true,
  });

  const verdict = renderStage2Verdict({
    results,
    distinctTrialCount: configTrialLog.distinctTrialCount(),
    window: effective,
  });

  printReport(results, verdict, print);

  freezeSelections(deps, verdict, results, effective, print);

  return verdict;
}

function printReport(
  results: readonly TrialGridResult[],
  verdict: Stage2Verdict,
  print: (line: string) => void,
): void {
  print('');
  print('=== Stage 2: per-config metrics ===');
  for (const result of results) {
    const m = result.report.window;
    print(
      `[${result.asset_class}] ${result.config_hash} ` +
        `fastWindow=${result.config.fastWindow} slowWindow=${result.config.slowWindow} ` +
        `atrStopMult=${result.config.atrStopMult} atrTargetMult=${result.config.atrTargetMult}`,
    );
    print(
      `    window: sharpe=${m.sharpe.toFixed(3)} sortino=${m.sortino.toFixed(3)} ` +
        `calmar=${m.calmar.toFixed(3)} max_drawdown=${m.max_drawdown.toFixed(3)} ` +
        `profit_factor=${m.profit_factor.toFixed(3)} expectancy=${m.expectancy.toFixed(3)} ` +
        `skew=${m.skew.toFixed(3)} kurtosis=${m.kurtosis.toFixed(3)} ` +
        `turnover=${m.turnover.toFixed(3)} exposure=${m.exposure.toFixed(3)}`,
    );
    print(
      `    dsr inputs: per_period_sharpe=${m.per_period_sharpe.toFixed(4)} ` +
        `annualization_factor=${m.annualization_factor.toFixed(3)} ` +
        `observations=${m.observations}`,
    );
    for (const split of result.report.splits) {
      print(`    fold sharpe=${split.metrics.sharpe.toFixed(3)}`);
    }
    if (result.cscv !== undefined) {
      print(
        `    cscv folds: ${
          'error' in result.cscv
            ? `UNAVAILABLE (${result.cscv.error})`
            : result.cscv.report.splits.map((s) => s.metrics.sharpe.toFixed(3)).join(' ')
        }`,
      );
    }
  }

  print('');
  print('=== Stage 2: kill-line checks (OOS Sharpe) ===');
  for (const check of verdict.kill_line_checks) {
    print(
      `[${check.asset_class}] ${check.config_hash} oos_sharpe=${check.oos_sharpe.toFixed(3)} ` +
        `window_sharpe=${check.window_sharpe.toFixed(3)} ` +
        `passes=${check.passes_oos_sharpe_line}`,
    );
  }

  print('');
  print('=== Stage 2: MinBTL ===');
  print(
    `n_distinct_trials=${verdict.n_distinct_trials} exceeded=${verdict.min_btl.exceeded} ` +
      JSON.stringify(verdict.min_btl),
  );

  print('');
  print('=== Stage 2: PBO ===');
  for (const outcome of verdict.pbo) {
    print(JSON.stringify(outcome));
  }

  print('');
  print('=== Stage 2: DSR ===');
  for (const outcome of verdict.dsr) {
    print(JSON.stringify(outcome));
  }

  print('');
  print(`=== Stage 2 VERDICT: ${verdict.overall_pass ? 'PASS' : 'KILL/INCOMPLETE'} ===`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const {
    client: polygonClient,
    window: runWindow,
    label,
    timeframe: runTimeframe,
  } = resolveStage2Source();
  console.log(
    `Stage 2 source: ${label} at ${runTimeframe} over ${runWindow.start.toISOString()} .. ` +
      `${runWindow.end.toISOString()}`,
  );
  const shared = openSharedStore(sharedStorePath());
  runStage2({
    polygonClient,
    costConfig: costConfigFor(runTimeframe),
    window: runWindow,
    timeframe: runTimeframe,
    dbPath: STAGE2_SCRATCH_DB_PATH,
    selections: new SqliteStage2SelectionStore(shared),
  }).catch((error: unknown) => {
    console.error('Stage 2 run failed:', error);
    process.exitCode = 1;
  });
}
