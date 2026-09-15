/**
 * F1 (#757) — the same warm-up defect `rsi-warmup.test.ts` pins for RSI
 * (#722), for the two ATR specs `atr-equivalence.test.ts` (#304) already
 * knew sat on the floor. `docs/reviews/indicator-characterisation-2026-08-16.md`
 * F1/F2.
 *
 * ## Why ATR needed its own gate, unlike RSI
 *
 * RSI had a clean pass bar for free — the 70/30 overbought/oversold
 * classification, which #722 measured flipping on 17.7% of bars at the floor
 * and 0.7% converged. ATR has no equivalent classification, and post-#739
 * (ADR-0018 D3/D5) it no longer prices the stop for any classified/live
 * instrument at all — `resolveSubclassBracket(...) !== null` (every
 * ADR-0016 leveraged-ETP row) sizes the stop as `bracket.stop_pct * entry`,
 * ATR-free. So the two candidates the issue named split:
 *
 * - "the stop distance the Trader derives" — only reachable via
 *   `bracket === null` (`DEFAULT_UNIVERSE` / `SMOKE_TEST_UNIVERSE` /
 *   backtest fixtures), never a live ADR-0016 row. Reported, not gated.
 * - "the volatility-breaker trip rate" — the live channel
 *   (`MarketDataVolatilityReadingProvider` → `CircuitBreakers.evaluate`), but
 *   a LITERAL trip-rate measurement is degenerate: `paper-profile.ts`'s
 *   `volatility.baseline` is `UNCALIBRATED_VOLATILITY_BASELINE = 1_000_000`
 *   against real ATR readings of order 1-10 price units — deliberately inert
 *   ("no observation to calibrate against yet"). 0% trips at both widths
 *   would trivially "pass" any bar and measure nothing.
 *
 * The gate actually used, adapted from the second candidate and declared on
 * the issue (comment, 2026-08-18) BEFORE this file's numbers were computed:
 * the RELATIVE SHIFT in the aggregated ATR reading itself, floor vs
 * converged, over the golden fixture's ordinary region — the input a future
 * baseline calibration would anchor to, so a large shift here means adopting
 * would silently reprice whatever threshold gets calibrated later.
 *
 * - Median relative shift `|converged - floor| / floor` <= 15%
 * - p90 relative shift <= 30%
 * - reported WITH SIGN, since a systematic decrease is risk-increasing (a
 *   tighter residual stop, a breaker that reads lower against a fixed future
 *   baseline) and a systematic increase is not, at the same magnitude.
 *
 * Measured: median 3.0%, p90 6.9%, worst-bar 13.4%, mean SIGNED shift +0.46%
 * (converged reads marginally HIGHER, not systematically lower — no
 * risk-increasing bias). Both bars cleared, so both specs adopt
 * `recommendedWarmupFor`, and `decide.ts`'s Trader-side bar fetch was widened
 * to match — otherwise the spec-level change would be inert on that path,
 * the same lesson #722's `WARM_START_WINDOWS` fix carries for RSI.
 *
 * Re-deriving `volatility.baseline`/`multiplier` is explicitly OUT of scope
 * here regardless of outcome — that is a soak question, not a unit-test one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_VOLATILITY_INDICATOR } from '../../apps/orchestrator/production/defaults.js';
import {
  type Bar,
  computeIndicator,
  type IndicatorSpec,
  minimumBarsFor,
  recommendedWarmupFor,
} from '../../providers/market-data-service/index.js';
import { atrIndicatorSpec } from './decide.js';

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

/** ATR(14) computed over the `lookback` bars ENDING at `endIndex` (exclusive) */
function atrAt(endIndex: number, lookback: number): number {
  const start = Math.max(0, endIndex - lookback);
  const window = BARS.slice(start, endIndex);
  const spec: IndicatorSpec = {
    indicator: 'atr',
    params: { period: PERIOD },
    timeframe: '1h',
    lookback: window.length,
  };
  return computeIndicator(window, spec);
}

/** The fabrication floor both specs used to sit on. Same shape as `rsi-warmup.test.ts`'s `FLOOR`. */
const FLOOR = minimumBarsFor({
  indicator: 'atr',
  params: { period: PERIOD },
  timeframe: '1h',
  lookback: 15,
});
/** The converged width both specs now ask for */
const CONVERGED = 4 * PERIOD + 1;
/** A comfortably-past-converged reference — same convention F2 used for RSI */
const WARM = 200;

