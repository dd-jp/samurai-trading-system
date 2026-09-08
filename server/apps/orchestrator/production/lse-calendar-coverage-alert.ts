/**
 * The operator-escalation port for the LSE table coverage cliff (#1378) —
 * one member of `ALERT_CHANNEL_FIELDS`.
 *
 * ## The decision this alert exists to make audible
 *
 * `LseRegularHoursCalendar` — the LIVE equity leg's calendar (ADR-0015) — is
 * backed by hand-entered tables (`LSE_HOLIDAYS`/`LSE_HALF_DAYS`,
 * trading-calendar.ts) whose checked coverage ends at
 * `LSE_TABLE_COVERAGE_END`. Unlike the US calendar's equivalent cliff, the
 * close resolver here does NOT throw past it — see trading-calendar.ts's
 * `LseRegularHoursCalendar` doc for why an unconditional throw would break
 * the flatten path itself. The boundary is instead enforced once, at boot,
 * by `assertLseCalendarCoverage`
 * (`production/lse-calendar-coverage-guard.ts`), while no live position
 * exists yet to strand.
 *
 * A hard refusal alone still leaves the cliff invisible until the day it
 * bites — an operator who does not read this file's date on every boot would
 * discover the outage the first morning the live leg refuses to start. This
 * alert is the horizon warning ahead of that: `assertLseCalendarCoverage`
 * posts it once coverage is within `LSE_COVERAGE_ALERT_HORIZON_DAYS`, on
 * every boot inside that window (no latch — boot is rare enough that this
 * does not flood the escalation chat, the same posture
 * `calendarFallbackAlerts` takes).
 *
 * Fires only for the LIVE leg: the paper leg's own coverage cliff already has
 * its own alert (`calendarFallbackAlerts`, #684) and a live network fetch
 * that sidesteps the hand table entirely on the happy path.
 */

/**
 * One coverage-horizon warning, at boot. Only raised AHEAD of the cliff —
 * once `days_remaining` goes negative, `assertLseCalendarCoverage` throws
 * instead of posting this (a boot refusal names the date directly in the
 * thrown error; there is no live process left to receive an async alert
 * about it).
 */
export interface LseCalendarCoverageAlert {
  /** `LSE_TABLE_COVERAGE_END` at the time this alert was raised. */
  coverage_end: string;
  /** Civil days from `reported_at` to `coverage_end`. Always >= 0 — see above. */
  days_remaining: number;
  reported_at: Date;
}

export interface LseCalendarCoverageAlertChannel {
  postLseCalendarCoverageAlert(alert: LseCalendarCoverageAlert): void;
}
