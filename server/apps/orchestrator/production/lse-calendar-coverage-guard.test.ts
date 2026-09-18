import {
  LSE_TABLE_COVERAGE_END,
  LseRegularHoursCalendar,
} from '../../../providers/market-data-service/index.js';
import type { LogEntry, Logger } from '../types.js';
import type { LseCalendarCoverageAlert } from './lse-calendar-coverage-alert.js';
import { assertLseCalendarCoverage } from './lse-calendar-coverage-guard.js';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

describe('assertLseCalendarCoverage delegates the boundary decision to coversCloseFor', () => {
  it('throws when coversCloseFor is false, even for a date on or before LSE_TABLE_COVERAGE_END', () => {
    const calendar = new LseRegularHoursCalendar();
    calendar.coversCloseFor = () => false;

    expect(() =>
      assertLseCalendarCoverage({
        now: new Date('2020-01-06T12:00:00Z'),
        calendar,
        logger: makeLogger(),
      }),
    ).toThrow(/LSE_TABLE_COVERAGE_END/);
  });

  it('does not throw when coversCloseFor is true, even for a date nominally past LSE_TABLE_COVERAGE_END', () => {
    const calendar = new LseRegularHoursCalendar();
    calendar.coversCloseFor = () => true;

    expect(() =>
      assertLseCalendarCoverage({
        now: new Date('2099-01-01T12:00:00Z'),
        calendar,
        logger: makeLogger(),
      }),
    ).not.toThrow();
  });

  it('posts the horizon alert with the real coverage_end and a non-negative days_remaining', () => {
    const calendar = new LseRegularHoursCalendar();
    const posted: LseCalendarCoverageAlert[] = [];
    const now = new Date(
      new Date(`${LSE_TABLE_COVERAGE_END}T12:00:00Z`).getTime() - 30 * 86_400_000,
    );

    assertLseCalendarCoverage({
      now,
      calendar,
      logger: makeLogger(),
      alertChannel: {
        postLseCalendarCoverageAlert: (alert) => {
          posted.push(alert);
        },
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      coverage_end: LSE_TABLE_COVERAGE_END,
      days_remaining: 30,
      reported_at: now,
    });
  });

  it('does not post when coversCloseFor disagrees with LSE_TABLE_COVERAGE_END and the raw comparison would be negative', () => {
    const calendar = new LseRegularHoursCalendar();
    calendar.coversCloseFor = () => true;
    const posted: LseCalendarCoverageAlert[] = [];

    assertLseCalendarCoverage({
      now: new Date('2099-01-01T12:00:00Z'),
      calendar,
      logger: makeLogger(),
      alertChannel: {
        postLseCalendarCoverageAlert: (alert) => {
          posted.push(alert);
        },
      },
    });

    expect(posted).toHaveLength(0);
  });
});
