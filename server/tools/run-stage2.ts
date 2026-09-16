/**
 * Stage 2 runner — ingests Polygon OHLCV for the MVP universe, runs the
 * 12-config grid across stock and crypto asset classes, and renders the
 * Stage 2 overfitting verdict. See docs/specs/stage2-validation-execution-spec.md.
 *
 * Unit-tested against a fake `PolygonClient` (`run-stage2.test.ts`); never run
 * against live Polygon traffic in this environment.
 *
 * Usage: `POLYGON_API_KEY=... npx tsc -p tsconfig.build.json && node dist/server/tools/run-stage2.js`
 */
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

/** The fixed MVP universe (CLAUDE.md "Broker Plan" / spec "User Stories") */
export const STOCK_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'TSLA'] as const;
export const CRYPTO_SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;

const FIVE_YEARS_MS = 5 * 365 * 86_400_000;
export const DEFAULT_CAPITAL_PER_TRADE = 10_000;
export const DEFAULT_AVERAGE_CAPITAL = 10_000;

/**
 * Pessimistic cost-model defaults — mirrors `cost-model.test.ts`'s
 * `PESSIMISTIC_CONFIG` fixture. Overridable via `RunStage2Deps.costConfig`.
 */
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

/**
 * Cost config calibrated against measured market data and published fee
 * schedules (2026-08-05); see
 * docs/research/archive/2026-08-05-cost-model-calibration.md for the
 * per-field derivation (spread measured from live quotes, commission from
 * published fee schedules, slippage assumed at spread/4, impact unchanged).
 */
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

/**
 * `CALIBRATED_COST_CONFIG` refitted at 1-minute replay resolution (#875) — a
 * daily spread/ATR ratio applied against per-minute volatility is a category
 * error. See docs/research/53-intraday-cost-calibration.md. Crypto keeps the
 * pessimistic fixture: this path is equities-only, crypto is out of scope.
 */
export const CALIBRATED_INTRADAY_COST_CONFIG: CostConfig = {
  crypto: PESSIMISTIC_COST_CONFIG.crypto,
  stocks: {
    spreadVolatilityCoefficient: 0.0697,
    commissionRate: 0,
    slippageCoefficient: 0.017425,
    impactK: 0.05,
  },
  // Saxo-priced leg for the intraday stocks replay (`MarketState.venue = 'saxo'`)
  // — 8bps/side per ADR-0015:201, separate from the Alpaca-priced `stocks.commissionRate` above
  venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
};

/**
 * Which cost config a direct run uses. `SAMURAI_STAGE2_COST_CONFIG=pessimistic`
 * re-runs against the old fixture for comparison; calibrated is the default.
 * Daily only — `run-stage2-cost-decomposition.ts` is pinned to this signature.
 */
export function costConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CostConfig {
  return env.SAMURAI_STAGE2_COST_CONFIG?.trim() === 'pessimistic'
    ? PESSIMISTIC_COST_CONFIG
    : CALIBRATED_COST_CONFIG;
}

/**
 * The cost config for a run at `timeframe` (#875). Every non-daily timeframe
 * gets the 1-minute fit, which OVER-charges coarser ones — deliberate: a
 * single measured coefficient that over-charges beats an unmeasured ladder.
 */
export function costConfigFor(timeframe: string, env: NodeJS.ProcessEnv = process.env): CostConfig {
  const fromEnv = costConfigFromEnv(env);
  if (fromEnv === PESSIMISTIC_COST_CONFIG) return fromEnv;
  return isDailyTimeframe(timeframe) ? CALIBRATED_COST_CONFIG : CALIBRATED_INTRADAY_COST_CONFIG;
}

/** Default window: the last 5 years, ending "now" — the spec's Starter-tier depth */
export function defaultFiveYearWindow(now: Date = new Date()): DateRange {
  return { start: new Date(now.getTime() - FIVE_YEARS_MS), end: now };
}

/**
 * The exact window the 2026-08-05 verdict requested, to the millisecond — a
 * direct run uses this rather than `defaultFiveYearWindow()`, which shifts
 * fold boundaries on each new day and would make the verdict unreproducible.
 */
export { STAGE2_FREE_STACK_WINDOW, STAGE2_PINNED_WINDOW } from './stage2-source.js';

/**
 * Where a DIRECT run keeps its ingested bars (#495) — persisted, not
 * `:memory:`, so a dead free-data vendor (#487) only costs new bars. A
 * separate file/schema from `sharedStorePath()`, which holds live run state.
 */
export const STAGE2_SCRATCH_DB_PATH = 'data/stage2-bars.sqlite';

export interface RunStage2Deps {
  polygonClient: PolygonClient;
  window?: DateRange;
  /** Scratch SQLite path for `Stage2HistoricalStore`. Defaults to `:memory:`. */
  dbPath?: string;
  capitalPerTrade?: number;
  averageCapital?: number;
  /** Bar resolution to ingest and replay (#664). Defaults to `'1d'`. An intraday value makes this an EQUITIES-ONLY run — see `universeFor`. */
  timeframe?: string;
  costConfig?: CostConfig;
  /** Sink for the printed report — defaults to `console.log` */
  print?: (line: string) => void;
  /**
   * Where the run's selected config is frozen (#375, #384) — the SHARED
   * store, which the Feedback Loop reads at runtime, not the scratch one
   * `dbPath` opens. Optional: no store means a dry run.
   */
  selections?: { record(selection: Stage2Selection): void };
  /** Stamps the selection; defaults to wall clock. Injected so a test can pin it. */
  now?: () => Date;
}

