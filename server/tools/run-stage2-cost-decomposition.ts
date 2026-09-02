/**
 * Stage 2 gross-vs-net cost decomposition.
 *
 * Answers the one question the 2026-08-05 Stage 2 kill left open
 * (docs/research/archive/2026-08-05-stage2-verdict-first-real-run.md, "Turnover,
 * not necessarily signal"): is a negative out-of-sample Sharpe in 22 of 24
 * (config, asset class) pairs a signal with no information in it, or a thin
 * gross edge churned 115–556 times over and eaten by `PESSIMISTIC_COST_CONFIG`?
 *
 * The two diagnoses point at different fixes, and — more expensively — at
 * different answers to whether buying deeper Polygon history is worth it. So
 * this runs the identical 12-config grid twice over the identical replay:
 * once scored net of modeled costs (reproducing the committed verdict) and
 * once scored gross of them (`GrossOfCostsTradeSource`).
 *
 * **The gross figures are not a "what if costs were lower" fantasy.** The
 * replay's trade path is provably cost-independent — entries, exits, stops,
 * targets and sizes are pure functions of bars and strategy config, and
 * nothing reads a fill price back into a decision. Adding modeled costs back
 * therefore reconstructs a genuinely frictionless run exactly;
 * `cost-attribution.test.ts` proves it by replaying against a zero-cost model
 * and comparing trade-for-trade.
 *
 * **Both sides go through the same `EvalExecutorImpl`** — same walk-forward
 * boundaries, same 50-bar embargo, same Lo annualization — and the gross OOS
 * Sharpe is built by the same `killLineChecks` as the net one. Anything less
 * would produce a gross number that is not comparable to the 0.5 kill line the
 * Stage 2 gate is defined on.
 *
 * **The window is pinned, not `new Date()`-relative.** `defaultFiveYearWindow`
 * moves every day, which would silently shift the effective window and stop
 * this decomposition lining up with the numbers in the committed verdict.
 *
 * Usage: `POLYGON_API_KEY=... node dist/server/tools/run-stage2-cost-decomposition.js`
 */
import {
  attributeRunCosts,
  type CostConfig,
  CostModelImpl,
  CRYPTO_PERIODS_PER_YEAR,
  type DateRange,
  DEFAULT_STAGE2_TIMEFRAME,
  EvalExecutorImpl,
  GrossOfCostsTradeSource,
  HttpPolygonClient,
  InMemoryConfigTrialLog,
  killLineChecks,
  type PolygonClient,
  type ReplayRunResult,
  type RunCostAttribution,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
  Stage2HistoricalStore,
  type TrialGridAssetClass,
  type TrialGridResult,
} from './backtest/index.js';
import {
  CRYPTO_SYMBOLS,
  costConfigFromEnv,
  DEFAULT_AVERAGE_CAPITAL,
  DEFAULT_CAPITAL_PER_TRADE,
  effectiveWindow,
  PESSIMISTIC_COST_CONFIG,
  STAGE2_PINNED_WINDOW,
  STOCK_SYMBOLS,
} from './run-stage2.js';
import { makeAssetClass } from './stage2-support.js';

/**
 * The exact window the committed 2026-08-05 verdict requested, to the
 * millisecond, so the effective window this intersects to — and therefore
 * every fold boundary — matches that run rather than merely resembling it.
 */
export const PINNED_VERDICT_WINDOW: DateRange = STAGE2_PINNED_WINDOW;

export interface CostDecompositionDeps {
  polygonClient: PolygonClient;
  window?: DateRange;
  /**
   * Scratch SQLite path. Defaults to a FILE rather than `:memory:` so a re-run
   * reuses the ingested bars instead of re-pulling six symbols from Polygon.
   */
  dbPath?: string;
  costConfig?: CostConfig;
  print?: (line: string) => void;
}

/** One (config, asset class) pair, scored both ways. */
export interface CostDecompositionRow {
  config_hash: string;
  asset_class: 'crypto' | 'stocks';
  label: string;
  net_oos_sharpe: number;
  gross_oos_sharpe: number;
  net_window_sharpe: number;
  gross_window_sharpe: number;
  net_profit_factor: number;
  gross_profit_factor: number;
  turnover: number;
  costs: RunCostAttribution;
}

