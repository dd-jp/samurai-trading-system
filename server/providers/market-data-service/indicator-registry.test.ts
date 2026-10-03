import { describe, expect, it } from 'vitest';
import {
  computeIndicator,
  InsufficientBarsError,
  minimumBarsFor,
  recommendedWarmupFor,
} from './indicators.js';
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

const PERIOD = 14;

const canonicalParams = (kind: IndicatorKind): Record<string, number> => {
  switch (kind) {
    case 'macd_histogram':
      return { fast: 12, slow: 26, signal: 9 };
    case 'bb_kc_squeeze':
      return { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 };
    default:
      return { period: PERIOD };
  }
};

const specFor = (kind: IndicatorKind, lookback: number): IndicatorSpec => ({
  indicator: kind,
  params: canonicalParams(kind),
  lookback,
  timeframe: '1h',
});

const BARS: Bar[] = Array.from({ length: 400 }, (_, i) => {
  const close = 100 + i * 0.37 + (i % 7) * 0.11;
  return {
    instrument: 'REG',
    timeframe: '1h',
    open_time: new Date(1767571200000 + i * 3_600_000),
    close_time: new Date(1767571200000 + (i + 1) * 3_600_000),
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000 + i,
    source: 'registry-test',
  };
});

describe('one registry, not two switches', () => {
  it('serves every declared kind', () => {
    for (const kind of INDICATOR_KINDS) {
      const value = computeIndicator(BARS.slice(0, 60), specFor(kind, 60));
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('declares the seed bar exactly where a predecessor is consumed', () => {
    expect(minimumBarsFor(specFor('sma', 20))).toBe(PERIOD);
    expect(minimumBarsFor(specFor('ema', 20))).toBe(PERIOD);
    expect(minimumBarsFor(specFor('rsi', 20))).toBe(PERIOD + 1);
    expect(minimumBarsFor(specFor('atr', 20))).toBe(PERIOD + 1);
  });

  it('declares the #744 arity for the five new kinds too', () => {
    expect(minimumBarsFor(specFor('atr_pct', 20))).toBe(PERIOD + 1);
    expect(minimumBarsFor(specFor('donchian_pos', 20))).toBe(PERIOD);
    expect(minimumBarsFor(specFor('adx', 20))).toBe(2 * PERIOD);
    expect(minimumBarsFor(specFor('macd_histogram', 40))).toBe(26 + 9 - 1);
    expect(minimumBarsFor(specFor('bb_kc_squeeze', 40))).toBe(20 + 1);
  });

  for (const kind of INDICATOR_KINDS) {
    it(`${kind}: exactly minimumBarsFor computes, one bar fewer throws by name`, () => {
      const required = minimumBarsFor(specFor(kind, 60));

      expect(() =>
        computeIndicator(BARS.slice(0, required), specFor(kind, required)),
      ).not.toThrow();
      expect(() =>
        computeIndicator(BARS.slice(0, required - 1), specFor(kind, required - 1)),
      ).toThrow(InsufficientBarsError);
    });
  }

  it('still throws below the floor for every kind, by that same arity', () => {
    for (const kind of INDICATOR_KINDS) {
      const required = minimumBarsFor(specFor(kind, 20));
      expect(() =>
        computeIndicator(BARS.slice(0, required - 1), specFor(kind, required - 1)),
      ).toThrow(InsufficientBarsError);
    }
  });

  it('names the unknown kind and the known ones rather than crashing', () => {
    const bogus = { ...specFor('rsi', 20), indicator: 'macd' as IndicatorKind };

    expect(() => computeIndicator(BARS.slice(0, 20), bogus)).toThrow(/Unsupported indicator: macd/);
    expect(() => minimumBarsFor(bogus)).toThrow(
      /Known kinds: sma, ema, rsi, atr, atr_pct, macd_histogram, adx, donchian_pos, bb_kc_squeeze/,
    );
  });
});

describe('recommendedWarmupFor — the width question, not the arity one', () => {
  it('is 4 x period + 1 for the recursive kinds', () => {
    expect(recommendedWarmupFor(specFor('ema', 20))).toBe(57);
    expect(recommendedWarmupFor(specFor('rsi', 20))).toBe(57);
    expect(recommendedWarmupFor(specFor('atr', 20))).toBe(57);
  });

  it('is the floor itself for sma, which is warm-up blind', () => {
    expect(recommendedWarmupFor(specFor('sma', 20))).toBe(minimumBarsFor(specFor('sma', 20)));
  });

  it('actually converges — one more bar past it barely moves the value', () => {
    const end = 300;
    const at = (lookback: number): number =>
      computeIndicator(BARS.slice(end - lookback, end), specFor('rsi', lookback));

    const recommended = at(recommendedWarmupFor(specFor('rsi', 20)));
    const converged = at(200);
    const floor = at(minimumBarsFor(specFor('rsi', 20)));

    expect(Math.abs(recommended - converged)).toBeLessThan(0.5);
    expect(Math.abs(floor - converged)).toBeGreaterThan(Math.abs(recommended - converged));
  });
});
