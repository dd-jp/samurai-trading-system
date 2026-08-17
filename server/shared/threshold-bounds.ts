/**
 * The in-code clamp on the kill-line and breaker thresholds (#638, GAP-6 /
 * CV-15).
 *
 * ## Why this file exists
 *
 * [ADR-0007](../../docs/adr/0007-fully-automatic-execution.md) removed the
 * human from the trade path and said "the breakers are now the only stop".
 * [ADR-0013](../../docs/adr/0013-no-human-gate-anywhere.md) went further:
 * nothing re-arms by hand and nothing gates a loosening, so **the numeric
 * thresholds are the only stop**, and — until this module — a config edit was
 * the entire distance between the running system and an arbitrary risk limit.
 * ADR-0013 names the clamp "a precondition of this ADR being safe, not a
 * tidiness item".
 *
 * The threat model is NOT an operator fat-fingering a file. It is the Feedback
 * Loop walking a dial by itself: ADR-0013 Decision 2 keeps the static hard
 * bounds precisely because there is no longer a person between a proposal and
 * its application, and requires every dial change to be "rejected in code if
 * it would cross a hard bound". So the bounds live here, in one table, and
 * every path that can put a number into force consults this table — boot-time
 * construction, the tuning store's write, and the Risk Manager's live read.
 *
 * ## Reject, never coerce
 *
 * A silently clamped value reads as accepted: the operator believes a limit is
 * in force that is not, which is this repo's documented dominant defect shape
 * (a control that reads as present while doing nothing). So every entry point
 * here THROWS. At boot that refuses the process. On the tuning-store write it
 * refuses the write and leaves the prior in-bound value standing. On the live
 * read it refuses to produce a risk decision at all: that throw is raised
 * inside a tick, so `tick-loop.ts`'s per-instrument catch (#507) takes it —
 * the instrument pass ABORTS, no order is placed, an `error` log line and an
 * `audit_log` row with `decision: 'crashed'` are written, and the loop
 * continues with the next instrument. It does NOT reach
 * `installFaultHandlers` and it does NOT raise an alert. That is fail-closed
 * on trading — no order can pass a Risk stage that threw — but it is not a
 * halt, so the boot-time and write-door checks are what actually keep a
 * mis-set line out of a running process. Alerting on a crashed instrument is
 * a separate gap, adjacent to #639.
 *
 * ## Names
 *
 * Keys are the flat `risk_thresholds`-table convention (`risk-thresholds.ts`),
 * not the nested config path, so one table serves the static config objects
 * AND any row the Feedback Loop may one day be allowed to write under the same
 * name. That is what makes the clamp survive a future widening of
 * `RISK_THRESHOLD_KEYS`: the bound is attached to the THRESHOLD, not to the
 * one call site that happens to read it today.
 */

/**
 * One research-mandated bright line, as an inclusive interval.
 *
 * `source` is not decoration — it is the answer to "who says so", and a bound
 * with no citable source is an engineering choice that must say so in as many
 * words (see `daily_loss_pct` and `max_drawdown_pct`'s ceiling below).
 */
export interface ThresholdBound {
  /** Lowest permitted value, inclusive. Absent means unbounded below. */
  readonly min?: number;
  /** Highest permitted value, inclusive. Absent means unbounded above. */
  readonly max?: number;
  /** Where the line comes from, quoted or cited. */
  readonly source: string;
}

/**
 * ADR-0018 D5's measured drawdown envelope at today's sizing: 23.1% for a 3x
 * index ETP, 26.2% for a 3x single-stock ETP. Drift-removed with zero edge
 * assumed, so it binds regardless of how good the signal turns out to be. The
 * wider of the two is the one every drawdown bound below is sited against —
 * using the narrower would let a breaker be configured to fire on the
 * single-stock leg working exactly as designed.
 */
const MEASURED_DRAWDOWN_ENVELOPE = 0.262;

/**
 * Every guarded threshold, keyed by its flat `risk_thresholds` name.
 *
 * What is here, and what deliberately is not, is recorded once in
 * `docs/specs/cross-spec-contracts.md` ("Threshold clamps") so the question
 * stops being re-litigated per spec.
 */
