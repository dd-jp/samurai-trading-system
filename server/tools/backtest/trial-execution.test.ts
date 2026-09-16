import type { Bar } from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar } from '../../providers/market-data-service/index.js';
import { digest, SimulatedClock } from '../../shared/index.js';
import { InMemoryConfigTrialLog } from './config-trial-log.js';
import type { EvalExecutor, EvalOptions, EvalReport } from './eval-types.js';
import { minbtl } from './overfitting.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import { type ReplayBarSource, ReplayDriver, type ReplayInstrument } from './replay-driver.js';
import {
  buildTrialGrid,
  CRYPTO_PERIODS_PER_YEAR,
  periodsPerYearFor,
  type ReplayRunner,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
  sizeTrialGridToSample,
  type TrialGridAssetClass,
  type TrialGridSizing,
} from './trial-execution.js';
import type { CostModel, CostModelResult, FillRequest, MarketState } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

describe('buildTrialGrid', () => {
  it('generates exactly the documented 12-config cross-product', () => {
    const grid = buildTrialGrid();

    expect(grid).toHaveLength(12);

    // fastWindow x slowWindow x the three paired risk:reward presets
    const expectedPresets = [
      { atrStopMult: 2, atrTargetMult: 3 },
      { atrStopMult: 1.5, atrTargetMult: 2 },
      { atrStopMult: 3, atrTargetMult: 4 },
    ];
    const expected: ProxyStrategyConfig[] = [];
    for (const fastWindow of [10, 20]) {
      for (const slowWindow of [30, 50]) {
        for (const preset of expectedPresets) {
          expected.push({
            fastWindow,
            slowWindow,
            atrWindow: 14,
            allowShort: true,
            ...preset,
          });
        }
      }
    }

    expect(grid.map((entry) => entry.config)).toEqual(expected);
  });

  it('fixes atrWindow=14 and allowShort=true across every config', () => {
    for (const entry of buildTrialGrid()) {
      expect(entry.config.atrWindow).toBe(14);
      expect(entry.config.allowShort).toBe(true);
    }
  });

  it('produces exactly 12 distinct config_hash values — the regression guard on N', () => {
    const grid = buildTrialGrid();

    expect(new Set(grid.map((entry) => entry.config_hash)).size).toBe(12);
  });

  it('hashes only the config — not asset class or any other run parameter', () => {
    for (const entry of buildTrialGrid()) {
      expect(entry.config_hash).toBe(digest(entry.config));
    }
  });

  it('pairs exactly the documented three risk:reward presets, not the full 3x3 stop/target product', () => {
    const grid = buildTrialGrid();
    const pairs = new Set(
      grid.map((entry) => `${entry.config.atrStopMult}:${entry.config.atrTargetMult}`),
    );

    expect(pairs).toEqual(new Set(['2:3', '1.5:2', '3:4']));
    // A naive nested loop over stopMults x targetMults would produce 9 pairs,
    // not 3 — this is the guard against that
    expect(pairs.size).toBe(3);
  });
});

/**
 * Long enough that MinBTL's cap does not cut the grid (#405).
 *
 * It was one DAY, which was fine while the grid ran unconditionally. Now that
 * `runTrialGrid` sizes the grid to the sample BEFORE running it, a one-day
 * window supports one trial and every "all 12 configs ran" assertion below
 * would be asserting the sizing rather than the thing it was written for. Six
 * years puts the cap comfortably above 12, so these tests keep testing
 * execution; the sizing itself is tested directly in its own describe.
 */
const WINDOW: DateRange = {
  start: new Date(Date.UTC(2020, 0, 1)),
  end: new Date(Date.UTC(2026, 0, 1)),
};

/** A canned `ReplayRunResult`-shaped stand-in — the fake runner never inspects it */
const FAKE_RUN = {
  trades: {
    closedTrades: async () => [],
    fills: async () => [],
  },
  timeline: { barTimestamps: async () => [] },
};

/** Records every `run` call and returns a fixed `FAKE_RUN` — orchestration-only fake */
class RecordingRunner implements ReplayRunner {
  readonly calls: Array<{ config: ProxyStrategyConfig; window: DateRange }> = [];

  async run(config: ProxyStrategyConfig, window: DateRange) {
    this.calls.push({ config, window });
    return FAKE_RUN;
  }
}

/** Records the `EvalOptions` it was called with and returns a canned `EvalReport` */
class RecordingEvaluator implements EvalExecutor {
  readonly calls: EvalOptions[] = [];

