import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../../providers/market-data-service/index.js';
import { AlwaysOpenCalendar, computeIndicator } from '../../providers/market-data-service/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { EvalExecutorImpl } from './eval-executor.js';
import { LookaheadViolationError } from './lookahead.js';
import { type ProxyStrategyConfig, proxyAtrSpec, proxyWarmupBars } from './proxy-strategy.js';
import {
  type ReplayBarSource,
  ReplayDriver,
  type ReplayDriverDeps,
  type ReplayInstrument,
} from './replay-driver.js';
import { assertCostModelPriced } from './trade-derivation.js';
import type { CostModel, CostModelResult, FillRequest, MarketState } from './types.js';
import type { DateRange, InstrumentListing, InstrumentRegistry } from './universe.js';
import { SurvivorshipViolationError } from './universe.js';

const CONFIG: ProxyStrategyConfig = {
  fastWindow: 3,
  slowWindow: 6,
  atrWindow: 4,
  atrStopMult: 2,
  atrTargetMult: 3,
  allowShort: true,
};

const INSTRUMENT = 'BTC-USD';
const UNIVERSE: ReplayInstrument[] = [{ symbol: INSTRUMENT, asset_class: 'crypto' }];

function day(i: number): Date {
  return new Date(Date.UTC(2024, 0, i + 1));
}

function buildBars(closes: readonly number[], overrides: Record<number, Partial<Bar>> = {}): Bar[] {
  return closes.map((close, i) => ({
    instrument: INSTRUMENT,
    timeframe: '1d',
    open_time: day(i),
    close_time: day(i + 1),
    open: i === 0 ? close : (closes[i - 1] as number),
    high: Math.max(close, i === 0 ? close : (closes[i - 1] as number)) + 1,
    low: Math.min(close, i === 0 ? close : (closes[i - 1] as number)) - 1,
    close,
    volume: 1_000,
    source: 'fixture',
    ...overrides[i],
  }));
}

const LEAD_IN_CLOSES = [99, 100, 99, 100, 99, 100, 99, 100, 99, 100, 99];
const LEAD_IN = LEAD_IN_CLOSES.length;

function buildWarmedBars(
  closes: readonly number[],
  overrides: Record<number, Partial<Bar>> = {},
): Bar[] {
  const shifted: Record<number, Partial<Bar>> = {
    0: { high: 100.5, low: 97.5 },
  };
  for (const [index, override] of Object.entries(overrides)) {
    shifted[Number(index) + LEAD_IN] = override;
  }
  return buildBars([...LEAD_IN_CLOSES, ...closes], shifted);
}

class FixtureBarSource implements ReplayBarSource {
  calls = 0;
  constructor(private readonly all: readonly Bar[]) {}

  bars(_symbol: string, window: DateRange): Bar[] {
    this.calls++;
    return this.all.filter(
      (bar) =>
        bar.close_time.getTime() >= window.start.getTime() &&
        bar.close_time.getTime() <= window.end.getTime(),
    );
  }
}

class FixtureRegistry implements InstrumentRegistry {
  constructor(private readonly listings: InstrumentListing[] = []) {}
  async membershipDuring(_window: DateRange): Promise<InstrumentListing[]> {
    return this.listings;
  }
}

class SentinelCostModel implements CostModel {
  readonly requests: { request: FillRequest; marketState: MarketState }[] = [];
  private next = 0;

  constructor(private readonly prices: readonly number[] = [999.5, 888.25, 777.125, 666.0625]) {}

  fill(request: FillRequest, marketState: MarketState): CostModelResult {
    this.requests.push({ request, marketState: { ...marketState } });
    const fill_price = this.prices[this.next % this.prices.length] as number;
    this.next++;
    return {
      fill_price,
      filled_size: request.size,
      cost_breakdown: {
        spread_cost: 0.5,
        commission: 1.25,
        slippage: 0.25,
        market_impact: 0.125,
      },
    };
  }
}

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

