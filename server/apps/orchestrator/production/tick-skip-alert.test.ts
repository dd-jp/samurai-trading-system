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
    expect(alerted).toEqual([1, 9, 17]);
  });

  it('a single non-degraded tick clears the run', () => {
    const throttle = new TickSkipThrottle();
    throttle.observe(true);
    throttle.observe(true);
    throttle.observe(true);
    const clean = throttle.observe(false);
    expect(clean).toEqual({ alert: false, consecutive: 0 });

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
    const channel = recordingChannel();
    for (let i = 0; i < ALERT_REPEAT_EVERY_DEGRADED_TICKS - 1; i += 1) {
      await reportTickSkip(throttle, channel, undefined, params);
    }
    await reportTickSkip(throttle, channel, undefined, params);
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
