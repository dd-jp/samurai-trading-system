
import type { SaxoTradingEnvironment } from '../../../pipeline/execution/index.js';
import { readTokenFile } from '../../../pipeline/execution/index.js';
import type { ZonedCivilDate } from '../../../providers/market-data-service/index.js';
import {
  LONDON_ZONE,
  nextCivilDay,
  toCivilDate,
  wallClockToInstant,
} from '../../../providers/market-data-service/index.js';
import type { Clock } from '../../../shared/index.js';
import { describeThrownSafely, SystemClock } from '../../../shared/index.js';
import type { Logger } from '../types.js';

export interface SaxoWeeklyReminderAlert {
  environment: SaxoTradingEnvironment;
  last_logged_in_at?: string;
  reported_at: Date;
}

export interface SaxoWeeklyReminderAlertChannel {
  postSaxoWeeklyReminderAlert(alert: SaxoWeeklyReminderAlert): Promise<void>;
}

export interface SaxoWeeklyReminderTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: SaxoWeeklyReminderTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const SAXO_WEEKLY_REMINDER_LONDON_MINUTES = 18 * 60;

function civilWeekday(date: ZonedCivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addCivilDays(date: ZonedCivilDate, days: number): ZonedCivilDate {
  let result = date;
  for (let i = 0; i < days; i += 1) result = nextCivilDay(result);
  return result;
}

export function nextWeeklySaxoReminderInstant(after: Date): Date {
  const civilNow = toCivilDate(after, LONDON_ZONE);
  const daysUntilSunday = (7 - civilWeekday(civilNow)) % 7;
  let candidateDate = addCivilDays(civilNow, daysUntilSunday);
  let candidateInstant = wallClockToInstant(
    candidateDate,
    SAXO_WEEKLY_REMINDER_LONDON_MINUTES,
    LONDON_ZONE,
  );
  if (candidateInstant.getTime() <= after.getTime()) {
    candidateDate = addCivilDays(candidateDate, 7);
    candidateInstant = wallClockToInstant(
      candidateDate,
      SAXO_WEEKLY_REMINDER_LONDON_MINUTES,
      LONDON_ZONE,
    );
  }
  return candidateInstant;
}

function readLastLoggedInAt(tokenPath: string): string | undefined {
  try {
    return readTokenFile(tokenPath)?.loggedInAt;
  } catch {
    return undefined;
  }
}

export interface SaxoWeeklyReminderDeps {
  environment: SaxoTradingEnvironment;
  tokenPath: string;
  channel: SaxoWeeklyReminderAlertChannel;
  logger: Logger;
  clock?: Clock;
  timers?: SaxoWeeklyReminderTimers;
}

export class SaxoWeeklyReminder {
  private readonly clock: Clock;
  private readonly timers: SaxoWeeklyReminderTimers;
  private handle: unknown;
  private stopped = false;

  constructor(private readonly deps: SaxoWeeklyReminderDeps) {
    this.clock = deps.clock ?? new SystemClock();
    this.timers = deps.timers ?? DEFAULT_TIMERS;
  }

  start(): void {
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) {
      this.timers.clear(this.handle);
      this.handle = undefined;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const next = nextWeeklySaxoReminderInstant(now);
    const delayMs = Math.max(0, next.getTime() - now.getTime());
    this.handle = this.timers.set(() => {
      void this.fire();
    }, delayMs);
  }

  private async fire(): Promise<void> {
    const lastLoggedInAt = readLastLoggedInAt(this.deps.tokenPath);
    const alert: SaxoWeeklyReminderAlert = {
      environment: this.deps.environment,
      ...(lastLoggedInAt === undefined ? {} : { last_logged_in_at: lastLoggedInAt }),
      reported_at: this.clock.now(),
    };
    try {
      await this.deps.channel.postSaxoWeeklyReminderAlert(alert);
    } catch (error) {
      this.deps.logger.log({
        trace_id: 'saxo-weekly-reminder',
        stage: 'orchestrator',
        event: 'saxo_weekly_reminder_send_failed',
        level: 'error',
        message: `Saxo ${this.deps.environment} weekly re-login reminder failed to send`,
        payload: { environment: this.deps.environment, error: describeThrownSafely(error) },
      });
    }
    this.scheduleNext();
  }
}
