import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import type { BarsSource } from '../data/index.js';
import { isLseInstrument } from './lse-lines.js';
import { MOVERS_MIN_DOLLAR_VOLUME_USD } from './parameters.js';
import {
  averageDollarVolume,
  liquidityCore,
  type PoolContext,
  selectMovers,
  selectUniverse,
  UNIVERSE_CAP,
} from './universe.js';

const GBP_USD = 1.25;
const TRADING_DATE = '2026-09-26';

function poolOf(bars: BarsSource, tradingDate = TRADING_DATE, gbpUsd = GBP_USD): PoolContext {
  return {
    bars,
    tradingDate,
    venueFor: (symbol) => (isLseInstrument(symbol) ? 'saxo' : 'alpaca'),
    market: { gbpUsdAtYearStart: () => gbpUsd },
  };
}

function series(symbol: string, days: number, price: number, volume: number): BarSeries {
  const bars: DailyBar[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    bars.push({
      date: `2026-09-${day}`,
      open: price,
      high: price + 1,
      low: price - 1,
      close: price,
      volume,
      rawClose: price,
    });
  }
  return { symbol, bars };
}

function referenceSeries(symbol: string, dates: readonly string[]): BarSeries {
  return {
    symbol,
    bars: dates.map((date) => ({
      date,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      rawClose: 1,
    })),
  };
}

function withCalendar(all: readonly BarSeries[]): readonly BarSeries[] {
  const dates = [...new Set(all.flatMap((entry) => entry.bars.map((bar) => bar.date)))].sort();
  return [...all, referenceSeries('SPY', dates), referenceSeries('ISF', dates)];
}

function memorySource(all: readonly BarSeries[]): BarsSource {
  const withReference = withCalendar(all);
  return { load: (symbol) => withReference.find((entry) => entry.symbol === symbol) };
}

function moved(input: BarSeries, close = 110): BarSeries {
  const last = input.bars.at(-1);
  if (last === undefined) return input;
  return { symbol: input.symbol, bars: [...input.bars.slice(0, -1), { ...last, close }] };
}

function withoutDates(input: BarSeries, dates: readonly string[]): BarSeries {
  return { symbol: input.symbol, bars: input.bars.filter((bar) => !dates.includes(bar.date)) };
}

describe('liquidity core', () => {
  it('ranks by 20-day average dollar volume over bars before the date, none older than 5 days', () => {
    const source = memorySource([
      series('BIG', 25, 100, 1_000),
      series('MID', 25, 10, 5_000),
      series('NEW', 5, 1_000, 1_000),
      series('STALE', 20, 100, 100_000),
    ]);
    expect(averageDollarVolume(series('BIG', 25, 100, 1_000).bars, 20)).toBe(100_000);
    expect(liquidityCore(['MID', 'BIG', 'NEW', 'STALE', 'MISSING'], poolOf(source), 10)).toEqual([
      'BIG',
      'MID',
    ]);
    expect(liquidityCore(['MID', 'BIG'], poolOf(source), 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], poolOf(source, '2026-09-25'), 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], poolOf(source, '2026-09-30'), 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], poolOf(source, '2026-10-01'), 1)).toEqual([]);
  });

  it('ranks a name in the pool by its dollar volume converted to one currency, never raw (#1774 c)', () => {
    const source = memorySource([series('ISF', 25, 100, 1_000), series('AAPL', 25, 100, 1_100)]);
    const pool = ['AAPL', 'ISF'];
    expect(liquidityCore(pool, poolOf(source, TRADING_DATE, 1.25), 2)).toEqual(['ISF', 'AAPL']);
    expect(liquidityCore(pool, poolOf(source, TRADING_DATE, 1.05), 2)).toEqual(['AAPL', 'ISF']);
  });

  it('breaks a tie alphabetically across venues', () => {
    const source = memorySource([series('ISF', 25, 10, 100), series('AAPL', 25, 10, 100)]);
    expect(liquidityCore(['ISF', 'AAPL'], poolOf(source, TRADING_DATE, 1), 1)).toEqual(['AAPL']);
    expect(liquidityCore(['AAPL', 'ISF'], poolOf(source, TRADING_DATE, 1), 2)).toEqual([
      'AAPL',
      'ISF',
    ]);
  });
});

