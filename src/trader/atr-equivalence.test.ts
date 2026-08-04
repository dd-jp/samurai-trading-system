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
 *   1. They agree exactly (to MDS's 8dp rounding) at the width Trader
 *      presents — `atr_lookback + 1` bars, which yields exactly
 *      `atr_lookback` true ranges, so `atr`'s smoothing loop is empty
 *      (`trueRanges.length <= period`).
 *   2. They DIVERGE once the window is wider than that, which is exactly why
 *      the `+ 1` fetch width in `decide.ts` is load-bearing rather than
 *      incidental. If someone widens that fetch, Wilder's smoothing switches
 *      on and every stop in the system moves.
 *   3. They diverge NARROWER than that too, since #319: the legacy function
 *      fabricated a short-window mean and called it ATR(`lookback`);
 *      `computeIndicator` now throws `InsufficientBarsError`. That is the one
 *      deliberate behavioural break from the migrated function.
 *
 * So this file is not a one-off check: it pins the equivalence Trader's stop
 * placement was calibrated on, and fails loudly if a future change to
 * `computeIndicator`'s `atr` case would move it.
 */
import { type Bar, computeIndicator, InsufficientBarsError } from '../market-data-service/index.js';
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
 * `atrFor` itself is not called here: it pre-checks `minimumBarsFor` and
 * returns null, which would hide the throw the last test below has to
 * observe.
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
  // Parametrized on the LOOKBACK, each at its own `lookback + 1` fetch width,
  // rather than on a bar count at a fixed ATR(14). Before #319 this ran short
  // windows through an ATR(14) spec — 2, 3, 7 and 14 bars — and the two
  // implementations "agreed" because both fabricated the same short-window
  // mean. `computeIndicator` now refuses those, so the plain-mean regime is
  // pinned the honest way: every case here is a window wide enough for the
  // period it claims, which is exactly the invariant `atrIndicatorSpec`
  // encodes and the only shape Trader can present now.
  it.each([
    1,
    2,
    6,
    13,
    LOOKBACK,
  ])('agrees exactly for an ATR(%i) over its own lookback + 1 fetch width', (lookback) => {
    for (let seed = 1; seed <= 25; seed++) {
      const bars = pseudoRandomBars(lookback + 1, seed);
      const legacy = LEGACY_TRADER_ATR(bars, lookback);
      expect(legacy).not.toBeNull();
      // MDS rounds to 8dp for determinism; the legacy function did not.
      // That fixed rounding is the ONLY numeric difference between them.
      expect(mdsAtr(bars, lookback)).toBeCloseTo(legacy as number, 8);
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

  it('THROWS below the seed width where the legacy function fabricated a mean (#319)', () => {
    // The divergence that matters now, and the reason `atrFor` pre-checks the
    // length rather than trusting the value.
    //
    // The legacy function answered a number for ANY window of two bars or
    // more — `trueRanges.slice(-14)` over 13 ranges is 13 ranges, divided by
    // 13, returned as an ATR(14). `computeIndicator` used to do the same via
    // `seedRanges.length`. Both were fabrications, and identical fabrications,
    // which is why the equivalence tests above could not see the bug.
    // `computeIndicator` now refuses, with the arity in the error.
    const oneShort = pseudoRandomBars(LOOKBACK, 3);
    expect(LEGACY_TRADER_ATR(oneShort, LOOKBACK)).toBeCloseTo(
      // The fabricated value the legacy code shipped: a mean over 13 ranges.
      LEGACY_TRADER_ATR(oneShort, LOOKBACK - 1) as number,
      10,
    );
    expect(() => mdsAtr(oneShort, LOOKBACK)).toThrow(InsufficientBarsError);

    // And at the extreme: one bar is no true range at all. The legacy
    // function returned null and `buildBracket` skipped on it; the throw is
    // what `atrFor`'s length pre-check converts back into that same skip.
    expect(LEGACY_TRADER_ATR(pseudoRandomBars(1, 3), LOOKBACK)).toBeNull();
    expect(() => mdsAtr(pseudoRandomBars(1, 3), LOOKBACK)).toThrow(
      /atr\(14\) needs 15 bars but received 1/,
    );
  });
});