/**
 * The run's shared replay context, identical across every asset class this
 * script builds — bundled so `makeAssetClass` takes one context instead of
 * four separate positional params per call.
 */
interface ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

/**
 * Which symbols a run of `timeframe` covers (#664). Daily keeps the full
 * six-symbol universe; intraday is equities-only, since crypto left Samurai's
 * scope (ADR-0015's 2026-08-16 amendment).
 */
export function universeFor(timeframe: string): readonly string[] {
  return isDailyTimeframe(timeframe) ? [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS] : [...STOCK_SYMBOLS];
}

/**
 * The sub-window of `requested` that EVERY symbol actually has bars for —
 * intersected, not unioned, since a fold outside one symbol's coverage
 * produces an opaque `toReturnSeries: no bars in the sample` abort. A symbol
 * with no bars, or an empty intersection, is a hard failure: silently
 * narrowing would change what the verdict is a verdict about.
 */
export function effectiveWindow(
  store: { bars: (symbol: string, window: DateRange) => Array<{ close_time: Date }> },
  requested: DateRange,
  /** Defaults to the full daily universe, which is what every pre-#664 call meant */
  symbols: readonly string[] = [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS],
): DateRange {
  let start = requested.start;
  let end = requested.end;

  for (const symbol of symbols) {
    const bars = store.bars(symbol, requested);
    let first: Date | undefined;
    let last: Date | undefined;
    for (const bar of bars) {
      if (first === undefined || bar.close_time.getTime() < first.getTime()) first = bar.close_time;
      if (last === undefined || bar.close_time.getTime() > last.getTime()) last = bar.close_time;
    }
    if (first === undefined || last === undefined) {
      throw new Error(
        `runStage2: ${symbol} has no bars in ${requested.start.toISOString()} .. ` +
          `${requested.end.toISOString()}, so the 12-config grid cannot be evaluated over the ` +
          'MVP universe. Check the symbol is served by this Polygon plan before reading any ' +
          'verdict — a grid missing a symbol is not the grid the Stage 2 gate is defined on.',
      );
    }

    if (first.getTime() > start.getTime()) start = first;
    if (last.getTime() < end.getTime()) end = last;
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

/** Resolves every `RunStage2Deps` optional field to its default, in one place */
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

/** Ingests every MVP-universe symbol at `timeframe` over `window`, printing per-symbol progress */
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

/**
 * Warn when EITHER boundary moved, naming which — warning only on the start
 * would let a lagging provider silently narrow the sample from the end.
 */
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

/**
 * `periodsPerYearFor`, not the daily constants (#664) — a 1-minute replay
 * annualized off 252 would understate Sharpe by ~sqrt(390). An intraday run
 * prices its stocks legs at Saxo (`CALIBRATED_INTRADAY_COST_CONFIG.venues.saxo`,
 * #1032 item 2); daily runs stay Alpaca-priced so pinned results don't move.
 */
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

/**
 * Freeze the selection (#375, #384) — without this the run is a printout:
 * nothing survives the process, and the Feedback Loop has no backtest Sharpe
 * or revalidation snapshot to evaluate its kill-lines with. Optional: no
 * store means a dry run.
 */
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

/**
 * Ingests the full MVP universe, runs the 12-config grid across stocks and
 * crypto, and renders the Stage 2 verdict. Returns the structured verdict so
 * a caller/test can assert on it without scraping stdout.
 */
export async function runStage2(deps: RunStage2Deps): Promise<Stage2Verdict> {
  const { window, print, capitalPerTrade, averageCapital, timeframe, dbPath, costConfig } =
    resolveRunStage2Config(deps);
  const symbols = universeFor(timeframe);

  const store = new Stage2HistoricalStore(deps.polygonClient, { timeframe, dbPath });

  await ingestUniverse(store, symbols, window, timeframe, print);

  // The window the data can actually support is not always the window asked
  // for (a Polygon plan serves bounded history) — intersected across symbols
  // so MinBTL's trial cap, a function of sample length, isn't overstated
  const effective = effectiveWindow(store, window, symbols);
  warnIfWindowNarrowed(window, effective, print);

  const costModel = new CostModelImpl(costConfig);
  const configTrialLog = new InMemoryConfigTrialLog();
  const ctx: ReplayContext = { store, costModel, window: effective, capitalPerTrade };

  const assetClasses = buildAssetClasses(ctx, timeframe);

  // #405: state the sizing before the run, not after 12 trials are spent
  const results = await runTrialGrid({
    assetClasses,
    window: effective,
    averageCapital,
    configTrialLog,
    // N is `selected.length`, not `limit` — they differ whenever the cap
    // doesn't bind, and printing `limit` would misreport what actually ran
    announceSizing: (sizing) =>
      print(
        `Stage 2: grid sized to N=${sizing.selected.length} from a ` +
          `${sizing.years.toFixed(1)}-year effective sample (the full cross-product asks ` +
          `for ${sizing.requested}; MinBTL supports ${sizing.limit}). ` +
          'Running across stocks + crypto...',
      ),
    // The gate run needs the CSCV pass — PBO has no configs x folds matrix to
    // rank across without it (#406)
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

/** Prints the full metrics suite per (config, asset class) plus the pass/kill decision */
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

/**
 * Entrypoint guard — only runs when this file is executed directly, not when
 * imported by a test.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Polygon (2y) unless `STAGE2_SOURCE=free-stack` asks for the ten-year free stack
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
  // The SHARED store (#375, #384): the Feedback Loop reads the frozen
  // selection at runtime; only a direct run freezes, tests stay a dry run
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