class PartialExitCostModel implements CostModel {
  private calls = 0;

  fill(request: FillRequest): CostModelResult {
    const first = this.calls === 0;
    this.calls++;
    return {
      fill_price: 100,
      filled_size: first ? request.size : request.size / 2,
      cost_breakdown: { spread_cost: 0, commission: 0, slippage: 0, market_impact: 0 },
    };
  }
}

class UnfilteredBarSource implements ReplayBarSource {
  constructor(private readonly all: readonly Bar[]) {}
  bars(): Bar[] {
    return [...this.all];
  }
}

function makeDeps(
  bars: readonly Bar[],
  overrides: Partial<ReplayDriverDeps> = {},
): { deps: ReplayDriverDeps; costModel: SentinelCostModel; barSource: FixtureBarSource } {
  const barSource = new FixtureBarSource(bars);
  const costModel = new SentinelCostModel();
  const timestamps = bars.map((bar) => bar.close_time);

  const deps: ReplayDriverDeps = {
    barSource,
    timeline: {
      barTimestamps: async (window: DateRange) =>
        timestamps.filter(
          (at) => at.getTime() >= window.start.getTime() && at.getTime() <= window.end.getTime(),
        ),
    },
    registry: new FixtureRegistry(),
    costModel,
    clock: new SimulatedClock(new Date(Date.UTC(2023, 11, 1))),
    universe: UNIVERSE,
    capitalPerTrade: 10_000,
    timeframe: '1d',
    sessionCalendar: new AlwaysOpenCalendar(),
    ...overrides,
  };

  return { deps, costModel, barSource };
}

function windowOf(bars: readonly Bar[]): DateRange {
  return {
    start: (bars[0] as Bar).close_time,
    end: (bars[bars.length - 1] as Bar).close_time,
  };
}

const REVERSAL_CLOSES = [100, 101, 102, 103, 104, 105, 106, 105.5, 105, 104.5, 104, 103.5, 103];

