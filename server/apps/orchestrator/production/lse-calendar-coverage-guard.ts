/**
 * The LIVE equity leg's boot-time table-coverage guard (#1378).
 *
 * ## Why this lives at boot, not in the calendar
 *
 * `LseRegularHoursCalendar` is what the LIVE equity leg runs on (ADR-0015),
 * and its `#closeMinutesFor` stays TOTAL past `LSE_TABLE_COVERAGE_END` — it
 * does not throw, unlike `UsEquityRegularHoursCalendar`'s equivalent. That
 * method backs `isOpen`/`sessionStart`/`sessionEnd`, all on the flatten
 * path, so an unconditional throw there would fire on every tick from the
 * coverage date forward and no position could ever be closed again — this
 * repo has already shipped that shape of bug once (a guard placed above an
 * early return blocked exits, not just entries). See
 * `LseRegularHoursCalendar`'s class doc (trading-calendar.ts) for the full
 * reasoning.
 *
 * So the boundary is enforced exactly once, here, at boot — while no live
 * position exists yet to strand. `buildProductionComponents` (production.ts)
 * calls this immediately after resolving `tradingCalendar`, before anything
 * else is constructed, for `mode === 'live'` only: the paper leg runs
 * `UsEquityRegularHoursCalendar`/`AlpacaEquitySessionCalendar` and has its
 * own coverage story (`calendarFallbackAlerts`, #684).
 *
 * ## Two thresholds, not one
 *
 * Past `LSE_TABLE_COVERAGE_END`: THROW. An operator-readable message naming
 * today's date, the coverage-end date, and what to extend
 * (`LSE_HOLIDAYS`/`LSE_HALF_DAYS`, trading-calendar.ts) — extending the
 * tables themselves is a separate change, out of scope here.
 *
 * Within `LSE_COVERAGE_ALERT_HORIZON_DAYS` of it (but not yet past): ALERT,
 * not refuse. This is what makes the cliff visible before it bites — without
 * it, the first anyone learns of the coverage gap is the morning the live
 * leg refuses to start. The alert fires on every boot inside the window (no
 * latch): boot is rare enough that this does not flood the escalation chat,
 * the same posture `calendarFallbackAlerts` takes.
 *
 * ## Residual gap — a running process is not covered
 *
 * This guard runs at boot only. A process already running when
 * `LSE_TABLE_COVERAGE_END` passes mid-session neither refuses nor alerts —
 * it keeps flattening on `LseRegularHoursCalendar`'s permissive 16:30 until
 * the next restart. That is the honest scope of a boot-only guard: closing
 * it fully would mean the resolver throwing on the money path, which is the
 * failure mode this file exists to avoid. An unattended run crossing the
 * cliff mid-soak is exactly what the horizon alert, well ahead of the date,
 * exists to make unlikely.
 */
import { LSE_TABLE_COVERAGE_END } from '../../../providers/market-data-service/index.js';
// Reached directly rather than through the barrel: these are the internal
// London-civil-date helpers `trading-calendar.ts` exports for exactly this
// caller (see `LONDON_ZONE`'s own doc comment) — not part of the package's
// public surface, so they stay off `providers/market-data-service/index.ts`.
import {
  civilDateKey,
  LONDON_ZONE,
  toCivilDate,
} from '../../../providers/market-data-service/trading-calendar.js';
import { LoggingLseCalendarCoverageAlertChannel } from '../console-channels.js';
import type { Logger } from '../types.js';
import type { LseCalendarCoverageAlertChannel } from './lse-calendar-coverage-alert.js';

/**
 * How far ahead of `LSE_TABLE_COVERAGE_END` the horizon alert starts firing.
 * 60 days: long enough that an operator checking the escalation chat weekly
 * cannot miss it, short enough that it does not fire for most of the year the
 * tables are freshly extended.
 */
export const LSE_COVERAGE_ALERT_HORIZON_DAYS = 60;

const CIVIL_DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a `civilDateKey`-shaped `YYYY-MM-DD` string to UTC epoch milliseconds at midnight. */
function civilDateKeyToUtcMs(key: string): number {
  const match = CIVIL_DATE_KEY_PATTERN.exec(key);
  if (match === null) {
    throw new Error(`civilDateKeyToUtcMs: '${key}' is not a YYYY-MM-DD civil date key`);
  }
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

/** Whole civil days from `fromKey` to `toKey` — both `YYYY-MM-DD`, `toKey >= fromKey`. */
function civilDaysBetween(fromKey: string, toKey: string): number {
  return Math.round((civilDateKeyToUtcMs(toKey) - civilDateKeyToUtcMs(fromKey)) / 86_400_000);
}

export interface AssertLseCalendarCoverageOptions {
  /** Boot time, read through the injected clock — never `Date.now()` directly. */
  now: Date;
  logger: Logger;
  /** Defaults to `LoggingLseCalendarCoverageAlertChannel(logger)`, same posture as `calendarFallbackAlerts`. */
  alertChannel?: LseCalendarCoverageAlertChannel | undefined;
}

/**
 * Throws when `now` is past `LSE_TABLE_COVERAGE_END`; posts a horizon alert
 * (never throws) when `now` is within `LSE_COVERAGE_ALERT_HORIZON_DAYS` of
 * it. Otherwise a no-op. See the module doc for why the two are separate
 * thresholds and why this is boot-only.
 */
export function assertLseCalendarCoverage(options: AssertLseCalendarCoverageOptions): void {
  const { now, logger } = options;
  const todayKey = civilDateKey(toCivilDate(now, LONDON_ZONE));

  if (todayKey > LSE_TABLE_COVERAGE_END) {
    throw new Error(
      `Orchestrator cannot start the live equity leg: today (${todayKey}, London) is past ` +
        `LSE_TABLE_COVERAGE_END (${LSE_TABLE_COVERAGE_END}). LseRegularHoursCalendar's ` +
        'hand-entered LSE_HOLIDAYS/LSE_HALF_DAYS tables (trading-calendar.ts) are unverified ' +
        'past that date — an unmodelled half-day would read as an ordinary 16:30 close and the ' +
        'flatten would fire four hours late, the exact overnight carry ADR-0014 forbids. Extend ' +
        'LSE_HOLIDAYS/LSE_HALF_DAYS (and their LSE_HOLIDAYS_CHECKED_THROUGH/' +
        'LSE_HALF_DAYS_CHECKED_THROUGH dates) against the published UK bank holiday calendar ' +
        'before restarting the live leg — see #1308 for the wider Saxo-data map this sits under.',
    );
  }

  const daysRemaining = civilDaysBetween(todayKey, LSE_TABLE_COVERAGE_END);
  if (daysRemaining <= LSE_COVERAGE_ALERT_HORIZON_DAYS) {
    const alertChannel = options.alertChannel ?? new LoggingLseCalendarCoverageAlertChannel(logger);
    alertChannel.postLseCalendarCoverageAlert({
      coverage_end: LSE_TABLE_COVERAGE_END,
      days_remaining: daysRemaining,
      reported_at: now,
    });
  }
}