describe('coverage invariant', () => {
  it('refuses a series whose last bar is more than five calendar days old', () => {
    const source = memorySource([series('STALE', 20, 100, 100_000)]);
    expect(liquidityCore(['STALE'], poolOf(source, '2026-09-25'), 1)).toEqual(['STALE']);
    expect(liquidityCore(['STALE'], poolOf(source), 1)).toEqual([]);
    expect(selectUniverse(['STALE'], poolOf(source)).movers).toEqual([]);
  });

  it('refuses a window missing more than 5% of the reference calendar sessions (#1791)', () => {
    const full = series('FULL', 25, 100, 1_000_000);
    const source = memorySource([
      full,
      withoutDates(series('ONE', 25, 100, 1_000_000), ['2026-09-10']),
      withoutDates(series('TWO', 25, 100, 1_000_000), ['2026-09-10', '2026-09-11']),
    ]);
    expect(liquidityCore(['FULL', 'ONE', 'TWO'], poolOf(source), 3)).toEqual(['FULL', 'ONE']);
  });

  it('refuses a mover whose prior session is missing (#1791)', () => {
    const core = Array.from({ length: 10 }, (_, i) => series(`L${i}`, 25, 100, 10_000_000 + i));
    const source = memorySource([
      ...core,
      moved(series('MOVE', 25, 100, 1_000_000)),
      withoutDates(moved(series('GAP', 25, 100, 1_000_000)), ['2026-09-24']),
    ]);
    const symbols = [...core.map((entry) => entry.symbol), 'MOVE', 'GAP'];
    expect(selectUniverse(symbols, poolOf(source)).movers).toEqual(['MOVE']);
  });

  it('reads each name off its own venue calendar, US off SPY and LSE off ISF (#1840)', () => {
    const usHolidays = ['2026-09-14', '2026-09-15'];
    const lseHolidays = ['2026-09-10', '2026-09-11'];
    const allDates = series('X', 25, 1, 1).bars.map((bar) => bar.date);
    const source: BarsSource = {
      load: (symbol) =>
        ({
          SPY: referenceSeries(
            'SPY',
            allDates.filter((date) => !usHolidays.includes(date)),
          ),
          ISF: referenceSeries(
            'ISF',
            allDates.filter((date) => !lseHolidays.includes(date)),
          ),
          AAPL: withoutDates(series('AAPL', 25, 100, 1_000_000), usHolidays),
          IUSA: withoutDates(series('IUSA', 25, 100, 1_000_000), lseHolidays),
        })[symbol],
    };
    expect(liquidityCore(['AAPL', 'IUSA'], poolOf(source, TRADING_DATE, 1), 2)).toEqual([
      'AAPL',
      'IUSA',
    ]);
  });

  it('refuses a US name that only covers the LSE calendar, and the reverse', () => {
    const usHolidays = ['2026-09-14', '2026-09-15'];
    const allDates = series('X', 25, 1, 1).bars.map((bar) => bar.date);
    const source: BarsSource = {
      load: (symbol) =>
        ({
          SPY: referenceSeries('SPY', allDates),
          ISF: referenceSeries(
            'ISF',
            allDates.filter((date) => !usHolidays.includes(date)),
          ),
          AAPL: withoutDates(series('AAPL', 25, 100, 1_000_000), usHolidays),
          IUSA: withoutDates(series('IUSA', 25, 100, 1_000_000), usHolidays),
        })[symbol],
    };
    expect(liquidityCore(['AAPL', 'IUSA'], poolOf(source), 2)).toEqual(['IUSA']);
  });

  it('breaks an average-dollar-volume tie alphabetically', () => {
    const source = memorySource([series('B', 25, 10, 100), series('A', 25, 10, 100)]);
    expect(liquidityCore(['B', 'A'], poolOf(source), 1)).toEqual(['A']);
    expect(liquidityCore(['B', 'A'], poolOf(source), 2)).toEqual(['A', 'B']);
  });
});

