/**
 * The operator-escalation port for #684's fetch-failure decision — the
 * sixteenth outbound operator escalation (`ALERT_CHANNEL_FIELDS`).
 *
 * ## The decision this alert exists to make audible
 *
 * #684 replaces the hand-entered `US_HOLIDAYS`/`US_EARLY_CLOSE_DAYS` tables
 * with Alpaca's own `GET /v2/calendar` for the paper equity leg. That table
 * is fetched once at boot (`us-equity-session-source.ts`), which raises the
 * question #684 poses explicitly: what happens when the fetch fails?
 *
 * Two options were on the table. REFUSING to boot is the fail-safe
 * direction for a flatten boundary — an orchestrator that cannot confirm
 * today's session shape should not trade blind — but it couples a 14-day
 * unattended paper soak's availability to a single network call succeeding
 * at the one moment it is made, and a transient Alpaca blip would then take
 * the whole book offline until an operator notices and restarts. Silently
 * falling back with no signal is worse than either: it is exactly the
 * "quiet degradation" shape #625/#691 both presented, indistinguishable from
 * a healthy run from outside.
 *
 * The resolution: fetch at startup; on failure, fall back to the
 * hand-entered `UsEquityRegularHoursCalendar` (still a defensible calendar —
 * it is what this process ran on before #684) but post THIS alert at `error`
 * so an operator is paged rather than merely logged past. The hand table's
 * own coverage cliff (`US_TABLE_COVERAGE_END`, trading-calendar.ts) already
 * throws rather than assuming a normal close for a date beyond it — so the
 * fallback still cannot silently take the dangerous direction even on a date
 * its own table never saw, it can only make the SAME (audited, checked)
 * mistake this process already accepted before #684 landed.
 *
 * Never a refusal: see `us-equity-session-source.ts` for where the decision
 * is implemented.
 */

/** One calendar-fetch fallback, at boot */
export interface CalendarFallbackAlert {
  /** The fetch failure's own message — never a credential, per every other alert on this list */
  reason: string;
  /**
   * The hand table `US_TABLE_COVERAGE_END` (trading-calendar.ts) currently
   * reads, so the operator knows how far the fallback can be trusted before
   * it itself starts throwing rather than guessing
   */
  fallback_coverage_end: string;
  reported_at: Date;
}

export interface CalendarFallbackAlertChannel {
  postCalendarFallbackAlert(alert: CalendarFallbackAlert): void;
}