  async evaluate(options: EvalOptions): Promise<EvalReport> {
    this.calls.push(options);
    return {
      window: fakeMetrics(),
      splits: Array.from({ length: 5 }, () => ({
        split: { train: [WINDOW], test: [WINDOW] },
        metrics: fakeMetrics(),
      })),
    };
  }
}

function fakeMetrics() {
  return {
    sharpe: 1,
    sortino: 1,
    calmar: 1,
    max_drawdown: 0.1,
    profit_factor: 1.5,
    expectancy: 10,
    skew: 0,
    kurtosis: 0,
    turnover: 1,
    exposure: 0.5,
    per_period_sharpe: 0.063,
    annualization_factor: 15.87,
    observations: 1000,
  };
}

describe('runTrialGrid — orchestration wiring (fakes, no real replay/eval)', () => {
  function makeAssetClass(
    asset_class: 'stocks' | 'crypto',
    periodsPerYear: number,
  ): { assetClass: TrialGridAssetClass; runners: RecordingRunner[] } {
    const runners: RecordingRunner[] = [];
    return {
      assetClass: {
        asset_class,
        periodsPerYear,
        makeRunner: () => {
          const runner = new RecordingRunner();
          runners.push(runner);
          return runner;
        },
      },
      runners,
    };
  }

  it('runs every one of the 12 configs through the replay driver and eval executor', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);
    const configTrialLog = new InMemoryConfigTrialLog();

    const results = await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog,
      makeEvaluator: () => evaluator,
    });

    expect(results).toHaveLength(12);
    expect(evaluator.calls).toHaveLength(12);
    expect(new Set(results.map((result) => result.config_hash)).size).toBe(12);
  });

  it('scores stock and crypto configs as separate EvalReports with the correct periodsPerYear', async () => {
    const stockEvaluator = new RecordingEvaluator();
    const cryptoEvaluator = new RecordingEvaluator();
    const evaluators = [stockEvaluator, cryptoEvaluator];
    let evaluatorIndex = 0;

    const { assetClass: stocks } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);
    const { assetClass: crypto } = makeAssetClass('crypto', CRYPTO_PERIODS_PER_YEAR);

    const results = await runTrialGrid({
      assetClasses: [stocks, crypto],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      // Alternates per (config, asset class) call, in the order runTrialGrid
      // makes them (stocks first, then crypto, for each config in turn)
      makeEvaluator: () => evaluators[evaluatorIndex++ % 2] as EvalExecutor,
    });

    // 12 configs x 2 asset classes = 24 (config, asset class) pairs
    expect(results).toHaveLength(24);
    expect(results.filter((result) => result.asset_class === 'stocks')).toHaveLength(12);
    expect(results.filter((result) => result.asset_class === 'crypto')).toHaveLength(12);

    expect(stockEvaluator.calls).toHaveLength(12);
    expect(cryptoEvaluator.calls).toHaveLength(12);
    expect(stockEvaluator.calls.every((call) => call.periodsPerYear === 252)).toBe(true);
    expect(cryptoEvaluator.calls.every((call) => call.periodsPerYear === 365)).toBe(true);
  });

  it('announces the sizing runTrialGrid actually used, before any trial runs', async () => {
    // The point of the callback: the operator-facing "grid sized to N=..." line
    // must be built from the sizing that constrained the search, not from a
    // second computation that merely agrees with it. Asserting the announced
    // `selected` is exactly what ran is what makes that non-negotiable
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);
    const announced: TrialGridSizing[] = [];

    const results = await runTrialGrid({
      assetClasses: [assetClass],
      // Deliberately NOT the module `WINDOW`, which is six years and wide
      // enough that the cap never bites: this test is about the sizing, so it
      // needs a window where the grid is actually cut
      window: { start: new Date(Date.UTC(2020, 0, 1)), end: new Date(Date.UTC(2022, 0, 1)) },
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
      announceSizing: (sizing) => {
        // Before, not after: a cap reported once the trials are spent is the
        // ordering #405 exists to correct
        expect(evaluator.calls).toHaveLength(0);
        announced.push(sizing);
      },
    });

    expect(announced).toHaveLength(1);
    const sizing = announced[0] as TrialGridSizing;
    expect(sizing.requested).toBe(12);
    expect(results).toHaveLength(sizing.selected.length);
    expect(results.map((result) => result.config_hash)).toEqual(
      sizing.selected.map((entry) => entry.config_hash),
    );
  });

  it('runs the fixed 5-fold walk-forward split (barMs=1 day, embargo=50 bars) for every call', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('crypto', CRYPTO_PERIODS_PER_YEAR);

    await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
    });

    expect(
      evaluator.calls.every(
        (call) =>
          call.scheme === 'walk_forward' && call.embargo === 50 && call.barMs === 86_400_000,
      ),
    ).toBe(true);
  });

  it('logs each config exactly once in ConfigTrialLog — N=12, not 24, across two asset classes', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass: stocks } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);
    const { assetClass: crypto } = makeAssetClass('crypto', CRYPTO_PERIODS_PER_YEAR);
    const configTrialLog = new InMemoryConfigTrialLog();

    await runTrialGrid({
      assetClasses: [stocks, crypto],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog,
      makeEvaluator: () => evaluator,
    });

    expect(configTrialLog.distinctTrialCount()).toBe(12);
    for (const entry of buildTrialGrid()) {
      expect(configTrialLog.getTrial(entry.config_hash)).toEqual({
        config_hash: entry.config_hash,
        seed: 0,
        tick_outcomes: [],
        lookahead_audit: 'passed',
      });
    }
  });

  it('a re-run of the same config does not inflate N — the log dedups by hash', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);
    const configTrialLog = new InMemoryConfigTrialLog();

    await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog,
      makeEvaluator: () => evaluator,
    });
    await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog,
      makeEvaluator: () => evaluator,
    });

    expect(configTrialLog.distinctTrialCount()).toBe(12);
  });

  it('builds a fresh runner per (config, asset class) pair — one call to makeRunner per config', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass, runners } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
    });

    expect(runners).toHaveLength(12);
    for (const runner of runners) {
      expect(runner.calls).toHaveLength(1);
    }
  });

  it('passes identical window and averageCapital to every config — the PBO ranking precondition', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 25_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
    });

    expect(evaluator.calls.every((call) => call.averageCapital === 25_000)).toBe(true);
    expect(evaluator.calls.every((call) => call.window === WINDOW)).toBe(true);
  });

  it('does not run the CSCV pass unless asked — the decomposition must not pay for it', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    const results = await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
    });

    expect(evaluator.calls).toHaveLength(12);
    expect(evaluator.calls.every((call) => call.scheme === 'walk_forward')).toBe(true);
    expect(results.every((result) => result.cscv === undefined)).toBe(true);
  });

  it('runs a second CSCV pass per pair when includeCscvPass is set, over the same replay', async () => {
    const evaluator = new RecordingEvaluator();
    const { assetClass, runners } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    const results = await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
      includeCscvPass: true,
    });

    // Two evaluations per config, but still one replay each: re-running the
    // replay would give the two passes different trades to score
    expect(evaluator.calls).toHaveLength(24);
    expect(runners).toHaveLength(12);
    expect(evaluator.calls.filter((call) => call.scheme === 'walk_forward')).toHaveLength(12);
    expect(evaluator.calls.filter((call) => call.scheme === 'cscv')).toHaveLength(12);

    // Everything except the scheme must match, or the two passes would not be
    // scoring the same thing
    for (const call of evaluator.calls) {
      expect(call.embargo).toBe(50);
      expect(call.barMs).toBe(86_400_000);
      expect(call.averageCapital).toBe(10_000);
      expect(call.window).toBe(WINDOW);
    }

    expect(results.every((result) => result.cscv !== undefined && 'report' in result.cscv)).toBe(
      true,
    );
  });

  it('records a CSCV failure as a refusal instead of aborting the grid', async () => {
    // A barren fold makes computeMetrics throw. The walk-forward pass answers
    // the kill line and must still abort the grid; the CSCV pass only feeds
    // PBO, so losing it is a reportable gap, not a lost gate run
    const evaluator: EvalExecutor = {
      evaluate: async (options: EvalOptions): Promise<EvalReport> => {
        if (options.scheme === 'cscv') {
          throw new Error('computeMetrics: return series has zero variance');
        }
        return {
          window: fakeMetrics(),
          splits: Array.from({ length: 5 }, () => ({
            split: { train: [WINDOW], test: [WINDOW] },
            metrics: fakeMetrics(),
          })),
        };
      },
    };
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    const results = await runTrialGrid({
      assetClasses: [assetClass],
      window: WINDOW,
      averageCapital: 10_000,
      configTrialLog: new InMemoryConfigTrialLog(),
      makeEvaluator: () => evaluator,
      includeCscvPass: true,
    });

    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result.cscv).toEqual({ error: 'computeMetrics: return series has zero variance' });
      // The walk-forward pass is untouched — the kill line still has its input
      expect(result.report.splits).toHaveLength(5);
    }
  });

  it('still aborts the grid when the walk-forward pass fails, CSCV pass or not', async () => {
    const evaluator: EvalExecutor = {
      evaluate: async (): Promise<EvalReport> => {
        throw new Error('walk-forward exploded');
      },
    };
    const { assetClass } = makeAssetClass('stocks', STOCK_PERIODS_PER_YEAR);

    await expect(
      runTrialGrid({
        assetClasses: [assetClass],
        window: WINDOW,
        averageCapital: 10_000,
        configTrialLog: new InMemoryConfigTrialLog(),
        makeEvaluator: () => evaluator,
        includeCscvPass: true,
      }),
    ).rejects.toThrow(/aborting grid/);
  });

  it('refuses to run with no asset classes — nothing to evaluate', async () => {
    await expect(
      runTrialGrid({
        assetClasses: [],
        window: WINDOW,
        averageCapital: 10_000,
        configTrialLog: new InMemoryConfigTrialLog(),
      }),
    ).rejects.toThrow(/at least one asset-class/);
  });
});

