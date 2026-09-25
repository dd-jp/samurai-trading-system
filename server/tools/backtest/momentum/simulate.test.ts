import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import { SAXO_COMMISSION_PER_SIDE } from '../../../pipeline/momentum/index.js';
import { syntheticSeries, tradingCalendar } from './fixture.js';
import { GBP_IDENTITY_FX } from './fx.js';
import type { TrialConfig } from './grid.js';
import { gridForVenue } from './grid.js';
import { AlignedMarket, monthEndIndices } from './market.js';
import type { SimulationInput } from './simulate.js';
import { calendarDaysBetween, simulate } from './simulate.js';

const calendar = tradingCalendar('2020-01-01', 420);
const firstDecision = monthEndIndices(calendar).find((index) => index >= 252) as number;

function flatSeries(symbol: string, price: number, from = 0, to = calendar.length): BarSeries {
  return {
    symbol,
    bars: calendar.slice(from, to).map((date) => ({
      date,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1,
      rawClose: price,
    })),
  };
}

function trendingSeries(symbol: string, dailyReturn: number, start = 100): BarSeries {
  let close = start;
  const bars: DailyBar[] = [];
  calendar.forEach((date, index) => {
    close *= 1 + dailyReturn + 0.001 * Math.sin(index);
    bars.push({ date, open: close, high: close, low: close, close, volume: 1, rawClose: close });
  });
  return { symbol, bars };
}

const lseNoStop = gridForVenue('lse')[0] as TrialConfig;
const lseStop = gridForVenue('lse')[1] as TrialConfig;
const usNoStop = gridForVenue('us')[0] as TrialConfig;

function input(
  series: readonly BarSeries[],
  overrides: Partial<SimulationInput> = {},
): SimulationInput {
  const reference = flatSeries('REF', 1);
  return {
    market: new AlignedMarket(reference, new Map(series.map((one) => [one.symbol, one]))),
    universe: () => series.map((one) => one.symbol),
    config: lseNoStop,
    role: 'strategy',
    book: { startCapitalGbp: 1_000, wholeShares: false, fx: GBP_IDENTITY_FX },
    costs: { venue: 'lse', halfSpreadBps: () => 0 },
    evaluationStartIndex: firstDecision,
    ...overrides,
  };
}

describe('simulate: shape and determinism', () => {
  it('emits one equity mark per session from the first decision day and returns equal to marks minus one', () => {
    const result = simulate(input([trendingSeries('UP', 0.001)]));
    expect(result.dates[0]).toBe(calendar[firstDecision]);
    expect(result.dates.length).toBe(calendar.length - firstDecision);
    expect(result.returns.length).toBe(result.equity.length - 1);
    expect(result.equity[0]).toBe(1_000);
  });

  it('is deterministic across runs', () => {
    const series = [
      syntheticSeries({ symbol: 'A', calendar, seed: 1 }),
      syntheticSeries({ symbol: 'B', calendar, seed: 2 }),
    ];
    const first = simulate(input(series, { config: lseStop }));
    const second = simulate(input(series, { config: lseStop }));
    expect(second).toEqual(first);
  });

  it('refuses an evaluation start that is not a month-end decision day', () => {
    expect(() =>
      simulate(input([trendingSeries('UP', 0.001)], { evaluationStartIndex: firstDecision + 1 })),
    ).toThrow(/not a month-end decision day/);
  });
});

