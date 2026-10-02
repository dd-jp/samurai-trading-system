import { describe, expect, it, vi } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import { BarsMarketData, fillFxOf, londonDateOf, quotePerGbp } from './market-data.js';

function bar(date: string, rawClose: number): V2Bar {
  return { date, open: 1, high: 1, low: 1, close: 1, volume: 1, rawClose };
}

describe('BarsMarketData', () => {
  const load = vi.fn((symbol: string) =>
    symbol === 'UP' ? { symbol, bars: [bar('2026-09-23', 10), bar('2026-09-24', 11)] } : undefined,
  );
  const market = new BarsMarketData({ load }, [
    { date: '2025-12-31', gbpUsd: 1.3 },
    { date: '2026-01-02', gbpUsd: 1.35 },
  ]);

  it('reads the last bar strictly before the trading date', () => {
    expect(market.lastBarBefore('UP', '2026-09-24')?.rawClose).toBe(10);
    expect(market.lastBarBefore('UP', '2026-09-25')?.rawClose).toBe(11);
    expect(market.lastBarBefore('UP', '2026-09-23')).toBeUndefined();
    expect(market.lastBarBefore('MISSING', '2026-09-25')).toBeUndefined();
  });

  it('reads at most the last count bars strictly before the trading date', () => {
    expect(market.barsBefore('UP', '2026-09-25', 1).map((b) => b.rawClose)).toEqual([11]);
    expect(market.barsBefore('UP', '2026-09-25', 5).map((b) => b.rawClose)).toEqual([10, 11]);
    expect(market.barsBefore('UP', '2026-09-24', 5).map((b) => b.rawClose)).toEqual([10]);
    expect(market.barsBefore('UP', '2026-09-25', 0)).toEqual([]);
    expect(market.barsBefore('MISSING', '2026-09-25', 5)).toEqual([]);
  });

  it('caches the year-start rate and quotes only US venues in dollars', () => {
    const first = market.gbpUsdAtYearStart(2026);
    expect(market.gbpUsdAtYearStart(2026)).toBe(first);
    expect(quotePerGbp(market, 'alpaca', '2026-09-25')).toBe(first);
    expect(quotePerGbp(market, 'saxo', '2026-09-25')).toBe(1);
    expect(() => market.gbpUsdAtYearStart(2024)).toThrow(/no GBPUSD/);
  });
});

describe('fillFxOf and londonDateOf (#1947)', () => {
  const market = new BarsMarketData({ load: () => undefined }, [
    { date: '2025-12-31', gbpUsd: 1.3 },
    { date: '2026-09-24', gbpUsd: 1.2 },
  ]);

  it('names the currency, the rate the fill was booked at and the fix it came from', () => {
    expect(fillFxOf(market, 'alpaca', '2026-09-25')).toEqual({
      currency: 'USD',
      quotePerGbp: 1.3,
      source: 'boe-xudluss:year-start:2026@2025-12-31',
    });
    expect(market.gbpUsdYearStartFixDate(2026)).toBe('2025-12-31');
  });

  it('names a stale fix as stale when the series ends before 1 January', () => {
    expect(fillFxOf(market, 'alpaca', '2027-01-04')).toMatchObject({
      quotePerGbp: 1.2,
      source: 'boe-xudluss:year-start:2027@2026-09-24',
    });
    expect(fillFxOf({ gbpUsdAtYearStart: () => 1.25 }, 'alpaca', '2027-01-04').source).toBe(
      'boe-xudluss:year-start:2027@unknown',
    );
  });

  it('needs no rate for sterling', () => {
    expect(fillFxOf(market, 'saxo', '2026-09-25')).toEqual({
      currency: 'GBP',
      quotePerGbp: 1,
      source: 'gbp',
    });
  });

  it('dates a timestamp by the London calendar, across both clock changes', () => {
    expect(londonDateOf('2026-07-01T22:59:59.000Z')).toBe('2026-07-01');
    expect(londonDateOf('2026-07-01T23:00:00.000Z')).toBe('2026-07-02');
    expect(londonDateOf('2026-12-01T23:59:59.000Z')).toBe('2026-12-01');
    expect(londonDateOf('2026-12-02T00:00:00.000Z')).toBe('2026-12-02');
  });
});
