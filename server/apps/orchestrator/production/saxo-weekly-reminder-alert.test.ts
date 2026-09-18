import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTokenFile } from '../../../pipeline/execution/adapters/saxo-token-file.js';
import { recordingLogger } from '../../../shared/recording-logger.js';
import type {
  SaxoWeeklyReminderAlert,
  SaxoWeeklyReminderAlertChannel,
  SaxoWeeklyReminderTimers,
} from './saxo-weekly-reminder-alert.js';
import { nextWeeklySaxoReminderInstant, SaxoWeeklyReminder } from './saxo-weekly-reminder-alert.js';

function movableClock(start: number): { now: () => Date; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

interface ScheduledCall {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
}

function fakeTimers(): { timers: SaxoWeeklyReminderTimers; scheduled: ScheduledCall[] } {
  const scheduled: ScheduledCall[] = [];
  return {
    scheduled,
    timers: {
      set(callback, delayMs) {
        scheduled.push({ callback, delayMs, cleared: false });
        return scheduled.length - 1;
      },
      clear(handle) {
        const entry = scheduled[handle as number];
        if (entry !== undefined) entry.cleared = true;
      },
    },
  };
}

function recordingChannel(): SaxoWeeklyReminderAlertChannel & {
  alerts: SaxoWeeklyReminderAlert[];
} {
  const alerts: SaxoWeeklyReminderAlert[] = [];
  return {
    alerts,
    postSaxoWeeklyReminderAlert: async (alert) => {
      alerts.push(alert);
    },
  };
}

describe('nextWeeklySaxoReminderInstant', () => {
  it('from a midweek instant, returns the upcoming Sunday at 18:00 London', () => {
    const after = new Date('2026-09-16T12:00:00.000Z');
    expect(nextWeeklySaxoReminderInstant(after).toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });

  it('from earlier the same Sunday, returns that Sunday at 18:00 London', () => {
    const after = new Date('2026-09-20T06:00:00.000Z');
    expect(nextWeeklySaxoReminderInstant(after).toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });

  it('from exactly the fire instant, rolls over to the FOLLOWING Sunday, not the same one', () => {
    const firedAt = new Date('2026-09-20T17:00:00.000Z');
    expect(nextWeeklySaxoReminderInstant(firedAt).toISOString()).toBe('2026-09-27T17:00:00.000Z');
  });

  it('from just after the fire instant, still rolls over to the following Sunday', () => {
    const after = new Date('2026-09-20T17:00:00.001Z');
    expect(nextWeeklySaxoReminderInstant(after).toISOString()).toBe('2026-09-27T17:00:00.000Z');
  });

  it('crosses the GMT->BST spring-forward transition (2026-03-29) landing on the new offset', () => {
    const after = new Date('2026-03-22T20:00:00.000Z');
    expect(nextWeeklySaxoReminderInstant(after).toISOString()).toBe('2026-03-29T17:00:00.000Z');
  });

  it('crosses the BST->GMT fall-back transition (2026-10-25) landing on the new offset', () => {
    const after = new Date('2026-10-18T20:00:00.000Z');
    expect(nextWeeklySaxoReminderInstant(after).toISOString()).toBe('2026-10-25T18:00:00.000Z');
  });
});

describe('SaxoWeeklyReminder', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'saxo-weekly-reminder-'));
    tokenPath = join(dir, 'sim.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function build(startMs: number) {
    const clock = movableClock(startMs);
    const { timers, scheduled } = fakeTimers();
    const channel = recordingChannel();
    const logger = recordingLogger();
    const reminder = new SaxoWeeklyReminder({
      environment: 'sim',
      tokenPath,
      channel,
      logger,
      clock,
      timers,
    });
    return { reminder, clock, scheduled, channel, logger };
  }

  it('arms exactly one timer, delayed to the next Sunday 18:00 London', () => {
    const start = Date.parse('2026-09-16T12:00:00.000Z');
    const { reminder, scheduled } = build(start);
    reminder.start();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(Date.parse('2026-09-20T17:00:00.000Z') - start);
  });

  it('fires with the environment and the loggedInAt read fresh from disk', async () => {
    writeTokenFile(tokenPath, {
      environment: 'sim',
      accessToken: 'access-fixture',
      refreshToken: 'refresh-fixture',
      accessTokenExpiresAt: '2026-09-20T18:00:00.000Z',
      refreshTokenExpiresAt: '2026-09-27T18:00:00.000Z',
      obtainedAt: '2026-09-16T12:00:00.000Z',
      loggedInAt: '2026-09-14T09:00:00.000Z',
    });
    const { reminder, scheduled, channel } = build(Date.parse('2026-09-16T12:00:00.000Z'));
    reminder.start();

    expect(scheduled).toHaveLength(1);
    scheduled[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.alerts).toEqual([
      {
        environment: 'sim',
        last_logged_in_at: '2026-09-14T09:00:00.000Z',
        reported_at: new Date('2026-09-16T12:00:00.000Z'),
      },
    ]);
  });

  it('reports last_logged_in_at absent when no session file has been saved', async () => {
    const { reminder, scheduled, channel } = build(Date.parse('2026-09-16T12:00:00.000Z'));
    reminder.start();
    scheduled[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.alerts).toHaveLength(1);
    expect(channel.alerts[0]?.last_logged_in_at).toBeUndefined();
  });

  it('re-arms after firing — a NEW delay computed from the post-fire clock, not a fixed interval', async () => {
    const { reminder, clock, scheduled } = build(Date.parse('2026-09-16T12:00:00.000Z'));
    reminder.start();
    expect(scheduled).toHaveLength(1);

    clock.advance(scheduled[0]?.delayMs ?? 0);
    scheduled[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]?.cleared).toBe(false);
    expect(scheduled[1]?.delayMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('logs and still re-arms when the channel send fails — a lost reminder must not stop future ones', async () => {
    const clock = movableClock(Date.parse('2026-09-16T12:00:00.000Z'));
    const { timers, scheduled } = fakeTimers();
    const logger = recordingLogger();
    const reminder = new SaxoWeeklyReminder({
      environment: 'sim',
      tokenPath,
      channel: {
        postSaxoWeeklyReminderAlert: async () => {
          throw new Error('telegram 502');
        },
      },
      logger,
      clock,
      timers,
    });
    reminder.start();
    scheduled[0]?.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.entries.map((entry) => entry.event)).toContain(
      'saxo_weekly_reminder_send_failed',
    );
    expect(scheduled).toHaveLength(2);
  });

  it('stop() clears the armed timer and firing does not re-arm afterwards', () => {
    const { reminder, scheduled } = build(Date.parse('2026-09-16T12:00:00.000Z'));
    reminder.start();
    expect(scheduled).toHaveLength(1);

    reminder.stop();

    expect(scheduled[0]?.cleared).toBe(true);
    scheduled[0]?.callback();
    expect(scheduled).toHaveLength(1);
  });
});
