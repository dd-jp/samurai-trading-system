import { describe, expect, it } from 'vitest';
import type { Bar } from '../market-data-service/types.js';
import { digest } from '../orchestrator/digest.js';
import { SimulatedClock } from '../shared/clock.js';
import { InMemoryConfigTrialLog } from './config-trial-log.js';
import type { EvalExecutor, EvalOptions, EvalReport } from './eval-types.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
import { type ReplayBarSource, ReplayDriver, type ReplayInstrument } from './replay-driver.js';
import {
  buildTrialGrid,
  CRYPTO_PERIODS_PER_YEAR,
  type ReplayRunner,
  runTrialGrid,
  STOCK_PERIODS_PER_YEAR,
  type TrialGridAssetClass,
} from './trial-execution.js';
import type { CostModel, CostModelResult, FillRequest, MarketState } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';

describe('buildTrialGrid', () => {
  it('generates exactly the documented 12-config cross-product', () => {
    const grid = buildTrialGrid();

    expect(grid).toHaveLength(12);

    // fastWindow x slowWindow x the three paired risk:reward presets.
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
    // not 3 — this is the guard against that.
    expect(pairs.size).toBe(3);
  });
});

const WINDOW: DateRange = {
  start: new Date(Date.UTC(2020, 0, 1)),
  end: new Date(Date.UTC(2020, 0, 2)),
};

/** A canned `ReplayRunResult`-shaped stand-in — the fake runner never inspects it. */
const FAKE_RUN = {
  trades: {
    closedTrades: async () => [],
    fills: async () => [],
  },
  timeline: { barTimestamps: async () => [] },
};

/** Records every `run` call and returns a fixed `FAKE_RUN` — orchestration-only fake. */
class RecordingRunner implements ReplayRunner {
  readonly calls: Array<{ config: ProxyStrategyConfig; window: DateRange }> = [];

  async run(config: ProxyStrategyConfig, window: DateRange) {
    this.calls.push({ config, window });
    return FAKE_RUN;
  }
}

/** Records the `EvalOptions` it was called with and returns a canned `EvalReport`. */
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
      // makes them (stocks first, then crypto, for each config in turn).
      makeEvaluator: () => evaluators[evaluatorIndex++ % 2] as EvalExecutor,
    });

    // 12 configs x 2 asset classes = 24 (config, asset class) pairs.
    expect(results).toHaveLength(24);
    expect(results.filter((result) => result.asset_class === 'stocks')).toHaveLength(12);
    expect(results.filter((result) => result.asset_class === 'crypto')).toHaveLength(12);

    expect(stockEvaluator.calls).toHaveLength(12);
    expect(cryptoEvaluator.calls).toHaveLength(12);
    expect(stockEvaluator.calls.every((call) => call.periodsPerYear === 252)).toBe(true);
    expect(cryptoEvaluator.calls.every((call) => call.periodsPerYear === 365)).toBe(true);
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

// --- Real end-to-end smoke test: actual ReplayDriver + EvalExecutorImpl -----

/** Day `i` of 2020, as the bar's close time. */
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

/** A plausible fill (mid moved a tick adversely) — mirrors replay-driver.test.ts's fixture. */
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

/** Bar timestamps within `window`, ascending — the fixture's own `ReplayTimeline`. */
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
      }),
  };
}

describe('runTrialGrid — real ReplayDriver + EvalExecutorImpl end to end', () => {
  it('runs all 12 configs across stock and crypto universes and produces 24 scored, 5-split EvalReports', async () => {
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

    expect(results).toHaveLength(24);
    expect(configTrialLog.distinctTrialCount()).toBe(12);

    for (const result of results) {
      expect(result.report.window).toBeDefined();
      expect(result.report.splits).toHaveLength(5);
    }

    // The evaluator instance used per pair is the default EvalExecutorImpl —
    // not the fakes above.
    expect(results.every((result) => typeof result.report.window.sharpe === 'number')).toBe(true);
  });
});
