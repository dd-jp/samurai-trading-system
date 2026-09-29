import { describe, expect, it } from 'vitest';
import type { MarketData, V2Bar } from '../../../../contracts/index.js';
import type { BarSeries, DailyBar } from '../../../pipeline/momentum/index.js';
import type { BarsSource } from '../data/index.js';
import {
  createMeanReversionBenchmarkSleeve,
  createMeanReversionSleeve,
  MEAN_REVERSION_BENCHMARK_ID,
  MEAN_REVERSION_CANDIDATE_ID,
  MEAN_REVERSION_ENTRY_THRESHOLDS,
  MEAN_REVERSION_FROM,
  MEAN_REVERSION_TIME_STOP_TRADING_DAYS,
  MEAN_REVERSION_TO,
  MEAN_REVERSION_UNIVERSE_COUNT,
  meanReversionSleeveId,
  relativeStrengthIndex,
} from './mean-reversion.js';

const CONTEXT = { tradingDate: '2025-01-01', macroDay: false, dryRun: true };
const SMA_WINDOW = 200;
const ATR_WINDOW = 20;
const LOOKBACK_BARS = SMA_WINDOW + ATR_WINDOW + 20;

function bar(index: number, close: number, overrides: Partial<V2Bar> = {}): V2Bar {
  return {
    date: `D${index}`,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    rawClose: close,
    ...overrides,
  };
}

function closesMarket(closes: readonly number[], finalOverrides: Partial<V2Bar> = {}): MarketData {
  const bars = closes.map((close, index) =>
    index === closes.length - 1 ? bar(index, close, finalOverrides) : bar(index, close),
  );
  return { lastBarBefore: () => undefined, barsBefore: () => bars, gbpUsdAtYearStart: () => 1 };
}

// #1785 ruling (d): a deep-oversold read inside a real uptrend. A long lower plateau (100) forms
// most of the trailing SMA(200) window, an elevated plateau (200) near the end pulls the SMA well
// below the current price, and the single tiny final-day dip (200 -> 199) is the only nonzero
// change in the last ~20 bars: relativeStrengthIndex's recursive average decays the prior gain/
// loss to ~0 by then, so that one small loss drives RSI(2) near 0 (measured ~0.019, asserted only
// as < 15) while close (199) stays far above the barely-moved SMA (~109.995, computed in-test)
function oversoldCloses(): number[] {
  const closes = Array.from({ length: LOOKBACK_BARS }, () => 100);
  for (let index = LOOKBACK_BARS - 20; index < LOOKBACK_BARS - 1; index++) {
    closes[index] = 200;
  }
  closes[LOOKBACK_BARS - 1] = 199;
  return closes;
}

// Mirrors oversoldCloses but recovers upward on the final bar: a long flat run decays gain/loss
// to ~0, then a single small final-day rise (100 -> 101) drives RSI(2) to exactly 100
function recoveredCloses(): number[] {
  const closes = Array.from({ length: LOOKBACK_BARS }, () => 100);
  closes[LOOKBACK_BARS - 1] = 101;
  return closes;
}

function flatCloses(): number[] {
  return Array.from({ length: LOOKBACK_BARS }, () => 100);
}

// Rise 26 / fall 7 lands RSI(2) on exactly 65 in floating point; rise 199 / fall 198 lands the
// last close exactly on SMA(200) (integer sums). Both found by search, so boundary tests can pin
// strict versus inclusive comparisons
function twoMoveCloses(rise: number, fall: number): number[] {
  const closes = Array.from({ length: LOOKBACK_BARS }, () => 1_000);
  closes[LOOKBACK_BARS - 2] = 1_000 + rise;
  closes[LOOKBACK_BARS - 1] = 1_000 + rise - fall;
  return closes;
}