describe('simulate: signal and execution lag', () => {
  it('stays flat on a falling name and long on a rising one, filling at the next session close', () => {
    const rising = trendingSeries('UP', 0.001);
    const falling = trendingSeries('DOWN', -0.001);
    const result = simulate(
      input([rising, falling], { config: { ...lseNoStop, targetVolatility: 1 } }),
    );
    const symbols = new Set(result.fills.map((fill) => fill.symbol));
    expect(symbols.has('UP')).toBe(true);
    expect(symbols.has('DOWN')).toBe(false);
    expect(result.fills[0]?.date).toBe(calendar[firstDecision + 1]);
    expect(result.fills[0]?.price).toBeCloseTo(rising.bars[firstDecision + 1]?.close as number);
  });

  it('benchmark role holds every eligible name regardless of trend', () => {
    const rising = trendingSeries('UP', 0.001);
    const falling = trendingSeries('DOWN', -0.001);
    const result = simulate(input([rising, falling], { role: 'benchmark' }));
    const symbols = new Set(result.fills.map((fill) => fill.symbol));
    expect(symbols).toEqual(new Set(['UP', 'DOWN']));
  });

  it('cross-sectional top-K buys the K strongest names equal-weighted', () => {
    const series = [0.003, 0.002, 0.001, -0.001, -0.002].map((drift, index) =>
      trendingSeries(`S${index}`, drift),
    );
    const result = simulate(
      input(series, {
        config: { ...usNoStop, topK: 2 },
        costs: { venue: 'us', halfSpreadBps: () => 0 },
      }),
    );
    const firstFills = result.fills.filter((fill) => fill.date === calendar[firstDecision + 1]);
    expect(firstFills.map((fill) => fill.symbol).sort()).toEqual(['S0', 'S1']);
    expect(firstFills[0]?.notional).toBeCloseTo(firstFills[1]?.notional as number, 3);
  });

  it('excludes a name whose coverage window is incomplete', () => {
    const late = trendingSeries('LATE', 0.002);
    const lateSeries = { symbol: 'LATE', bars: late.bars.slice(firstDecision - 100) };
    const result = simulate(input([lateSeries, trendingSeries('UP', 0.001)]));
    const firstMonth = result.fills.filter((fill) => fill.date === calendar[firstDecision + 1]);
    expect(firstMonth.map((fill) => fill.symbol)).toEqual(['UP']);
  });
});

describe('simulate: costs', () => {
  it('charges Saxo commission and half spread on every fill and accrues custody daily', () => {
    const result = simulate(
      input([trendingSeries('UP', 0.0005)], {
        config: { ...lseNoStop, targetVolatility: 1 },
        costs: { venue: 'lse', halfSpreadBps: () => 10 },
      }),
    );
    const first = result.fills[0] as (typeof result.fills)[number];
    expect(first.cost).toBeCloseTo(first.notional * (SAXO_COMMISSION_PER_SIDE + 0.001), 8);
    expect(result.custodyCost).toBeGreaterThan(0);
    expect(result.totalCost).toBeGreaterThan(result.custodyCost);
  });

  it('charges no commission and no custody on Alpaca', () => {
    const result = simulate(
      input([trendingSeries('UP', 0.0005)], {
        config: { ...usNoStop, topK: 1 },
        costs: { venue: 'us', halfSpreadBps: () => 0 },
      }),
    );
    expect(result.custodyCost).toBe(0);
    const buy = result.fills.find((fill) => fill.side === 'buy') as (typeof result.fills)[number];
    expect(buy.cost).toBeLessThan(0.01);
  });
});

describe('simulate: whole shares', () => {
  it('rounds down to whole raw shares and counts targets that round to zero', () => {
    const cheap = trendingSeries('CHEAP', 0.001, 10);
    const dear = trendingSeries('DEAR', 0.001, 5_000);
    const result = simulate(
      input([cheap, dear], {
        config: { ...usNoStop, topK: 2 },
        costs: { venue: 'us', halfSpreadBps: () => 0 },
        book: { startCapitalGbp: 1_000, wholeShares: true, fx: GBP_IDENTITY_FX },
      }),
    );
    expect(result.zeroShareTargets).toBeGreaterThan(0);
    for (const fill of result.fills) {
      const bar = cheap.bars.find((one) => one.date === fill.date) as DailyBar;
      expect(fill.symbol).toBe('CHEAP');
      expect(
        Number.isInteger(Math.round(((fill.quantity * bar.close) / bar.rawClose) * 1e6) / 1e6),
      ).toBe(true);
    }
  });

  it('keeps the adjusted quantity worth the same through a split', () => {
    const split = syntheticSeries({
      symbol: 'SPLIT',
      calendar,
      seed: 7,
      drift: 0.002,
      volatility: 0.001,
      splitAt: { index: firstDecision + 10, ratio: 4 },
    });
    const result = simulate(
      input([split], {
        config: { ...lseNoStop, targetVolatility: 1 },
        book: { startCapitalGbp: 1_000, wholeShares: true, fx: GBP_IDENTITY_FX },
      }),
    );
    const before = result.equity[9] as number;
    const after = result.equity[11] as number;
    expect(Math.abs(after / before - 1)).toBeLessThan(0.02);
  });
});

