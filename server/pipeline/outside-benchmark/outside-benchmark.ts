export const OUTSIDE_BENCHMARKS = ['spy', 'sixty_forty'] as const;

export type OutsideBenchmarkId = (typeof OUTSIDE_BENCHMARKS)[number];

export interface BenchmarkLeg {
  instrument: string;
  weight: number;
}

export const BENCHMARK_COMPOSITION: Record<OutsideBenchmarkId, readonly BenchmarkLeg[]> = {
  spy: [{ instrument: 'SPY', weight: 1 }],
  sixty_forty: [
    { instrument: 'SPY', weight: 0.6 },
    { instrument: 'AGG', weight: 0.4 },
  ],
};

export interface BenchmarkObservation {
  close_time: Date;
  close: number;
}

export interface OutsideBenchmarkPerformance {
  benchmark: OutsideBenchmarkId;
  buy_and_hold_return_pct: number;
  max_drawdown_pct: number;
  observation_count: number;
}

export interface OutsideBenchmarkSample {
  computed_at: Date;
  from: Date;
  to: Date;
  performance: OutsideBenchmarkPerformance;
}

interface ResolvedBenchmarkLeg {
  leg: BenchmarkLeg;
  anchor: BenchmarkObservation;
  inWindow: BenchmarkObservation[];
}

function resolveBenchmarkLeg(
  benchmark: OutsideBenchmarkId,
  leg: BenchmarkLeg,
  observations: readonly BenchmarkObservation[],
  from: Date,
  to: Date,
): ResolvedBenchmarkLeg {
  const sorted = [...observations].sort((a, b) => a.close_time.getTime() - b.close_time.getTime());

  const anchor = sorted.filter((o) => o.close_time.getTime() <= from.getTime()).at(-1);
  if (anchor === undefined) {
    throw new Error(
      `buildOutsideBenchmark(${benchmark}): leg ${leg.instrument} has no close at or ` +
        `before the window start ${from.toISOString()}, so the window's first daily ` +
        'return has no denominator. Refusing rather than measuring a shorter window than ' +
        'the arms were measured over.',
    );
  }

  const inWindow = sorted.filter(
    (o) => o.close_time.getTime() > from.getTime() && o.close_time.getTime() <= to.getTime(),
  );
  if (inWindow.length === 0) {
    throw new Error(
      `buildOutsideBenchmark(${benchmark}): leg ${leg.instrument} has no closes inside ` +
        `(${from.toISOString()}, ${to.toISOString()}]. There is nothing to measure.`,
    );
  }

  if (anchor.close <= 0 || inWindow.some((o) => o.close <= 0)) {
    throw new Error(
      `buildOutsideBenchmark(${benchmark}): leg ${leg.instrument} carries a ` +
        'non-positive close. A price of zero or less is bad data, not a bad day.',
    );
  }

  return { leg, anchor, inWindow };
}

function commonCloseTimeline(
  benchmark: OutsideBenchmarkId,
  perLeg: readonly ResolvedBenchmarkLeg[],
): number[] {
  const perLegTimes = perLeg.map(
    (entry) => new Set(entry.inWindow.map((o) => o.close_time.getTime())),
  );
  const timeline = [...(perLegTimes[0] ?? new Set<number>())]
    .filter((time) => perLegTimes.every((times) => times.has(time)))
    .sort((a, b) => a - b);
  if (timeline.length === 0) {
    throw new Error(
      `buildOutsideBenchmark(${benchmark}): the legs share no common close time inside ` +
        'the window, so no blended observation can be formed.',
    );
  }
  return timeline;
}

function blendIndexSeries(
  perLeg: readonly ResolvedBenchmarkLeg[],
  timeline: readonly number[],
): { index: number; maxDrawdown: number } {
  let index = 1;
  let peak = 1;
  let maxDrawdown = 0;
  const previousClose = new Map(perLeg.map((entry) => [entry.leg.instrument, entry.anchor.close]));

  for (const time of timeline) {
    let blendedReturn = 0;
    for (const entry of perLeg) {
      const observation = entry.inWindow.find((o) => o.close_time.getTime() === time);
      if (observation === undefined) continue;
      const previous = previousClose.get(entry.leg.instrument) ?? observation.close;
      blendedReturn += entry.leg.weight * (observation.close / previous - 1);
      previousClose.set(entry.leg.instrument, observation.close);
    }

    index *= 1 + blendedReturn;
    if (index > peak) peak = index;
    const drawdown = (peak - index) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return { index, maxDrawdown };
}

export function buildOutsideBenchmark(input: {
  benchmark: OutsideBenchmarkId;
  legs: readonly { leg: BenchmarkLeg; observations: readonly BenchmarkObservation[] }[];
  from: Date;
  to: Date;
}): OutsideBenchmarkPerformance {
  if (input.legs.length === 0) {
    throw new Error(
      `buildOutsideBenchmark(${input.benchmark}): no legs supplied. A benchmark with no ` +
        'composition has no return to measure.',
    );
  }

  const weightSum = input.legs.reduce((total, { leg }) => total + leg.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error(
      `buildOutsideBenchmark(${input.benchmark}): leg weights sum to ${weightSum}, not 1. ` +
        'A blend whose weights do not sum to 1 is levered or under-invested, and its return ' +
        'is not the benchmark it claims to be.',
    );
  }

  if (input.from.getTime() >= input.to.getTime()) {
    throw new Error(
      `buildOutsideBenchmark(${input.benchmark}): window start ${input.from.toISOString()} is ` +
        `not before its end ${input.to.toISOString()}.`,
    );
  }

  const perLeg = input.legs.map(({ leg, observations }) =>
    resolveBenchmarkLeg(input.benchmark, leg, observations, input.from, input.to),
  );

  const timeline = commonCloseTimeline(input.benchmark, perLeg);

  const { index, maxDrawdown } = blendIndexSeries(perLeg, timeline);

  return {
    benchmark: input.benchmark,
    buy_and_hold_return_pct: index - 1,
    max_drawdown_pct: maxDrawdown,
    observation_count: timeline.length,
  };
}
