/**
 * B1 (#703) — what the technical analyst's RSI(14) actually is, and what its
 * warm-up costs.
 *
 * ## The gap this fills
 *
 * `trader/atr-equivalence.test.ts` already establishes the equivalent fact for
 * ATR, in as many words: at `atr_lookback + 1` bars "`atr`'s smoothing loop is
 * empty", and widening that fetch "switches Wilder's smoothing on and every
 * stop in the system moves". Excellent prior art — and it covers only the
 * stop.
 *
 * Nothing pinned the same thing for RSI. `RSI_SPEC` carries
 * `lookback: INDICATOR_LOOKBACK + 1` = 15 with `params.period` = 14, which is
 * exactly `minimumBarsFor`, so `rsi`'s smoothing loop runs ZERO times in
 * production too. The value the debate reads as "RSI(14)" is the simple-mean
 * SEED — Cutler's RSI — not Wilder's smoothed RSI, whatever the surrounding
 * doc comments describe. `technicalAnalyst` is `mandatory` and its four prose
 * strings are the entire market read every persona ever sees
 * (`debate-engine/personas.ts:128`), so this is not a detail of one number.
 *
 * ## This is not a claim that `indicators.ts` is wrong
 *
 * The arithmetic is correct for the window it is given —
 * `indicator-golden.test.ts` checks that against an independent reference and
 * it agrees on all 32 cases. What this file pins is the WARM-UP choice, which
 * lives in the spec rather than in the maths: `lookback` is the fabrication
 * floor (`minimumBarsFor`), and the live specs sit exactly on it. Step B2's
 * `recommendedWarmupFor` (`4 x period + 1`) is where that gets a deliberate
 * answer; until then this test states the size of what is being given up, so
 * it is a decision on the record rather than something a soak discovers.
 *
 * Deliberately does NOT change `RSI_SPEC`. Widening the warm-up reprices every
 * technical opinion in the system, and B1's rule is that a characterisation
 * step establishes the baseline and changes nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
} from '../../providers/market-data-service/index.js';
import { RSI_SPEC, SMA_SPEC } from './technical-analyst.js';

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

/** RSI(14) computed over the `lookback` bars ENDING at `endIndex` (exclusive). */
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

/** `technical-analyst.ts`'s `confidenceFrom`, which is module-local there. */
const confidenceFrom = (rsi: number): number =>
  Math.min(0.95, Math.max(0.05, Math.abs(rsi - 50) / 50));

/** `directionFrom`'s gates, also module-local there. */
const OVERBOUGHT = 70;
const OVERSOLD = 30;

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

describe('the live RSI spec sits on the fabrication floor', () => {
  it('asks for exactly minimumBarsFor, so no Wilder smoothing step ever runs', () => {
    expect(RSI_SPEC.params.period).toBe(PERIOD);
    expect(RSI_SPEC.lookback).toBe(PERIOD + 1);
    expect(RSI_SPEC.lookback).toBe(minimumBarsFor(RSI_SPEC));
  });

  it('so the debate reads a plain-mean RSI, not the Wilder one the code describes', () => {
    // `RSI_SPEC.lookback` bars yield exactly `period` changes, so
    // `changes.slice(period)` is empty and `rsi` returns its seed unchanged.
    for (const end of [60, 120, 200, 340, BARS.length]) {
      expect(rsiAt(end, RSI_SPEC.lookback)).toBeCloseTo(
        plainMeanRsi(closesEnding(end, RSI_SPEC.lookback), PERIOD),
        8,
      );
    }
  });

  it('and diverges from that seed as soon as one more bar is given', () => {
    // The mirror of atr-equivalence's point 2: the equality above is a
    // property of the WIDTH, not of the algorithm. One extra bar switches
    // Wilder's smoothing on for exactly one step.
    //
    // The comparison has to be against the seed `rsi` ACTUALLY takes, which is
    // the LEADING `period + 1` closes of the wider window — not `plainMeanRsi`
    // over the whole window, whose trailing-`period` slice is a different set
    // of changes and would differ even between two identical algorithms.
    for (const end of [120, 200, 340]) {
      const window = closesEnding(end, RSI_SPEC.lookback + 1);
      const seed = plainMeanRsi(window.slice(0, PERIOD + 1), PERIOD);

      // That seed is by construction the value the live spec returns one bar
      // earlier, which is what makes the divergence below a smoothing step
      // rather than a window shift.
      expect(seed).toBeCloseTo(rsiAt(end - 1, RSI_SPEC.lookback), 8);
      expect(Math.abs(rsiAt(end, RSI_SPEC.lookback + 1) - seed)).toBeGreaterThan(0.01);
    }
  });

  it('leaves SMA_SPEC alone, because sma reads the trailing period and nothing else', () => {
    // `SMA_SPEC.lookback === minimumBarsFor(SMA_SPEC)` would be true for ANY
    // lookback here and proves nothing: `params` is empty, so `periodOf` falls
    // back to `spec.lookback` and `minimumBarsFor` returns it unchanged. The
    // fact worth pinning is the one that makes that fallback safe — the period
    // IS the lookback for `sma`, so there is no `+ 1` to get wrong and no
    // seed-then-smooth split for a warm-up to change.
    expect(SMA_SPEC.params.period).toBeUndefined();
    expect(minimumBarsFor(SMA_SPEC)).toBe(SMA_SPEC.lookback);
    // Same trailing 14 bars, two wildly different history lengths, identical
    // answer — the property RSI does NOT have.
    expect(computeIndicator(BARS.slice(386, 400), SMA_SPEC)).toBeCloseTo(
      computeIndicator(BARS.slice(0, 400), { ...SMA_SPEC, lookback: 400, params: { period: 14 } }),
      8,
    );
  });
});

describe('what the missing warm-up costs, measured', () => {
  it('shifts RSI by a median of ~4.6 points, p90 ~12', () => {
    const gaps = REGION.map((end) =>
      Math.abs(rsiAt(end, RSI_SPEC.lookback) - rsiAt(end, WARM)),
    ).sort((a, b) => a - b);

    const median = gaps[Math.floor(gaps.length / 2)] as number;
    const p90 = gaps[Math.floor(gaps.length * 0.9)] as number;

    expect(median).toBeGreaterThan(3);
    expect(median).toBeLessThan(7);
    expect(p90).toBeGreaterThan(9);
  });

  it('flips the overbought/oversold classification on ~18% of bars', () => {
    // The consequence that matters. `directionFrom` gates on 70/30, so a bar
    // the live spec calls overbought is one a warmed RSI calls ordinary, and
    // the analyst's `direction` changes with it. Nearly one bar in five.
    const flipped = REGION.filter((end) => {
      const live = rsiAt(end, RSI_SPEC.lookback);
      const warm = rsiAt(end, WARM);
      return live >= OVERBOUGHT !== warm >= OVERBOUGHT || live < OVERSOLD !== warm < OVERSOLD;
    });

    expect(flipped.length).toBeGreaterThan(15);
    expect(flipped.length / REGION.length).toBeGreaterThan(0.12);
  });

  it('moves the confidence the debate weights the analyst by, by more than 4x', () => {
    // `confidenceFrom` is `|rsi - 50| / 50`, so a warm-up shift is a
    // confidence shift, and confidence is what the debate weights an analyst
    // by. Same period, same bar, different history length.
    const ratios = REGION.map((end) => {
      const live = confidenceFrom(rsiAt(end, RSI_SPEC.lookback));
      const warm = confidenceFrom(rsiAt(end, WARM));
      return Math.max(live / warm, warm / live);
    });

    expect(Math.max(...ratios)).toBeGreaterThan(4);
  });
});
