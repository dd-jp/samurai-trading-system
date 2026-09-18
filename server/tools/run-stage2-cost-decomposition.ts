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

const PINNED_VERDICT_WINDOW: DateRange = STAGE2_PINNED_WINDOW;

interface CostDecompositionDeps {
  polygonClient: PolygonClient;
  window?: DateRange;
  dbPath?: string;
  costConfig?: CostConfig;
  print?: (line: string) => void;
}

interface CostDecompositionRow {
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

interface CostDecompositionResult {
  window: DateRange;
  rows: CostDecompositionRow[];
  passes_gross: number;
  passes_net: number;
  sensitivity: CostSensitivityPoint[];
}

interface CostSensitivityPoint {
  scale: number;
  passes: number;
  stocks_bps: number;
  crypto_bps: number;
}

const COST_SCALES = [1, 0.5, 0.25, 0.1, 0.05] as const;

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
    ...(config.venues ? { venues: scaleVenues(config.venues, factor) } : {}),
  };
}

function scaleVenues(
  venues: NonNullable<CostConfig['venues']>,
  factor: number,
): NonNullable<CostConfig['venues']> {
  const copy: NonNullable<CostConfig['venues']> = {};
  for (const venue of Object.keys(venues) as Array<keyof NonNullable<CostConfig['venues']>>) {
    const override = venues[venue];
    if (!override) continue;
    const scaled: Partial<CostConfig['crypto']> = {};
    for (const field of Object.keys(override) as Array<keyof CostConfig['crypto']>) {
      const value = override[field];
      if (value !== undefined) scaled[field] = value * factor;
    }
    copy[venue] = scaled;
  }
  return copy;
}

async function ingestSymbols(
  store: Stage2HistoricalStore,
  symbols: readonly string[],
  window: DateRange,
  print: (line: string) => void,
): Promise<void> {
  for (const symbol of symbols) {
    await store.ingest(symbol, window);
    print(`  ${symbol}: ${store.bars(symbol, window).length} bars`);
  }
}

async function buildDecompositionRows(
  net: readonly TrialGridResult[],
  gross: readonly TrialGridResult[],
  runs: readonly ReplayRunResult[],
  netChecks: ReturnType<typeof killLineChecks>,
  grossChecks: ReturnType<typeof killLineChecks>,
  costConfig: CostConfig,
  window: DateRange,
): Promise<CostDecompositionRow[]> {
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

  return rows;
}

async function sweepCostSensitivity(
  store: Stage2HistoricalStore,
  window: DateRange,
  costConfig: CostConfig,
): Promise<CostSensitivityPoint[]> {
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
  return sensitivity;
}

async function runCostDecomposition(deps: CostDecompositionDeps): Promise<CostDecompositionResult> {
  const print = deps.print ?? console.log;
  const requested = deps.window ?? PINNED_VERDICT_WINDOW;
  const costConfig = deps.costConfig ?? PESSIMISTIC_COST_CONFIG;

  const store = new Stage2HistoricalStore(deps.polygonClient, {
    timeframe: DEFAULT_STAGE2_TIMEFRAME,
    dbPath: deps.dbPath ?? 'stage2-cost-decomposition.sqlite',
  });

  print(
    `Stage 2 cost decomposition: ingesting over ${requested.start.toISOString()} .. ` +
      `${requested.end.toISOString()}`,
  );
  await ingestSymbols(store, [...STOCK_SYMBOLS, ...CRYPTO_SYMBOLS], requested, print);

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

  if (net.length !== gross.length || net.length !== runs.length) {
    throw new Error(
      `Cost decomposition: net/gross/replay counts disagree (${net.length}/${gross.length}/` +
        `${runs.length}) — the rows cannot be aligned.`,
    );
  }

  const netChecks = killLineChecks(net);
  const grossChecks = killLineChecks(gross);
  const rows = await buildDecompositionRows(
    net,
    gross,
    runs,
    netChecks,
    grossChecks,
    costConfig,
    window,
  );

  print('Sweeping the cost fixture down to find what the grid can bear...');
  const sensitivity = await sweepCostSensitivity(store, window, costConfig);

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
