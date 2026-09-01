/**
 * #981's acceptance criteria, as tests — the outside-benchmark half of #636.
 *
 * Three of these are claims about TYPES rather than about arithmetic, and they
 * are the ones that matter most, because #636's named failure mode is a
 * presentation defect rather than a maths one:
 *
 *  - `max_drawdown_pct` is REQUIRED (a `@ts-expect-error`, mirroring
 *    `arm-comparison.test.ts`'s enforcement of the same rule for the arms);
 *  - the return field is NOT called `return_pct`, so a benchmark's
 *    fully-invested return cannot be stacked in one column with an arm's
 *    realized-PnL-over-the-book return;
 *  - the shape carries no verdict, no trade count and no PnL — an outside
 *    benchmark is secondary and is not a third arm.
 */
import {
  BENCHMARK_COMPOSITION,
  type BenchmarkObservation,
  buildOutsideBenchmark,
  OUTSIDE_BENCHMARKS,
  type OutsideBenchmarkPerformance,
} from './outside-benchmark.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-08-01T20:00:00.000Z');

/** Daily closes starting one day BEFORE `from`, so index 0 is the anchor. */
function series(closes: readonly number[], start = T0): BenchmarkObservation[] {
  return closes.map((close, i) => ({
    close_time: new Date(start.getTime() + i * DAY),
    close,
  }));
}

/** The window opens ON the anchor bar and closes after the last observation. */
const FROM = T0;
const TO = new Date(T0.getTime() + 10 * DAY);

describe('buildOutsideBenchmark — composition (#981)', () => {
  it('names SPY and 60/40, and nothing else', () => {
    expect([...OUTSIDE_BENCHMARKS]).toEqual(['spy', 'sixty_forty']);
  });

  it("uses AGG as the 60/40 blend's bond leg, at 40%", () => {
    expect(BENCHMARK_COMPOSITION.spy).toEqual([{ instrument: 'SPY', weight: 1 }]);
    expect(BENCHMARK_COMPOSITION.sixty_forty).toEqual([
      { instrument: 'SPY', weight: 0.6 },
      { instrument: 'AGG', weight: 0.4 },
    ]);
  });

  it('has weights summing to 1 for every benchmark', () => {
    for (const id of OUTSIDE_BENCHMARKS) {
      const sum = BENCHMARK_COMPOSITION[id].reduce((total, leg) => total + leg.weight, 0);
      expect(sum).toBeCloseTo(1, 12);
    }
  });
});

describe('buildOutsideBenchmark — return and drawdown together', () => {
  it('measures return from the ANCHOR close, not the first in-window close', () => {
    // Anchor 100, then 110. Measured from the anchor the window returned 10%.
    // Measured from the first IN-WINDOW close it would return 0% — the defect
    // the anchor exists to prevent, since a trade closing one second after
    // `from` counts for the arms and the benchmark must cover that instant too.
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 110]) }],
      from: FROM,
      to: TO,
    });

    expect(result.buy_and_hold_return_pct).toBeCloseTo(0.1, 12);
    expect(result.observation_count).toBe(1);
  });

  it('computes drawdown relative to the running peak, not to the seed', () => {
    // 100 -> 120 -> 60 -> 90. Peak index 1.2, trough 0.6: a 50% drawdown,
    // on a window whose total return is -10%.
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 120, 60, 90]) }],
      from: FROM,
      to: TO,
    });

    expect(result.buy_and_hold_return_pct).toBeCloseTo(-0.1, 12);
    expect(result.max_drawdown_pct).toBeCloseTo(0.5, 12);
  });

  it('reports zero drawdown for a series that never falls below a prior peak', () => {
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 101, 105, 110]) }],
      from: FROM,
      to: TO,
    });

    expect(result.max_drawdown_pct).toBe(0);
    expect(result.buy_and_hold_return_pct).toBeGreaterThan(0);
  });

  it('reports a real drawdown for a benchmark that is down from its first day', () => {
    // The index is seeded at 1 on the anchor, so a benchmark that only falls
    // has a drawdown equal to its loss — its high-water mark is the capital it
    // started with, matching `performanceFor`'s peak-starts-at-0 rule for arms.
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 90, 80]) }],
      from: FROM,
      to: TO,
    });

    expect(result.buy_and_hold_return_pct).toBeCloseTo(-0.2, 12);
    expect(result.max_drawdown_pct).toBeCloseTo(0.2, 12);
  });
});

