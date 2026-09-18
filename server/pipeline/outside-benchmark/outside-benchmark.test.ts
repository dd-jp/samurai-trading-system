import {
  BENCHMARK_COMPOSITION,
  type BenchmarkObservation,
  buildOutsideBenchmark,
  OUTSIDE_BENCHMARKS,
  type OutsideBenchmarkPerformance,
} from './outside-benchmark.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-08-01T20:00:00.000Z');

function series(closes: readonly number[], start = T0): BenchmarkObservation[] {
  return closes.map((close, i) => ({
    close_time: new Date(start.getTime() + i * DAY),
    close,
  }));
}

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
      to: new Date(T0.getTime() + 2 * DAY),
    });

    expect(narrow.observation_count).toBe(2);
    expect(narrow.buy_and_hold_return_pct).toBeCloseTo(0.2, 12);
  });

  it('refuses a leg with no anchor rather than measuring a shorter window', () => {
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
    const returnOnly: OutsideBenchmarkPerformance = {
      benchmark: 'spy',
      buy_and_hold_return_pct: 0.02,
      observation_count: 21,
    };
    expect(returnOnly).toBeTruthy();
  });

  it("does NOT name its return field `return_pct`, so it cannot be stacked with an arm's", () => {
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

    for (const absent of ['diverged', 'reason', 'trade_count', 'realized_pnl_net', 'arm']) {
      expect(absent in result).toBe(false);
    }
  });
});