// Real end-to-end smoke test: actual ReplayDriver + EvalExecutorImpl

/** Day `i` of 2020, as the bar's close time */
function day(i: number): Date {
  return new Date(Date.UTC(2020, 0, 1) + i * 86_400_000);
}

/**
 * A long, gently-trending sine series: period=100 bars, amplitude=30, over
 * 500 bars — long enough for the spec's fixed embargo=50/5-fold walk-forward
 * split (the first fold's train side needs > embargo bars, i.e. span > 300
 * days at a 6-way partition), and with a period long relative to every grid
 * config's slowWindow (<= 50) so the SMA crossover survives the smoothing and
 * produces at least one signal-exit trade in every fold's test slice, for
 * every (fastWindow, slowWindow) pair in the grid — verified by simulation
 * before this fixture was written, not just asserted.
 */
function buildTrendingBars(symbol: string): Bar[] {
  const closes = Array.from(
    { length: 500 },
    (_, i) => 100 + 30 * Math.sin((2 * Math.PI * i) / 100) + 0.02 * i,
  );

  return closes.map((close, i) => {
    const prevClose = i === 0 ? close : (closes[i - 1] as number);
    return {
      instrument: symbol,
      timeframe: '1d',
      open_time: day(i),
      close_time: day(i + 1),
      open: prevClose,
      high: Math.max(close, prevClose) + 1,
      low: Math.min(close, prevClose) - 1,
      close,
      volume: 1_000,
      source: 'fixture',
    };
  });
}

