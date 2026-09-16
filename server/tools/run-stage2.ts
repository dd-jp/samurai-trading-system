/**
 * Stage 2 runner — see docs/specs/stage2-validation-execution-spec.md.
 * One-shot (re-runnable) glue: ingests real Polygon OHLCV for the MVP
 * universe, runs the 12-config grid across stock and crypto asset classes,
 * and renders the Stage 2 overfitting verdict. Every seam it wires already
 * exists and is tested; this file only sequences calls.
 *
 * Not exercised against live Polygon traffic: this sandboxed environment has
 * no network access, so the real ~5-year, 6-symbol ingestion has never
 * actually run here. `runStage2` is unit-tested against a fake
 * `PolygonClient` (`run-stage2.test.ts`) to verify wiring/typechecking only —
 * running it for real and producing a written verdict is a follow-up
 * manual/ops step.
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
 * `PESSIMISTIC_CONFIG` fixture, the only asset-class cost values this repo
 * has settled on so far. Overridable via `RunStage2Deps.costConfig` once a
 * real config is decided; using the same fixture here keeps this script's
 * numbers directly comparable to the unit-tested cost model behaviour.
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
 * schedules. See docs/research/archive/2026-08-05-cost-model-calibration.md.
 *
 * spreadVolatilityCoefficient — MEASURED: median spread/ATR14 from real
 * Alpaca quotes sampled in the five minutes before each bar's close (where
 * the replay fills); the fitted per-asset-class medians are used here.
 *
 * commissionRate — PUBLISHED: Alpaca's crypto taker fee (0.25%,
 * docs.alpaca.markets/docs/crypto-fees) and equities' commission-free rate
 * (0, relying on `CostModelImpl`'s structural 1bp floor for the real
 * SEC/FINRA-TAF/CAT pass-through).
 *
 * slippageCoefficient — ASSUMPTION: derived as
 * `spreadVolatilityCoefficient / 4` since slippage can't be measured without
 * live fills. Replace with a measured figure once the paper soak produces
 * fills to compare modeled against realized.
 *
 * impactK — UNCHANGED: negligible at $10k/trade in this universe (54 of
 * 62,393 currency units in the worst decomposition row), no measurement
 * basis to revise it.
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
 * The same calibration, fitted at the INTRADAY replay resolution.
 * `CALIBRATED_COST_CONFIG` fits `spreadVolatilityCoefficient` against daily
 * ATR14, but `CostModelImpl` consumes it against whatever bars the run
 * replays — a ratio fitted at one resolution and consumed at another is a
 * category error, which is why this config exists.
 *
 * spreadVolatilityCoefficient — MEASURED at 1-minute resolution: real Alpaca
 * SIP quotes sampled in the minute ending at each 1-minute bar close, against
 * 1-minute ATR14, not the daily coefficient rescaled by arithmetic. See
 * docs/research/53-intraday-cost-calibration.md.
 *
 * commissionRate — PUBLISHED, unchanged: nothing about resolution changes a
 * fee schedule.
 *
 * slippageCoefficient — ASSUMPTION: the same `spreadVolatilityCoefficient / 4`
 * rule as the daily config.
 *
 * impactK — UNCHANGED: its smallness basis shrinks further at minute
 * resolution, so there is no reason to revise it.
 *
 * crypto — the PESSIMISTIC fixture, deliberately not the calibrated one: an
 * intraday run is equities-only (`universeFor`), so this branch is
 * unreachable; if ever reached, it over-charges rather than flatters.
 */
export const CALIBRATED_INTRADAY_COST_CONFIG: CostConfig = {
  crypto: PESSIMISTIC_COST_CONFIG.crypto,
  stocks: {
    spreadVolatilityCoefficient: 0.0697,
    commissionRate: 0,
    slippageCoefficient: 0.017425,
    impactK: 0.05,
  },
  // Layered via `venues` rather than `stocks.commissionRate` (kept 0 for the
  // Alpaca-priced legs this config also serves): the intraday stocks replay
  // stamps `MarketState.venue = 'saxo'` (`runStage2` below), so 8bps a side
  // (ADR-0015) is what an intraday run now charges.
  venues: { saxo: { commissionRate: SAXO_COMMISSION_RATE } },
};

