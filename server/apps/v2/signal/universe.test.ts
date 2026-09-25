import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import type { BarsSource } from '../data/index.js';
import { MOVERS_MIN_DOLLAR_VOLUME_USD } from './parameters.js';
import { averageDollarVolume, liquidityCore, selectMovers, selectUniverse } from './universe.js';

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

function memorySource(all: readonly BarSeries[]): BarsSource {
  return { load: (symbol) => all.find((entry) => entry.symbol === symbol) };
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
    expect(
      liquidityCore(['MID', 'BIG', 'NEW', 'STALE', 'MISSING'], source, '2026-09-26', 10),
    ).toEqual(['BIG', 'MID']);
    expect(liquidityCore(['MID', 'BIG'], source, '2026-09-26', 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], source, '2026-09-25', 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], source, '2026-09-30', 1)).toEqual(['BIG']);
    expect(liquidityCore(['BIG'], source, '2026-10-01', 1)).toEqual([]);
  });
});

describe('coverage invariant', () => {
  it('refuses a series whose last bar is more than five calendar days old', () => {
    const source = memorySource([series('STALE', 20, 100, 100_000)]);
    expect(liquidityCore(['STALE'], source, '2026-09-25', 1)).toEqual(['STALE']);
    expect(liquidityCore(['STALE'], source, '2026-09-26', 1)).toEqual([]);
    expect(selectUniverse(['STALE'], source, '2026-09-26').movers).toEqual([]);
  });

  it('breaks an average-dollar-volume tie alphabetically', () => {
    const source = memorySource([series('B', 25, 10, 100), series('A', 25, 10, 100)]);
    expect(liquidityCore(['B', 'A'], source, '2026-09-26', 1)).toEqual(['A']);
    expect(liquidityCore(['B', 'A'], source, '2026-09-26', 2)).toEqual(['A', 'B']);
  });
});

function moved(input: BarSeries): BarSeries {
  const last = input.bars.at(-1);
  if (last === undefined) return input;
  return { symbol: input.symbol, bars: [...input.bars.slice(0, -1), { ...last, close: 110 }] };
}

describe('movers', () => {
  it('ranks by absolute prior-day return above the dollar-volume floor, ties alphabetically', () => {
    const candidates = [
      { symbol: 'UP', dayReturn: 0.05, dollarVolume: MOVERS_MIN_DOLLAR_VOLUME_USD },
      { symbol: 'DOWN', dayReturn: -0.08, dollarVolume: MOVERS_MIN_DOLLAR_VOLUME_USD },
      { symbol: 'THIN', dayReturn: 0.5, dollarVolume: MOVERS_MIN_DOLLAR_VOLUME_USD - 1 },
      { symbol: 'B', dayReturn: 0.05, dollarVolume: MOVERS_MIN_DOLLAR_VOLUME_USD * 2 },
      { symbol: 'A', dayReturn: -0.05, dollarVolume: MOVERS_MIN_DOLLAR_VOLUME_USD * 2 },
    ];
    expect(selectMovers(candidates)).toEqual(['DOWN', 'A', 'B', 'UP']);
    expect(selectMovers(candidates, 2)).toEqual(['DOWN', 'A']);
  });
});

describe('selectUniverse', () => {
  it('fills the liquidity half first, so a thin constituent list leaves no movers', () => {
    const source = memorySource([
      series('BIG', 25, 100, 10_000_000),
      moved(series('MOVE', 25, 100, 1_000_000)),
      series('FLAT', 25, 100, 1_000_000),
    ]);
    const selection = selectUniverse(['BIG', 'MOVE', 'FLAT'], source, '2026-09-26');
    expect(selection.liquidity).toEqual(['BIG', 'FLAT', 'MOVE']);
    expect(selection.movers).toEqual([]);
    expect(selection.refusals.map((refusal) => refusal.parameter)).toEqual([
      'G18_SMALL_CAP_FLOORS',
    ]);
  });

  it('picks movers from the pool outside the liquidity core, disjoint from it', () => {
    const core = Array.from({ length: 10 }, (_, i) => series(`L${i}`, 25, 100, 10_000_000 + i));
    const source = memorySource([
      ...core,
      moved(series('MOVE', 25, 100, 1_000_000)),
      series('FLAT', 25, 100, 1_000_000),
      series('THIN', 25, 100, 1_000),
    ]);
    const symbols = [...core.map((entry) => entry.symbol), 'MOVE', 'FLAT', 'THIN'];
    const selection = selectUniverse(symbols, source, '2026-09-26');
    expect(selection.liquidity).toHaveLength(10);
    expect(selection.liquidity).not.toContain('MOVE');
    expect(selection.movers).toEqual(['MOVE', 'FLAT']);
  });
});