async function decideOn(closes: readonly number[], entryThreshold: number) {
  const noSource: BarsSource = { load: () => undefined };
  const sleeve = createMeanReversionSleeve(
    noSource,
    () => [],
    entryThreshold,
  )(closesMarket(closes));
  const output = await sleeve.decide(CONTEXT, ['AAA']);
  return output.decisions[0];
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

function withCalendar(all: readonly BarSeries[]): readonly BarSeries[] {
  const dates = [...new Set(all.flatMap((entry) => entry.bars.map((bar_) => bar_.date)))].sort();
  const reference = dates.map((date) => ({
    date,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    rawClose: 1,
  }));
  return [...all, { symbol: 'SPY', bars: reference }];
}

function memorySource(all: readonly BarSeries[]): BarsSource {
  const withReference = withCalendar(all);
  return { load: (symbol) => withReference.find((entry) => entry.symbol === symbol) };
}

describe('relativeStrengthIndex', () => {
  it('is undefined below period + 1 bars', () => {
    expect(relativeStrengthIndex([bar(0, 100), bar(1, 101)], 2)).toBeUndefined();
  });

  it('is 50 on a perfectly flat series (no gains, no losses)', () => {
    const bars = Array.from({ length: 10 }, (_, index) => bar(index, 100));
    expect(relativeStrengthIndex(bars, 2)).toBe(50);
  });

  it('is 100 after a long flat run followed by a single up day', () => {
    const bars = flatCloses().map((close, index) => bar(index, close));
    const lastUp = [...bars.slice(0, -1), bar(bars.length - 1, 101)];
    expect(relativeStrengthIndex(lastUp, 2)).toBe(100);
  });

  it('matches a hand-computed Wilder RSI(2) on a mixed series', () => {
    const closesOf = (closes: readonly number[]) => closes.map((close, index) => bar(index, close));
    expect(relativeStrengthIndex(closesOf([10, 11, 10, 12]), 2)).toBeCloseTo(100 - 100 / 6, 9);
    expect(relativeStrengthIndex(closesOf([10, 11, 10, 12, 11.5]), 2)).toBeCloseTo(62.5, 9);
  });

  it('is 0 after a long flat run followed by a single down day', () => {
    const bars = flatCloses().map((close, index) => bar(index, close));
    const lastDown = [...bars.slice(0, -1), bar(bars.length - 1, 99)];
    expect(relativeStrengthIndex(lastDown, 2)).toBe(0);
  });
});

describe('meanReversionSleeveId', () => {
  it('ids by RSI entry threshold', () => {
    expect(meanReversionSleeveId(10)).toBe('mean-reversion-rsi10');
    expect(meanReversionSleeveId(15)).toBe('mean-reversion-rsi15');
  });
});

describe('MEAN_REVERSION constants', () => {
  it('pins the candidate id, thresholds, window literals and benchmark id used by the trial hash', () => {
    expect(MEAN_REVERSION_CANDIDATE_ID).toBe('mean-reversion');
    expect(MEAN_REVERSION_BENCHMARK_ID).toBe('mean-reversion-benchmark');
    expect(MEAN_REVERSION_ENTRY_THRESHOLDS).toEqual([10, 15]);
    expect(MEAN_REVERSION_FROM).toBe('2016-10-11');
    expect(MEAN_REVERSION_TO).toBe('2025-09-24');
    expect(MEAN_REVERSION_TIME_STOP_TRADING_DAYS).toBe(10);
    expect(MEAN_REVERSION_UNIVERSE_COUNT).toBe(300);
  });
});

describe('createMeanReversionSleeve', () => {
  const noSource: BarsSource = { load: () => undefined };
  const noConstituents = (): readonly string[] => [];

  it('ids by entry threshold and declares its spec', () => {
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      10,
    )(closesMarket(flatCloses()));
    expect(sleeve.id).toBe('mean-reversion-rsi10');
    expect(sleeve.spec).toEqual({
      capitalShare: 0.7,
      minimumCapitalGbp: 0,
      capacityGbp: Number.POSITIVE_INFINITY,
      validation: 'backtest',
      macroGate: false,
      sizing: {
        riskFraction: 0.005,
        stopAtrMultiple: 5,
        targetAtrMultiple: 1_000_000,
        timeStopTradingDays: 10,
        advShare: 1,
        advWindowBars: 20,
      },
      books: [{ variant: 'primary', instantiated: true }],
    });
  });

  it('enters long on an oversold RSI(2) dip inside an uptrend (close above SMA200)', async () => {
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      15,
    )(closesMarket(oversoldCloses()));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.refusals).toEqual([]);
    const decision = output.decisions[0];
    if (decision === undefined) throw new Error('expected a decision');
    const payload = decision.payload as { rsi2: number; sma200: number };
    expect(decision.action).toBe('enter_long');
    expect(decision.direction).toBe('bullish');
    expect(decision.venue).toBe('alpaca');
    expect(decision.price).toBe(199);
    expect(decision.stop_price).toBeLessThan(199);
    expect(decision.reason).toBe('close above SMA200, RSI(2) dip');
    expect(payload.rsi2).toBeLessThan(15);
    expect(payload.sma200).toBe(109.995);
    expect(decision.inputs_hash).toBe('AAA-2025-01-01');
  });

  it('rescales atr and stop_price by the raw/close ratio on a split-adjusted last bar (#1785)', async () => {
    // oversoldCloses' plateau (100 -> 200 at index 220) sits inside the trailing 20-day ATR
    // window, contributing a true range of 100 on its own; the 18 flat-200 days after it
    // contribute 0; overriding only the last bar's high/low to 259/199 (close stays 199) adds a
    // final true range of 60. ATR in close terms is (100 + 0*18 + 60)/20 = 8. rawClose=497.5
    // makes the raw/close ratio 2.5, so the rescaled atr is 8*2.5=20, stop_price 497.5-5*20=397.5
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      15,
    )(closesMarket(oversoldCloses(), { high: 259, low: 199, rawClose: 497.5 }));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    const decision = output.decisions[0];
    expect(decision?.action).toBe('enter_long');
    expect(decision?.price).toBe(497.5);
    expect(decision?.atr).toBeCloseTo(20, 9);
    expect(decision?.stop_price).toBeCloseTo(397.5, 9);
  });

  it('exits on RSI(2) recovery above 65, independent of the SMA gate', async () => {
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      10,
    )(closesMarket(recoveredCloses()));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    const [decision] = output.decisions;
    expect(decision?.action).toBe('exit');
    expect(decision?.direction).toBe('neutral');
    expect(decision?.stop_price).toBeUndefined();
    expect(decision?.reason).toBe('RSI(2) recovered above 65');
    expect(decision?.payload).toEqual({ rsi2: 100, sma200: 100.005 });
    expect(decision?.venue).toBe('alpaca');
    expect(decision?.inputs_hash).toBe('AAA-2025-01-01');
  });

  it('skips as no_signal when RSI(2) sits between the entry threshold and the recovery line', async () => {
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      10,
    )(closesMarket(flatCloses()));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('no_signal');
    expect(output.decisions[0]?.payload).toStrictEqual({ rsi2: 50, sma200: 100 });
  });

  it('skips a dip that closes below SMA(200) even with RSI(2) under the entry threshold', async () => {
    const decision = await decideOn(twoMoveCloses(10, 100), 15);
    const payload = decision?.payload as { rsi2: number; sma200: number };
    expect(payload.rsi2).toBeLessThan(15);
    expect(decision?.price).toBeLessThan(payload.sma200);
    expect(decision?.action).toBe('skip');
    expect(decision?.reason).toBe('no_signal');
  });

  it('needs the close strictly above SMA(200): a close exactly on it skips', async () => {
    const decision = await decideOn(twoMoveCloses(199, 198), 50);
    const payload = decision?.payload as { rsi2: number; sma200: number };
    expect(payload.rsi2).toBeLessThan(50);
    expect(decision?.price).toBe(payload.sma200);
    expect(decision?.action).toBe('skip');
  });

  it('enters only when RSI(2) is strictly below the entry threshold', async () => {
    const closes = twoMoveCloses(26, 7);
    expect((await decideOn(closes, 65))?.action).toBe('skip');
    expect((await decideOn(closes, 65 + 1e-9))?.action).toBe('enter_long');
  });

  it('exits only when RSI(2) is strictly above 65', async () => {
    const atBoundary = await decideOn(twoMoveCloses(26, 7), 10);
    expect(atBoundary?.payload).toMatchObject({ rsi2: 65 });
    expect(atBoundary?.action).toBe('skip');
    const above = await decideOn(twoMoveCloses(27, 7), 10);
    expect(above?.action).toBe('exit');
  });

  it('skips as insufficient_history below the SMA(200) warmup', async () => {
    const closes = Array.from({ length: 50 }, () => 100);
    const sleeve = createMeanReversionSleeve(noSource, noConstituents, 10)(closesMarket(closes));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('insufficient_history');
  });

  it('skips as insufficient_history below the ATR(20) warmup even with RSI(2) defined', async () => {
    const closes = Array.from({ length: 3 }, () => 100);
    const sleeve = createMeanReversionSleeve(noSource, noConstituents, 10)(closesMarket(closes));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('insufficient_history');
  });

  it('skips as bad_last_bar when the last bar fails the shape check, fail-closed', async () => {
    const sleeve = createMeanReversionSleeve(
      noSource,
      noConstituents,
      10,
    )(closesMarket(oversoldCloses(), { close: 500, high: 199 }));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('bad_last_bar');
  });

  it('skips as bad_last_bar when there is no last bar at all', async () => {
    const empty: MarketData = {
      lastBarBefore: () => undefined,
      barsBefore: () => [],
      gbpUsdAtYearStart: () => 1,
    };
    const sleeve = createMeanReversionSleeve(noSource, noConstituents, 10)(empty);
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('bad_last_bar');
    expect(output.decisions[0]?.payload).toStrictEqual({ rsi2: undefined, sma200: undefined });
  });

  it('sorts decisions by RSI(2) ascending, most oversold first (ruling g)', async () => {
    const market: MarketData = {
      lastBarBefore: () => undefined,
      barsBefore: (instrument) => {
        if (instrument === 'LOW') return oversoldCloses().map((close, index) => bar(index, close));
        if (instrument === 'FLAT') return flatCloses().map((close, index) => bar(index, close));
        return recoveredCloses().map((close, index) => bar(index, close));
      },
      gbpUsdAtYearStart: () => 1,
    };
    const sleeve = createMeanReversionSleeve(noSource, noConstituents, 15)(market);
    const output = await sleeve.decide(CONTEXT, ['HIGH', 'FLAT', 'LOW']);
    expect(output.decisions.map((decision) => decision.instrument)).toEqual([
      'LOW',
      'FLAT',
      'HIGH',
    ]);
  });

  it('declares a universe filtered by the point-in-time constituents (ruling g)', () => {
    const bars = memorySource([
      series('BIG', 25, 100, 1_000),
      series('MID', 25, 10, 5_000),
      series('NEW', 5, 1_000, 1_000),
    ]);
    const constituentsFor = (tradingDate: string): readonly string[] =>
      tradingDate >= '2026-09-26' ? ['BIG', 'MID', 'NEW'] : ['BIG'];
    const sleeve = createMeanReversionSleeve(bars, constituentsFor, 10)(closesMarket(flatCloses()));
    expect(sleeve.universe({ ...CONTEXT, tradingDate: '2026-09-26' })).toEqual({
      instruments: ['BIG', 'MID'],
      refusals: [],
    });
    expect(sleeve.universe({ ...CONTEXT, tradingDate: '2026-09-25' })).toEqual({
      instruments: ['BIG'],
      refusals: [],
    });
  });

  it('ranks US names by native dollar volume whatever GBPUSD is, since a US name converts by exactly 1', () => {
    const bars = memorySource([series('BIG', 25, 100, 1_000), series('MID', 25, 10, 5_000)]);
    for (const gbpUsd of [1, 1.27, 0.83]) {
      const market: MarketData = { ...closesMarket(flatCloses()), gbpUsdAtYearStart: () => gbpUsd };
      const sleeve = createMeanReversionSleeve(bars, () => ['MID', 'BIG'], 10)(market);
      expect(sleeve.universe({ ...CONTEXT, tradingDate: '2026-09-26' }).instruments).toEqual([
        'BIG',
        'MID',
      ]);
    }
  });
});