describe('movers', () => {
  it('ranks by absolute prior-day return above the dollar-volume floor, ties alphabetically', () => {
    const candidates = [
      { symbol: 'UP', dayReturn: 0.05, dollarVolumeUsd: MOVERS_MIN_DOLLAR_VOLUME_USD },
      { symbol: 'DOWN', dayReturn: -0.08, dollarVolumeUsd: MOVERS_MIN_DOLLAR_VOLUME_USD },
      { symbol: 'THIN', dayReturn: 0.5, dollarVolumeUsd: MOVERS_MIN_DOLLAR_VOLUME_USD - 1 },
      { symbol: 'B', dayReturn: 0.05, dollarVolumeUsd: MOVERS_MIN_DOLLAR_VOLUME_USD * 2 },
      { symbol: 'A', dayReturn: -0.05, dollarVolumeUsd: MOVERS_MIN_DOLLAR_VOLUME_USD * 2 },
    ];
    expect(selectMovers(candidates)).toEqual(['DOWN', 'A', 'B', 'UP']);
    expect(selectMovers(candidates, 2)).toEqual(['DOWN', 'A']);
  });
});

function core(): BarSeries[] {
  return Array.from({ length: 10 }, (_, i) => series(`L${i}`, 25, 100, 10_000_000 + i));
}

