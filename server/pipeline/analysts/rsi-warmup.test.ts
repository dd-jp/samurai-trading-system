/**
 * B1 (#703), then #722 — what the technical analyst's RSI(14) actually is, what
 * the missing warm-up cost, and what adopting the converged one bought.
 *
 * B1 measured the floor and changed nothing. #722 re-pointed `RSI_SPEC` at
 * `recommendedWarmupFor` (57 bars), so this file now carries BOTH halves: the
 * floor's cost, still measured against `minimumBarsFor` rather than against
 * whatever the live spec happens to say, and the live spec's cost beside it.
 * Keeping the first half live is the point — it is the evidence the adoption
 * rests on, and retargeting it at `RSI_SPEC` would have quietly deleted it.
 *
 * ## The gap this fills
 *
 * `trader/atr-equivalence.test.ts` already establishes the equivalent fact for
 * ATR, in as many words: at `atr_lookback + 1` bars "`atr`'s smoothing loop is
 * empty", and widening that fetch "switches Wilder's smoothing on and every
 * stop in the system moves". Excellent prior art — and it covers only the
 * stop.
 *
 * Nothing pinned the same thing for RSI. `RSI_SPEC` used to carry
 * `lookback: INDICATOR_LOOKBACK + 1` = 15 with `params.period` = 14, which is
 * exactly `minimumBarsFor`, so `rsi`'s smoothing loop ran ZERO times in
 * production too and the value the debate read as "RSI(14)" was the simple-mean
 * SEED — Cutler's RSI — not Wilder's smoothed RSI, whatever the surrounding
 * doc comments described. `technicalAnalyst` is `mandatory` and its four prose
 * strings are the entire market read every persona ever sees
 * (`debate-engine/personas.ts:128`), so this was not a detail of one number.
 * ATR is unchanged and still sits on its floor: #722's scope is the RSI the
 * debate reads, and `atr-equivalence.test.ts` still owns the stop.
 *
 * ## This is not a claim that `indicators.ts` is wrong
 *
 * The arithmetic is correct for the window it is given —
 * `indicator-golden.test.ts` checks that against an independent reference and
 * it agrees on all 32 cases. What this file pins is the WARM-UP choice, which
 * lives in the spec rather than in the maths: `lookback` was the fabrication
 * floor (`minimumBarsFor`) and every live spec sat exactly on it. Step B2's
 * `recommendedWarmupFor` (`4 x period + 1`) gave that a number, and #722 is
 * where RSI takes it — a knowing repricing of every technical opinion in the
 * system, on the record, rather than something a soak discovers.
 */
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

/**
 * A plain arithmetic-mean RSI over the last `period` changes — Cutler's RSI,
 * with no Wilder smoothing anywhere in it. Kept here as the reference for the
 * same reason `atr-equivalence.test.ts` keeps `LEGACY_TRADER_ATR`: the claim
 * "the live spec computes this, not Wilder" is only worth making if the thing
 * it computes is written down.
 */
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

/** RSI(14) computed over the `lookback` bars ENDING at `endIndex` (exclusive) */
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

/**
 * `confidenceFrom` and `directionFrom`'s gates, IMPORTED from
 * `technical-analyst.ts` rather than restated here.
 *
 * They were hand-copied in the first draft of this file, which quietly voids
 * what it measures: this test's whole claim is "the live analyst classifies
 * 18% of bars differently on the warm window", and a local copy makes that a
 * claim about the copy the moment the real gate moves. The measurement has to
 * ride the same constants production reads. Exporting three symbols is the
 * cheaper side of that trade — the same reasoning that made `RSI_SPEC` an
 * export rather than a rebuilt literal.
 */
const OVERBOUGHT = RSI_OVERBOUGHT;
const OVERSOLD = RSI_OVERSOLD;

/**
 * A warmed window for comparison. 200 bars is ~14 x period — comfortably past
 * the point where an extra bar still moves the value, so the comparison is
 * "the live spec vs a converged RSI" rather than "one arbitrary width vs
 * another".
 */
const WARM = 200;

/**
 * The golden fixture's ordinary random-walk region. Deliberately excludes the
 * synthetic strictly-rising (200-219), strictly-falling (220-239) and flat
 * (240-259) segments — those exist to pin degenerate branches and would
 * inflate every number below. The worst case in the flat segment is RSI 100
 * live against 19.95 warmed; quoting that as the headline would be dishonest,
 * so the region stops at 200.
 */
const REGION = Array.from({ length: 141 }, (_, i) => i + 60);