/**
 * Which cost config a direct run uses. `SAMURAI_STAGE2_COST_CONFIG=pessimistic`
 * re-runs against the old fixture for comparison; the calibrated one is the
 * default because it is the one with a stated basis for every number.
 *
 * Daily only — kept at this signature because `run-stage2-cost-decomposition.ts`
 * calls it and is pinned to `STAGE2_PINNED_WINDOW` at daily resolution, so
 * changing what it selects would silently move a recorded result. A run
 * that knows its timeframe should call `costConfigFor`.
 */
export function costConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CostConfig {
  return env.SAMURAI_STAGE2_COST_CONFIG?.trim() === 'pessimistic'
    ? PESSIMISTIC_COST_CONFIG
    : CALIBRATED_COST_CONFIG;
}

/**
 * The cost config for a run at `timeframe` — the timeframe-keyed shape,
 * following `periodsPerYearFor(assetClass, timeframe)` and the
 * timeframe-scoped historical store.
 *
 * Composes with `costConfigFromEnv` rather than replacing it: the
 * `pessimistic` escape hatch still wins, since a run asking for the
 * uncalibrated fixture wants a comparison at every resolution.
 *
 * Every non-daily timeframe gets the 1-minute fit, which OVER-charges
 * coarser ones (ATR grows with bar length, quoted spread doesn't) —
 * deliberate, since a single over-charging coefficient beats an unmeasured
 * per-timeframe ladder, and the product's replay resolution is 1m.
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
 * The exact window the 2026-08-05 verdict requested, to the millisecond.
 *
 * A direct run uses this rather than `defaultFiveYearWindow()`, which reads
 * `new Date()` and therefore shifts the effective window — and every
 * walk-forward fold boundary — on each new day. A gate verdict that cannot
 * be reproduced tomorrow is not evidence.
 *
 * Defined in `stage2-source.ts` alongside the free stack's ten-year window,
 * and re-exported here so other callers keep importing it from where they
 * always have.
 */
export { STAGE2_FREE_STACK_WINDOW, STAGE2_PINNED_WINDOW } from './stage2-source.js';

/**
 * Where a DIRECT run keeps its ingested bars.
 *
 * Not `:memory:`: every run would otherwise start from an empty database and
 * re-pull the whole five-year window from the vendor. Persisting it is the
 * load-bearing precondition for the free-data decision — a free, no-SLA
 * source is only acceptable if history survives on disk.
 *
 * Deliberately NOT `sharedStorePath()`: this is research scratch with a
 * private schema, and the shared store holds live run state — the two must
 * not share a file. `runStage2`'s own default stays `:memory:`, which keeps
 * tests from touching the filesystem or reading each other's bars.
 */
export const STAGE2_SCRATCH_DB_PATH = 'data/stage2-bars.sqlite';

export interface RunStage2Deps {
  polygonClient: PolygonClient;
  window?: DateRange;
  /** Scratch SQLite path for `Stage2HistoricalStore`. Defaults to `:memory:`. */
  dbPath?: string;
  capitalPerTrade?: number;
  averageCapital?: number;
  /**
   * The bar resolution to ingest and replay. Defaults to `'1d'`.
   * An intraday value makes this an EQUITIES-ONLY run — see `universeFor`.
   */
  timeframe?: string;
  costConfig?: CostConfig;
  /** Sink for the printed report — defaults to `console.log` */
  print?: (line: string) => void;
  /**
   * Where the run's selected config is frozen — the SHARED store, not the
   * scratch one `dbPath` opens: the Feedback Loop reads it at runtime, and a
   * verdict written to a research scratch file would be a verdict nobody can
   * act on.
   *
   * Optional: a caller that supplies none is doing a dry run, and writing to
   * a database it did not ask for would be the surprising behaviour.
   */
  selections?: { record(selection: Stage2Selection): void };
  /** Stamps the selection; defaults to wall clock. Injected so a test can pin it. */
  now?: () => Date;
}

/**
 * The run's shared replay context — identical across every asset class this
 * script builds (`store`, `costModel`, `window`, `capitalPerTrade`). Bundled
 * so `makeAssetClass` takes one context plus the three fields that actually
 * vary per asset class, instead of the same four values traveling as
 * separate positional params on every call.
 */
