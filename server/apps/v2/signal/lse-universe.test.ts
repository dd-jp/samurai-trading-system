import { describe, expect, it } from 'vitest';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import type { BarsSource } from '../data/index.js';
import { lseInstrumentsAbove, selectLseUniverse } from './lse-universe.js';
import { SAXO_APPROPRIATENESS_TEST_TAKEN } from './parameters.js';

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

function withCalendar(all: readonly BarSeries[]): readonly BarSeries[] {
  if (all.some((entry) => entry.symbol === 'ISF')) return all;
  const dates = [...new Set(all.flatMap((entry) => entry.bars.map((bar) => bar.date)))].sort();
  const reference = dates.map((date) => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    rawClose: 1,
  }));
  return [...all, { symbol: 'ISF', bars: reference }];
}

function memorySource(all: readonly BarSeries[]): BarsSource {
  const withReference = withCalendar(all);
  return { load: (symbol) => withReference.find((entry) => entry.symbol === symbol) };
}

describe('lseInstrumentsAbove', () => {
  it('screens by 20-day average GBP notional and gates SGLN/SSLN behind the appropriateness test', () => {
    const source = memorySource([
      series('ISF', 25, 100, 1_000_000),
      series('IGLT', 25, 1, 100),
      series('SGLN', 25, 100, 1_000_000),
    ]);
    const untaken = lseInstrumentsAbove(source, '2026-09-26', 50_000_000, false);
    expect(untaken).toContain('ISF');
    expect(untaken).not.toContain('IGLT');
    expect(untaken).not.toContain('SGLN');
    const taken = lseInstrumentsAbove(source, '2026-09-26', 50_000_000, true);
    expect(taken).toContain('SGLN');
  });

  it('excludes a name with no covered bars, and admits the fixture at a zero floor', () => {
    const source = memorySource([series('ISF', 25, 100, 1_000_000)]);
    expect(lseInstrumentsAbove(source, '2026-09-26', 0)).toEqual(['ISF']);
    expect(lseInstrumentsAbove(source, '2026-09-26', Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('admits a name whose average notional exactly equals the floor', () => {
    const source = memorySource([series('ISF', 25, 100, 1_000_000)]);
    expect(lseInstrumentsAbove(source, '2026-09-26', 100_000_000)).toEqual(['ISF']);
    expect(lseInstrumentsAbove(source, '2026-09-26', 100_000_000.01)).toEqual([]);
  });
});

describe('selectLseUniverse', () => {
  it('screens at the resolved 1M GBP floor and admits the complex lines now the test is taken (#1774)', () => {
    const source = memorySource([
      series('ISF', 25, 100, 1_000_000),
      series('IUKP', 25, 100, 5_000),
      series('SGLN', 25, 100, 1_000_000),
    ]);
    const selection = selectLseUniverse(source, '2026-09-26');
    expect([...selection.instruments].sort()).toEqual(['ISF', 'SGLN']);
    expect(selection.refusals).toEqual([]);
  });

  it('selects the lines above a set screen with no refusal, injected so it does not wait on #1871', () => {
    const source = memorySource([series('ISF', 25, 100, 1_000_000), series('IGLT', 25, 1, 100)]);
    const screen = { name: 'LSE_LIQUIDITY_SCREEN', ticket: '#1774', value: 1_000_000 };
    expect(selectLseUniverse(source, '2026-09-26', screen)).toEqual({
      instruments: ['ISF'],
      refusals: [],
    });
  });
});
