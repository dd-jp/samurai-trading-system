import { describeThrownSafely } from '../../shared/index.js';
import type { DebateAnalystFailure } from './debate-logger.js';
import type { AnalystView, Direction } from './types.js';

const DIRECTIONS: Direction[] = ['bullish', 'bearish', 'neutral'];

export interface ExpectedAnalyst {
  analyst_id: string;
  analyst_type: string;
  response: Promise<AnalystView>;
}

export interface AnalystCollectionResult {
  quorum_met: boolean;
  views: AnalystView[];
  failures: DebateAnalystFailure[];
  expected_count: number;
}

type RaceOutcome =
  | { analyst_id: string; analyst_type: string; status: 'settled'; view: AnalystView }
  | { analyst_id: string; analyst_type: string; status: 'error'; reason: string }
  | { analyst_id: string; analyst_type: string; status: 'timeout' };

function isDirection(value: unknown): value is Direction {
  return typeof value === 'string' && (DIRECTIONS as string[]).includes(value);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat sequence of independent field checks, each naming the one field it rejects; splitting them into sub-functions would scatter one validation contract across several call sites for no gain in readability.
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

function raceWithTimeout(expected: ExpectedAnalyst, timeoutMs: number): Promise<RaceOutcome> {
  const { analyst_id, analyst_type } = expected;

  const settled: Promise<RaceOutcome> = expected.response.then(
    (view): RaceOutcome => ({ analyst_id, analyst_type, status: 'settled', view }),
    (error): RaceOutcome => ({
      analyst_id,
      analyst_type,
      status: 'error',
      reason: describeThrownSafely(error),
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<RaceOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ analyst_id, analyst_type, status: 'timeout' }), timeoutMs);
  });

  return Promise.race([settled, timedOut]).finally(() => clearTimeout(timer));
}

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
