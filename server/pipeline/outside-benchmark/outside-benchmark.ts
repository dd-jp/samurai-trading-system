/**
 * The risk-adjusted OUTSIDE benchmarks — SPY and 60/40 (#981, under #636).
 *
 * #636 asked one question with two halves: which spec owns computing the
 * falsifier control arm **and the risk-adjusted outside benchmarks**. David's
 * 2026-08-26 resolution answered both with `feedback-loop-spec.md`. #971 built
 * the first half (`pipeline/control-arm/arm-comparison.ts`, the matched control);
 * this module is the second.
 *
 * ## Not a third arm — and the type system says so
 *
 * An outside benchmark is a conceptually different record from an arm, and the
 * shapes here are deliberately NOT `ArmPerformance` with a different label:
 *
 *  - There is **no `trade_count`**. SPY does not trade; it is held.
 *  - There is **no `realized_pnl_net`**. The benchmark has no fills, no fees and
 *    no account — a currency figure here would be a number nobody made.
 *  - There is **no divergence verdict and no alert channel.** The matched control
 *    can wake a human (`evaluateArmDivergence`); an outside benchmark cannot, by
 *    construction, because it is SECONDARY and never the thing to beat
 *    (CLAUDE.md Key Constraints; ADR-0014 amendment 2; ADR-0017 §Consequences).
 *    There is no threshold in this file to change that with.
 *
 * ## Why the return field is NOT called `return_pct`
 *
 * `ArmPerformance.return_pct` is realized PnL over the window as a fraction of
 * the declared book — a book that is flat overnight and unlevered most of the
 * session, so its denominator is capital AT RISK ONLY WHEN A TRADE IS ON.
 * `buy_and_hold_return_pct` here is the return of a position that is fully
 * invested for the whole window, every day, including the nights the live book
 * is deliberately flat (ADR-0014's flat-by-close horizon).
 *
 * They are both "a fraction over the same window" and they are NOT the same
 * quantity. #636 names this exact failure mode — *"easy to lose in a per-arm
 * metrics table with one column per arm"* — so the field carries a different
 * name rather than a footnote. A summary table that wants to stack these in one
 * column has to rename something first, in code that reads as the mistake it is.
 * That is the same argument `arm-comparison.ts`'s header makes about drawdown,
 * applied to the denominator instead of the column.
 *
 * ## D4, again, and structurally
 *
 * `docs/research/12-edge-hypothesis-critique.md` **D4** rules out return-only
 * comparison against a risk-targeted stream, and it binds the outside benchmarks
 * exactly as hard as it binds the arms — CLAUDE.md: *"outside benchmarks report
 * return **and** drawdown together."* So `max_drawdown_pct` is REQUIRED on
 * `OutsideBenchmarkPerformance`, there is no view of a benchmark on this module
 * that omits it, and the persisted columns are `NOT NULL`. A caller that wants
 * the return alone has to construct a drawdown it then discards.
 */

/**
 * The outside benchmarks this system measures. A closed union rather than a
 * free string: #636 settled WHICH benchmarks (SPY and 60/40) and #981's
 * non-goals rule out reopening it, so a new member is a decision, not a typo.
 * The persisted table carries the matching `CHECK` constraint for the same
 * reason — an unconstrained key is how a misspelling becomes a silent third
 * series in the dashboard's trend.
 */
export const OUTSIDE_BENCHMARKS = ['spy', 'sixty_forty'] as const;

export type OutsideBenchmarkId = (typeof OUTSIDE_BENCHMARKS)[number];

/**
 * One leg of a benchmark's composition: an instrument and its fixed weight.
 *
 * `sixty_forty` is a **daily-rebalanced fixed-weight** blend, not a
 * buy-and-hold of two sleeves left to drift. Over a 30-day window the two
 * differ, and a reader will assume whichever construction they are used to —
 * so the choice is stated here, in the spec, and on the panel. Daily rebalancing
 * is what makes "60/40" mean 60/40 on every day of the window rather than only
 * on its first.
 */
export interface BenchmarkLeg {
  instrument: string;
  /** Fraction of the benchmark's notional. All legs must sum to 1. */
  weight: number;
}

/**
 * How each benchmark is built. Exported as data rather than buried in the
 * cycle so the composition is one readable table, and so the spec's prose and
 * the code cannot describe two different blends.
 *
 * **The "40" is AGG** — the iShares Core U.S. Aggregate Bond ETF, the ETF
 * tracking the Bloomberg U.S. Aggregate Bond Index that "60/40" has always
 * meant. It is picked over IEF (7-10y Treasuries only — a duration bet, not the
 * aggregate), BND (the same index, but a second vendor's wrapper with no
 * advantage here) and TLT (20y+, far longer duration than the 60/40 convention).
 * All four were confirmed available on the feed this system already reads; AGG
 * is the one that matches what the benchmark is named after.
 */
export const BENCHMARK_COMPOSITION: Record<OutsideBenchmarkId, readonly BenchmarkLeg[]> = {
  spy: [{ instrument: 'SPY', weight: 1 }],
  sixty_forty: [
    { instrument: 'SPY', weight: 0.6 },
    { instrument: 'AGG', weight: 0.4 },
  ],
};

/** One daily observation of a benchmark leg — the close and when it closed */
export interface BenchmarkObservation {
  close_time: Date;
  close: number;
}

