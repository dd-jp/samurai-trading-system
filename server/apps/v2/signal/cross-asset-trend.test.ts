import { describe, expect, it } from 'vitest';
import type { MarketData, V2Bar } from '../../../../contracts/index.js';
import {
  CROSS_ASSET_TREND_BENCHMARK_ID,
  CROSS_ASSET_TREND_TIDMS,
  createCrossAssetTrendBenchmarkSleeve,
  createCrossAssetTrendSleeve,
  crossAssetTrendSleeveId,
} from './cross-asset-trend.js';

const CONTEXT = { tradingDate: '2025-01-01', macroDay: false, dryRun: true };

function flatMarket(finalClose: number, finalOverrides: Partial<V2Bar> = {}): MarketData {
  return {
    lastBarBefore: () => undefined,
    barsBefore: (_instrument, _tradingDate, count) =>
      Array.from({ length: count }, (_, index) => {
        const isLast = index === count - 1;
        const close = isLast ? finalClose : 100;
        return {
          date: `2024-01-${String(index + 1).padStart(2, '0')}`,
          open: close,
          high: close,
          low: close,
          close,
          volume: 1_000,
          rawClose: close,
          ...(isLast ? finalOverrides : {}),
        };
      }),
    gbpUsdAtYearStart: () => 1,
  };
}

describe('CROSS_ASSET_TREND_TIDMS', () => {
  it('is exactly the 15 declared lines from #1785 ruling (b)', () => {
    expect(CROSS_ASSET_TREND_TIDMS).toHaveLength(15);
    expect(new Set(CROSS_ASSET_TREND_TIDMS)).toEqual(
      new Set([
        'ISF',
        'VMID',
        'IUSA',
        'IEUX',
        'IJPN',
        'IEEM',
        'IGLT',
        'INXG',
        'SLXX',
        'VUTY',
        'SGLN',
        'SSLN',
        'CUKS',
        'CUS1',
        'CPJ1',
      ]),
    );
  });
});

describe('createCrossAssetTrendSleeve', () => {
  it('ids by window and declares the universe with no refusals', () => {
    const sleeve100 = createCrossAssetTrendSleeve(100)(flatMarket(100));
    const sleeve200 = createCrossAssetTrendSleeve(200)(flatMarket(100));
    expect(sleeve100.id).toBe('cross-asset-trend-sma100');
    expect(sleeve200.id).toBe('cross-asset-trend-sma200');
    expect(crossAssetTrendSleeveId(100)).toBe('cross-asset-trend-sma100');
    expect(sleeve100.universe(CONTEXT)).toEqual({
      instruments: CROSS_ASSET_TREND_TIDMS,
      refusals: [],
    });
  });

  it('enters long when the close is above the SMA', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(150));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('enter_long');
      expect(decision.price).toBe(150);
      expect(decision.stop_price).toBeLessThan(150);
      expect(decision.atr).toBeGreaterThan(0);
    }
  });

  it('exits when the close is below the SMA', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(50));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('exit');
      expect(decision.price).toBe(50);
      expect(decision.stop_price).toBeUndefined();
    }
  });

  it('skips as insufficient_history when the SMA/ATR window has not warmed up', async () => {
    const thin: MarketData = {
      lastBarBefore: () => undefined,
      barsBefore: () => [
        {
          date: '2024-01-01',
          open: 100,
          high: 100,
          low: 100,
          close: 100,
          volume: 1,
          rawClose: 100,
        },
      ],
      gbpUsdAtYearStart: () => 1,
    };
    const sleeve = createCrossAssetTrendSleeve(100)(thin);
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('insufficient_history');
    }
  });

  it('skips as bad_last_bar when the last bar fails the #1838 shape check, fail-closed', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(150, { close: 200, high: 150 }));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('bad_last_bar');
    }
  });
});

describe('createCrossAssetTrendBenchmarkSleeve', () => {
  it('always signals long once its own warmup window is covered, trend ignored (ruling d)', async () => {
    const sleeve = createCrossAssetTrendBenchmarkSleeve()(flatMarket(50));
    expect(sleeve.id).toBe(CROSS_ASSET_TREND_BENCHMARK_ID);
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('enter_long');
    }
  });
});
