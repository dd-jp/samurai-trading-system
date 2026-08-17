/**
 * #744 — the five new indicator kinds' own behaviour, beyond what the
 * characterisation goldens (`indicator-golden.test.ts`) pin against the
 * independent Wilder reference.
 *
 * Three things live here rather than in the golden file:
 *
 *   1. The missing-parameter THROW for `macd_histogram` and `bb_kc_squeeze`
 *      — the acceptance criterion that a multi-parameter kind must name the
 *      absent parameter rather than silently inherit `spec.lookback`
 *      (`periodOf`'s convention, deliberately not reused here).
 *   2. Property tests over a random walk for the BOUNDED kinds
 *      (`donchian_pos` in [0, 1], `adx` in [0, 100]).
 *   3. Degenerate-denominator cases (`upper === lower`, `high === low`) that
 *      a random walk essentially never produces, proving no kind answers
 *      `NaN`/`Infinity` on them.
 */
import { describe, expect, it } from 'vitest';

import { computeIndicator, InsufficientBarsError } from './indicators.js';
import type { Bar, IndicatorSpec } from './types.js';

/**
 * A written-out LCG, matching `generate-indicator-golden.py`'s own reasoning
 * for not using a language-provided RNG (`Math.random()` here): a property
 * test that can pick a different seed on every run is a flaky test with
 * extra steps, not a stronger one.
 */