describe('buildOutsideBenchmark — the 60/40 blend', () => {
  it('blends the legs daily-rebalanced, weighting SIMPLE returns 60/40', () => {
    // Day 1: SPY +10%, AGG  0%  -> blend +6%
    // Day 2: SPY  0%,  AGG +10% -> blend +4%
    // Index: 1.06 * 1.04 = 1.1024. Daily rebalancing is what makes day 2's
    // weights 60/40 again rather than the drifted 61.9/38.1 a buy-and-hold of
    // two sleeves would carry into it.
    const result = buildOutsideBenchmark({
      benchmark: 'sixty_forty',
      legs: [
        { leg: { instrument: 'SPY', weight: 0.6 }, observations: series([100, 110, 110]) },
        { leg: { instrument: 'AGG', weight: 0.4 }, observations: series([100, 100, 110]) },
      ],
      from: FROM,
      to: TO,
    });

    expect(result.buy_and_hold_return_pct).toBeCloseTo(1.06 * 1.04 - 1, 12);
    expect(result.observation_count).toBe(2);
  });

  it("takes drawdown on the BLENDED index, never a blend of the sleeves' drawdowns", () => {
    // SPY troughs on day 1, AGG on day 2 — they never trough together.
    // SPY's own drawdown is 20% and AGG's is 10%; a 60/40 blend of those two
    // NUMBERS would be 16%. The blended INDEX only falls 8%:
    //   day1 blend = .6(-.20) + .4(+.10) = -.08 -> index 0.92
    //   day2 blend = .6(+.25) + .4(-.10) = +.11 -> index 1.0212
    // So blending drawdowns overstates, because the sleeves diversify each
    // other and a blend of drawdowns cannot see that.
    const result = buildOutsideBenchmark({
      benchmark: 'sixty_forty',
      legs: [
        { leg: { instrument: 'SPY', weight: 0.6 }, observations: series([100, 80, 100]) },
        { leg: { instrument: 'AGG', weight: 0.4 }, observations: series([100, 110, 99]) },
      ],
      from: FROM,
      to: TO,
    });

    expect(result.max_drawdown_pct).toBeCloseTo(0.08, 12);
    expect(result.max_drawdown_pct).not.toBeCloseTo(0.16, 4);
  });

  it('drops a day one leg is missing rather than treating the blend as part-invested', () => {
    // AGG has no close on day 2. That day is not a day of this benchmark:
    // counting it would silently run a 60%-invested blend for one session.
    const spy = series([100, 110, 120, 130]);
    const agg = series([100, 100, 100, 100]).filter((_, i) => i !== 2);

    const result = buildOutsideBenchmark({
      benchmark: 'sixty_forty',
      legs: [
        { leg: { instrument: 'SPY', weight: 0.6 }, observations: spy },
        { leg: { instrument: 'AGG', weight: 0.4 }, observations: agg },
      ],
      from: FROM,
      to: TO,
    });

    // Three in-window SPY closes, but only two are shared with AGG.
    expect(result.observation_count).toBe(2);
  });
});