export interface CostDecompositionResult {
  window: DateRange;
  rows: CostDecompositionRow[];
  /**
   * The discriminator, stated as a count rather than left to the reader: how
   * many pairs clear the 0.5 kill line once costs are removed. A grid that
   * fails net and also fails gross has no edge to defend; one that passes
   * gross and fails net is a cost problem.
   */
  passes_gross: number;
  passes_net: number;
  /** How the grid scores as the cost fixture is scaled down. See `COST_SCALES`. */
  sensitivity: CostSensitivityPoint[];
}

/** The grid's score under one scaling of every cost coefficient. */
export interface CostSensitivityPoint {
  /** Multiplier applied to all four coefficients of both asset classes. */
  scale: number;
  passes: number;
  stocks_bps: number;
  crypto_bps: number;
}

/**
 * The sensitivity ladder. `1` reproduces the committed verdict; `0` is the
 * gross case already computed. The rungs between exist because "gross beats
 * net" alone does not say how MUCH cheaper the fixture would have to be for
 * the grid to survive — which is the number that decides whether calibrating
 * the cost model is worth doing before anything else.
 */
export const COST_SCALES = [1, 0.5, 0.25, 0.1, 0.05] as const;

/**
 * Scales every cost coefficient of both asset classes by `factor`.
 *
 * Note this is NOT exactly linear in the resulting charge: `CostModelImpl`
 * applies a structural 1bp floor beneath the half-spread and the commission,
 * so far enough down the ladder the floor starts binding and the realized cost
 * stops falling proportionally. That is a property of the model, deliberately
 * preserved here rather than modeled around — each rung is re-run against the
 * real cost model instead of extrapolated arithmetically, so the reported bps
 * are what the model actually charged.
 *
 * `floors` and `venues` (#1000) are carried through UNSCALED, not dropped:
 * they are not among "every cost coefficient" this function's own docstring
 * scales, so silently omitting them would have quietly reset any caller's
 * floor override back to `DEFAULT_COST_FLOORS` at every rung. `PESSIMISTIC_COST_CONFIG`
 * (this file's own default) sets neither, so the default caller sees no
 * behaviour change from this.
 *
 * Copied, not aliased, same as every other field this function returns: a
 * caller mutating a scaled rung's `floors`/`venues` must not reach back into
 * the input `config` it was scaled from — `copyVenues` below does that
 * per-venue-object copy for `venues`.
 */
export function scaleCostConfig(config: CostConfig, factor: number): CostConfig {
  const scale = (c: CostConfig['crypto']): CostConfig['crypto'] => ({
    spreadVolatilityCoefficient: c.spreadVolatilityCoefficient * factor,
    commissionRate: c.commissionRate * factor,
    slippageCoefficient: c.slippageCoefficient * factor,
    impactK: c.impactK * factor,
  });
  return {
    crypto: scale(config.crypto),
    stocks: scale(config.stocks),
    ...(config.floors ? { floors: { ...config.floors } } : {}),
    ...(config.venues ? { venues: copyVenues(config.venues) } : {}),
  };
}

/** Shallow-copies each venue's override object so `venues` isn't aliased. */
function copyVenues(venues: NonNullable<CostConfig['venues']>): NonNullable<CostConfig['venues']> {
  const copy: NonNullable<CostConfig['venues']> = {};
  for (const venue of Object.keys(venues) as Array<keyof NonNullable<CostConfig['venues']>>) {
    const override = venues[venue];
    if (override) copy[venue] = { ...override };
  }
  return copy;
}