/**
 * Same region `rsi-warmup.test.ts` uses, for the same reason: the golden
 * fixture's ordinary random-walk stretch (bars 60-200), excluding the
 * synthetic rising/falling/flat segments that would inflate every number
 */
const REGION = Array.from({ length: 141 }, (_, i) => i + 60);

describe('both live ATR specs sit on a converged warm-up (#757)', () => {
  it('atrIndicatorSpec asks for the recommendation, not the fabrication floor', () => {
    const spec = atrIndicatorSpec(PERIOD, '1h');
    expect(spec.params.period).toBe(PERIOD);
    expect(FLOOR).toBe(PERIOD + 1);
    expect(spec.lookback).toBe(recommendedWarmupFor(spec));
    expect(spec.lookback).toBe(CONVERGED);
    expect(spec.lookback).toBeGreaterThan(FLOOR);
  });

  it('DEFAULT_VOLATILITY_INDICATOR asks for the recommendation too', () => {
    expect(DEFAULT_VOLATILITY_INDICATOR.params.period).toBe(PERIOD);
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBe(
      recommendedWarmupFor(DEFAULT_VOLATILITY_INDICATOR),
    );
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBe(CONVERGED);
    expect(DEFAULT_VOLATILITY_INDICATOR.lookback).toBeGreaterThan(FLOOR);
  });

  it('minimumBarsFor is unchanged — the floor still trades, just less warm', () => {
    expect(minimumBarsFor(atrIndicatorSpec(PERIOD, '1h'))).toBe(FLOOR);
    expect(minimumBarsFor(DEFAULT_VOLATILITY_INDICATOR)).toBe(FLOOR);
  });

  it('the declared gate: relative shift floor vs converged, over the fixture region', () => {
    // Reproduces exactly the numbers declared on #757 before adoption
    const relShifts: number[] = [];
    const signedShifts: number[] = [];
    for (const end of REGION) {
      const floor = atrAt(end, FLOOR);
      const converged = atrAt(end, CONVERGED);
      relShifts.push(Math.abs(converged - floor) / floor);
      signedShifts.push((converged - floor) / floor);
    }
    relShifts.sort((a, b) => a - b);
    const median = relShifts[Math.floor(relShifts.length / 2)] as number;
    const p90 = relShifts[Math.floor(relShifts.length * 0.9)] as number;
    const meanSigned = signedShifts.reduce((a, b) => a + b, 0) / signedShifts.length;

    // The declared bar (median <= 15%, p90 <= 30%), both cleared
    expect(median).toBeLessThanOrEqual(0.15);
    expect(p90).toBeLessThanOrEqual(0.3);
    // Pin the actual measured numbers, not just the pass/fail, so a future
    // change to `atr`'s arithmetic that moves this materially is visible
    // rather than silently still-passing a loose bound
    expect(median).toBeCloseTo(0.0301, 3);
    expect(p90).toBeCloseTo(0.0693, 3);
    // No material risk-increasing bias: converged does not read systematically
    // lower (which would tighten the residual stop and delay the breaker)
    expect(Math.abs(meanSigned)).toBeLessThan(0.02);
  });

  it('the converged width has actually converged, against a 200-bar reference', () => {
    for (const end of [120, 200, 340, BARS.length]) {
      const converged = atrAt(end, CONVERGED);
      const warm = atrAt(end, WARM);
      expect(Math.abs(converged - warm) / warm).toBeLessThan(0.02);
    }
  });

  it('and no longer the plain-mean seed the floor returns', () => {
    // At FLOOR bars, `trueRanges.length <= period` so `atr`'s smoothing loop
    // never runs and the value is the seed — a plain mean of the true ranges
    // The converged width pulls in enough history that the Wilder recursion
    // actually smooths, which is the whole point of adopting it
    for (const end of [120, 200, 340, BARS.length]) {
      expect(Math.abs(atrAt(end, CONVERGED) - atrAt(end, FLOOR))).toBeGreaterThan(0);
    }
  });
});
