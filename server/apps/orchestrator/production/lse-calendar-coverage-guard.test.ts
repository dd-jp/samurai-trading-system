import { LseRegularHoursCalendar } from '../../../providers/market-data-service/index.js';
import type { LogEntry, Logger } from '../types.js';
import type { LseCalendarCoverageAlert } from './lse-calendar-coverage-alert.js';
import { assertLseCalendarCoverage } from './lse-calendar-coverage-guard.js';

function makeLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { entries, log: (entry: LogEntry) => entries.push(entry) };
}

/**
 * Direct unit coverage on `assertLseCalendarCoverage` itself, bypassing
 * `buildProductionComponents`. This is what proves the guard's boundary
 * decision is `calendar.coversCloseFor(now)`, not a re-derived comparison
 * against `LSE_TABLE_COVERAGE_END` — every test in production.test.ts uses
 * the real `LseRegularHoursCalendar`, where the two currently agree, so
 * none of them can tell a guard that calls `coversCloseFor` apart from one
 * that silently re-derives the same answer another way. Overriding the
 * public method on a real instance (rather than a duck-typed object) is
 * required here: `LseRegularHoursCalendar` carries private class fields, so
 * TypeScript's structural typing for it is effectively nominal.
 */
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

  it('posts the horizon alert using LSE_TABLE_COVERAGE_END regardless of coversCloseFor', () => {
    // The horizon alert's days-remaining count is independent of
    // coversCloseFor — it is always measured against the real
    // LSE_TABLE_COVERAGE_END, so a caller sees a consistent coverage_end
    // even if coversCloseFor were ever overridden for testing elsewhere.
    const calendar = new LseRegularHoursCalendar();
    const posted: LseCalendarCoverageAlert[] = [];

    assertLseCalendarCoverage({
      now: new Date('2020-01-06T12:00:00Z'),
      calendar,
      logger: makeLogger(),
      alertChannel: {
        postLseCalendarCoverageAlert: (alert) => {
          posted.push(alert);
        },
      },
    });

    expect(posted).toHaveLength(0); // 2020-01-06 is nowhere near the horizon.
  });
});