export async function runCostDecomposition(
  deps: CostDecompositionDeps,
): Promise<CostDecompositionResult> {
  const print = deps.print ?? console.log;
  const requested = deps.window ?? PINNED_VERDICT_WINDOW;
  const costConfig = deps.costConfig ?? PESSIMISTIC_COST_CONFIG;

  // DAILY, stated explicitly (#664): this script decomposes the costs of the
  // recorded daily verdict runs, so it must keep replaying what they replayed.
  const store = new Stage2HistoricalStore(deps.polygonClient, {
    timeframe: DEFAULT_STAGE2_TIMEFRAME,
    dbPath: deps.dbPath ?? 'stage2-cost-decomposition.sqlite',
  });

  print(
    `Stage 2 cost decomposition: ingesting over ${requested.start.toISOString()} .. ` +
      `${requested.end.toISOString()}`,
  );
  for (const symbol of [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS]) {
    await store.ingest(symbol, requested);
    print(`  ${symbol}: ${store.bars(symbol, requested).length} bars`);
  }

  const window = effectiveWindow(store, requested);
  print(
    `Effective window: ${window.start.toISOString().slice(0, 10)} .. ` +
      `${window.end.toISOString().slice(0, 10)}`,
  );

  const costModel = new CostModelImpl(costConfig);
  const build = (): TrialGridAssetClass[] => [
    makeAssetClass(
      { store, costModel, window, capitalPerTrade: DEFAULT_CAPITAL_PER_TRADE },
      'stocks',
      STOCK_SYMBOLS,
      STOCK_PERIODS_PER_YEAR,
    ),
    makeAssetClass(
      { store, costModel, window, capitalPerTrade: DEFAULT_CAPITAL_PER_TRADE },
      'crypto',
      CRYPTO_SYMBOLS,
      CRYPTO_PERIODS_PER_YEAR,
    ),
  ];

  // The net pass also captures each replay, in grid order, so costs can be
  // attributed afterwards from the same runs the metrics were computed on
  // rather than from a third replay that might not be identical.
  const runs: ReplayRunResult[] = [];
  print('Scoring the 12-config grid NET of costs (reproducing the committed verdict)...');
  const net = await runTrialGrid({
    assetClasses: build(),
    window,
    averageCapital: DEFAULT_AVERAGE_CAPITAL,
    configTrialLog: new InMemoryConfigTrialLog(),
    makeEvaluator: (run) => {
      runs.push(run);
      return new EvalExecutorImpl({ source: run.trades, timeline: run.timeline });
    },
  });

  print('Scoring the same grid GROSS of costs...');
  const gross = await runTrialGrid({
    assetClasses: build(),
    window,
    averageCapital: DEFAULT_AVERAGE_CAPITAL,
    configTrialLog: new InMemoryConfigTrialLog(),
    makeEvaluator: (run) =>
      new EvalExecutorImpl({
        source: new GrossOfCostsTradeSource(run.trades),
        timeline: run.timeline,
      }),
  });

  // The three arrays are aligned by construction — `runTrialGrid` calls
  // `makeEvaluator` exactly once per pushed result, in grid order, and both
  // passes iterate the same grid over the same asset classes. Asserted rather
  // than assumed, because a misalignment would attribute one config's costs to
  // another's Sharpe and be invisible in the output.
  if (net.length !== gross.length || net.length !== runs.length) {
    throw new Error(
      `Cost decomposition: net/gross/replay counts disagree (${net.length}/${gross.length}/` +
        `${runs.length}) — the rows cannot be aligned.`,
    );
  }

  const netChecks = killLineChecks(net);
  const grossChecks = killLineChecks(gross);
  const rows: CostDecompositionRow[] = [];

  for (const [i, result] of net.entries()) {
    const grossResult = gross[i] as TrialGridResult;
    const netCheck = netChecks[i] as (typeof netChecks)[number];
    const grossCheck = grossChecks[i] as (typeof grossChecks)[number];

    if (result.config_hash !== grossResult.config_hash) {
      throw new Error(
        `Cost decomposition: row ${i} pairs config ${result.config_hash} against ` +
          `${grossResult.config_hash} — the two passes did not run the same grid order.`,
      );
    }

    rows.push({
      config_hash: result.config_hash,
      asset_class: result.asset_class,
      label:
        `fast=${result.config.fastWindow} slow=${result.config.slowWindow} ` +
        `stop=${result.config.atrStopMult} target=${result.config.atrTargetMult}`,
      net_oos_sharpe: netCheck.oos_sharpe,
      gross_oos_sharpe: grossCheck.oos_sharpe,
      net_window_sharpe: netCheck.window_sharpe,
      gross_window_sharpe: grossCheck.window_sharpe,
      net_profit_factor: result.report.window.profit_factor,
      gross_profit_factor: grossResult.report.window.profit_factor,
      turnover: result.report.window.turnover,
      costs: await attributeRunCosts(
        (runs[i] as ReplayRunResult).trades,
        window,
        costConfig[result.asset_class].slippageCoefficient,
      ),
    });
  }

  print('Sweeping the cost fixture down to find what the grid can bear...');
  const sensitivity: CostSensitivityPoint[] = [];
  for (const scale of COST_SCALES) {
    const scaled = scaleCostConfig(costConfig, scale);
    const scaledRuns: ReplayRunResult[] = [];
    const scaledModel = new CostModelImpl(scaled);
    const results = await runTrialGrid({
      assetClasses: [
        makeAssetClass(
          { store, costModel: scaledModel, window, capitalPerTrade: DEFAULT_CAPITAL_PER_TRADE },
          'stocks',
          STOCK_SYMBOLS,
          STOCK_PERIODS_PER_YEAR,
        ),
        makeAssetClass(
          { store, costModel: scaledModel, window, capitalPerTrade: DEFAULT_CAPITAL_PER_TRADE },
          'crypto',
          CRYPTO_SYMBOLS,
          CRYPTO_PERIODS_PER_YEAR,
        ),
      ],
      window,
      averageCapital: DEFAULT_AVERAGE_CAPITAL,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: (run) => {
        scaledRuns.push(run);
        return new EvalExecutorImpl({ source: run.trades, timeline: run.timeline });
      },
    });

    // Averaged per asset class so the reported rate is the grid's, not one
    // arbitrarily-chosen config's.
    const bps = { stocks: [] as number[], crypto: [] as number[] };
    for (const [i, result] of results.entries()) {
      const attribution = await attributeRunCosts(
        (scaledRuns[i] as ReplayRunResult).trades,
        window,
      );
      bps[result.asset_class].push(attribution.bps_of_notional);
    }
    const mean = (xs: number[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

    sensitivity.push({
      scale,
      passes: killLineChecks(results).filter((c) => c.passes_oos_sharpe_line).length,
      stocks_bps: mean(bps.stocks),
      crypto_bps: mean(bps.crypto),
    });
  }

  const decomposition: CostDecompositionResult = {
    window,
    rows,
    passes_gross: grossChecks.filter((c) => c.passes_oos_sharpe_line).length,
    passes_net: netChecks.filter((c) => c.passes_oos_sharpe_line).length,
    sensitivity,
  };

  printReport(decomposition, print);
  return decomposition;
}

function printReport(result: CostDecompositionResult, print: (line: string) => void): void {
  print('');
  print('=== Gross vs net, per (config, asset class) ===');
  for (const row of result.rows) {
    print(`[${row.asset_class}] ${row.label} (${row.config_hash})`);
    print(
      `    oos_sharpe   net=${row.net_oos_sharpe.toFixed(3)} gross=${row.gross_oos_sharpe.toFixed(3)}`,
    );
    print(
      `    window_sharpe net=${row.net_window_sharpe.toFixed(3)} gross=${row.gross_window_sharpe.toFixed(3)}`,
    );
    print(
      `    profit_factor net=${row.net_profit_factor.toFixed(3)} gross=${row.gross_profit_factor.toFixed(3)}` +
        ` turnover=${row.turnover.toFixed(1)}`,
    );
    print(
      `    costs: total=${row.costs.total.toFixed(0)} spread=${row.costs.spread.toFixed(0)} ` +
        `slippage=${row.costs.slippage.toFixed(0)} impact=${row.costs.market_impact.toFixed(0)} ` +
        `commission=${row.costs.commission.toFixed(0)}`,
    );
    print(
      `    cost rate: ${row.costs.bps_of_notional.toFixed(1)}bps of notional over ` +
        `${row.costs.trades} trades` +
        (row.costs.mean_adverse_move_in_atr === undefined
          ? ''
          : `, ${row.costs.mean_adverse_move_in_atr.toFixed(3)} ATR adverse move per fill`),
    );
  }

  print('');
  print('=== Cost sensitivity (pairs clearing the 0.5 OOS Sharpe line) ===');
  for (const point of result.sensitivity) {
    print(
      `  cost×${point.scale.toString().padEnd(5)} passes=${point.passes}/${result.rows.length} ` +
        `stocks=${point.stocks_bps.toFixed(1)}bps crypto=${point.crypto_bps.toFixed(1)}bps`,
    );
  }
  print(`  cost×0     passes=${result.passes_gross}/${result.rows.length} (gross)`);

  print('');
  print('=== Discriminator ===');
  print(
    `pairs clearing the 0.5 OOS Sharpe kill line:  net=${result.passes_net}/${result.rows.length} gross=${result.passes_gross}/${result.rows.length}`,
  );
  print(
    result.passes_gross > result.passes_net
      ? 'Removing modeled costs rescues configs: the net kill is at least partly COST DRAG.'
      : 'Removing modeled costs rescues nothing: the kill is the SIGNAL, not the cost model.',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCostDecomposition({
    polygonClient: new HttpPolygonClient(),
    costConfig: costConfigFromEnv(),
  }).catch((error: unknown) => {
    console.error('Cost decomposition failed:', error);
    process.exitCode = 1;
  });
}
