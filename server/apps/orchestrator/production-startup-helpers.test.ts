import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEDBACK_INTERVAL_MS } from './production/defaults.js';
import { feedbackScheduleStartupMessage, resolveFeedbackIntervalMs } from './production.js';

describe('resolveFeedbackIntervalMs', () => {
  it('defaults an unset interval to the daily interval', () => {
    expect(resolveFeedbackIntervalMs(undefined)).toBe(DEFAULT_FEEDBACK_INTERVAL_MS);
  });

  it('keeps a positive interval', () => {
    expect(resolveFeedbackIntervalMs(1)).toBe(1);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (intervalMs) => {
    expect(() => resolveFeedbackIntervalMs(intervalMs)).toThrow(
      `FeedbackCycleConfig.intervalMs must be positive, got ${intervalMs}`,
    );
  });
});

describe('feedbackScheduleStartupMessage', () => {
  const next = new Date('2026-07-16T00:00:00.000Z');

  it('reports an unknown schedule when the store read failed, whatever the due flag', () => {
    expect(feedbackScheduleStartupMessage(true, true, next)).toBe(
      'daily feedback cycle schedule is UNKNOWN — the store could not be read at startup, so no ' +
        "catch-up decision was made here; runIfDue's own guarded read decides on its first pass, " +
        'next boundary at 2026-07-16T00:00:00.000Z (#1110)',
    );
  });

  it('reports a catch-up when the boundary is due', () => {
    expect(feedbackScheduleStartupMessage(false, true, next)).toBe(
      'daily feedback cycle is due now — catching up on the current boundary, then resuming the ' +
        'normal schedule, next due at 2026-07-16T00:00:00.000Z (#1110)',
    );
  });

  it('reports the next due time when the boundary already ran', () => {
    expect(feedbackScheduleStartupMessage(false, false, next)).toBe(
      'daily feedback cycle already ran for the current boundary — next due at ' +
        '2026-07-16T00:00:00.000Z',
    );
  });
});
