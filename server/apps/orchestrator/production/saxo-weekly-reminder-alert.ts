/**
 * The weekly Saxo re-login reminder (#1524).
 *
 * Saxo's own OAuth guidance (openapi.help.saxo): a retail client cannot
 * authenticate headlessly, and a manually-logged-in session "can maintain
 * active sessions for extended periods" — but Saxo still recommends
 * authenticating at least once weekly, typically before Monday market open,
 * because a session may occasionally be terminated when a disclaimer update
 * requires re-confirmation. Nothing about `SaxoTokenRefresher`'s rotation
 * (#1523) satisfies that recommendation — a rotated refresh token is not a
 * fresh manual login — so this is a SEPARATE, self-scheduled nudge with no
 * per-request trigger to hang off, unlike the immediate loss alert
 * (`SaxoSessionLostAlertChannel`, saxo-token-source.ts).
 *
 * ## Why Sunday 18:00 London, and why self-scheduling
 *
 * "Sunday evening" per the ticket, chosen at 18:00 so a whole day's slack
 * sits between the reminder and Monday's LSE open — comfortably inside the
 * evening the ticket names and nowhere near a DST transition hour (both UK
 * clock changes land at 01:00/02:00 on a Sunday, six hours off). A FIXED
 * `setInterval` of `7 * 24h` would drift by an hour across every BST/GMT
 * transition — `daily-cycle.ts`'s known limitation, acceptable there because
 * a day's re-phasing is absorbed by its window, but wrong here: this alert's
 * whole job is to land on a specific London wall-clock instant. So the timer
 * is re-armed after every fire, computed fresh off `wallClockToInstant`
 * (trading-calendar.ts) — the same DST-safe fixpoint `LseRegularHoursCalendar`
 * uses for session boundaries — rather than a naive millisecond multiple.
 *
 * ## Why the reminder reads the token file itself, not the running refresher
 *
 * `SaxoTokenRefresher` loads the saved session ONCE, at `load()`, and never
 * re-reads the file afterwards except through its own rotations — an
 * operator running `yarn saxo:login` again while the orchestrator process is
 * still up does not reach a `SaxoTokenRefresher` that has already gone
 * `lost` (recovering that requires a restart, which is #1523's territory,
 * not this ticket's). Reading `readTokenFile(tokenPath)` fresh on every fire
 * decouples "what does the reminder report" from "what bearer is this
 * process currently using": the former is always the truth on disk, whether
 * or not a running process has picked it up yet.
 */

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

/** One weekly nudge, at the scheduled Sunday-evening instant */
export interface SaxoWeeklyReminderAlert {
  environment: SaxoTradingEnvironment;
  /**
   * The saved session's `loggedInAt`, read fresh from disk at fire time.
   * Absent when there is no saved session, the file predates #1524, or it
   * could not be read — see this module's doc for why a stale in-memory
   * refresher is never the source instead.
   */
  last_logged_in_at?: string;
  reported_at: Date;
}

/**
 * Declared beside `SaxoWeeklyReminderAlert`, like every other alert type in
 * this directory. The catalogue's `saxoWeeklyReminderAlerts` entry
 * (alert-catalogue.ts) implements it.
 */
export interface SaxoWeeklyReminderAlertChannel {
  postSaxoWeeklyReminderAlert(alert: SaxoWeeklyReminderAlert): Promise<void>;
}

export interface SaxoWeeklyReminderTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/** `unref()` for `Heartbeat.start`'s reason: this timer must never by itself keep the process alive */
const DEFAULT_TIMERS: SaxoWeeklyReminderTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** 18:00 — see the module doc's "Why Sunday 18:00" section */
export const SAXO_WEEKLY_REMINDER_LONDON_MINUTES = 18 * 60;

/** `Date.prototype.getUTCDay()`'s numbering (0 = Sunday) — a civil date's weekday is zone-independent */
function civilWeekday(date: ZonedCivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addCivilDays(date: ZonedCivilDate, days: number): ZonedCivilDate {
  let result = date;
  for (let i = 0; i < days; i += 1) result = nextCivilDay(result);
  return result;
}

/**
 * The next Sunday `SAXO_WEEKLY_REMINDER_LONDON_MINUTES` strictly after
 * `after`, DST included. Exported for its own tests: a scheduling function is
 * far cheaper to check exhaustively across a BST/GMT transition than the
 * class that arms a real timer off it.
 */
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

/** Reads `loggedInAt` fresh from disk; a missing or unreadable file reports as unknown rather than failing the reminder */
function readLastLoggedInAt(tokenPath: string): string | undefined {
  try {
    return readTokenFile(tokenPath)?.loggedInAt;
  } catch {
    return undefined;
  }
}

export interface SaxoWeeklyReminderDeps {
  environment: SaxoTradingEnvironment;
  /** `tokenFilePath(environment)` in production — overridable for tests, `buildSaxoTokenSource`'s reason */
  tokenPath: string;
  channel: SaxoWeeklyReminderAlertChannel;
  logger: Logger;
  clock?: Clock;
  timers?: SaxoWeeklyReminderTimers;
}

/**
 * Self-scheduling weekly reminder. `start()`/`stop()` mirror `Heartbeat`'s
 * shape; unlike `Heartbeat` the delay is recomputed on every fire rather than
 * fixed, for the DST reason in the module doc.
 */
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

  /** Never throws — a delivery failure is logged, and the next week's reminder is armed regardless */
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