describe('createMeanReversionBenchmarkSleeve', () => {
  const noConstituents = (): readonly string[] => [];

  it('ignores the RSI signal entirely: enters whenever warmed up, no time stop in its spec (ruling f)', async () => {
    const noSource: BarsSource = { load: () => undefined };
    const sleeve = createMeanReversionBenchmarkSleeve(
      noSource,
      noConstituents,
    )(closesMarket(flatCloses()));
    expect(sleeve.id).toBe(MEAN_REVERSION_BENCHMARK_ID);
    expect(sleeve.spec.sizing.timeStopTradingDays).toBe(1_000_000);
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('enter_long');
  });

  it('keeps the universe order in decide(), unsorted by any signal (ruling g)', async () => {
    const noSource: BarsSource = { load: () => undefined };
    const sleeve = createMeanReversionBenchmarkSleeve(
      noSource,
      noConstituents,
    )(closesMarket(flatCloses()));
    const output = await sleeve.decide(CONTEXT, ['ZZZ', 'AAA', 'MMM']);
    expect(output.decisions.map((decision) => decision.instrument)).toEqual(['ZZZ', 'AAA', 'MMM']);
  });

  it('skips as insufficient_history before its own ATR(20) warmup', async () => {
    const noSource: BarsSource = { load: () => undefined };
    const closes = Array.from({ length: 5 }, () => 100);
    const sleeve = createMeanReversionBenchmarkSleeve(
      noSource,
      noConstituents,
    )(closesMarket(closes));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('insufficient_history');
  });

  it('skips as bad_last_bar when the last bar fails the shape check, fail-closed', async () => {
    const noSource: BarsSource = { load: () => undefined };
    const sleeve = createMeanReversionBenchmarkSleeve(
      noSource,
      noConstituents,
    )(closesMarket(flatCloses(), { close: 500, high: 199 }));
    const output = await sleeve.decide(CONTEXT, ['AAA']);
    expect(output.decisions[0]?.action).toBe('skip');
    expect(output.decisions[0]?.reason).toBe('bad_last_bar');
  });
});