describe('simulate: loss budget', () => {
  const longCalendar = tradingCalendar('2020-01-01', 700);
  const crashThenRecover = (from: number, dailyReturn: number, until: number): BarSeries => {
    let close = 100;
    const bars: DailyBar[] = [];
    longCalendar.forEach((date, index) => {
      close *= index > from && index <= until ? 1 + dailyReturn : 1.001 + 0.001 * Math.sin(index);
      bars.push({ date, open: close, high: close, low: close, close, volume: 1, rawClose: close });
    });
    return { symbol: 'CRASH', bars };
  };
  const longInput = (series: BarSeries, overrides: Partial<SimulationInput>): SimulationInput => ({
    ...input([series], overrides),
    market: new AlignedMarket(
      {
        symbol: 'REF',
        bars: longCalendar.map((date) => ({
          date,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          rawClose: 1,
        })),
      },
      new Map([[series.symbol, series]]),
    ),
  });
  const book = { startCapitalGbp: 5_000, wholeShares: false, fx: GBP_IDENTITY_FX };
  const fullSize = { ...lseNoStop, targetVolatility: 1 };

  it('halts for the year at -1500 GBP, exits at the next fill and buys nothing until the new year', () => {
    const result = simulate(
      longInput(crashThenRecover(firstDecision + 2, -0.03, firstDecision + 40), {
        config: fullSize,
        book,
      }),
    );
    expect(result.budgetDays.half).toBeGreaterThan(0);
    expect(result.budgetDays.quarter).toBeGreaterThan(0);
    expect(result.budgetDays.halted).toBeGreaterThan(0);
    const haltFill = result.fills.find(
      (fill) => fill.reason === 'halt',
    ) as (typeof result.fills)[number];
    expect(haltFill.side).toBe('sell');
    expect(haltFill.date.startsWith('2021')).toBe(true);
    const haltIndex = result.dates.indexOf(haltFill.date);
    expect(result.equity[haltIndex - 1]).toBeLessThanOrEqual(3_500);
    expect(result.equity[haltIndex - 2]).toBeGreaterThan(3_500);
    const buysAfterHalt = result.fills.filter(
      (fill) => fill.side === 'buy' && fill.date > haltFill.date,
    );
    expect(buysAfterHalt.every((fill) => fill.date >= '2022-01-01')).toBe(true);
    expect(buysAfterHalt.length).toBeGreaterThan(0);
  });

  it('halves then quarters size before halting', () => {
    const result = simulate(
      longInput(crashThenRecover(firstDecision + 2, -0.01, firstDecision + 60), {
        config: fullSize,
        book,
      }),
    );
    expect(result.budgetDays.half).toBeGreaterThan(0);
    expect(result.budgetDays.quarter).toBeGreaterThan(0);
  });

  it('blocks entries at the next fill after a 1% daily loss on start capital', () => {
    const result = simulate(
      longInput(crashThenRecover(firstDecision, -0.02, firstDecision + 5), {
        config: fullSize,
        book: { ...book, startCapitalGbp: 1_000 },
      }),
    );
    expect(result.budgetDays.capBlocked).toBeGreaterThan(0);
  });

  it('converts USD equity at the fixed year rate for the GBP budget', () => {
    const usdOnly = simulate(
      longInput(crashThenRecover(firstDecision + 2, -0.03, firstDecision + 40), {
        config: fullSize,
        costs: { venue: 'us', halfSpreadBps: () => 0 },
        book: { ...book, fx: { usdPerGbpFor: () => 2 } },
      }),
    );
    expect(usdOnly.equity[0]).toBe(10_000);
    const haltFill = usdOnly.fills.find(
      (fill) => fill.reason === 'halt',
    ) as (typeof usdOnly.fills)[number];
    const haltIndex = usdOnly.dates.indexOf(haltFill.date);
    expect(usdOnly.equity[haltIndex - 1]).toBeLessThanOrEqual(7_000);
    expect(usdOnly.equity[haltIndex - 2]).toBeGreaterThan(7_000);
  });
});

