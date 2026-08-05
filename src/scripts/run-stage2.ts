/**
 * Stage 2 runner (ticket #266) — see
 * docs/specs/stage2-validation-execution-spec.md and wayfinder map #154
 * (decisions #155/#157). One-shot (re-runnable) glue: ingests real Polygon
 * OHLCV for the MVP universe, runs the 12-config grid across stock and
 * crypto asset classes, and renders the Stage 2 overfitting verdict.
 *
 * **Ops/setup, not new design.** Every seam this wires already exists and is
 * tested (`Stage2HistoricalStore` #241, `ReplayDriver` #243, `runTrialGrid`
 * #244, `renderStage2Verdict` #245). `HttpPolygonClient` (#266,
 * `../cost-model-backtest/http-polygon-client.js`) is the one new piece of
 * logic this file's neighbor supplies; this file only sequences calls.
 *
 * **Not exercised against live Polygon traffic.** This sandboxed environment
 * has no network access, so the real ~5-year, 6-symbol ingestion this script
 * is built to run has never actually executed here. `runStage2` is unit-
 * tested against a fake `PolygonClient` (`run-stage2.test.ts`) to verify the
 * wiring/typechecking is correct; running it for real against Polygon and
 * producing a written Stage 2 verdict is a follow-up manual/ops step — see
 * #245's still-open AC2/4/5, which this ticket does not attempt to close.
 *
 * Usage: `POLYGON_API_KEY=... npx tsc -p tsconfig.json && node dist/scripts/run-stage2.js`
 * (or wire an `npm run stage2` script once this has been run for real once).
 */
import {
  type CostConfig,
  CostModelImpl,
  CRYPTO_PERIODS_PER_YEAR,
  type DateRange,
  HttpPolygonClient,
  InMemoryConfigTrialLog,
  type PolygonClient,
  ReplayDriver,
  renderStage2Verdict,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
  Stage2HistoricalStore,
  type Stage2Verdict,
  type TrialGridAssetClass,
  type TrialGridResult,
} from '../cost-model-backtest/index.js';
import { SimulatedClock } from '../shared/index.js';

/** The fixed MVP universe (CLAUDE.md "Broker Plan" / spec "User Stories"). */
export const STOCK_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'TSLA'] as const;
export const CRYPTO_SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;

const FIVE_YEARS_MS = 5 * 365 * 86_400_000;
const DEFAULT_CAPITAL_PER_TRADE = 10_000;
const DEFAULT_AVERAGE_CAPITAL = 10_000;

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

/** Default window: the last 5 years, ending "now" — the spec's Starter-tier depth. */
export function defaultFiveYearWindow(now: Date = new Date()): DateRange {
  return { start: new Date(now.getTime() - FIVE_YEARS_MS), end: now };
}