class FixtureBarSource implements ReplayBarSource {
  constructor(private readonly all: readonly Bar[]) {}
  bars(_symbol: string, window: DateRange): Bar[] {
    return this.all.filter(
      (bar) =>
        bar.close_time.getTime() >= window.start.getTime() &&
        bar.close_time.getTime() <= window.end.getTime(),
    );
  }
}

class FixtureRegistry implements InstrumentRegistry {
  constructor(private readonly listings: InstrumentListing[] = []) {}
  async membershipDuring(): Promise<InstrumentListing[]> {
    return this.listings;
  }
}

/** A plausible fill (mid moved a tick adversely) — mirrors replay-driver.test.ts's fixture */
class NearMidCostModel implements CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult {
    const sign = request.side === 'buy' ? 1 : -1;
    return {
      fill_price: marketState.mid + sign * 0.05,
      filled_size: request.size,
      cost_breakdown: {
        spread_cost: 0.02,
        commission: 0.01 * request.size,
        slippage: 0.02,
        market_impact: 0.01,
      },
    };
  }
}

/** Bar timestamps within `window`, ascending — the fixture's own `ReplayTimeline` */
function timelineOf(bars: readonly Bar[]): {
  barTimestamps(window: DateRange): Promise<readonly Date[]>;
} {
  return {
    barTimestamps: async (window: DateRange) =>
      bars
        .filter(
          (bar) =>
            bar.close_time.getTime() >= window.start.getTime() &&
            bar.close_time.getTime() <= window.end.getTime(),
        )
        .map((bar) => bar.close_time),
  };
}

