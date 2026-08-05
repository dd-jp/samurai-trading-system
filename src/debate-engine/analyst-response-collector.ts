/**
 * Analyst response collection: timeout + majority quorum — see
 * docs/specs/debate-engine-spec.md "Module: Analyst Failure Handling"
 * (ticket #37, blocked by #25 "AnalystView Validation & Quorum
 * Enforcement"). #25 is unimplemented and its acceptance criteria are a
 * strict subset of #37's (same validation + quorum check, minus the
 * timeout), so both are built here rather than leaving #37 with nothing to
 * depend on.
 *
 * Failure modes handled (spec's three): no response (timeout), malformed
 * output (validation failure), and an outright error from the analyst.
 * Every failure is categorized and returned — never thrown — so the caller
 * can log it via `DebateLogger.logAnalystFailure` once a `debate_id` exists
 * (this module runs before that hash can be computed, so it does not log
 * itself).
 */
import type { DebateAnalystFailure } from './debate-logger.js';
import type { AnalystView, Direction } from './types.js';

const DIRECTIONS: Direction[] = ['bullish', 'bearish', 'neutral'];

/** One analyst's in-flight response, keyed for failure reporting if it never settles. */
export interface ExpectedAnalyst {
  analyst_id: string;
  analyst_type: string;
  response: Promise<AnalystView>;
}

export interface AnalystCollectionResult {
  /** True if >=50% of `expected` produced a valid view before the timeout. */
  quorum_met: boolean;
  /** Valid views, sourced from responders. Empty if quorum was not met (abort signal). */
  views: AnalystView[];
  /** Every non-view outcome: timeout, malformed output, or error — reason-tagged. */
  failures: DebateAnalystFailure[];
  /** Size of `expected` — the quorum denominator. */
  expected_count: number;
}

type RaceOutcome =
  | { analyst_id: string; analyst_type: string; status: 'settled'; view: AnalystView }
  | { analyst_id: string; analyst_type: string; status: 'error'; reason: string }
  | { analyst_id: string; analyst_type: string; status: 'timeout' };

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as string[]).includes(value);
}

/**
 * Validates an analyst's response against the `AnalystView` upstream
 * contract (debate-engine-spec.md "Key Interfaces"). Structural check only
 * — no business-rule validation (e.g. confidence calibration) belongs here.
 */
export function validateAnalystView(
  candidate: unknown,
): { valid: true; view: AnalystView } | { valid: false; reason: string } {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'malformed output: not an object' };
  }

  const view = candidate as Partial<AnalystView>;

  if (typeof view.analyst_id !== 'string' || view.analyst_id.length === 0) {
    return { valid: false, reason: 'malformed output: missing or invalid analyst_id' };
  }
  if (typeof view.analyst_type !== 'string' || view.analyst_type.length === 0) {
    return { valid: false, reason: 'malformed output: missing or invalid analyst_type' };
  }
  if (!isDirection(view.direction)) {
    return { valid: false, reason: 'malformed output: missing or invalid direction' };
  }
  if (
    typeof view.confidence !== 'number' ||
    Number.isNaN(view.confidence) ||
    view.confidence < 0 ||
    view.confidence > 1
  ) {
    return { valid: false, reason: 'malformed output: confidence must be a number in [0, 1]' };
  }
  if (!Array.isArray(view.key_points) || !view.key_points.every((p) => typeof p === 'string')) {
    return { valid: false, reason: 'malformed output: key_points must be a string array' };
  }
  if (!(view.timestamp instanceof Date) || Number.isNaN(view.timestamp.getTime())) {
    return { valid: false, reason: 'malformed output: missing or invalid timestamp' };
  }
  if (typeof view.trace_id !== 'string' || view.trace_id.length === 0) {
    return { valid: false, reason: 'malformed output: missing or invalid trace_id' };
  }

  return { valid: true, view: view as AnalystView };
}

/**
 * Races one analyst's response against the shared timeout. Never rejects.
 *
 * NOT CANCELLED, deliberately — checked as part of #347, which fixed the same
 * `Promise.race` + `setTimeout` shape in `latency-budget.ts`. The difference
 * is that there the loser is a chain this code STARTS (`produceResult` ->
 * `runDebate` -> billed LLM calls), so it can be handed an `AbortSignal`;
 * here the loser is `expected.response`, an opaque `Promise<AnalystView>` the
 * CALLER already has in flight before `collectAnalystViews` is entered. This
 * module never issues the call, holds no client, and has nothing to abort —
 * adding a signal parameter would only move the problem to a caller that does
 * not exist yet (`collectAnalystViews` is exported but, as of #347, called by
 * no production code; the Analyst stage that will call it is out of scope
 * here, per debate-engine-spec.md "Out of Scope: Analyst Stage Design").
 * Whether a straggling analyst is even a billed LLM call is that caller's
 * property, not this one's, so the honest move is to leave the seam alone and
 * say why rather than invent a cancellation contract nothing implements.
 *
 * The TIMER, by contrast, was a real and unambiguous leak — one unfired timer
 * per analyst per collection — and is cleared below.
 */
function raceWithTimeout(expected: ExpectedAnalyst, timeoutMs: number): Promise<RaceOutcome> {
  const { analyst_id, analyst_type } = expected;

  const settled: Promise<RaceOutcome> = expected.response.then(
    (view): RaceOutcome => ({ analyst_id, analyst_type, status: 'settled', view }),
    (error): RaceOutcome => ({
      analyst_id,
      analyst_type,
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<RaceOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ analyst_id, analyst_type, status: 'timeout' }), timeoutMs);
  });

  return Promise.race([settled, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Waits up to `timeoutMs` for every expected analyst, validates whatever
 * responds, and enforces majority quorum (debate-engine-spec.md "Handling
 * Strategy"). A straggler that never settles is reported as a timeout
 * failure; the promise itself is left to resolve/reject later and is
 * ignored.
 */
export async function collectAnalystViews(
  expected: ExpectedAnalyst[],
  timeoutMs: number,
): Promise<AnalystCollectionResult> {
  const outcomes = await Promise.all(
    expected.map((analyst) => raceWithTimeout(analyst, timeoutMs)),
  );

  const views: AnalystView[] = [];
  const failures: DebateAnalystFailure[] = [];

  for (const outcome of outcomes) {
    if (outcome.status === 'timeout') {
      failures.push({
        analyst_id: outcome.analyst_id,
        analyst_type: outcome.analyst_type,
        reason: `timeout: no response within ${timeoutMs}ms`,
      });
      continue;
    }
    if (outcome.status === 'error') {
      failures.push({
        analyst_id: outcome.analyst_id,
        analyst_type: outcome.analyst_type,
        reason: outcome.reason,
      });
      continue;
    }

    const validation = validateAnalystView(outcome.view);
    if (!validation.valid) {
      failures.push({
        analyst_id: outcome.analyst_id,
        analyst_type: outcome.analyst_type,
        reason: validation.reason,
      });
      continue;
    }
    views.push(validation.view);
  }

  const expected_count = expected.length;
  const quorum_met = expected_count > 0 && views.length / expected_count >= 0.5;

  return {
    quorum_met,
    views: quorum_met ? views : [],
    failures,
    expected_count,
  };
}
