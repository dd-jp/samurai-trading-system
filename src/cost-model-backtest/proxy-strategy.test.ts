import type { Bar } from '../market-data-service/index.js';
import { computeIndicator } from '../market-data-service/index.js';
import { type ProxyStrategyConfig, proxySignal } from './proxy-strategy.js';

const BASE_CONFIG: ProxyStrategyConfig = {
  fastWindow: 3,
  slowWindow: 6,
  atrWindow: 4,
  atrStopMult: 2,
  atrTargetMult: 3,
  allowShort: true,
};

/** Builds `count` daily bars whose close moves by `step` each bar, starting at `start`. */
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
    });
  }
  return bars;
}

/** Builds `count` perfectly flat bars (every OHLC field identical) — fast SMA == slow SMA. */
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
    });
  }
  return bars;
}

describe('proxySignal', () => {
  it('signals long when the fast SMA leads the slow SMA (uptrend)', () => {
    const bars = buildTrendingBars(10, 100, 1);

    const signal = proxySignal(bars, BASE_CONFIG);

    expect(signal.direction).toBe('long');
  });

  it('signals short when the fast SMA trails the slow SMA (downtrend) and shorting is allowed', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, BASE_CONFIG);

    expect(signal.direction).toBe('short');
  });

  it('stays flat when neither SMA leads (perfectly flat bars)', () => {
    const bars = buildFlatBars(10, 100);

    const signal = proxySignal(bars, BASE_CONFIG);

    expect(signal.direction).toBe('flat');
    expect(signal.stop).toBe(100);
    expect(signal.target).toBe(100);
  });

  it('stays flat on a downtrend when allowShort is false, instead of signaling short', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, { ...BASE_CONFIG, allowShort: false });

    expect(signal.direction).toBe('flat');
  });

  it.each([
    { atrStopMult: 2, atrTargetMult: 3 },
    { atrStopMult: 1.5, atrTargetMult: 2 },
    { atrStopMult: 3, atrTargetMult: 4 },
  ])('computes stop/target from the ATR at entry scaled by the config multipliers ($atrStopMult x / $atrTargetMult x)', ({
    atrStopMult,
    atrTargetMult,
  }) => {
    const bars = buildTrendingBars(10, 100, 1);
    const config = { ...BASE_CONFIG, atrStopMult, atrTargetMult };

    const signal = proxySignal(bars, config);
    const lastClose = bars[bars.length - 1].close;
    const atrValue = computeIndicator(bars.slice(-(config.atrWindow + 1)), {
      indicator: 'atr',
      params: {},
      lookback: config.atrWindow,
    });

    expect(signal.direction).toBe('long');
    expect(signal.stop).toBeCloseTo(lastClose - atrValue * atrStopMult, 5);
    expect(signal.target).toBeCloseTo(lastClose + atrValue * atrTargetMult, 5);
  });

  it('places the stop below and target above entry for a long signal', () => {
    const bars = buildTrendingBars(10, 100, 1);

    const signal = proxySignal(bars, BASE_CONFIG);
    const lastClose = bars[bars.length - 1].close;

    expect(signal.stop).toBeLessThan(lastClose);
    expect(signal.target).toBeGreaterThan(lastClose);
  });

  it('places the stop above and target below entry for a short signal', () => {
    const bars = buildTrendingBars(10, 100, -1);

    const signal = proxySignal(bars, BASE_CONFIG);
    const lastClose = bars[bars.length - 1].close;

    expect(signal.stop).toBeGreaterThan(lastClose);
    expect(signal.target).toBeLessThan(lastClose);
  });
});