describe('selectUniverse', () => {
  it('fills the liquidity half first, so a thin constituent list leaves no movers', () => {
    const source = memorySource([
      series('BIG', 25, 100, 10_000_000),
      moved(series('MOVE', 25, 100, 1_000_000)),
      series('FLAT', 25, 100, 1_000_000),
    ]);
    const selection = selectUniverse(['BIG', 'MOVE', 'FLAT'], poolOf(source));
    expect(selection.liquidity).toEqual(['BIG', 'FLAT', 'MOVE']);
    expect(selection.movers).toEqual([]);
    expect(selection.refusals.map((refusal) => refusal.parameter)).toEqual([
      'G18_SMALL_CAP_FLOORS',
    ]);
  });

  it('picks movers from the pool outside the liquidity core, disjoint from it', () => {
    const source = memorySource([
      ...core(),
      moved(series('MOVE', 25, 100, 1_000_000)),
      series('FLAT', 25, 100, 1_000_000),
      series('THIN', 25, 100, 1_000),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'MOVE', 'FLAT', 'THIN'];
    const selection = selectUniverse(symbols, poolOf(source));
    expect(selection.liquidity).toHaveLength(10);
    expect(selection.liquidity).not.toContain('MOVE');
    expect(selection.movers).toEqual(['MOVE', 'FLAT']);
  });

  it('ranks a fall of 30% above a rise of 20%, by size of move not sign', () => {
    const source = memorySource([
      ...core(),
      moved(series('DOWN', 25, 100, 1_000_000), 70),
      moved(series('UP', 25, 100, 1_000_000), 120),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'UP', 'DOWN'];
    expect(selectUniverse(symbols, poolOf(source)).movers).toEqual(['DOWN', 'UP']);
  });

  it('reads the GBPUSD rate of the trading date year', () => {
    const source = memorySource([series('ISF', 25, 100, 1_000), series('AAPL', 25, 100, 1_100)]);
    const yearRate = (year: number) => {
      if (year !== 2026) throw new Error(`asked for ${year}`);
      return 1.25;
    };
    const pool = { ...poolOf(source), market: { gbpUsdAtYearStart: yearRate } };
    expect(liquidityCore(['AAPL', 'ISF'], pool, 2)).toEqual(['ISF', 'AAPL']);
  });

  it('applies the USD movers floor to an LSE name after converting its GBP volume', () => {
    const gbpVolume = MOVERS_MIN_DOLLAR_VOLUME_USD / 1.1;
    const source = memorySource([
      ...core(),
      moved(series('IUSA', 25, 1, gbpVolume)),
      moved(series('AAPL', 25, 1, gbpVolume)),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'IUSA', 'AAPL'];
    expect(selectUniverse(symbols, poolOf(source, TRADING_DATE, 1.2)).movers).toEqual(['IUSA']);
    expect(selectUniverse(symbols, poolOf(source, TRADING_DATE, 1.05)).movers).toEqual([]);
  });

  it('ranks an LSE mover against a US mover on return alone, whatever the currency', () => {
    const source = memorySource([
      ...core(),
      moved(series('IUSA', 25, 100, 1_000_000), 120),
      moved(series('AAPL', 25, 100, 1_000_000), 110),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'AAPL', 'IUSA'];
    expect(selectUniverse(symbols, poolOf(source)).movers).toEqual(['IUSA', 'AAPL']);
  });

  it('holds the shared cap in total, US plus LSE never above the cap (#1774 c)', () => {
    const us = Array.from({ length: 25 }, (_, i) =>
      moved(series(`U${String(i).padStart(2, '0')}`, 25, 100, 10_000_000 + i), 100 + i),
    );
    const lseTidms = [
      'ISF',
      'VMID',
      'CUKS',
      'IUSA',
      'CUS1',
      'IEUX',
      'IJPN',
      'CPJ1',
      'IEEM',
      'IITU',
    ];
    const lse = lseTidms.map((tidm, i) =>
      moved(series(tidm, 25, 100, 10_000_000 + 100 + i), 100 + 30 + i),
    );
    const source = memorySource([...us, ...lse]);
    const symbols = [...us, ...lse].map((entry) => entry.symbol);
    const selection = selectUniverse(symbols, poolOf(source));
    expect(UNIVERSE_CAP).toBe(20);
    expect(selection.liquidity).toHaveLength(10);
    expect(selection.movers).toHaveLength(10);
    const picked = [...selection.liquidity, ...selection.movers];
    expect(new Set(picked).size).toBe(UNIVERSE_CAP);
    expect(picked.filter(isLseInstrument).length).toBeGreaterThan(0);
    expect(picked.filter((symbol) => !isLseInstrument(symbol)).length).toBeGreaterThan(0);
  });

  it('keeps the cap and the US-only picks when LSE names join a full US pool', () => {
    const us = Array.from({ length: 30 }, (_, i) =>
      series(`U${String(i).padStart(2, '0')}`, 25, 100, 10_000_000 + i * 1000),
    );
    const lse = ['ISF', 'IUSA', 'VMID'].map((tidm) => series(tidm, 25, 100, 1_000));
    const usSymbols = us.map((entry) => entry.symbol);
    const pool = poolOf(memorySource([...us, ...lse]));
    const usOnly = selectUniverse(usSymbols, pool);
    const shared = selectUniverse([...usSymbols, ...lse.map((entry) => entry.symbol)], pool);
    expect(shared).toEqual(usOnly);
    expect(shared.liquidity.length + shared.movers.length).toBe(UNIVERSE_CAP);
  });

  it('selects US names identically whatever the GBPUSD rate', () => {
    const source = memorySource([
      ...core(),
      moved(series('MOVE', 25, 100, 1_000_000)),
      series('FLAT', 25, 100, 500_000),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'MOVE', 'FLAT'];
    const at = (rate: number) => selectUniverse(symbols, poolOf(source, TRADING_DATE, rate));
    expect(at(0.5).movers).toEqual(['MOVE', 'FLAT']);
    expect(at(0.5)).toEqual(at(2));
  });

  it('orders deterministically whatever order the pool arrives in', () => {
    const source = memorySource([
      ...core(),
      moved(series('IUSA', 25, 100, 1_000_000), 120),
      moved(series('AAPL', 25, 100, 1_000_000), 120),
      moved(series('BBB', 25, 100, 1_000_000), 120),
    ]);
    const symbols = [...core().map((entry) => entry.symbol), 'IUSA', 'AAPL', 'BBB'];
    const forward = selectUniverse(symbols, poolOf(source));
    expect(selectUniverse([...symbols].reverse(), poolOf(source))).toEqual(forward);
    expect(forward.movers).toEqual(['AAPL', 'BBB', 'IUSA']);
  });
});
