/**
 * Migration evidence for ticket #304 — "move `computeAtr` out of Trader into
 * the Market Data Service".
 *
 * Trader used to carry its own private `computeAtr`: a PLAIN ARITHMETIC MEAN
 * of the last `lookback` true ranges. The Market Data Service's `atr` (via
 * `computeIndicator`) is WILDER-SMOOTHED: it seeds on the first `period` true
 * ranges and then smooths every remaining one. Those are different
 * algorithms, and ATR sets Trader's stop distance — so deleting the private
 * one is only safe if the two agree at the width Trader actually calls with.
 *
 * `LEGACY_TRADER_ATR` below is the deleted function, verbatim, kept as the
 * reference implementation. These tests prove:
 *   1. They agree exactly (to MDS's 8dp rounding) for every bar count Trader
 *      can present — because Trader fetches `atr_lookback + 1` bars, which
 *      yields at most `atr_lookback` true ranges, and `atr`'s smoothing loop
 *      is empty whenever `trueRanges.length <= period`.
 *   2. They DIVERGE once the window is wider than that, which is exactly why
 *      the `+ 1` fetch width in `decide.ts` is load-bearing rather than
 *      incidental. If someone widens that fetch, Wilder's smoothing switches
 *      on and every stop in the system moves.
 *
 * So this file is not a one-off check: it pins the equivalence Trader's stop
 * placement was calibrated on, and fails loudly if a future change to
 * `computeIndicator`'s `atr` case would move it.
 */
import { type Bar, computeIndicator } from '../market-data-service/index.js';
import { atrIndicatorSpec } from './decide.js';

const LOOKBACK = 14;

/**
 * The pre-#304 `trader/decide.ts` `computeAtr`, copied unchanged. Do not
 * "improve" it — its value here is being the historical algorithm, not being
 * good code.
 */
function LEGACY_TRADER_ATR(bars: Bar[], lookback: number): number | null {
  const [earliest, ...rest] = [...bars].sort(
    (a, b) => a.close_time.getTime() - b.close_time.getTime(),
  );
  if (earliest === undefined || rest.length === 0) return null;

  let previousClose = earliest.close;
  const trueRanges: number[] = [];
  for (const current of rest) {
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(previousClose - current.low),
      ),
    );
    previousClose = current.close;
  }

  const window = trueRanges.slice(-lookback);
  return window.reduce((sum, tr) => sum + tr, 0) / window.length;
}

/**
 * The real spec `decide.ts` asks MDS for — imported, not rebuilt here. A
 * local copy would keep this file green if `atrIndicatorSpec` drifted (e.g.
 * someone dropped the pinned `params.period` and let `computeIndicator`'s
 * `?? spec.lookback` fallback turn this into an ATR(15)), which is precisely
 * the drift this file exists to catch.
 *
 * `atrFor` itself is not called here: it guards `bars.length < 2` and returns
 * null, which would hide the NaN the last test below has to observe.
 */
function mdsAtr(bars: Bar[], lookback: number): number {
  return computeIndicator(bars, atrIndicatorSpec(lookback));
}

/**
 * Deterministic pseudo-random OHLC bars — a fixed LCG rather than
 * `Math.random`, so a failure is reproducible from the seed alone. Gaps
 * between one bar's close and the next bar's range are deliberate: they are
 * what makes the `|high - prevClose|` / `|prevClose - low|` legs of the true
 * range bind, instead of `high - low` always winning.
 */
function pseudoRandomBars(count: number, seed: number): Bar[] {
  let state = seed;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };

  const base = new Date('2026-07-15T10:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const mid = 100 + (next() - 0.5) * 20;
    const halfRange = next() * 5 + 0.1;
    const closeTime = new Date(base - (count - 1 - i) * 3_600_000);
    return {
      instrument: 'AAPL',
      timeframe: '1h',
      open_time: new Date(closeTime.getTime() - 3_600_000),
      close_time: closeTime,
      open: mid,
      high: mid + halfRange,
      low: mid - halfRange,
      close: mid + (next() - 0.5) * halfRange,
      volume: 1_000,
      source: 'fixture',
    };
  });
}

describe('ATR migration (#304) — Trader’s deleted computeAtr vs MDS computeIndicator', () => {
  it.each([
    2,
    3,
    7,
    14,
    LOOKBACK + 1,
  ])('agrees exactly at %i bars — every width Trader can present', (barCount) => {
    for (let seed = 1; seed <= 25; seed++) {
      const bars = pseudoRandomBars(barCount, seed);
      const legacy = LEGACY_TRADER_ATR(bars, LOOKBACK);
      expect(legacy).not.toBeNull();
      // MDS rounds to 8dp for determinism; the legacy function did not.
      // That fixed rounding is the ONLY numeric difference between them.
      expect(mdsAtr(bars, LOOKBACK)).toBeCloseTo(legacy as number, 8);
    }
  });

  it('agrees on the exact fetch width decide.ts uses, to the last bit', () => {
    // `atr_lookback + 1` bars -> exactly `atr_lookback` true ranges, so
    // `seedRanges` is the whole array and the smoothing loop never runs.
    const bars = pseudoRandomBars(LOOKBACK + 1, 99);
    const legacy = LEGACY_TRADER_ATR(bars, LOOKBACK) as number;

    expect(mdsAtr(bars, LOOKBACK)).toBe(Number(legacy.toFixed(8)));
  });

  it('DIVERGES beyond that width — why decide.ts fetches lookback + 1, not more', () => {
    // 5 bars past the call-site width => 5 true ranges past the seed, so
    // Wilder's smoothing engages and the two answers part company. This is
    // the regression a widened fetch would introduce, made visible.
    const bars = pseudoRandomBars(LOOKBACK + 6, 7);
    const legacy = LEGACY_TRADER_ATR(bars, LOOKBACK) as number;

    expect(mdsAtr(bars, LOOKBACK)).not.toBeCloseTo(legacy, 6);
  });

  it('returns NaN below two bars, which is why decide.ts guards the length itself', () => {
    // The legacy function returned null and `buildBracket` skipped on it.
    // `computeIndicator` divides by an empty seed instead: NaN survives
    // `Math.max`, `stopDistance <= 0` and the min-notional check (every
    // comparison against NaN is false), so an unguarded migration would emit
    // an OrderIntent with NaN size/stop/target rather than skipping.
    expect(LEGACY_TRADER_ATR(pseudoRandomBars(1, 3), LOOKBACK)).toBeNull();
    expect(mdsAtr(pseudoRandomBars(1, 3), LOOKBACK)).toBeNaN();
  });
});
