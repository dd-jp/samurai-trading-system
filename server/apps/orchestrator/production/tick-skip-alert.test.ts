/**
 * #1084 — the tick-skip escalation threshold and throttle.
 *
 * Tested on its own rather than only through `startTickLoop` because the
 * failure modes here are about SEQUENCES of ticks and boundary fractions,
 * and reproducing those through the full tick loop would test the fixture
 * rather than the rule — same reasoning as `trader-diagnostic-alert.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LogEntry, Logger } from '../../../shared/index.js';
import {
  ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS,
  ALERT_REPEAT_EVERY_DEGRADED_TICKS,
  isMateriallyDegraded,
  reportTickSkip,
  TICK_SKIP_ALERT_FRACTION,
  TICK_SKIP_ALERT_MIN_INSTRUMENTS,
  type TickSkipAlert,
  type TickSkipAlertChannel,
  TickSkipThrottle,
} from './tick-skip-alert.js';

function capturingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

function recordingChannel(): TickSkipAlertChannel & { alerts: TickSkipAlert[] } {
  const alerts: TickSkipAlert[] = [];
  return {
    alerts,
    postTickSkipAlert: async (alert) => {
      alerts.push(alert);
    },
  };
}

describe('isMateriallyDegraded', () => {
  // The six measurements #1084 itself quotes from a real paper-soak session
  it.each([
    [2, 20, false],
    [1, 20, false],
    [3, 20, false],
    [7, 20, false],
    [11, 20, true],
    [15, 20, true],
  ])('skipped=%i planned=%i -> degraded=%s', (skipped, planned, expected) => {
    expect(isMateriallyDegraded(skipped, planned)).toBe(expected);
  });

  it('stays quiet below the floor even at 100% of a small plan', () => {
    // 2 of 4 is the exact fraction (50%) that would alert on a 20-instrument
    // plan, but on a small plan it is still just two ordinary slow debates —
    // the case #1084's own AC says must stay quiet
    expect(isMateriallyDegraded(2, 4)).toBe(false);
    expect(isMateriallyDegraded(1, 1)).toBe(false);
  });

  it('alerts at exactly the floor when it is also at least half the plan', () => {
    expect(isMateriallyDegraded(3, 4)).toBe(true);
    expect(
      isMateriallyDegraded(TICK_SKIP_ALERT_MIN_INSTRUMENTS, TICK_SKIP_ALERT_MIN_INSTRUMENTS),
    ).toBe(true);
  });

  it('is false for an empty plan — nothing was skipped, nothing was planned', () => {
    expect(isMateriallyDegraded(0, 0)).toBe(false);
  });

  it('is inclusive at the fraction boundary on a plan well above the floor', () => {
    // A plan large enough that TICK_SKIP_ALERT_MIN_INSTRUMENTS is not the
    // binding constraint — this pins the `>=` in `isMateriallyDegraded`
    // itself, not the floor. Exactly half fires; one below does not.
    expect(isMateriallyDegraded(10, 20)).toBe(true);
    expect(isMateriallyDegraded(9, 20)).toBe(false);
  });

  it('the fraction constant is what the module doc claims', () => {
    expect(TICK_SKIP_ALERT_FRACTION).toBe(0.5);
    expect(TICK_SKIP_ALERT_MIN_INSTRUMENTS).toBe(3);
  });
});

describe('TickSkipThrottle', () => {
  it('alerts on the first degraded tick', () => {
    expect(ALERT_AFTER_CONSECUTIVE_DEGRADED_TICKS).toBe(1);
    const throttle = new TickSkipThrottle();
    const result = throttle.observe(true);
    expect(result).toEqual({ alert: true, consecutive: 1 });
  });

  it('does not re-alert on every consecutive degraded tick', () => {
    const throttle = new TickSkipThrottle();
    throttle.observe(true);
    for (let i = 2; i < ALERT_REPEAT_EVERY_DEGRADED_TICKS + 1; i += 1) {
      const result = throttle.observe(true);
      expect(result.alert).toBe(false);
      expect(result.consecutive).toBe(i);
    }
  });

  it('repeats the alert every 8th consecutive degraded tick', () => {
    const throttle = new TickSkipThrottle();
    const alerted: number[] = [];
    for (let i = 1; i <= 17; i += 1) {
      const result = throttle.observe(true);
      if (result.alert) alerted.push(result.consecutive);
    }
    // 1 (threshold), then every 8th after: 9, 17
    expect(alerted).toEqual([1, 9, 17]);
  });

  it('a single non-degraded tick clears the run', () => {
    const throttle = new TickSkipThrottle();
    throttle.observe(true);
    throttle.observe(true);
    throttle.observe(true);
    const clean = throttle.observe(false);
    expect(clean).toEqual({ alert: false, consecutive: 0 });

    // The run has to start over, not resume: the very next degraded tick
    // reads as consecutive=1 again, and alerts again
    const result = throttle.observe(true);
    expect(result).toEqual({ alert: true, consecutive: 1 });
  });
});

describe('reportTickSkip', () => {
  it('posts to the channel with the instrument names and consecutive count', async () => {
    const throttle = new TickSkipThrottle();
    const channel = recordingChannel();
    const { logger } = capturingLogger();
    const reportedAt = new Date('2026-09-04T10:00:00Z');

    await reportTickSkip(throttle, channel, logger, {
      skipped: ['A', 'B', 'C'],
      planned: 4,
      reportedAt,
    });

    expect(channel.alerts).toEqual([
      {
        skipped: 3,
        planned: 4,
        skipped_instruments: ['A', 'B', 'C'],
        consecutive_ticks: 1,
        reported_at: reportedAt,
      },
    ]);
  });

  it('does not post when the tick is not materially degraded', async () => {
    const throttle = new TickSkipThrottle();
    const channel = recordingChannel();

    await reportTickSkip(throttle, channel, undefined, {
      skipped: ['A'],
      planned: 4,
      reportedAt: new Date(),
    });

    expect(channel.alerts).toHaveLength(0);
  });

  it('does not post on a degraded tick that has not yet reached the repeat boundary', async () => {
    const throttle = new TickSkipThrottle();
    const channel = recordingChannel();
    const params = { skipped: ['A', 'B', 'C'], planned: 4, reportedAt: new Date() };

    await reportTickSkip(throttle, channel, undefined, params);
    await reportTickSkip(throttle, channel, undefined, params);

    expect(channel.alerts).toHaveLength(1);
  });

  it('still advances the throttle when no channel is injected (log-only-without-default caller)', async () => {
    const throttle = new TickSkipThrottle();
    const params = { skipped: ['A', 'B', 'C'], planned: 4, reportedAt: new Date() };

    await reportTickSkip(throttle, undefined, undefined, params);
    // If the throttle had not advanced, this second call would also read as
    // consecutive=1 forever and never reach the repeat boundary correctly
    const channel = recordingChannel();
    for (let i = 0; i < ALERT_REPEAT_EVERY_DEGRADED_TICKS - 1; i += 1) {
      await reportTickSkip(throttle, channel, undefined, params);
    }
    await reportTickSkip(throttle, channel, undefined, params);
    // Called once the throttle reaches consecutive=9 (1 + 8), not before
    expect(channel.alerts).toHaveLength(1);
    expect(channel.alerts[0]?.consecutive_ticks).toBe(9);
  });

  it('logs at error and swallows a channel failure rather than throwing', async () => {
    const throttle = new TickSkipThrottle();
    const { logger, entries } = capturingLogger();
    const channel: TickSkipAlertChannel = {
      postTickSkipAlert: vi.fn(async () => {
        throw new Error('telegram unreachable');
      }),
    };

    await expect(
      reportTickSkip(throttle, channel, logger, {
        skipped: ['A', 'B', 'C'],
        planned: 4,
        reportedAt: new Date(),
      }),
    ).resolves.toBeUndefined();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.message).toContain('nobody has been told');
  });
});
