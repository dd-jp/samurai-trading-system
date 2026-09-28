import { describe, expect, it } from 'vitest';
import type { MarketData, V2Bar } from '../../../../contracts/index.js';
import {
  CROSS_ASSET_TREND_BENCHMARK_ID,
  CROSS_ASSET_TREND_CANDIDATE_ID,
  CROSS_ASSET_TREND_FROM,
  CROSS_ASSET_TREND_TIDMS,
  CROSS_ASSET_TREND_TO,
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

function fixedCountMarket(count: number, finalClose = 100): MarketData {
  return {
    lastBarBefore: () => undefined,
    barsBefore: () =>
      Array.from({ length: count }, (_, index) => {
        const close = index === count - 1 ? finalClose : 100;
        return {
          date: `D${index}`,
          open: close,
          high: close,
          low: close,
          close,
          volume: 1_000,
          rawClose: close,
        };
      }),
    gbpUsdAtYearStart: () => 1,
  };
}

function emptyMarket(): MarketData {
  return { lastBarBefore: () => undefined, barsBefore: () => [], gbpUsdAtYearStart: () => 1 };
}

function marketWithOldOutlierBars(): MarketData {
  const bars: V2Bar[] = [];
  for (let index = 0; index < 10; index++) {
    bars.push({
      date: `OLD${index}`,
      open: 200,
      high: 200,
      low: 200,
      close: 200,
      volume: 1_000,
      rawClose: 200,
    });
  }
  for (let index = 10; index < 109; index++) {
    bars.push({
      date: `D${index}`,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1_000,
      rawClose: 100,
    });
  }
  bars.push({
    date: 'D109',
    open: 110,
    high: 110,
    low: 110,
    close: 110,
    volume: 1_000,
    rawClose: 110,
  });
  return { lastBarBefore: () => undefined, barsBefore: () => bars, gbpUsdAtYearStart: () => 1 };
}

// open(200) > high(100) fails shapeValid; a correct filter drops it, leaving 109 flat closes at
// 100 so close(100) is not above the SMA (exit). Left unfiltered, its close=0 drags the average
// below 100, so close(100) IS above it and the sleeve wrongly enters
function marketWithInteriorBadBar(): MarketData {
  const bars: V2Bar[] = Array.from({ length: 110 }, (_, index) => ({
    date: `D${index}`,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1_000,
    rawClose: 100,
  }));
  bars[105] = {
    date: 'D105',
    open: 200,
    high: 100,
    low: 100,
    close: 0,
    volume: 1_000,
    rawClose: 0,
  };
  return { lastBarBefore: () => undefined, barsBefore: () => bars, gbpUsdAtYearStart: () => 1 };
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
    expect(sleeve100.spec).toEqual({
      capitalShare: 0.7,
      minimumCapitalGbp: 0,
      capacityGbp: Number.POSITIVE_INFINITY,
      validation: 'backtest',
      macroGate: false,
      sizing: {
        riskFraction: 0.0015,
        stopAtrMultiple: 3,
        targetAtrMultiple: 1_000_000,
        timeStopTradingDays: 1_000_000,
        advShare: 1,
        advWindowBars: 20,
      },
      books: [{ variant: 'primary', instantiated: true }],
    });
  });

  it('pins the candidate id, window literals and benchmark id used by the trial hash (doc 66, 2026-09-28)', () => {
    expect(CROSS_ASSET_TREND_CANDIDATE_ID).toBe('cross-asset-trend');
    expect(CROSS_ASSET_TREND_FROM).toBe('2017-08-18');
    expect(CROSS_ASSET_TREND_TO).toBe('2025-09-24');
    expect(CROSS_ASSET_TREND_BENCHMARK_ID).toBe('cross-asset-trend-benchmark');
  });

  it('enters long when the close is above the SMA', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(150));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    expect(output.refusals).toEqual([]);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('enter_long');
      expect(decision.price).toBe(150);
      expect(decision.stop_price).toBeLessThan(150);
      expect(decision.atr).toBeGreaterThan(0);
      expect(decision.venue).toBe('saxo');
      expect(decision.direction).toBe('bullish');
      expect(decision.reason).toBe('close above SMA');
      expect(decision.inputs_hash).toBe(`${decision.instrument}-2025-01-01`);
    }
  });

  it('rescales atr and stop_price by the raw/close ratio on a split-adjusted last bar', async () => {
    // Base bars close=100 flat; the last bar's close=150 (above the ~100.5 SMA, enters long) with
    // a wide 140-160 range against a flat 100 previous close, so its true range is 60 and the
    // 20-day ATR is 60/20=3 in close terms; rawClose=375 makes the raw/close ratio 2.5, so the
    // rescaled atr is 3*2.5=7.5 and stop_price is 375 - 3*7.5=352.5
    const sleeve = createCrossAssetTrendSleeve(100)(
      flatMarket(150, { high: 160, low: 140, rawClose: 375 }),
    );
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('enter_long');
      expect(decision.price).toBe(375);
      expect(decision.atr).toBeCloseTo(7.5, 9);
      expect(decision.stop_price).toBeCloseTo(352.5, 9);
    }
  });

  it('exits when the close is below the SMA', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(50));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('exit');
      expect(decision.price).toBe(50);
      expect(decision.stop_price).toBeUndefined();
      expect(decision.venue).toBe('saxo');
      expect(decision.direction).toBe('neutral');
      expect(decision.reason).toBe('close below SMA');
      expect(decision.inputs_hash).toBe(`${decision.instrument}-2025-01-01`);
    }
  });

  it('filters a shape-invalid interior bar out of the SMA window rather than averaging it in', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(marketWithInteriorBadBar());
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('exit');
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
      expect(decision.atr).toBeUndefined();
      expect(decision.price).toBe(100);
      expect(decision.venue).toBe('saxo');
      expect(decision.direction).toBe('neutral');
      expect(decision.inputs_hash).toBe('');
    }
  });

  it('skips as insufficient_history when the ATR warms up before the SMA does', async () => {
    // 50 bars: enough for the 20-day ATR (needs >= 21) but short of the 100-day SMA window
    const sleeve = createCrossAssetTrendSleeve(100)(fixedCountMarket(50));
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

  it.each([
    ['open below low', { open: 90, high: 150, low: 100, close: 120 }],
    ['open above high', { open: 160, high: 150, low: 100, close: 120 }],
    ['close below low', { open: 120, high: 150, low: 100, close: 90 }],
    ['close above high', { open: 120, high: 150, low: 100, close: 160 }],
  ])('skips as bad_last_bar when the last bar has %s', async (_label, overrides) => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(120, overrides));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('bad_last_bar');
    }
  });

  it.each([
    ['open equal to low', { open: 100, high: 150, low: 100, close: 120 }],
    ['open equal to high', { open: 150, high: 150, low: 100, close: 120 }],
    ['close equal to low', { open: 120, high: 150, low: 100, close: 100 }],
    ['close equal to high', { open: 120, high: 150, low: 100, close: 150 }],
  ])('treats a last bar with %s as shape-valid, not bad_last_bar', async (_label, overrides) => {
    const sleeve = createCrossAssetTrendSleeve(100)(flatMarket(120, overrides));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.reason).not.toBe('bad_last_bar');
    }
  });

  it('computes the SMA at exactly smaWindow bars, the warmup boundary', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(fixedCountMarket(100));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.reason).not.toBe('insufficient_history');
    }
  });

  it('averages only the trailing smaWindow bars, not every bar in history', async () => {
    // 10 bars at 200 sit outside the SMA(100) window; only the trailing 100 bars (99 at 100,
    // last at 110) count. Correct SMA = (99*100+110)/100 = 100.1, so close(110) sits just above
    // it and the sleeve enters; summing all 110 bars instead would push the average to 120.1,
    // flipping the decision to exit
    const sleeve = createCrossAssetTrendSleeve(100)(marketWithOldOutlierBars());
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('enter_long');
    }
  });

  it('skips as bad_last_bar when there is no last bar at all', async () => {
    const sleeve = createCrossAssetTrendSleeve(100)(emptyMarket());
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

  it('skips as insufficient_history when its SMA(20) warms up before its own ATR(20) does', async () => {
    // The benchmark's own smaWindow equals ATR_WINDOW (20), so 20 bars satisfy the SMA's
    // length >= 20 but not the ATR's length >= 21 — the one case where this candidate's two
    // window thresholds can disagree instead of the SMA(100/200) sleeves' always-wider SMA window
    const sleeve = createCrossAssetTrendBenchmarkSleeve()(fixedCountMarket(20));
    const output = await sleeve.decide(CONTEXT, CROSS_ASSET_TREND_TIDMS);
    for (const decision of output.decisions) {
      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('insufficient_history');
    }
  });
});
