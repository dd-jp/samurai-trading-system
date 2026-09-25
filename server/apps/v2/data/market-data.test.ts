import { describe, expect, it, vi } from 'vitest';
import type { V2Bar } from '../../../../contracts/index.js';
import { BarsMarketData, quotePerGbp } from './market-data.js';

function bar(date: string, rawClose: number): V2Bar {
  return { date, open: 1, high: 1, low: 1, close: 1, volume: 1, rawClose };
}

describe('BarsMarketData', () => {
  const load = vi.fn((symbol: string) =>
    symbol === 'UP'
      ? { symbol, bars: [bar('2026-09-23', 10), bar('2026-09-24', 11)] }
      : undefined,
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

  it('caches the year-start rate and quotes only US venues in dollars', () => {
    const first = market.gbpUsdAtYearStart(2026);
    expect(market.gbpUsdAtYearStart(2026)).toBe(first);
    expect(quotePerGbp(market, 'alpaca', '2026-09-25')).toBe(first);
    expect(quotePerGbp(market, 'saxo', '2026-09-25')).toBe(1);
    expect(() => market.gbpUsdAtYearStart(2024)).toThrow(/no GBPUSD/);
  });
});