interface ReplayContext {
  store: Stage2HistoricalStore;
  costModel: CostModelImpl;
  window: DateRange;
  capitalPerTrade: number;
}

/**
 * Which symbols a run of `timeframe` covers.
 *
 * Daily runs keep the full six-symbol MVP universe, unchanged. An INTRADAY
 * run is equities-only: crypto left Samurai's scope (ADR-0015's amendment),
 * and `FreeStackAggregatesClient`'s Coinbase leg refuses any non-daily
 * request. Narrowing here rather than letting that throw makes the scope
 * decision legible at the runner.
 */
export function universeFor(timeframe: string): readonly string[] {
  return isDailyTimeframe(timeframe) ? [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS] : [...STOCK_SYMBOLS];
}

/**
 * Bar bounds are computed by min/max rather than by taking `bars[0]` and
 * `bars.at(-1)`: `Stage2HistoricalStore.bars` does `ORDER BY close_time ASC`
 * today, but this function's structural parameter type cannot state that, and
 * a store that ever returned bars unordered would silently mis-narrow the
 * window rather than fail
 */
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

/**
 * The sub-window of `requested` that EVERY symbol actually has bars for.
 *
 * Intersected, not unioned: the grid replays one universe per asset class,
 * and a fold whose range predates a symbol's first bar produced the
 * `toReturnSeries: no bars in the sample` abort on the first live run.
 *
 * A symbol with NO bars at all is a hard failure, not a narrowing — silently
 * dropping it would change what the verdict is a verdict ABOUT. So is an
 * EMPTY intersection (start >= end): disjoint coverage across symbols would
 * otherwise hand replay/folds/MinBTL a window they cannot sample.
 */