describe('simulate: resting stop', () => {
  it('exits on the session the low touches the stop and never re-enters that month', () => {
    let close = 100;
    const bars: DailyBar[] = calendar.map((date, index) => {
      close = index === firstDecision + 5 ? close * 0.8 : close * (1.001 + 0.001 * Math.sin(index));
      const low = index === firstDecision + 5 ? close * 0.98 : close;
      return { date, open: close, high: close, low, close, volume: 1, rawClose: close };
    });
    const result = simulate(
      input([{ symbol: 'GAP', bars }], { config: { ...lseStop, targetVolatility: 1 } }),
    );
    expect(result.stopHits).toBeGreaterThanOrEqual(1);
    const stopFill = result.fills.find(
      (fill) => fill.reason === 'stop',
    ) as (typeof result.fills)[number];
    expect(stopFill.date).toBe(calendar[firstDecision + 5]);
    expect(stopFill.price).toBeCloseTo(bars[firstDecision + 5]?.open as number);
    const sameMonth = result.fills.filter(
      (fill) =>
        fill.side === 'buy' &&
        fill.date > stopFill.date &&
        fill.date.slice(0, 7) === stopFill.date.slice(0, 7),
    );
    expect(sameMonth).toEqual([]);
  });

  it('sets no stop when the trial has none', () => {
    const result = simulate(
      input([syntheticSeries({ symbol: 'A', calendar, seed: 3, volatility: 0.05 })]),
    );
    expect(result.stopHits).toBe(0);
    expect(result.fills.filter((fill) => fill.reason === 'stop')).toEqual([]);
  });
});

describe('simulate: delisting', () => {
  it('force-sells at the last available close when a series ends', () => {
    const ending = trendingSeries('END', 0.001);
    const endIndex = firstDecision + 20;
    const truncated = { symbol: 'END', bars: ending.bars.slice(0, endIndex) };
    const result = simulate(input([truncated], { config: { ...lseNoStop, targetVolatility: 1 } }));
    const forced = result.fills.find(
      (fill) => fill.reason === 'delisted',
    ) as (typeof result.fills)[number];
    expect(forced.date).toBe(calendar[endIndex]);
    expect(forced.price).toBeCloseTo(ending.bars[endIndex - 1]?.close as number);
    expect(result.equity[result.equity.length - 1]).toBeGreaterThan(0);
  });
});

describe('calendarDaysBetween', () => {
  it('counts calendar days across a weekend', () => {
    expect(calendarDaysBetween('2024-01-05', '2024-01-08')).toBe(3);
    expect(calendarDaysBetween('2024-01-05', '2024-01-05')).toBe(0);
  });
});

describe('simulate: no look-ahead', () => {
  function scaledAfter(series: BarSeries, cut: number, factor: number): BarSeries {
    return {
      symbol: series.symbol,
      bars: series.bars.map((bar, index) =>
        index < cut
          ? bar
          : {
              ...bar,
              open: bar.open * factor,
              high: bar.high * factor,
              low: bar.low * factor,
              close: bar.close * factor,
              rawClose: bar.rawClose * factor,
            },
      ),
    };
  }

  it.each([lseNoStop, lseStop, usNoStop])(
    'rewriting every bar after a cut leaves marks and fills up to the cut unchanged (%o)',
    (config) => {
      const cut = firstDecision + 60;
      const cutDate = calendar[cut] as string;
      const base = [
        syntheticSeries({ symbol: 'A', calendar, seed: 11, volatility: 0.02 }),
        syntheticSeries({ symbol: 'B', calendar, seed: 12, volatility: 0.02 }),
        syntheticSeries({ symbol: 'C', calendar, seed: 13, volatility: 0.02 }),
      ];
      const future = base.map((series, index) => scaledAfter(series, cut, 1.5 + index));
      const before = simulate(input(base, { config }));
      const after = simulate(input(future, { config }));
      const upTo = (result: typeof before) => ({
        equity: result.equity.filter((_, index) => (result.dates[index] as string) < cutDate),
        fills: result.fills.filter((fill) => fill.date < cutDate),
      });
      expect(upTo(after)).toEqual(upTo(before));
      expect(upTo(before).fills.length).toBeGreaterThan(0);
      expect(after.equity[after.equity.length - 1]).not.toBe(
        before.equity[before.equity.length - 1],
      );
    },
  );
});