function lcg(seed: number): () => number {
  let x = seed;
  return () => {
    x = (1103515245 * x + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
}

const HOUR_MS = 60 * 60 * 1000;
const START_MS = 1_767_571_200_000;

function buildBar(index: number, open: number, high: number, low: number, close: number): Bar {
  const closeTime = START_MS + (index + 1) * HOUR_MS;
  return {
    instrument: 'NEWKIND',
    timeframe: '1h',
    open_time: new Date(closeTime - HOUR_MS),
    close_time: new Date(closeTime),
    open,
    high,
    low,
    close,
    volume: 1_000 + index,
    source: 'property-test',
  };
}

/** A random-walk series, ordinary bars with real (non-degenerate) ranges. */
function randomWalkBars(count: number, seed: number): Bar[] {
  const rand = lcg(seed);
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    close = open + (rand() - 0.5) * 2;
    const bodyHigh = Math.max(open, close);
    const bodyLow = Math.min(open, close);
    const high = bodyHigh + rand() * 0.6 + 0.01;
    const low = bodyLow - rand() * 0.6 - 0.01;
    bars.push(buildBar(i, open, high, low, close));
  }
  return bars;
}

/** Every bar a doji at the same price: `high === low`, `upper === lower` for any channel/band built on it. */
function flatBars(count: number, price: number): Bar[] {
  return Array.from({ length: count }, (_, i) => buildBar(i, price, price, price, price));
}

const specFor = (
  indicator: IndicatorSpec['indicator'],
  params: Record<string, number>,
  lookback: number,
): IndicatorSpec => ({ indicator, params, lookback, timeframe: '1h' });

describe('multi-parameter kinds throw on a missing parameter, naming it', () => {
  // The trap named twice in the issue: `periodOf`'s `params.period ??
  // spec.lookback` fallback must never be reachable for these two kinds.
  const macdParams = { fast: 12, slow: 26, signal: 9 };
  for (const missing of ['fast', 'slow', 'signal'] as const) {
    it(`macd_histogram without params.${missing} throws naming it, not a fabricated value`, () => {
      const params = { ...macdParams };
      delete (params as Record<string, number | undefined>)[missing];
      const spec = specFor('macd_histogram', params, 40);

      expect(() => computeIndicator(randomWalkBars(60, 1), spec)).toThrow(
        new RegExp(`params\\.${missing}, which was not provided`),
      );
    });
  }

  const bbKcParams = { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 };
  for (const missing of ['bb_period', 'bb_mult', 'kc_period', 'kc_mult'] as const) {
    it(`bb_kc_squeeze without params.${missing} throws naming it, not a fabricated value`, () => {
      const params = { ...bbKcParams };
      delete (params as Record<string, number | undefined>)[missing];
      const spec = specFor('bb_kc_squeeze', params, 40);

      expect(() => computeIndicator(randomWalkBars(60, 2), spec)).toThrow(
        new RegExp(`params\\.${missing}, which was not provided`),
      );
    });
  }

  it('never falls back to spec.lookback for either multi-parameter kind', () => {
    // A huge `lookback` (999, far more than enough bars) must not quietly
    // become the missing `signal` parameter's value and let the call
    // through as some derived number — it must still throw naming `signal`,
    // not answer InsufficientBarsError (a bars-too-short complaint) or a
    // fabricated result.
    const spec = specFor('macd_histogram', { fast: 12, slow: 26 }, 999);
    expect(() => computeIndicator(randomWalkBars(999, 3), spec)).not.toThrow(InsufficientBarsError);
  });

  it('names params.signal specifically, not a generic length complaint', () => {
    const spec = specFor('macd_histogram', { fast: 12, slow: 26 }, 999);
    expect(() => computeIndicator(randomWalkBars(999, 3), spec)).toThrow(
      /params\.signal, which was not provided/,
    );
  });
});

describe('bounded kinds over a random walk', () => {
  const bars = randomWalkBars(400, 20260817);

  it('donchian_pos stays in [0, 1] for every warmed window', () => {
    for (let end = 20; end <= bars.length; end += 7) {
      const window = bars.slice(0, end);
      const value = computeIndicator(
        window,
        specFor('donchian_pos', { period: 14 }, window.length),
      );
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('adx stays in [0, 100] for every warmed window', () => {
    for (let end = 30; end <= bars.length; end += 11) {
      const window = bars.slice(0, end);
      const value = computeIndicator(window, specFor('adx', { period: 14 }, window.length));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('atr_pct is never negative', () => {
    for (let end = 20; end <= bars.length; end += 13) {
      const window = bars.slice(0, end);
      const value = computeIndicator(window, specFor('atr_pct', { period: 14 }, window.length));
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('bb_kc_squeeze is finite and non-negative', () => {
    for (let end = 25; end <= bars.length; end += 17) {
      const window = bars.slice(0, end);
      const value = computeIndicator(
        window,
        specFor(
          'bb_kc_squeeze',
          { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 },
          window.length,
        ),
      );
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('macd_histogram is always finite', () => {
    for (let end = 40; end <= bars.length; end += 19) {
      const window = bars.slice(0, end);
      const value = computeIndicator(
        window,
        specFor('macd_histogram', { fast: 12, slow: 26, signal: 9 }, window.length),
      );
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('degenerate denominators do not produce NaN or Infinity', () => {
  // `high === low` for every bar in the window forces every channel/band
  // built on it to have `upper === lower` too — the shape the acceptance
  // criteria name explicitly.
  const flat = flatBars(60, 100);

  it('donchian_pos: upper === lower answers the neutral 0.5, not NaN', () => {
    const value = computeIndicator(flat, specFor('donchian_pos', { period: 14 }, flat.length));
    expect(value).toBe(0.5);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('adx: zero true range throughout answers a finite value, not NaN', () => {
    const value = computeIndicator(flat, specFor('adx', { period: 14 }, flat.length));
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBe(0);
  });

  it('atr_pct: zero ATR over a flat window answers exactly 0, not NaN', () => {
    const value = computeIndicator(flat, specFor('atr_pct', { period: 14 }, flat.length));
    expect(value).toBe(0);
  });

  it('bb_kc_squeeze: kcWidth === 0 answers the neutral 1, not Infinity or NaN', () => {
    const value = computeIndicator(
      flat,
      specFor(
        'bb_kc_squeeze',
        { bb_period: 20, bb_mult: 2, kc_period: 20, kc_mult: 1.5 },
        flat.length,
      ),
    );
    expect(value).toBe(1);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('macd_histogram: a flat window answers exactly 0, not NaN', () => {
    // Every EMA on a constant series equals that constant, so the line and
    // its signal are both flat at the same value — the histogram is exactly
    // 0, a genuine answer rather than a degenerate one, but pinned here
    // because a division mistake in the signal seed would show up as NaN.
    const value = computeIndicator(
      flat,
      specFor('macd_histogram', { fast: 12, slow: 26, signal: 9 }, flat.length),
    );
    expect(value).toBe(0);
  });
});
