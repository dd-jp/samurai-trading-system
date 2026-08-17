/**
 * B2 (#703) — the registry, and the warm-up dial that owns B1's finding F2.
 *
 * Two things are under test and they are deliberately separate:
 *
 *   1. `minimumBarsFor` and `computeIndicator` now read ONE table, so a kind
 *      cannot exist in the arithmetic and not in the arity. That property is
 *      enforced by the compiler (`Record<IndicatorKind, IndicatorDefinition>`),
 *      and what remains testable is that the table still says the right things.
 *   2. `recommendedWarmupFor` is a DIFFERENT number from `minimumBarsFor` for
 *      every recursive kind, it genuinely converges, and — since #722 — it is
 *      what `RSI_SPEC` asks for. That adoption was B2's open finding F2 and is
 *      the deliberate repricing of every technical opinion the debate reads;
 *      ATR and SMA stay on the floor, so the two are pinned separately below.
 */
import { describe, expect, it } from 'vitest';
import { RSI_SPEC, SMA_SPEC } from '../../pipeline/analysts/technical-analyst.js';
import { atrIndicatorSpec } from '../../pipeline/trader/decide.js';
import {
  computeIndicator,
  InsufficientBarsError,
  minimumBarsFor,
  recommendedWarmupFor,
} from './indicators.js';
import { type Bar, INDICATOR_KINDS, type IndicatorKind, type IndicatorSpec } from './types.js';

const PERIOD = 14;

/**
 * Canonical params per kind (#744) — the single-period kinds all get
 * `{ period: PERIOD }`; the two multi-parameter additions get a realistic
 * named-parameter set instead, since `specFor`'s old single-`period` shape
 * can no longer describe every row in `INDICATOR_KINDS`.
 */
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

/** A gently rising walk, so no kind hits a degenerate branch. */
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
    // If a kind were in the union with no row, this file would not compile. The
    // runtime half: every kind actually computes rather than throwing
    // `Unsupported indicator`, which is what the old duplicated `default`
    // branches produced when the two switches disagreed.
    for (const kind of INDICATOR_KINDS) {
      const value = computeIndicator(BARS.slice(0, 60), specFor(kind, 60));
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('declares the seed bar exactly where a predecessor is consumed', () => {
    // The "N bars yield N-1 deltas" rule, now stated once as data. Getting this
    // wrong does not throw — it computes over `period - 1` deltas and divides
    // by `period`, which is the RSI(13)-labelled-14 defect (#319) and the ATR
    // off-by-one, both of which this repo has already shipped once.
    expect(minimumBarsFor(specFor('sma', 20))).toBe(PERIOD);
    expect(minimumBarsFor(specFor('ema', 20))).toBe(PERIOD);
    expect(minimumBarsFor(specFor('rsi', 20))).toBe(PERIOD + 1);
    expect(minimumBarsFor(specFor('atr', 20))).toBe(PERIOD + 1);
  });

  it('declares the #744 arity for the five new kinds too', () => {
    // Same intent as the block above, extended to the new kinds — this is
    // the row-by-row boundary a `minimumBars` closure that lied would fail.
    expect(minimumBarsFor(specFor('atr_pct', 20))).toBe(PERIOD + 1);
    expect(minimumBarsFor(specFor('donchian_pos', 20))).toBe(PERIOD);
    // 2 x period: the structural ADX floor, not a warm-up preference — see
    // the `adx` row's comment in indicators.ts.
    expect(minimumBarsFor(specFor('adx', 20))).toBe(2 * PERIOD);
    // max(fast, slow) + signal - 1, with the canonical 12/26/9.
    expect(minimumBarsFor(specFor('macd_histogram', 40))).toBe(26 + 9 - 1);
    // max(bb_period, kc_period + 1), with the canonical 20/20.
    expect(minimumBarsFor(specFor('bb_kc_squeeze', 40))).toBe(20 + 1);
  });

  for (const kind of INDICATOR_KINDS) {
    it(`${kind}: exactly minimumBarsFor computes, one bar fewer throws by name`, () => {
      // The registry-driven boundary: a `minimumBars` closure perturbed by
      // one bar for any single kind fails exactly this test, by that kind's
      // name, rather than a generic "some kind is off" failure.
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
    // Reachable only through a cast, which is the honest scope of the guard:
    // there is no unvalidated runtime path into `IndicatorSpec.indicator`
    // today. The cast below is exactly what would silence the compiler at a
    // real call site, and unchecked `INDICATORS[kind]` fails at
    // `.compute is not a function`, naming neither the spec nor the kind.
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
    // Not a special case for tidiness: `rsi-warmup.test.ts` pins that `sma` at
    // 14 bars of history equals `sma` at 400. Recommending more would be
    // recommending waste.
    expect(recommendedWarmupFor(specFor('sma', 20))).toBe(minimumBarsFor(specFor('sma', 20)));
  });

  it('actually converges — one more bar past it barely moves the value', () => {
    // The claim `4 x period + 1` makes, checked rather than asserted. Compared
    // against a 200-bar warm-up on the SAME final bar.
    const end = 300;
    const at = (lookback: number): number =>
      computeIndicator(BARS.slice(end - lookback, end), specFor('rsi', lookback));

    const recommended = at(recommendedWarmupFor(specFor('rsi', 20)));
    const converged = at(200);
    const floor = at(minimumBarsFor(specFor('rsi', 20)));

    expect(Math.abs(recommended - converged)).toBeLessThan(0.5);
    // And the floor is the thing it is not: strictly further away.
    expect(Math.abs(floor - converged)).toBeGreaterThan(Math.abs(recommended - converged));
  });

  it('is what RSI_SPEC now asks for — the analyst reads a converged Wilder RSI (#722)', () => {
    // B2 added the dial; #722 turned it, for RSI only. The assertion this
    // replaces pinned `RSI_SPEC.lookback === minimumBarsFor(RSI_SPEC)` (15) and
    // was designed to fail here, so that adopting the warm-up would be a
    // visible change rather than a quiet one. This is that change.
    //
    // Derived, not literal: `RSI_SPEC` composes `recommendedWarmupFor`, so this
    // asserts the two cannot drift apart, and the `57` pins the value the
    // repricing was measured at.
    expect(RSI_SPEC.lookback).toBe(recommendedWarmupFor(RSI_SPEC));
    expect(RSI_SPEC.lookback).toBe(57);
    expect(RSI_SPEC.lookback).toBeGreaterThan(minimumBarsFor(RSI_SPEC));
    // The floor itself is untouched: 15 bars still produce a value, so a cold
    // instrument degrades to a less-warm RSI rather than to no view at all.
    expect(minimumBarsFor(RSI_SPEC)).toBe(15);
  });

  it('is NOT adopted by the other live specs, which stay on the floor', () => {
    // #722's scope is F2 — the RSI the debate reads — and nothing else. ATR's
    // equivalent gap is owned by `trader/atr-equivalence.test.ts`, and moving
    // it here would reprice every stop in the system as a side effect.
    // `SMA_SPEC` is warm-up BLIND (`rsi-warmup.test.ts` pins 14 bars against
    // 400), so the floor is not a compromise for it at all.
    for (const spec of [SMA_SPEC, atrIndicatorSpec(PERIOD, '1h')]) {
      expect(spec.lookback).toBe(minimumBarsFor(spec));
    }
    expect(recommendedWarmupFor(atrIndicatorSpec(PERIOD, '1h'))).toBe(57);
    expect(atrIndicatorSpec(PERIOD, '1h').lookback).toBe(15);
  });
});