export interface RunStage2Deps {
  polygonClient: PolygonClient;
  window?: DateRange;
  /** Scratch SQLite path for `Stage2HistoricalStore`. Defaults to `:memory:`. */
  dbPath?: string;
  capitalPerTrade?: number;
  averageCapital?: number;
  costConfig?: CostConfig;
  /** Sink for the printed report — defaults to `console.log`. */
  print?: (line: string) => void;
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
 * The sub-window of `requested` that EVERY symbol actually has bars for.
 *
 * Intersected, not unioned: the grid replays one universe per asset class, and
 * a fold whose range predates a symbol's first bar is what produced the
 * `toReturnSeries: no bars in the sample` abort on the first live run. Taking
 * the latest first-bar and earliest last-bar across symbols gives the range
 * where the whole universe is present.
 *
 * A symbol with NO bars at all is a hard failure, not a narrowing: silently
 * dropping it would change what the verdict is a verdict ABOUT. So is an
 * EMPTY intersection (start >= end), which is what disjoint coverage across
 * symbols produces — one symbol's history ending before another's begins.
 * Returning an inverted range there would hand replay/folds/MinBTL a window
 * they cannot sample, reproducing the same opaque `toReturnSeries` abort this
 * function exists to prevent, just one layer further down.
 *
 * Bar bounds are computed by min/max rather than by taking `bars[0]` and
 * `bars.at(-1)`: `Stage2HistoricalStore.bars` does `ORDER BY close_time ASC`
 * today, but the structural parameter type above cannot state that, and a
 * store that ever returned bars unordered would silently mis-narrow the
 * window rather than fail.
 */
export function effectiveWindow(
  store: { bars: (symbol: string, window: DateRange) => Array<{ close_time: Date }> },
  requested: DateRange,
): DateRange {
  let start = requested.start;
  let end = requested.end;

  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
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

/** One asset class's fixed symbol/periodsPerYear pairing this script drives. */
function makeAssetClass(
  ctx: ReplayContext,
  asset_class: 'stocks' | 'crypto',
  symbols: readonly string[],
  periodsPerYear: number,
): TrialGridAssetClass {
  return {
    asset_class,
    periodsPerYear,
    makeRunner: () =>
      new ReplayDriver({
        barSource: ctx.store,
        timeline: ctx.store,
        registry: ctx.store,
        costModel: ctx.costModel,
        clock: new SimulatedClock(ctx.window.start),
        universe: symbols.map((symbol) => ({ symbol, asset_class })),
        capitalPerTrade: ctx.capitalPerTrade,
      }),
  };
}

/**
 * Ingests the full MVP universe, runs the 12-config grid across stocks and
 * crypto, and renders the Stage 2 verdict. Returns the verdict (and prints
 * the full metrics suite per config plus the pass/kill decision via
 * `deps.print`) so a caller/test can assert on the structured result without
 * scraping stdout.
 */
export async function runStage2(deps: RunStage2Deps): Promise<Stage2Verdict> {
  const window = deps.window ?? defaultFiveYearWindow();
  const print = deps.print ?? console.log;
  const capitalPerTrade = deps.capitalPerTrade ?? DEFAULT_CAPITAL_PER_TRADE;
  const averageCapital = deps.averageCapital ?? DEFAULT_AVERAGE_CAPITAL;

  const store = new Stage2HistoricalStore(deps.polygonClient, deps.dbPath ?? ':memory:');

  print(
    `Stage 2: ingesting ${STOCK_SYMBOLS.length + CRYPTO_SYMBOLS.length} MVP-universe symbols ` +
      `over ${window.start.toISOString()} .. ${window.end.toISOString()}`,
  );
  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
    await store.ingest(symbol, window);
    const barCount = store.bars(symbol, window).length;
    print(`  ingested ${symbol}: ${barCount} bars`);
  }

  // The window the data can actually support, which is NOT always the window
  // asked for: a Polygon plan serves a bounded history, and the first real run
  // of this script (2026-08-05) asked for 5 years and received 2 — 501 stock
  // bars, earliest 2024-08-06. Replaying the requested window against that
  // produced `toReturnSeries: no bars in the sample` from inside the first
  // fold, an opaque failure four layers down from its cause.
  //
  // So the effective window is INTERSECTED across symbols and everything
  // downstream — replay, folds, and crucially MinBTL — runs on it. MinBTL's
  // trial cap is a function of sample length, so computing it over a window
  // the data does not cover would overstate how many configs the sample can
  // support, which is the one number in this verdict that exists to prevent
  // exactly that kind of overfitting.
  // Warn when EITHER boundary moved, naming which. A provider whose history
  // lags the request narrows the END instead of the start (stale or partial
  // vendor data), and warning only on the start would let that shrink the
  // sample invisibly — the run output would read as a full-window run.
  const effective = effectiveWindow(store, window);
  const narrowedStart = effective.start.getTime() > window.start.getTime();
  const narrowedEnd = effective.end.getTime() < window.end.getTime();
  if (narrowedStart || narrowedEnd) {
    const narrowing: string[] = [];
    if (narrowedStart) {
      narrowing.push(
        `requested a start of ${window.start.toISOString().slice(0, 10)} but the data starts ` +
          `${effective.start.toISOString().slice(0, 10)}`,
      );
    }
    if (narrowedEnd) {
      narrowing.push(
        `requested an end of ${window.end.toISOString().slice(0, 10)} but the data ends ` +
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

  const costModel = new CostModelImpl(deps.costConfig ?? PESSIMISTIC_COST_CONFIG);
  const configTrialLog = new InMemoryConfigTrialLog();
  const ctx: ReplayContext = { store, costModel, window: effective, capitalPerTrade };

  const stocks = makeAssetClass(ctx, 'stocks', STOCK_SYMBOLS, STOCK_PERIODS_PER_YEAR);
  const crypto = makeAssetClass(ctx, 'crypto', CRYPTO_SYMBOLS, CRYPTO_PERIODS_PER_YEAR);

  print('Stage 2: running the 12-config trial grid across stocks + crypto...');
  const results = await runTrialGrid({
    assetClasses: [stocks, crypto],
    window: effective,
    averageCapital,
    configTrialLog,
  });

  const verdict = renderStage2Verdict({
    results,
    distinctTrialCount: configTrialLog.distinctTrialCount(),
    window: effective,
  });

  printReport(results, verdict, print);

  return verdict;
}

/** Prints the full metrics suite per (config, asset class) plus the pass/kill decision. */
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
    for (const split of result.report.splits) {
      print(`    fold sharpe=${split.metrics.sharpe.toFixed(3)}`);
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
  print(JSON.stringify(verdict.dsr_note));

  print('');
  print(`=== Stage 2 VERDICT: ${verdict.overall_pass ? 'PASS' : 'KILL/INCOMPLETE'} ===`);
}

/**
 * Entrypoint guard — only runs when this file is executed directly (`node
 * dist/scripts/run-stage2.js`), not when imported by a test. Mirrors
 * `src/orchestrator/index.ts` / `src/dashboard/index.ts`'s split between an
 * exported, testable function and a thin top-level invocation.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const polygonClient = new HttpPolygonClient();
  runStage2({ polygonClient }).catch((error: unknown) => {
    console.error('Stage 2 run failed:', error);
    process.exitCode = 1;
  });
}