export const GUARDED_THRESHOLD_BOUNDS = {
  /**
   * The hard drawdown breaker's trip. A CEILING ONLY, and the missing floor is
   * a decision rather than an oversight.
   *
   * Ceiling: ENGINEERING CHOICE, not research. CONTEXT.md:68 records a ~20-25%
   * drawdown tolerance and the shipped trip is 0.30, set above ADR-0018's
   * measured envelope rather than inside the tolerance. 0.35 is one tuning
   * step past the shipped value; beyond it the breaker no longer bounds loss
   * anywhere near the recorded tolerance and reads as a control while being
   * none. The `0.95` / `0.90` pair that `CircuitBreakers`' existing width
   * check happily accepts is exactly what this refuses.
   *
   * No floor, deliberately (see cross-spec-contracts.md). #638 asks for "a
   * fixed maximum" and a floor is a different control: a trip set too LOW
   * halts new entries early and never blocks an exit (risk-manager-spec.md
   * ":15"), so it cannot increase loss — it is an availability failure, which
   * is #634/ADR-0013's subject, not this one's. Siting the trip against the
   * measured envelope stays a spec-level obligation.
   */
  max_drawdown_pct: {
    max: 0.35,
    source:
      'CONTEXT.md:68 ~20-25% drawdown tolerance; ceiling an engineering choice recorded in cross-spec-contracts.md',
  },
  /**
   * The hysteresis band's lower edge. Capped at the envelope so the book
   * resumes only once it is back inside the drawdown it was sized for; a
   * re-arm edge configured ABOVE the envelope would clear the halt while the
   * book was still outside its own sizing assumption.
   *
   * No floor: a lower re-arm edge only keeps the halt in force longer, which
   * is the safe direction, and `CircuitBreakers` already refuses a band of
   * zero or negative width.
   */
  recovery_drawdown_pct: {
    max: MEASURED_DRAWDOWN_ENVELOPE,
    source: 'ADR-0018 D5 measured envelope; risk-manager-spec.md hysteresis band',
  },
  /**
   * The portfolio-level daily-loss breaker, and its two per-class tiers.
   *
   * ENGINEERING CHOICE, recorded as one: no document states a daily-loss
   * number. The ceiling is derived from the drawdown clamp above rather than
   * invented free-hand — at 0.10 the daily tier can fire at least three
   * sessions before the 0.30 drawdown trip, which is what makes it an
   * independent control instead of a second name for the same halt.
   */
  daily_loss_pct: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  daily_loss_pct_crypto: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  daily_loss_pct_stocks: {
    max: 0.1,
    source: 'engineering choice, derived from max_drawdown_pct (cross-spec-contracts.md)',
  },
  /**
   * The one hard kill criterion. CONTEXT.md's overfitting note states it as a
   * bright line ("Kill if PBO > 0.05"), the falsification test repeats it
   * ("PBO <= 0.05"), `PBO_REJECT_THRESHOLD` hard-codes it in the validation
   * library, and feedback-loop-spec.md story 13 says it literally. The
   * Feedback Loop's copy of it was the only mutable one.
   */
  max_pbo: {
    max: 0.05,
    source: "CONTEXT.md 'Kill if PBO > 0.05'; feedback-loop-spec.md story 13",
  },
  /**
   * Kill lines in the other direction: LOWERING either one softens the kill,
   * so both are floors.
   */
  min_oos_sharpe: {
    min: 0.5,
    source: "feedback-loop-spec.md story 13 'OOS/paper Sharpe < 0.5'",
  },
  min_deflated_sharpe: {
    min: 0.95,
    source:
      "CONTEXT.md falsification test 'DSR-significant' at the conventional 5% level; feedback-loop-spec.md story 13",
  },
} as const satisfies Readonly<Record<string, ThresholdBound>>;

export type GuardedThresholdName = keyof typeof GUARDED_THRESHOLD_BOUNDS;

/** Every guarded name, for callers that must prove they covered all of them. */
export const GUARDED_THRESHOLD_NAMES = Object.keys(
  GUARDED_THRESHOLD_BOUNDS,
) as readonly GuardedThresholdName[];

export function boundFor(name: string): ThresholdBound | undefined {
  return Object.hasOwn(GUARDED_THRESHOLD_BOUNDS, name)
    ? GUARDED_THRESHOLD_BOUNDS[name as GuardedThresholdName]
    : undefined;
}

/**
 * Thrown, never caught-and-corrected. A distinct class so a caller that wants
 * to report the refusal (rather than die on it) can tell a bound crossing from
 * an unrelated fault — nobody may use it to CONTINUE with the offending value.
 */
export class ThresholdBoundViolationError extends Error {
  constructor(
    readonly threshold: string,
    readonly value: number,
    readonly bound: ThresholdBound,
    readonly where: string,
  ) {
    const limit =
      bound.min !== undefined && value < bound.min
        ? `must be at least ${bound.min}`
        : `must be at most ${bound.max}`;
    super(
      `${where}: risk threshold '${threshold}' is ${value}, which crosses the in-code clamp — it ${limit}. ` +
        `Source: ${bound.source}. ADR-0013 makes these thresholds the only stop left, so the value is REFUSED, not clamped.`,
    );
    this.name = 'ThresholdBoundViolationError';
  }
}

/**
 * Refuses one value. A name with no bound is not an error — most thresholds
 * are legitimately free config, and inventing a bound where no document states
 * one would be a fabricated safety limit.
 *
 * A non-finite value is refused wherever a bound exists, because `NaN`
 * compares false against every limit and would sail through both edges of an
 * interval check.
 */
export function assertThresholdWithinBounds(name: string, value: number, where: string): void {
  const bound = boundFor(name);
  if (bound === undefined) return;

  if (!Number.isFinite(value)) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
  if (bound.min !== undefined && value < bound.min) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
  if (bound.max !== undefined && value > bound.max) {
    throw new ThresholdBoundViolationError(name, value, bound, where);
  }
}

/**
 * Refuses a whole set at once, checking EVERY entry before reporting, so a
 * config with two crossings names both rather than sending the operator round
 * the loop twice. `undefined` entries are skipped: absence is a different
 * failure, owned by the config's own required-field checks.
 */
export function assertThresholdsWithinBounds(
  values: Readonly<Record<string, number | undefined>>,
  where: string,
): void {
  const violations: ThresholdBoundViolationError[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    try {
      assertThresholdWithinBounds(name, value, where);
    } catch (error) {
      if (error instanceof ThresholdBoundViolationError) {
        violations.push(error);
        continue;
      }
      throw error;
    }
  }

  if (violations.length === 1) throw violations[0];
  if (violations.length > 1) {
    throw new Error(violations.map((violation) => violation.message).join('\n'));
  }
}
