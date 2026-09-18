import type { Bar } from '../../providers/market-data-service/index.js';
import { computeIndicator } from '../../providers/market-data-service/index.js';
import {
  type ProxyStrategyConfig,
  proxyAtrSpec,
  proxySignal,
  proxyWarmupBars,
} from './proxy-strategy.js';

const BASE_CONFIG: ProxyStrategyConfig = {
  fastWindow: 3,
  slowWindow: 6,
  atrWindow: 4,
  atrStopMult: 2,
  atrTargetMult: 3,
  allowShort: true,
};

function buildTrendingBars(count: number, start: number, step: number): Bar[] {
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < count; i++) {
    const open = close;
    close = close + step;
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    bars.push({
      instrument: 'BTC-USD',
      timeframe: '1d',
      open_time: new Date(2024, 0, i + 1),
      close_time: new Date(2024, 0, i + 2),
      open,
      high,
      low,
      close,
      volume: 1_000,
      source: 'fixture',
    });
  }
  return bars;
}

function buildVariedBars(count: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const open = 100 + i * 0.6;
    const close = open + 0.6;
    const spread = 1 + 2.5 * Math.abs(Math.sin(i / 2.2)) + 1.5 * Math.abs(Math.cos(i / 1.3));
    bars.push({
      instrument: 'BTC-USD',
      timeframe: '1d',
      open_time: new Date(2024, 0, i + 1),
      close_time: new Date(2024, 0, i + 2),
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 1_000,
      source: 'fixture',
    });
  }
  return bars;
}

function wilderAtr(bars: readonly Bar[], period: number): number {
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const current = bars[i] as Bar;
    const previousClose = (bars[i - 1] as Bar).close;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }
  const seed = trueRanges.slice(0, period);
  let value = seed.reduce((sum, range) => sum + range, 0) / seed.length;
  for (const range of trueRanges.slice(period)) {
    value = (value * (period - 1) + range) / period;
  }
  return value;
}

function buildFlatBars(count: number, price: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    bars.push({
      instrument: 'BTC-USD',
      timeframe: '1d',
      open_time: new Date(2024, 0, i + 1),
      close_time: new Date(2024, 0, i + 2),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1_000,
      source: 'fixture',
    });
  }
  return bars;
}

describe('proxySignal', () => {
  it('signals long when the fast SMA leads the slow SMA (uptrend)', () => {
    const bars = buildTrendingBars(10, 100, 1);

    const signal = proxySignal(bars, BASE_CONFIG, '1d');

    expect(signal.direction).toBe('long');
  });

  it('signals short when the fast SMA trails the slow SMA (downtrend) and shorting is allowed', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, BASE_CONFIG, '1d');

    expect(signal.direction).toBe('short');
  });

  it('stays flat when neither SMA leads (perfectly flat bars)', () => {
    const bars = buildFlatBars(10, 100);

    const signal = proxySignal(bars, BASE_CONFIG, '1d');

    expect(signal.direction).toBe('flat');
    expect(signal.stop).toBe(100);
    expect(signal.target).toBe(100);
  });

  it('stays flat on a downtrend when allowShort is false, instead of signaling short', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, { ...BASE_CONFIG, allowShort: false }, '1d');

    expect(signal.direction).toBe('flat');
  });

  it.each([
    { atrStopMult: 2, atrTargetMult: 3 },
    { atrStopMult: 1.5, atrTargetMult: 2 },
    { atrStopMult: 3, atrTargetMult: 4 },
  ])(
    'computes stop/target from the ATR at entry scaled by the config multipliers ($atrStopMult x / $atrTargetMult x)',
    ({ atrStopMult, atrTargetMult }) => {
      const bars = buildTrendingBars(10, 100, 1);
      const config = { ...BASE_CONFIG, atrStopMult, atrTargetMult };

      const signal = proxySignal(bars, config, '1d');
      const lastClose = bars[bars.length - 1].close;
      const atrSpec = proxyAtrSpec(config, '1d');
      const atrValue = computeIndicator(bars.slice(-atrSpec.lookback), atrSpec);

      expect(signal.direction).toBe('long');
      expect(signal.stop).toBeCloseTo(lastClose - atrValue * atrStopMult, 5);
      expect(signal.target).toBeCloseTo(lastClose + atrValue * atrTargetMult, 5);
    },
  );

  it('places the stop below and target above entry for a long signal', () => {
    const bars = buildTrendingBars(10, 100, 1);

    const signal = proxySignal(bars, BASE_CONFIG, '1d');
    const lastClose = bars[bars.length - 1].close;

    expect(signal.stop).toBeLessThan(lastClose);
    expect(signal.target).toBeGreaterThan(lastClose);
  });

  it('places the stop above and target below entry for a short signal', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, BASE_CONFIG, '1d');
    const lastClose = bars[bars.length - 1].close;

    expect(signal.stop).toBeGreaterThan(lastClose);
    expect(signal.target).toBeLessThan(lastClose);
  });
});

describe('the replay ATR spec (#857)', () => {
  it('asks for the converged warm-up while keeping the period at atrWindow', () => {
    const spec = proxyAtrSpec(BASE_CONFIG, '1d');

    expect(spec.lookback).toBe(4 * BASE_CONFIG.atrWindow + 1);

    expect(spec.params.period).toBe(BASE_CONFIG.atrWindow);
    expect(spec.indicator).toBe('atr');
    expect(spec.timeframe).toBe('1d');
  });

  it('makes the caller warm-up wide enough to fill that window', () => {
    expect(proxyWarmupBars(BASE_CONFIG, '1d')).toBeGreaterThanOrEqual(
      proxyAtrSpec(BASE_CONFIG, '1d').lookback,
    );
    expect(proxyWarmupBars({ ...BASE_CONFIG, slowWindow: 500 }, '1d')).toBe(500);
  });

  it('folds the smoothing loop — the stop is derived from a converged ATR, not the seed mean', () => {
    const bars = buildVariedBars(40);
    const signal = proxySignal(bars, BASE_CONFIG, '1d');
    expect(signal.direction).not.toBe('flat');

    const impliedAtr =
      Math.abs(bars[bars.length - 1].close - signal.stop) / BASE_CONFIG.atrStopMult;

    expect(impliedAtr).toBeCloseTo(
      wilderAtr(bars.slice(-(4 * BASE_CONFIG.atrWindow + 1)), BASE_CONFIG.atrWindow),
      7,
    );
    expect(
      Math.abs(
        impliedAtr - wilderAtr(bars.slice(-(BASE_CONFIG.atrWindow + 1)), BASE_CONFIG.atrWindow),
      ),
    ).toBeGreaterThan(1e-6);
  });
});