describe('buildOutsideBenchmark — the window is a correctness condition', () => {
  it('excludes closes after `to` and at or before `from`', () => {
    const observations = series([100, 110, 120, 130, 140]);
    const narrow = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations }],
      from: FROM,
      // Only the first two in-window closes fall at or before this instant.
      to: new Date(T0.getTime() + 2 * DAY),
    });

    expect(narrow.observation_count).toBe(2);
    expect(narrow.buy_and_hold_return_pct).toBeCloseTo(0.2, 12);
  });

  it('refuses a leg with no anchor rather than measuring a shorter window', () => {
    // Every close is INSIDE the window, so the window's first daily return has
    // no denominator. #636: an approximate window is noise, not a comparison.
    const observations = series([100, 110], new Date(T0.getTime() + DAY));
    expect(() =>
      buildOutsideBenchmark({
        benchmark: 'spy',
        legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations }],
        from: FROM,
        to: TO,
      }),
    ).toThrow(/no close at or before the window start/);
  });

  it('refuses a leg with no in-window close', () => {
    expect(() =>
      buildOutsideBenchmark({
        benchmark: 'spy',
        legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100]) }],
        from: FROM,
        to: TO,
      }),
    ).toThrow(/no closes inside/);
  });

  it('refuses an inverted window', () => {
    expect(() =>
      buildOutsideBenchmark({
        benchmark: 'spy',
        legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 110]) }],
        from: TO,
        to: FROM,
      }),
    ).toThrow(/not before its end/);
  });

  it('refuses weights that do not sum to 1', () => {
    expect(() =>
      buildOutsideBenchmark({
        benchmark: 'sixty_forty',
        legs: [
          { leg: { instrument: 'SPY', weight: 0.6 }, observations: series([100, 110]) },
          { leg: { instrument: 'AGG', weight: 0.2 }, observations: series([100, 100]) },
        ],
        from: FROM,
        to: TO,
      }),
    ).toThrow(/weights sum to/);
  });

  it('refuses a non-positive close rather than treating it as a bad day', () => {
    expect(() =>
      buildOutsideBenchmark({
        benchmark: 'spy',
        legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 0]) }],
        from: FROM,
        to: TO,
      }),
    ).toThrow(/non-positive close/);
  });

  it('refuses an empty composition', () => {
    expect(() => buildOutsideBenchmark({ benchmark: 'spy', legs: [], from: FROM, to: TO })).toThrow(
      /no legs supplied/,
    );
  });
});

describe('buildOutsideBenchmark — D4 made structural, and "secondary" made structural', () => {
  it('cannot express a benchmark performance without its drawdown', () => {
    // @ts-expect-error `max_drawdown_pct` is REQUIRED — a return-only view of an
    // outside benchmark is unrepresentable, exactly as it is for an arm
    // (`ArmPerformance`, arm-comparison.test.ts). CLAUDE.md: "outside benchmarks
    // report return AND drawdown together". If this line ever stops erroring,
    // D4's enforcement has been downgraded from a type to a convention.
    const returnOnly: OutsideBenchmarkPerformance = {
      benchmark: 'spy',
      buy_and_hold_return_pct: 0.02,
      observation_count: 21,
    };
    expect(returnOnly).toBeTruthy();
  });

  it("does NOT name its return field `return_pct`, so it cannot be stacked with an arm's", () => {
    // `ArmPerformance.return_pct` is realized PnL over a book that is flat
    // overnight; this is a fully-invested notional's return. Same units,
    // different quantities — #636's named failure mode ("easy to lose in a
    // per-arm metrics table with one column per arm"). The distinct name is
    // what forces a would-be one-column table to rename something first.
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 110]) }],
      from: FROM,
      to: TO,
    });

    expect('return_pct' in result).toBe(false);
    expect('buy_and_hold_return_pct' in result).toBe(true);
  });

  it('carries no divergence verdict, trade count or PnL — it is not a third arm', () => {
    const result = buildOutsideBenchmark({
      benchmark: 'spy',
      legs: [{ leg: { instrument: 'SPY', weight: 1 }, observations: series([100, 110]) }],
      from: FROM,
      to: TO,
    });

    // Secondary, structurally: nothing on this shape can alert, and nothing on
    // it reads as an account. There is no threshold here to change that with.
    for (const absent of ['diverged', 'reason', 'trade_count', 'realized_pnl_net', 'arm']) {
      expect(absent in result).toBe(false);
    }
  });
});