describe('ReplayDriver.run', () => {
  it('produces ClosedTrade/Fill records at exactly the injected fill prices', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades).toHaveLength(1);
    const trade = trades[0] as (typeof trades)[number];
    const fills = await result.trades.fills(trade.idempotency_key);

    expect(fills).toHaveLength(2);
    expect(fills.map((fill) => fill.price)).toEqual([999.5, 888.25]);
    expect(trade.entry).toBe(999.5);
    expect(costModel.requests.every((call) => call.request.order_type === 'market')).toBe(true);
    expect(REVERSAL_CLOSES).not.toContain(trade.entry);
    expect(trade.entry).not.toBe(trade.stop);
  });

  it('stamps MarketState.venue from the replayed instrument', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars, {
      universe: [{ symbol: INSTRUMENT, asset_class: 'stocks', venue: 'saxo' }],
    });

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    expect(costModel.requests.length).toBeGreaterThan(0);
    expect(costModel.requests.every((call) => call.marketState.venue === 'saxo')).toBe(true);
  });

  it('leaves MarketState.venue unset when the instrument names none', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    expect(costModel.requests.every((call) => !('venue' in call.marketState))).toBe(true);
  });

  it('closes the lot with the side opposite the entry (an exit is never favorable)', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    const [entry, exit] = costModel.requests;
    expect(entry?.request.side).toBe('buy');
    expect(exit?.request.side).toBe('sell');
    expect(entry?.request.size).toBe(exit?.request.size);
    expect(entry?.request.idempotency_key).toBe(exit?.request.idempotency_key);
  });

  it('populates Fill.cost_breakdown from the CostModelResult on every leg', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    for (const trade of trades) {
      const fills = await result.trades.fills(trade.idempotency_key);
      expect(() => assertCostModelPriced(trade, fills)).not.toThrow();
      for (const fill of fills) {
        expect(fill.cost_breakdown).toEqual({
          spread_cost: 0.5,
          commission: 1.25,
          slippage: 0.25,
          market_impact: 0.125,
        });
      }
    }
  });

  it('feeds EvalExecutorImpl unchanged — assertCostModelPriced passes end to end', async () => {
    const bars = buildBars(
      Array.from({ length: 150 }, (_, i) => 100 + 8 * Math.sin(i / 2.5) + i * 0.05),
    );
    const { deps } = makeDeps(bars, { costModel: new NearMidCostModel() });
    const window = windowOf(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, window);
    expect((await result.trades.closedTrades(window)).length).toBeGreaterThan(10);

    const report = await new EvalExecutorImpl({
      source: result.trades,
      timeline: result.timeline,
    }).evaluate({
      window,
      averageCapital: 10_000,
      periodsPerYear: 365,
      scheme: 'walk_forward',
      embargo: 0,
      barMs: 86_400_000,
    });

    expect(report.window).toBeDefined();
    expect(report.splits).toHaveLength(5);
  });

  it('prices a gapped stop exit at the gap price, never at the stop level', async () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 55];
    const bars = buildWarmedBars(closes, { 7: { open: 50, high: 56, low: 49, close: 55 } });
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades).toHaveLength(1);
    expect((trades[0] as (typeof trades)[number]).close_reason).toBe('stop');

    const exitCall = costModel.requests[1];
    expect(exitCall?.marketState.mid).toBe(50);
  });

  it('prices an unbroken stop exit at the stop level itself', async () => {
    const bars = buildWarmedBars([100, 101, 102, 103, 104, 105, 100], {
      6: { open: 104, high: 105, low: 98, close: 100 },
    });
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades.map((trade) => trade.close_reason)).toEqual(['stop']);
    expect(trades[0]?.stop).toBe(99);
    expect(costModel.requests[1]?.marketState.mid).toBe(99);
  });

  it('prices a target exit at the target, and at the gap price when it gapped through', async () => {
    const touched = buildWarmedBars([100, 101, 102, 103, 104, 105, 114], {
      6: { open: 106, high: 115, low: 105, close: 114 },
    });
    const gapped = buildWarmedBars([100, 101, 102, 103, 104, 105, 120], {
      6: { open: 120, high: 122, low: 119, close: 120 },
    });

    const touchedRun = makeDeps(touched);
    const touchedTrades = await (
      await new ReplayDriver(touchedRun.deps).run(CONFIG, windowOf(touched))
    ).trades.closedTrades(windowOf(touched));

    expect(touchedTrades.map((trade) => trade.close_reason)).toEqual(['target']);
    expect(touchedRun.costModel.requests[1]?.marketState.mid).toBe(114);

    const gappedRun = makeDeps(gapped);
    const gappedTrades = await (
      await new ReplayDriver(gappedRun.deps).run(CONFIG, windowOf(gapped))
    ).trades.closedTrades(windowOf(gapped));

    expect(gappedTrades.map((trade) => trade.close_reason)).toEqual(['target']);
    expect(gappedRun.costModel.requests[1]?.marketState.mid).toBe(120);
  });

  it('replays the short side: sell entry, buy exit, stop above the entry', async () => {
    const bars = buildWarmedBars([100, 99, 98, 97, 96, 95, 100], {
      6: { open: 96, high: 102, low: 95, close: 100 },
    });
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades).toHaveLength(1);
    expect(trades[0]?.side).toBe('sell');
    expect(trades[0]?.stop).toBe(101);
    expect(trades[0]?.close_reason).toBe('stop');
    expect(costModel.requests[0]?.request.side).toBe('sell');
    expect(costModel.requests[1]?.request.side).toBe('buy');
    expect(costModel.requests[1]?.marketState.mid).toBe(101);
  });

  it('refuses to close a lot on a partial exit fill rather than mis-sizing the trade', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps } = makeDeps(bars, { costModel: new PartialExitCostModel() });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(/partially/i);
  });

  it('fails the run when the data source serves a bar stamped after clock.now()', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const window = windowOf(bars);
    const future = [...bars, ...buildBars([200]).map((bar) => ({ ...bar, close_time: day(99) }))];
    const { deps } = makeDeps(bars, { barSource: new UnfilteredBarSource(future) });

    await expect(new ReplayDriver(deps).run(CONFIG, window)).rejects.toThrow(
      LookaheadViolationError,
    );
  });

  it('asserts survivorship-freeness before stepping the first bar', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, barSource } = makeDeps(bars, {
      registry: new FixtureRegistry([{ symbol: 'DEAD-USD', delisted_at: day(3) }]),
    });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(
      SurvivorshipViolationError,
    );
    expect(barSource.calls).toBe(0);
  });

  it('fails the run when the data source serves bars out of close_time order', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const shuffled = [bars[2] as Bar, bars[1] as Bar, ...bars.slice(3)];
    const { deps } = makeDeps(bars, { barSource: new UnfilteredBarSource(shuffled) });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(
      /out of order/i,
    );
  });

  it('reads each instrument from the bar source once, not once per stepped bar', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps, barSource } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    expect(deps.universe).toHaveLength(1);
    expect(barSource.calls).toBe(1);
    expect(bars.length).toBeGreaterThan(1);
  });

  it('produces a timeline of exactly the bars it stepped', async () => {
    const bars = buildWarmedBars(REVERSAL_CLOSES);
    const { deps } = makeDeps(bars);
    const window = windowOf(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, window);

    expect(await result.timeline.barTimestamps(window)).toEqual(bars.map((bar) => bar.close_time));
  });

  it('BarCursor.visibleAt neutrality (#836): the incrementally-revealed prefix matches an independent full-history recompute, bar for bar, across a long multi-instrument run', async () => {
    const oneUp = (n: number, seedClose: number, amplitude: number) =>
      Array.from({ length: n }, (_, i) => seedClose + amplitude * Math.sin(i / 3) + i * 0.15);

    const btcCloses = oneUp(80, 100, 6);
    const ethCloses = oneUp(80, 50, 4);
    const btcBars = buildBars(btcCloses).map((bar) => ({ ...bar, instrument: 'BTC-USD' }));
    const ethBars = buildBars(ethCloses).map((bar) => ({ ...bar, instrument: 'ETH-USD' }));
    const byInstrument = new Map<string, Bar[]>([
      ['BTC-USD', btcBars],
      ['ETH-USD', ethBars],
    ]);

    class MultiInstrumentBarSource implements ReplayBarSource {
      bars(symbol: string, window: DateRange): Bar[] {
        return (byInstrument.get(symbol) ?? []).filter(
          (bar) =>
            bar.close_time.getTime() >= window.start.getTime() &&
            bar.close_time.getTime() <= window.end.getTime(),
        );
      }
    }

    const universe: ReplayInstrument[] = [
      { symbol: 'BTC-USD', asset_class: 'crypto' },
      { symbol: 'ETH-USD', asset_class: 'crypto' },
    ];

    const requests: { request: FillRequest; marketState: MarketState }[] = [];
    class RecordingCostModel implements CostModel {
      fill(request: FillRequest, marketState: MarketState): CostModelResult {
        requests.push({ request, marketState: { ...marketState } });
        const sign = request.side === 'buy' ? 1 : -1;
        return {
          fill_price: marketState.mid + sign * 0.05,
          filled_size: request.size,
          cost_breakdown: {
            spread_cost: 0.02,
            commission: 0.01,
            slippage: 0.02,
            market_impact: 0.01,
          },
        };
      }
    }

    const allBars = [...btcBars, ...ethBars];
    const window = { start: day(0), end: day(80) };
    const timestamps = [...new Set(allBars.map((bar) => bar.close_time.getTime()))]
      .sort((a, b) => a - b)
      .map((t) => new Date(t));

    const deps: ReplayDriverDeps = {
      barSource: new MultiInstrumentBarSource(),
      timeline: { barTimestamps: async () => timestamps },
      registry: new FixtureRegistry(),
      costModel: new RecordingCostModel(),
      clock: new SimulatedClock(day(0)),
      universe,
      capitalPerTrade: 10_000,
      timeframe: '1d',
      sessionCalendar: new AlwaysOpenCalendar(),
    };

    await new ReplayDriver(deps).run(CONFIG, window);

    expect(requests.length).toBeGreaterThan(8);

    for (const { request, marketState } of requests) {
      const fullSeries = (byInstrument.get(request.instrument) ?? []) as Bar[];
      const index = fullSeries.findIndex(
        (bar) => bar.close_time.getTime() === marketState.timestamp.getTime(),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const visiblePrefix = fullSeries.slice(0, index + 1);

      const atrSpec = proxyAtrSpec(CONFIG, '1d');
      const expectedAtr = computeIndicator(
        visiblePrefix.slice(-atrSpec.lookback) as Bar[],
        atrSpec,
      );
      expect(marketState.volatility).toBe(expectedAtr);

      const advRecent = visiblePrefix.slice(-20);
      const expectedAdv = advRecent.reduce((sum, bar) => sum + bar.volume, 0) / advRecent.length;
      expect(marketState.adv).toBe(expectedAdv);
    }
  });

  it('never reaches the live gate sequence — no broker/trader/risk/verdict imports', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./replay-driver.ts', import.meta.url)),
      'utf8',
    );
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);

    expect(imports.filter((path) => /broker|trader|risk|verdict|execution/i.test(path))).toEqual(
      [],
    );
  });
});