/**
 * The fabrication floor the live spec USED to sit on, and the thing the
 * measurements below are still taken against. `minimumBarsFor` is unchanged by
 * #722 — only `RSI_SPEC.lookback` moved — so this stays 15 and the "before"
 * half of the record keeps computing exactly what production computed.
 */
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
    // The claim the adoption makes, checked on the same bars the "before"
    // measurement below uses
    for (const end of [60, 120, 200, 340, BARS.length]) {
      expect(Math.abs(rsiAt(end, RSI_SPEC.lookback) - rsiAt(end, WARM))).toBeLessThan(0.5);
    }
  });

  it('and no longer the plain-mean seed, which is what the floor returned', () => {
    // `FLOOR` bars yield exactly `period` changes, so `changes.slice(period)`
    // is empty and `rsi` returns its seed unchanged — Cutler's RSI. That is
    // still true of the floor, and is no longer what the live spec asks for
    for (const end of [60, 120, 200, 340, BARS.length]) {
      expect(rsiAt(end, FLOOR)).toBeCloseTo(plainMeanRsi(closesEnding(end, FLOOR), PERIOD), 8);
      expect(Math.abs(rsiAt(end, RSI_SPEC.lookback) - rsiAt(end, FLOOR))).toBeGreaterThan(0.01);
    }
  });

  it('and diverges from that seed as soon as one more bar is given', () => {
    // The mirror of atr-equivalence's point 2: the equality above is a
    // property of the WIDTH, not of the algorithm. One extra bar switches
    // Wilder's smoothing on for exactly one step
    //
    // The comparison has to be against the seed `rsi` ACTUALLY takes, which is
    // the LEADING `period + 1` closes of the wider window — not `plainMeanRsi`
    // over the whole window, whose trailing-`period` slice is a different set
    // of changes and would differ even between two identical algorithms
    for (const end of [120, 200, 340]) {
      const window = closesEnding(end, FLOOR + 1);
      const seed = plainMeanRsi(window.slice(0, PERIOD + 1), PERIOD);

      // That seed is by construction the value the FLOOR returns one bar
      // earlier, which is what makes the divergence below a smoothing step
      // rather than a window shift
      expect(seed).toBeCloseTo(rsiAt(end - 1, FLOOR), 8);
      expect(Math.abs(rsiAt(end, FLOOR + 1) - seed)).toBeGreaterThan(0.01);
    }
  });

  it('leaves SMA_SPEC alone, because sma reads the trailing period and nothing else', () => {
    // `SMA_SPEC.lookback === minimumBarsFor(SMA_SPEC)` would be true for ANY
    // lookback here and proves nothing: `params` is empty, so `periodOf` falls
    // back to `spec.lookback` and `minimumBarsFor` returns it unchanged. The
    // fact worth pinning is the one that makes that fallback safe — the period
    // IS the lookback for `sma`, so there is no `+ 1` to get wrong and no
    // seed-then-smooth split for a warm-up to change
    expect(SMA_SPEC.params.period).toBeUndefined();
    expect(minimumBarsFor(SMA_SPEC)).toBe(SMA_SPEC.lookback);
    // Same trailing 14 bars, two wildly different history lengths, identical
    // answer — the property RSI does NOT have
    expect(computeIndicator(BARS.slice(386, 400), SMA_SPEC)).toBeCloseTo(
      computeIndicator(BARS.slice(0, 400), { ...SMA_SPEC, lookback: 400, params: { period: 14 } }),
      8,
    );
  });
});

/** Absolute RSI gap against the converged 200-bar warm-up, per bar in REGION */
const gapsAgainstWarm = (lookback: number): number[] =>
  REGION.map((end) => Math.abs(rsiAt(end, lookback) - rsiAt(end, WARM))).sort((a, b) => a - b);

/** Bars in REGION whose 70/30 classification differs from the converged one */
const flipsAgainstWarm = (lookback: number): number[] =>
  REGION.filter((end) => {
    const live = rsiAt(end, lookback);
    const warm = rsiAt(end, WARM);
    return live >= OVERBOUGHT !== warm >= OVERBOUGHT || live < OVERSOLD !== warm < OVERSOLD;
  });

/**
 * Bars in REGION whose MOMENTUM VOTE differs from the converged one.
 *
 * This replaces a `confidenceFrom` ratio (#745). `confidenceFrom` was
 * `|rsi - 50| / 50` and WAS the analyst's whole confidence, so a warm-up shift
 * was directly a confidence shift. Under the axis vote, confidence is
 * `|net| / availableAxes` and RSI reaches it only through the momentum axis's
 * vote — so the honest successor measurement is how often the warm-up flips
 * that vote, which is exactly the quantity that now moves the numerator.
 * Retargeting the old ratio at the new confidence would have measured the
 * other three axes' fixtures instead of the RSI warm-up.
 *
 * `undefined` for the MACD half on purpose: this file measures the RSI
 * warm-up, and pairing it with a second oscillator would mix two effects.
 */
