/**
 * Wall-clock boundary math for the Feedback Loop's daily cycle (#1110).
 *
 * Pure and clock-agnostic on purpose: the composition root (production.ts)
 * is the only caller that knows about timers, stores, or process restarts.
 * This module answers exactly one question — "what is the boundary `now`
 * falls in, for an interval of this length" — so it can be driven directly
 * with plain `Date`s in a unit test, with no fake timers and no store.
 *
 * DESIGN DECISION — wall-clock boundary, not elapsed interval since boot:
 * boundaries are floor-divided against the Unix epoch, not against process
 * start time. Epoch 0 is itself a UTC midnight, so the default 24h interval
 * produces exact UTC-midnight boundaries with no separate "calendar day"
 * concept to invent. This is what makes consecutive `closed_trades` windows
 * comparable across restarts (#753 / `docs/research/12-edge-hypothesis-
 * critique.md` D4): an interval anchored to boot time gives every restart a
 * different, incomparable phase, while a wall-clock boundary gives the same
 * phase regardless of how many times the process has restarted.
 */

/** The most recently completed boundary at or before `now`. */
export function currentBoundary(now: Date, intervalMs: number): Date {
  if (intervalMs <= 0) {
    throw new Error(`currentBoundary: intervalMs must be positive, got ${intervalMs}`);
  }
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/** The boundary one interval after the one `now` falls in. */
export function nextBoundary(now: Date, intervalMs: number): Date {
  return new Date(currentBoundary(now, intervalMs).getTime() + intervalMs);
}

/**
 * Whether `boundary` has not yet been recorded as completed. `last` is
 * whatever `FeedbackCycleScheduleStore.lastBoundary()` returned — `null`
 * before any cycle has ever run. The single check both `scheduleFeedbackCycle`
 * and its own startup log in production.ts perform, so the two cannot
 * silently disagree about what "due" means (#1110).
 */
export function isBoundaryDue(boundary: Date, last: Date | null): boolean {
  return last === null || boundary.getTime() > last.getTime();
}
