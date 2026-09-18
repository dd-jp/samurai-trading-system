import type { LseRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import { LSE_TABLE_COVERAGE_END } from '../../../providers/market-data-service/index.js';
import {
  civilDateKey,
  LONDON_ZONE,
  toCivilDate,
} from '../../../providers/market-data-service/trading-calendar.js';
import { loggingAlertChannel } from '../alert-catalogue.js';
import type { Logger } from '../types.js';
import type { LseCalendarCoverageAlertChannel } from './lse-calendar-coverage-alert.js';

export const LSE_COVERAGE_ALERT_HORIZON_DAYS = 60;

const CIVIL_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function civilDateKeyToUtcMs(key: string): number {
  const match = CIVIL_DATE_KEY_PATTERN.exec(key);
  if (match === null) {
    throw new Error(`civilDateKeyToUtcMs: '${key}' is not a YYYY-MM-DD civil date key`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function civilDaysBetween(fromKey: string, toKey: string): number {
  return Math.round((civilDateKeyToUtcMs(toKey) - civilDateKeyToUtcMs(fromKey)) / 86_400_000);
}

export interface AssertLseCalendarCoverageOptions {
  now: Date;
  calendar: LseRegularHoursCalendar;
  logger: Logger;
  alertChannel?: LseCalendarCoverageAlertChannel | undefined;
}

export function assertLseCalendarCoverage(options: AssertLseCalendarCoverageOptions): void {
  const { now, calendar, logger } = options;
  const todayKey = civilDateKey(toCivilDate(now, LONDON_ZONE));

  if (!calendar.coversCloseFor(now)) {
    throw new Error(
      `Orchestrator cannot start the live equity leg: today (${todayKey}, London) is past ` +
        `LSE_TABLE_COVERAGE_END (${LSE_TABLE_COVERAGE_END}). LseRegularHoursCalendar's ` +
        'hand-entered LSE_HOLIDAYS/LSE_HALF_DAYS tables (trading-calendar.ts) are unverified ' +
        'past that date — an unmodelled half-day would read as an ordinary 16:30 close and the ' +
        'flatten would fire four hours late, the exact overnight carry ADR-0014 forbids. Extend ' +
        'LSE_HOLIDAYS/LSE_HALF_DAYS (and their LSE_HOLIDAYS_CHECKED_THROUGH/' +
        'LSE_HALF_DAYS_CHECKED_THROUGH dates) against the published UK bank holiday calendar ' +
        'before restarting the live leg — see #1387.',
    );
  }

  const daysRemaining = civilDaysBetween(todayKey, LSE_TABLE_COVERAGE_END);
  if (daysRemaining >= 0 && daysRemaining <= LSE_COVERAGE_ALERT_HORIZON_DAYS) {
    const alertChannel =
      options.alertChannel ?? loggingAlertChannel('lseCalendarCoverageAlerts', logger);
    alertChannel.postLseCalendarCoverageAlert({
      coverage_end: LSE_TABLE_COVERAGE_END,
      days_remaining: daysRemaining,
      reported_at: now,
    });
  }
}