const momentumFlipsAgainstWarm = (lookback: number): number[] =>
  REGION.filter(
    (end) =>
      momentumVote(rsiAt(end, lookback), undefined) !== momentumVote(rsiAt(end, WARM), undefined),
  );

/**
 * BEFORE — what the floor cost, kept measuring the floor rather than deleted.
 *
 * These are the numbers `docs/reviews/indicator-characterisation-2026-08-16.md`
 * F2 quotes, and #722's decision rests on them. Retargeting them at
 * `RSI_SPEC.lookback` would have turned the evidence for the change into a
 * restatement of the change, so they name `FLOOR` explicitly and stay put.
 */
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
    // The consequence that matters. `directionFrom` gates on 70/30, so a bar
    // the floored spec calls overbought is one a warmed RSI calls ordinary, and
    // the analyst's `direction` changed with it. Nearly one bar in five.
    const flipped = flipsAgainstWarm(FLOOR);

    expect(flipped.length).toBeGreaterThan(15);
    expect(flipped.length / REGION.length).toBeGreaterThan(0.12);
  });

  it('flips the momentum vote the analyst carries into the debate, on 1 bar in 8', () => {
    // The consequence under #745's axis vote: RSI drives the MOMENTUM axis, and
    // a flipped momentum vote moves `net` by 1 or 2 out of a denominator of at
    // most 4 — i.e. it moves the confidence the debate weights the analyst by,
    // and can move `direction` outright. Same period, same bar, different
    // history length
    const flipped = momentumFlipsAgainstWarm(FLOOR);

    expect(flipped.length).toBeGreaterThan(10);
    expect(flipped.length / REGION.length).toBeGreaterThan(0.08);
  });
});

/**
 * AFTER — the same three measurements against what the live spec asks for now.
 *
 * Not "approximately zero" as a slogan: the bounds are stated as numbers so a
 * later change that quietly walks the warm-up back fails here.
 */
describe('what the adopted warm-up costs instead — the live spec, measured (#722)', () => {
  it('shifts RSI by a median under 0.5 points, p90 under 1', () => {
    const gaps = gapsAgainstWarm(RSI_SPEC.lookback);

    expect(gaps[Math.floor(gaps.length / 2)] as number).toBeLessThan(0.5);
    expect(gaps[Math.floor(gaps.length * 0.9)] as number).toBeLessThan(1);
    // The WORST bar in the region is still better than the floor's TYPICAL
    // bar. Stated this way on purpose: "better on every bar than the floor was
    // on that bar" is NOT true and was asserted here first — the floor's own
    // best bar is 0.056 off, closer than the converged spec's worst at 0.94,
    // because a seed can land on the converged value by luck. Convergence is a
    // claim about the distribution, not about every draw
    const floorGaps = gapsAgainstWarm(FLOOR);
    expect(gaps.at(-1) as number).toBeLessThan(
      floorGaps[Math.floor(floorGaps.length / 2)] as number,
    );
  });

  it('flips the 70/30 classification on at most 1 bar in the region, not 25', () => {
    // ~0.7% against 18%. NOT asserted as exactly zero: a bar sitting within a
    // fraction of a point of 70 or 30 can still land on the other side of the
    // line at 57 bars versus 200, and pinning zero would make this test a
    // hostage to the fixture rather than a statement about convergence
    expect(flipsAgainstWarm(RSI_SPEC.lookback).length).toBeLessThanOrEqual(1);
    expect(flipsAgainstWarm(FLOOR).length).toBeGreaterThan(20);
  });

  it('flips the momentum vote on at most 2 bars, where the floor flipped 1 in 8', () => {
    // The successor to the old confidence-ratio assertion (#745): the same
    // "and the adopted warm-up costs almost none of it" claim, stated against
    // the quantity RSI now actually moves
    //
    // 2 rather than the 70/30 test's 1, and measured rather than assumed: the
    // momentum vote has THREE boundaries (30, 50, 70) where that test has two,
    // so there is more line for a near-converged bar to straddle. 2 of 141 is
    // 1.4% against the floor's 12%+
    expect(momentumFlipsAgainstWarm(RSI_SPEC.lookback).length).toBeLessThanOrEqual(2);
    expect(momentumFlipsAgainstWarm(FLOOR).length).toBeGreaterThan(10);
  });
});
