/**
 * B2 (#703) — the registry, and the warm-up dial that owns B1's finding F2.
 *
 * Two things are under test and they are deliberately separate:
 *
 *   1. `minimumBarsFor` and `computeIndicator` now read ONE table, so a kind
 *      cannot exist in the arithmetic and not in the arity. That property is
 *      enforced by the compiler (`Record<IndicatorKind, IndicatorDefinition>`),
 *      and what remains testable is that the table still says the right things.
 *   2. `recommendedWarmupFor` exists, is a DIFFERENT number from
 *      `minimumBarsFor` for every recursive kind, and — the point — is not
 *      wired into anything yet. Adopting it reprices every technical opinion in
 *      the system and is a decision for the map, not a side effect of B2.
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

const specFor = (kind: IndicatorKind, lookback: number): IndicatorSpec => ({
  indicator: kind,
  params: { period: PERIOD },
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
    expect(() => minimumBarsFor(bogus)).toThrow(/Known kinds: sma, ema, rsi, atr/);
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

  it('does NOT change what the live specs ask for', () => {
    // B2 adds the dial. It does not turn it. Every live spec still sits on the
    // fabrication floor, which is finding F2 — open, and owned by the wayfinder
    // map rather than closed silently here, because widening the warm-up
    // reprices every technical opinion the debate ever reads.
    for (const spec of [RSI_SPEC, SMA_SPEC, atrIndicatorSpec(PERIOD, '1h')]) {
      expect(spec.lookback).toBe(minimumBarsFor(spec));
    }

    // And the gap that leaves open, stated as a number so closing it is a
    // visible change rather than a quiet one.
    expect(recommendedWarmupFor(RSI_SPEC)).toBe(57);
    expect(RSI_SPEC.lookback).toBe(15);
  });
});