function makeAssetClass(
  asset_class: 'stocks' | 'crypto',
  symbol: string,
  periodsPerYear: number,
  window: DateRange,
): TrialGridAssetClass {
  const bars = buildTrendingBars(symbol);
  const instrument: ReplayInstrument = { symbol, asset_class };

  return {
    asset_class,
    periodsPerYear,
    makeRunner: () =>
      new ReplayDriver({
        barSource: new FixtureBarSource(bars),
        timeline: timelineOf(bars),
        registry: new FixtureRegistry(),
        costModel: new NearMidCostModel(),
        clock: new SimulatedClock(window.start),
        universe: [instrument],
        capitalPerTrade: 10_000,
        timeframe: '1d',
        sessionCalendar: new AlwaysOpenCalendar(),
      }),
  };
}

describe('runTrialGrid — real ReplayDriver + EvalExecutorImpl end to end', () => {
  it('runs the sample-sized grid across both universes and scores every retained config', async () => {
    const referenceBars = buildTrendingBars('AAPL');
    const window: DateRange = {
      start: (referenceBars[0] as Bar).close_time,
      end: (referenceBars[referenceBars.length - 1] as Bar).close_time,
    };

    const configTrialLog = new InMemoryConfigTrialLog();
    const stocks = makeAssetClass('stocks', 'AAPL', STOCK_PERIODS_PER_YEAR, window);
    const crypto = makeAssetClass('crypto', 'BTC-USD', CRYPTO_PERIODS_PER_YEAR, window);

    const results = await runTrialGrid({
      assetClasses: [stocks, crypto],
      window,
      averageCapital: 10_000,
      configTrialLog,
    });

    // #405: the grid is now sized to what the sample supports BEFORE anything
    // runs, so the count is MinBTL's cap rather than the full cross-product
    // Asserted against `minbtl` rather than a literal, so this states the rule
    // instead of pinning whatever number this fixture's bar span happens to
    // produce
    const { limit } = minbtl(window);
    expect(limit).toBeLessThan(buildTrialGrid().length);
    expect(results).toHaveLength(limit * 2);
    expect(configTrialLog.distinctTrialCount()).toBe(limit);

    for (const result of results) {
      expect(result.report.window).toBeDefined();
      expect(result.report.splits).toHaveLength(5);
    }

    // The evaluator instance used per pair is the default EvalExecutorImpl —
    // not the fakes above
    expect(results.every((result) => typeof result.report.window.sharpe === 'number')).toBe(true);
  });
});

/**
 * #405 — the binding constraint on the Stage 2 gate.
 *
 * The 12-config grid was sized against an assumed 5-year sample (MinBTL cap
 * ~45). The Polygon plan serves 2 years, which supports 7, so every run
 * reported `{"limit":7,"distinct_configs":12,"exceeded":true}` — the cap
 * computed at the END, after all 12 trials had already run. The number exists
 * to constrain the search, not to grade it afterwards.
 */