/**
 * One benchmark's risk-adjusted performance over the comparison window.
 *
 * **Both fields are required.** See the module header: that is D4 made
 * structural rather than conventional.
 */
export interface OutsideBenchmarkPerformance {
  benchmark: OutsideBenchmarkId;
  /**
   * The benchmark's return over the window, as a signed fraction of a
   * FULLY-INVESTED notional. NOT `ArmPerformance.return_pct` and deliberately
   * not named like it — see the module header.
   *
   * Not annualised and not compounded to a rate, for the same reason the arms'
   * figure is not: over a soak-length window an annualisation is an
   * extrapolation.
   */
  buy_and_hold_return_pct: number;
  /**
   * The deepest peak-to-trough fall of the benchmark's index over the window,
   * as a POSITIVE fraction. Zero when the index never fell below a prior peak.
   *
   * Computed on the BLENDED index series, never as a blend of the two sleeves'
   * separate drawdowns — those are different numbers and the second one is
   * wrong (two sleeves rarely trough on the same day, so blending their
   * drawdowns overstates the blend's).
   */
  max_drawdown_pct: number;
  /**
   * Daily observations the index was built from, after intersecting the legs'
   * calendars. The count a percentage was computed over, carried for the reason
   * `ArmPerformance.trade_count` is: a return over three observations and a
   * return over three hundred look identical without it.
   */
  observation_count: number;
}

/** One benchmark, measured over the matched control's own window */
export interface OutsideBenchmarkSample {
  /** The FL cycle instant, read through the injected `Clock` */
  computed_at: Date;
  /**
   * The window, copied from the `ArmComparison` this benchmark accompanies —
   * never chosen here. See `runOutsideBenchmarkCycle`.
   */
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
      // Unreachable: `time` comes from the intersection of every leg's own
      // close times, so each leg has this observation by construction. Kept as
      // a `continue` rather than a throw: the narrowing is what `find`'s type
      // requires, and skipping a leg cannot produce a wrong number here since
      // the branch is unreachable
      if (observation === undefined) continue;
      const previous = previousClose.get(entry.leg.instrument) ?? observation.close;
      blendedReturn += entry.leg.weight * (observation.close / previous - 1);
      previousClose.set(entry.leg.instrument, observation.close);
    }

    index *= 1 + blendedReturn;
    if (index > peak) peak = index;
    // Drawdown is RELATIVE to the running peak, not to the seed: a benchmark
    // that doubled and then halved fell 50%, not 0%
    const drawdown = (peak - index) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return { index, maxDrawdown };
}

/**
 * Builds one benchmark's performance from its legs' daily closes.
 *
 * ## The window is an input, not a parameter this file chooses
 *
 * `from`/`to` arrive from the `ArmComparison` that has already been computed
 * this cycle. #636: *"Outside benchmarks computed on approximate windows are
 * not risk-adjusted comparisons, they are noise."* A benchmark measured over
 * its own idea of "the last 30 days" while the arms were measured over theirs
 * is off by a bar boundary at best, and the two are then not comparable at all.
 *
 * ## The anchor, and why the series reaches one bar BEFORE the window
 *
 * The window is half-open at the start (`close_time > from AND <= to`), matching
 * `buildArmComparison`. A trade closing one second after `from` counts for the
 * arms — so the benchmark's return must also cover that first instant, which
 * means the first in-window close has to be measured against the last close AT
 * OR BEFORE `from`. That earlier bar is the ANCHOR: it contributes no
 * observation of its own, it is only the denominator of the window's first
 * daily return. Without it the benchmark would silently measure a shorter
 * period than the arms did, which is the exact defect this construction exists
 * to rule out.
 *
 * ## Missing data is refused, never patched
 *
 * A leg with no anchor, or with fewer than one in-window observation, throws.
 * The cycle above catches that and persists NOTHING for the benchmark — an
 * absent row means "not measured", which the dashboard renders as those words.
 * Interpolating a close, carrying one forward, or defaulting a return to zero
 * would each turn a data outage into a measurement, and a fabricated benchmark
 * is worse than an absent one.
 */
export function buildOutsideBenchmark(input: {
  benchmark: OutsideBenchmarkId;
  /** Each leg's observations, in any order. Keyed by the composition's instrument. */
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

  // Per leg: the anchor close (last at or before `from`) and the in-window
  // closes, keyed by close time so the legs can be intersected below
  const perLeg = input.legs.map(({ leg, observations }) =>
    resolveBenchmarkLeg(input.benchmark, leg, observations, input.from, input.to),
  );

  // The legs are intersected on close time before blending. SPY and AGG share
  // the US equity calendar so this is normally a no-op — but a vendor gap in ONE
  // leg must not silently become a day on which the blend was 60% invested. A
  // day either has every leg's close or it is not a day of this benchmark
  const timeline = commonCloseTimeline(input.benchmark, perLeg);

  // The blended index, seeded at 1 on the anchor. Each step is the
  // weighted sum of the legs' SIMPLE daily returns — which is what
  // "daily-rebalanced fixed weight" means: the weights are restored to
  // BENCHMARK_COMPOSITION every day rather than drifting with performance
  const { index, maxDrawdown } = blendIndexSeries(perLeg, timeline);

  return {
    benchmark: input.benchmark,
    buy_and_hold_return_pct: index - 1,
    max_drawdown_pct: maxDrawdown,
    observation_count: timeline.length,
  };
}
