import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import {
  momentumVote,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  RSI_SPEC,
  SMA_SPEC,
} from './technical-analyst.js';

const PERIOD = 14;

const GOLDEN = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../providers/market-data-service/__fixtures__/indicator-golden.json',
        import.meta.url,
      ),
    ),
    { encoding: 'utf8' },
  ),
) as {
  bars: {
    open_time: number;
    close_time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
};

const BARS: Bar[] = GOLDEN.bars.map((raw) => ({
  instrument: 'GOLDEN',
  timeframe: '1h',
  open_time: new Date(raw.open_time),
  close_time: new Date(raw.close_time),
  open: raw.open,
  high: raw.high,
  low: raw.low,
  close: raw.close,
  volume: raw.volume,
  source: 'golden-fixture',
}));

function plainMeanRsi(closes: number[], period: number): number {
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push((closes[i] as number) - (closes[i - 1] as number));
  }
  const window = changes.slice(-period);
  const avgGain = window.filter((c) => c > 0).reduce((sum, c) => sum + c, 0) / period;
  const avgLoss = window.filter((c) => c < 0).reduce((sum, c) => sum - c, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function rsiAt(endIndex: number, lookback: number): number {
  const start = Math.max(0, endIndex - lookback);
  const window = BARS.slice(start, endIndex);
  const spec: IndicatorSpec = {
    indicator: 'rsi',
    params: { period: PERIOD },
    timeframe: '1h',
    lookback: window.length,
  };
  return computeIndicator(window, spec);
}

const closesEnding = (endIndex: number, lookback: number): number[] =>
  BARS.slice(Math.max(0, endIndex - lookback), endIndex).map((bar) => bar.close);

const OVERBOUGHT = RSI_OVERBOUGHT;
const OVERSOLD = RSI_OVERSOLD;

const WARM = 200;

const REGION = Array.from({ length: 141 }, (_, i) => i + 60);

const FLOOR = minimumBarsFor(RSI_SPEC);

describe('the live RSI spec sits on a converged warm-up (#722)', () => {
  it('asks for the recommendation, not the fabrication floor', () => {
    expect(RSI_SPEC.params.period).toBe(PERIOD);
    expect(FLOOR).toBe(PERIOD + 1);
    expect(RSI_SPEC.lookback).toBe(recommendedWarmupFor(RSI_SPEC));
    expect(RSI_SPEC.lookback).toBe(4 * PERIOD + 1);
    expect(RSI_SPEC.lookback).toBeGreaterThan(FLOOR);
  });

  it('so the debate reads Wilder, within 0.5 points of a converged 200-bar warm-up', () => {
    for (const end of [60, 120, 200, 340, BARS.length]) {
      expect(Math.abs(rsiAt(end, RSI_SPEC.lookback) - rsiAt(end, WARM))).toBeLessThan(0.5);
    }
  });

  it('and no longer the plain-mean seed, which is what the floor returned', () => {
    for (const end of [60, 120, 200, 340, BARS.length]) {
      expect(rsiAt(end, FLOOR)).toBeCloseTo(plainMeanRsi(closesEnding(end, FLOOR), PERIOD), 8);
      expect(Math.abs(rsiAt(end, RSI_SPEC.lookback) - rsiAt(end, FLOOR))).toBeGreaterThan(0.01);
    }
  });

  it('and diverges from that seed as soon as one more bar is given', () => {
    for (const end of [120, 200, 340]) {
      const window = closesEnding(end, FLOOR + 1);
      const seed = plainMeanRsi(window.slice(0, PERIOD + 1), PERIOD);

      expect(seed).toBeCloseTo(rsiAt(end - 1, FLOOR), 8);
      expect(Math.abs(rsiAt(end, FLOOR + 1) - seed)).toBeGreaterThan(0.01);
    }
  });

  it('leaves SMA_SPEC alone, because sma reads the trailing period and nothing else', () => {
    expect(SMA_SPEC.params.period).toBeUndefined();
    expect(minimumBarsFor(SMA_SPEC)).toBe(SMA_SPEC.lookback);
    expect(computeIndicator(BARS.slice(386, 400), SMA_SPEC)).toBeCloseTo(
      computeIndicator(BARS.slice(0, 400), { ...SMA_SPEC, lookback: 400, params: { period: 14 } }),
      8,
    );
  });
});

const gapsAgainstWarm = (lookback: number): number[] =>
  REGION.map((end) => Math.abs(rsiAt(end, lookback) - rsiAt(end, WARM))).sort((a, b) => a - b);

const flipsAgainstWarm = (lookback: number): number[] =>
  REGION.filter((end) => {
    const live = rsiAt(end, lookback);
    const warm = rsiAt(end, WARM);
    return live >= OVERBOUGHT !== warm >= OVERBOUGHT || live < OVERSOLD !== warm < OVERSOLD;
  });

const momentumFlipsAgainstWarm = (lookback: number): number[] =>
  REGION.filter(
    (end) =>
      momentumVote(rsiAt(end, lookback), undefined) !== momentumVote(rsiAt(end, WARM), undefined),
  );

describe('what the missing warm-up cost — the floor, measured', () => {
  it('shifts RSI by a median of ~4.6 points, p90 ~12', () => {
    const gaps = gapsAgainstWarm(FLOOR);

    const median = gaps[Math.floor(gaps.length / 2)] as number;
    const p90 = gaps[Math.floor(gaps.length * 0.9)] as number;

    expect(median).toBeGreaterThan(3);
    expect(median).toBeLessThan(7);
    expect(p90).toBeGreaterThan(9);
  });

  it('flips the overbought/oversold classification on ~18% of bars', () => {
    const flipped = flipsAgainstWarm(FLOOR);

    expect(flipped.length).toBeGreaterThan(15);
    expect(flipped.length / REGION.length).toBeGreaterThan(0.12);
  });

  it('flips the momentum vote the analyst carries into the debate, on 1 bar in 8', () => {
    const flipped = momentumFlipsAgainstWarm(FLOOR);

    expect(flipped.length).toBeGreaterThan(10);
    expect(flipped.length / REGION.length).toBeGreaterThan(0.08);
  });
});

describe('what the adopted warm-up costs instead — the live spec, measured (#722)', () => {
  it('shifts RSI by a median under 0.5 points, p90 under 1', () => {
    const gaps = gapsAgainstWarm(RSI_SPEC.lookback);

    expect(gaps[Math.floor(gaps.length / 2)] as number).toBeLessThan(0.5);
    expect(gaps[Math.floor(gaps.length * 0.9)] as number).toBeLessThan(1);
    const floorGaps = gapsAgainstWarm(FLOOR);
    expect(gaps.at(-1) as number).toBeLessThan(
      floorGaps[Math.floor(floorGaps.length / 2)] as number,
    );
  });

  it('flips the 70/30 classification on at most 1 bar in the region, not 25', () => {
    expect(flipsAgainstWarm(RSI_SPEC.lookback).length).toBeLessThanOrEqual(1);
    expect(flipsAgainstWarm(FLOOR).length).toBeGreaterThan(20);
  });

  it('flips the momentum vote on at most 2 bars, where the floor flipped 1 in 8', () => {
    expect(momentumFlipsAgainstWarm(RSI_SPEC.lookback).length).toBeLessThanOrEqual(2);
    expect(momentumFlipsAgainstWarm(FLOOR).length).toBeGreaterThan(10);
  });
});
