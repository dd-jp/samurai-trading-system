import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../../providers/market-data-service/index.js';
import { computeIndicator } from '../../providers/market-data-service/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { EvalExecutorImpl } from './eval-executor.js';
import { LookaheadViolationError } from './lookahead.js';
import type { ProxyStrategyConfig } from './proxy-strategy.js';
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

/** Day `i` of 2024-01, as the bar's close time (the point-in-time key). */
function day(i: number): Date {
  return new Date(Date.UTC(2024, 0, i + 1));
}

/**
 * Builds bars from a close series. `high`/`low` bracket the close by 1 unless
 * a per-index override supplies them (used to force a gap through a stop).
 */
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

/**
 * Returns a distinct sentinel `fill_price` per call — deliberately far from
 * every OHLC value and from any stop/target level, so a record that matched a
 * level instead of the injected price fails loudly rather than by coincidence.
 */
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

/** A plausible fill (mid moved adversely by a tick) — for the end-to-end eval run. */
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

/** Fills the entry in full but only half the exit — a partial close. */
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

/** Serves every fixture bar regardless of the requested window — a misbehaving source. */
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

/** Rise into a long entry, then decline gently enough that the SMA crossover exits first. */
const REVERSAL_CLOSES = [100, 101, 102, 103, 104, 105, 106, 105.5, 105, 104.5, 104, 103.5, 103];