describe('sizeTrialGridToSample', () => {
  function windowOfYears(years: number): DateRange {
    return {
      start: new Date(Date.UTC(2020, 0, 1)),
      end: new Date(Date.UTC(2020, 0, 1) + years * 365.25 * 24 * 60 * 60 * 1_000),
    };
  }

  it('cuts the grid to the cap the sample supports', () => {
    const full = buildTrialGrid();
    const window = windowOfYears(2);
    const { limit } = minbtl(window);

    const sizing = sizeTrialGridToSample(full, window);

    expect(limit).toBeLessThan(full.length);
    expect(sizing.selected).toHaveLength(limit);
    expect(sizing.requested).toBe(full.length);
    expect(sizing.years).toBeCloseTo(2, 2);
  });

  it('leaves the grid alone when the sample supports all of it', () => {
    const full = buildTrialGrid();

    const sizing = sizeTrialGridToSample(full, windowOfYears(20));

    expect(sizing.selected).toEqual(full);
    expect(sizing.selected.length).toBeLessThanOrEqual(sizing.limit);
  });

  it('SPREADS the retained configs rather than truncating', () => {
    // Taking the first N would keep every config from one corner of the
    // parameter space and call it a smaller search. It is not smaller, it is
    // narrower — and chosen by array order rather than by design
    const full = buildTrialGrid();

    const sizing = sizeTrialGridToSample(full, windowOfYears(2));
    const kept = sizing.selected.map((entry) => full.indexOf(entry));

    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(full.length - 1);
    // "Spread" has to be asserted as spread, not merely as increasing:
    // strictly-increasing indices are equally true of a head-truncation
    // (0,1,2,…), which is the behaviour this test exists to rule out. The
    // property that actually distinguishes them is EVEN spacing — every gap
    // within one of the ideal step. (Not "no two adjacent": at this cap the
    // ideal step is under 2, so some gaps are legitimately 1. A truncation
    // fails on the `kept[last]` assertion above, and on the ceiling here.)
    const step = (full.length - 1) / (kept.length - 1);
    for (let i = 1; i < kept.length; i++) {
      const gap = (kept[i] as number) - (kept[i - 1] as number);
      expect(gap).toBeGreaterThanOrEqual(Math.floor(step));
      expect(gap).toBeLessThanOrEqual(Math.ceil(step));
    }
  });

  it('reports a cap that does NOT bind without overstating the grid', () => {
    // The trap in the announced figure: over a 5-6 year window MinBTL supports
    // ~45 trials while the cross-product only asks for 12. A message built from
    // `limit` would announce a 45-config grid and then run 12 — the same
    // reported-vs-actual divergence the callback exists to remove. `selected`
    // is the only field that tracks what runs in BOTH regimes
    const sizing = sizeTrialGridToSample(buildTrialGrid(), windowOfYears(6));

    expect(sizing.limit).toBeGreaterThan(12);
    expect(sizing.requested).toBe(12);
    expect(sizing.selected).toHaveLength(12);
  });

  it('refuses an empty grid rather than sizing it to nothing', () => {
    // The `limit < 1` guard's mirror image, and this one is REACHABLE: an
    // empty array falls straight through the `requested <= limit` branch and
    // returns an empty selection, which is the vacuous zero-trial verdict the
    // guard exists to prevent — arrived at from the other direction
    expect(() => sizeTrialGridToSample([], windowOfYears(2))).toThrow(/empty grid/);
  });

  it('forwards an explicit expectedAnnualSharpe to the MinBTL cap (#637)', () => {
    // A lower E[SR] shrinks the cap sharply — sizing must reflect the value
    // actually passed, not the hardcoded default
    const full = buildTrialGrid();
    const window = windowOfYears(5);

    const atDefault = sizeTrialGridToSample(full, window);
    const atMeasured = sizeTrialGridToSample(full, window, 0.71);

    expect(atMeasured.limit).toBeLessThan(atDefault.limit);
    expect(atMeasured.limit).toBe(minbtl(window, 0.71).limit);
  });

  it('keeps only distinct configs — a duplicate would inflate N against the cap', () => {
    const sizing = sizeTrialGridToSample(buildTrialGrid(), windowOfYears(2));
    const hashes = sizing.selected.map((entry) => entry.config_hash);

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('is deterministic — the same window always yields the same configs', () => {
    // A reproducible verdict is the whole point of Stage 2: a gate that cannot
    // be re-run to check it is not evidence
    const window = windowOfYears(2);
    const first = sizeTrialGridToSample(buildTrialGrid(), window);
    const second = sizeTrialGridToSample(buildTrialGrid(), window);

    expect(first.selected.map((e) => e.config_hash)).toEqual(
      second.selected.map((e) => e.config_hash),
    );
  });
});

/**
 * #664: `periodsPerYear` is the annualization base for every Sharpe, Sortino
 * and Calmar in the suite. The two module constants are DAILY bar counts, and
 * threading a timeframe end-to-end while leaving them in place is exactly the
 * "config changed, consumer still reads the literal" defect this repo has hit
 * before — nothing errors, every metric is simply ~20x wrong.
 */
describe('periodsPerYearFor (#664)', () => {
  it('keeps the daily answers exactly as they were', () => {
    expect(periodsPerYearFor('stocks', '1d')).toBe(STOCK_PERIODS_PER_YEAR);
    expect(periodsPerYearFor('crypto', '1d')).toBe(CRYPTO_PERIODS_PER_YEAR);
  });

  it('counts intraday bars per session — 390 one-minute bars a US trading day', () => {
    expect(periodsPerYearFor('stocks', '1m')).toBe(252 * 390);
    expect(periodsPerYearFor('stocks', '5m')).toBe(252 * 78);
  });

  it('counts a 24-hour venue over the whole day, not a cash session', () => {
    expect(periodsPerYearFor('crypto', '1m')).toBe(365 * 1_440);
  });

  it('refuses a bar longer than the session it would be counted in', () => {
    // A 1-hour stock bar is fine (6.5 a session); a 12-hour one is not, and
    // silently returning 0.54 bars a year would poison every annualized metric
    expect(() => periodsPerYearFor('stocks', '12h')).toThrow(/longer than the stocks session/);
  });
});
