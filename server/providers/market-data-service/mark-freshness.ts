import type { Mark } from './types.js';

export const MARK_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export function markAgeMs(mark: Mark, readAt: Date): number {
  return readAt.getTime() - mark.observed_at.getTime();
}

export type MarkFreshness =
  | { status: 'fresh'; age_ms: number }
  | { status: 'stale'; age_ms: number; bound_ms: number }
  | { status: 'ahead'; age_ms: number; tolerance_ms: number };

export function classifyMarkFreshness(mark: Mark, readAt: Date, maxAgeMs: number): MarkFreshness {
  if (!(maxAgeMs > 0)) {
    throw new Error(
      `classifyMarkFreshness: max mark age must be a positive number of milliseconds, got ` +
        `${maxAgeMs}. A non-positive bound would make every mark stale and halt trading ` +
        'entirely; if that is what you want, stop the process rather than configuring a gate ' +
        'to reject forever.',
    );
  }

  const age_ms = markAgeMs(mark, readAt);
  if (age_ms < -MARK_CLOCK_SKEW_TOLERANCE_MS) {
    return { status: 'ahead', age_ms, tolerance_ms: MARK_CLOCK_SKEW_TOLERANCE_MS };
  }
  if (age_ms > maxAgeMs) {
    return { status: 'stale', age_ms, bound_ms: maxAgeMs };
  }
  return { status: 'fresh', age_ms };
}