describe('ReplayDriver.run', () => {
  it('produces ClosedTrade/Fill records at exactly the injected fill prices', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades).toHaveLength(1);
    const trade = trades[0] as (typeof trades)[number];
    const fills = await result.trades.fills(trade.idempotency_key);

    expect(fills).toHaveLength(2);
    // The exact sentinels the fake cost model returned, in call order — not a
    // stop/target level, and not any bar's close.
    expect(fills.map((fill) => fill.price)).toEqual([999.5, 888.25]);
    expect(trade.entry).toBe(999.5);
    expect(costModel.requests.every((call) => call.request.order_type === 'market')).toBe(true);
    // Not a bar close, not the stop, not the target — the injected price only.
    expect(REVERSAL_CLOSES).not.toContain(trade.entry);
    expect(trade.entry).not.toBe(trade.stop);
  });

  it('closes the lot with the side opposite the entry (an exit is never favorable)', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps, costModel } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    const [entry, exit] = costModel.requests;
    expect(entry?.request.side).toBe('buy');
    expect(exit?.request.side).toBe('sell');
    expect(entry?.request.size).toBe(exit?.request.size);
    expect(entry?.request.idempotency_key).toBe(exit?.request.idempotency_key);
  });

  it('populates Fill.cost_breakdown from the CostModelResult on every leg', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
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
    // A long oscillating series so every walk-forward fold's test slice holds
    // trades; the executor rejects a zero-variance slice outright.
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
    // Rise into a long, then a bar that opens far below the protective stop.
    const closes = [100, 101, 102, 103, 104, 105, 106, 55];
    const bars = buildBars(closes, { 7: { open: 50, high: 56, low: 49, close: 55 } });
    const { deps, costModel } = makeDeps(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, windowOf(bars));
    const trades = await result.trades.closedTrades(windowOf(bars));

    expect(trades).toHaveLength(1);
    expect((trades[0] as (typeof trades)[number]).close_reason).toBe('stop');

    const exitCall = costModel.requests[1];
    // The gap price the market actually opened at — not the stop the strategy
    // asked for, which was never available.
    expect(exitCall?.marketState.mid).toBe(50);
  });

  it('prices an unbroken stop exit at the stop level itself', async () => {
    // Long entry at close 105 (ATR 3 → stop 99). The next bar opens above the
    // stop and only dips through it intrabar, so the stop was genuinely
    // available: the level is the honest reference, not the bar's open.
    const bars = buildBars([100, 101, 102, 103, 104, 105, 100], {
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
    // Long entry at close 105 (ATR 3 → target 114).
    const touched = buildBars([100, 101, 102, 103, 104, 105, 114], {
      6: { open: 106, high: 115, low: 105, close: 114 },
    });
    const gapped = buildBars([100, 101, 102, 103, 104, 105, 120], {
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
    // Gapped past the target — the fill happened at the open, not at 114.
    expect(gappedRun.costModel.requests[1]?.marketState.mid).toBe(120);
  });

  it('replays the short side: sell entry, buy exit, stop above the entry', async () => {
    // Falling series → short entry at close 95 (ATR 3 → stop 101).
    const bars = buildBars([100, 99, 98, 97, 96, 95, 100], {
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
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps } = makeDeps(bars, { costModel: new PartialExitCostModel() });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(/partially/i);
  });

  it('fails the run when the data source serves a bar stamped after clock.now()', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const window = windowOf(bars);
    const future = [...bars, ...buildBars([200]).map((bar) => ({ ...bar, close_time: day(99) }))];
    const { deps } = makeDeps(bars, { barSource: new UnfilteredBarSource(future) });

    await expect(new ReplayDriver(deps).run(CONFIG, window)).rejects.toThrow(
      LookaheadViolationError,
    );
  });

  it('asserts survivorship-freeness before stepping the first bar', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps, barSource } = makeDeps(bars, {
      registry: new FixtureRegistry([{ symbol: 'DEAD-USD', delisted_at: day(3) }]),
    });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(
      SurvivorshipViolationError,
    );
    expect(barSource.calls).toBe(0);
  });

  it('fails the run when the data source serves bars out of close_time order', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const shuffled = [bars[2] as Bar, bars[1] as Bar, ...bars.slice(3)];
    const { deps } = makeDeps(bars, { barSource: new UnfilteredBarSource(shuffled) });

    await expect(new ReplayDriver(deps).run(CONFIG, windowOf(bars))).rejects.toThrow(
      /out of order/i,
    );
  });

  it('reads each instrument from the bar source once, not once per stepped bar', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps, barSource } = makeDeps(bars);

    await new ReplayDriver(deps).run(CONFIG, windowOf(bars));

    // One universe instrument, one read — not one per timestamp. Re-reading
    // per step is a SQL query plus a full row materialization per step
    // against the real `Stage2HistoricalStore`.
    expect(deps.universe).toHaveLength(1);
    expect(barSource.calls).toBe(1);
    expect(bars.length).toBeGreaterThan(1);
  });

  it('produces a timeline of exactly the bars it stepped', async () => {
    const bars = buildBars(REVERSAL_CLOSES);
    const { deps } = makeDeps(bars);
    const window = windowOf(bars);

    const result = await new ReplayDriver(deps).run(CONFIG, window);

    expect(await result.timeline.barTimestamps(window)).toEqual(bars.map((bar) => bar.close_time));
  });

  it('BarCursor.visibleAt neutrality (#836): the incrementally-revealed prefix matches an independent full-history recompute, bar for bar, across a long multi-instrument run', async () => {
    // #836/#289 H11 replaced `BarCursor.visibleAt`'s per-call
    // `this.all.slice(0, this.cursor)` with an array grown in place by
    // `push`. This test is the neutrality proof for that change: it builds
    // two long, independently-trending instrument series (so both open and
    // close lots repeatedly, exercising `visibleAt` on many distinct cursor
    // positions for each), then — for every fill the driver produces —
    // independently recomputes `marketState.volatility` and `.adv` from the
    // TEST's own copy of the fixture bars, sliced fresh with `Array.slice`
    // exactly the way the pre-#836 code did it (the "recompute path"), and
    // asserts it equals what the driver (the "incremental path") actually
    // fed the cost model. Any drift in what `visibleAt` reveals — a stale
    // element, a wrong count, a mis-ordered push — would show up here as a
    // volatility/adv mismatch on some fill.
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
    };

    await new ReplayDriver(deps).run(CONFIG, window);

    // Multiple round trips on both instruments, or the test isn't exercising
    // enough distinct cursor positions to be meaningful.
    expect(requests.length).toBeGreaterThan(8);

    for (const { request, marketState } of requests) {
      const fullSeries = (byInstrument.get(request.instrument) ?? []) as Bar[];
      // The index this fill's bar occupies in the instrument's own series —
      // located by the timestamp the driver stamped `marketState` with,
      // which is `clock.now()` at the step the fill was priced, i.e. the
      // current bar's `close_time`.
      const index = fullSeries.findIndex(
        (bar) => bar.close_time.getTime() === marketState.timestamp.getTime(),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const visiblePrefix = fullSeries.slice(0, index + 1);

      const expectedAtr = computeIndicator(visiblePrefix.slice(-(CONFIG.atrWindow + 1)) as Bar[], {
        indicator: 'atr',
        params: {},
        timeframe: '1d',
        lookback: CONFIG.atrWindow,
      });
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