function wilderAtr(bars: readonly Bar[], period: number): number {
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const current = bars[i] as Bar;
    const previousClose = (bars[i - 1] as Bar).close;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }
  const seed = trueRanges.slice(0, period);
  let value = seed.reduce((sum, range) => sum + range, 0) / seed.length;
  for (const range of trueRanges.slice(period)) {
    value = (value * (period - 1) + range) / period;
  }
  return value;
}

describe('the backtest ATR is converged, not seed-only (#857)', () => {
  const VARIED_CLOSES = Array.from(
    { length: 40 },
    (_, i) => 100 + i * 0.6 + 7 * Math.sin(i / 2.2) + 3 * Math.cos(i / 1.3),
  );

  const CONVERGED_WIDTH = 4 * CONFIG.atrWindow + 1;
  const SEED_ONLY_WIDTH = CONFIG.atrWindow + 1;

  it('stamps marketState.volatility from the converged Wilder recurrence, never the seed mean', async () => {
    const bars = buildBars(VARIED_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    expect(costModel.requests.length).toBeGreaterThan(0);

    for (const { marketState } of costModel.requests) {
      const index = bars.findIndex(
        (bar) => bar.close_time.getTime() === marketState.timestamp.getTime(),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const prefix = bars.slice(0, index + 1);

      expect(marketState.volatility).toBeCloseTo(
        wilderAtr(prefix.slice(-CONVERGED_WIDTH), CONFIG.atrWindow),
        7,
      );

      const seedOnly = wilderAtr(prefix.slice(-SEED_ONLY_WIDTH), CONFIG.atrWindow);
      expect(Math.abs(marketState.volatility - seedOnly)).toBeGreaterThan(1e-6);
    }
  });

  it('holds every step back until the converged ATR window can actually be filled', async () => {
    const bars = buildBars(VARIED_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    const first = costModel.requests[0];
    if (first === undefined) throw new Error('expected at least one fill');
    const firstIndex = bars.findIndex(
      (bar) => bar.close_time.getTime() === first.marketState.timestamp.getTime(),
    );

    expect(proxyWarmupBars(CONFIG, '1d')).toBe(CONVERGED_WIDTH);
    expect(firstIndex).toBeGreaterThanOrEqual(proxyWarmupBars(CONFIG, '1d') - 1);
  });
});