export function effectiveWindow(
  store: { bars: (symbol: string, window: DateRange) => Array<{ close_time: Date }> },
  requested: DateRange,
  /** Defaults to the full daily universe */
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

/** One asset class's fixed symbol/periodsPerYear pairing this script drives */

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
 * Warn when EITHER boundary moved, naming which. A provider whose history
 * lags the request narrows the END instead of the start (stale or partial
 * vendor data), and warning only on the start would let that shrink the
 * sample invisibly — the run output would read as a full-window run
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
 * `periodsPerYearFor`, not the daily constants: `periodsPerYear` is the
 * annualization base for every Sharpe in the suite, so a 1-minute replay
 * annualized off 252 understates it by ~sqrt(390).
 *
 * An intraday run is the LSE-ETP universe replayed on its US proxy
 * (ADR-0016) and its live venue is Saxo, so its stocks legs price at
 * `CALIBRATED_INTRADAY_COST_CONFIG.venues.saxo`. Daily runs stay
 * Alpaca-priced: `CALIBRATED_COST_CONFIG` carries no `venues` and the
 * pinned daily results must not move.
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
 * Freeze the selection.
 *
 * Without this the run is a printout: the trial log was in-memory, so
 * nothing survived the process that computed it, and the Feedback Loop had
 * neither a backtest Sharpe to measure divergence against nor a
 * `revalidation` snapshot to evaluate PBO/OOS-Sharpe/DSR with.
 *
 * Optional, and absent in the unit tests: a caller that supplies no store is
 * doing a dry run, and writing to a database it did not ask for would be the
 * surprising behaviour.
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
 * crypto, and renders the Stage 2 verdict. Returns the verdict (and prints
 * the full metrics suite per config plus the pass/kill decision via
 * `deps.print`) so a caller/test can assert on the structured result without
 * scraping stdout.
 */
export async function runStage2(deps: RunStage2Deps): Promise<Stage2Verdict> {
  const { window, print, capitalPerTrade, averageCapital, timeframe, dbPath, costConfig } =
    resolveRunStage2Config(deps);
  const symbols = universeFor(timeframe);

  const store = new Stage2HistoricalStore(deps.polygonClient, { timeframe, dbPath });

  await ingestUniverse(store, symbols, window, timeframe, print);

  // The window the data can actually support, which is NOT always the window
  // asked for: a Polygon plan serves a bounded history, and replaying the
  // requested window against a shorter one produces an opaque
  // `toReturnSeries: no bars in the sample` failure inside the first fold.
  //
  // So the effective window is INTERSECTED across symbols and everything
  // downstream — replay, folds, and MinBTL — runs on it. MinBTL's trial cap
  // is a function of sample length, so computing it over an uncovered window
  // would overstate how many configs the sample can support.
  const effective = effectiveWindow(store, window, symbols);
  warnIfWindowNarrowed(window, effective, print);

  const costModel = new CostModelImpl(costConfig);
  const configTrialLog = new InMemoryConfigTrialLog();
  const ctx: ReplayContext = { store, costModel, window: effective, capitalPerTrade };

  const assetClasses = buildAssetClasses(ctx, timeframe);

  // State the sizing POSITIVELY, before the run, rather than reporting
  // `exceeded: true` after 12 trials have already been spent. The cap exists
  // to constrain the search; a reader should see what it constrained it to.
  const results = await runTrialGrid({
    assetClasses,
    window: effective,
    averageCapital,
    configTrialLog,
    // Printed from INSIDE the run, off the sizing it actually used, rather
    // than a second `sizeTrialGridToSample` call here — a verdict's audit
    // trail should report what ran, not something computed alongside it.
    //
    // N is `selected.length`, NOT `limit`: they differ whenever the cap
    // does not bind, e.g. a 5-year window supporting ~45 trials against a
    // 12-config cross-product, where printing `limit` would announce a
    // 45-config grid and then run 12.
    announceSizing: (sizing) =>
      print(
        `Stage 2: grid sized to N=${sizing.selected.length} from a ` +
          `${sizing.years.toFixed(1)}-year effective sample (the full cross-product asks ` +
          `for ${sizing.requested}; MinBTL supports ${sizing.limit}). ` +
          'Running across stocks + crypto...',
      ),
    // The gate run is the one caller that needs the CSCV pass: without it
    // PBO has no configs x folds matrix to rank across and the verdict can
    // only refuse. Costs a second evaluate() per pair over the same replay.
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
 * Entrypoint guard — only runs when this file is executed directly (`node
 * dist/server/tools/run-stage2.js`), not when imported by a test. Mirrors
 * `server/apps/orchestrator/index.ts` / `server/apps/service-api/index.ts`'s split between an
 * exported, testable function and a thin top-level invocation.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Polygon (2y) unless `STAGE2_SOURCE=free-stack` asks for the ten-year free
  // stack — see `stage2-source.ts` for why the old path stays the default
  const {
    client: polygonClient,
    window: runWindow,
    label,
    // Read from `STAGE2_TIMEFRAME` (default '1d'), so a direct run — the
    // only real caller of this script — is what drives an intraday replay.
    // `STAGE2_TIMEFRAME=1m STAGE2_SOURCE=free-stack` is the intended intraday
    // invocation.
    timeframe: runTimeframe,
  } = resolveStage2Source();
  console.log(
    `Stage 2 source: ${label} at ${runTimeframe} over ${runWindow.start.toISOString()} .. ` +
      `${runWindow.end.toISOString()}`,
  );
  // Stated explicitly at the entrypoint rather than by changing `runStage2`'s
  // own default, so every existing caller and test keeps the cost config it
  // was written against and only a direct run picks up the calibrated one.
  // The SHARED store, not the scratch `dbPath` this script opens for bars:
  // the Feedback Loop reads the frozen selection at runtime, and a verdict
  // written to a research scratch file is a verdict nobody can act on. A
  // direct run is the only caller that freezes; `runStage2`'s own tests pass
  // no store and stay a dry run.
  const shared = openSharedStore(sharedStorePath());
  runStage2({
    polygonClient,
    // Keyed on the run's timeframe: a daily-fitted spread/ATR ratio consumed
    // against per-minute volatility is the defect this avoids.
    costConfig: costConfigFor(runTimeframe),
    window: runWindow,
    timeframe: runTimeframe,
    // Stated here rather than by changing `runStage2`'s `:memory:` default,
    // so only a direct run persists bars and every existing caller and test
    // keeps the isolated in-memory store it was written against.
    dbPath: STAGE2_SCRATCH_DB_PATH,
    selections: new SqliteStage2SelectionStore(shared),
  }).catch((error: unknown) => {
    console.error('Stage 2 run failed:', error);
    process.exitCode = 1;
  });
}
