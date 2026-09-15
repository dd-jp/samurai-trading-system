/**
 * The operator-escalation port for a fill fee reported outside book currency
 * (#1465) — the other half of #1220, which raised
 * `FEE_CURRENCY_NOT_BOOK_CURRENCY` at `error` but wired no channel.
 *
 * ## Why this exists
 *
 * `warnOnNonSterlingFee` (ingest-fills.ts) fires when a broker reports a
 * fill's fee in a currency `isBookCurrency` refuses. That can only happen for
 * an instrument `tradeableUniverse()` should already have excluded (#1220's
 * sterling-only gate) — so a foreign fee means a selection-layer defect
 * already reached the venue with real money, not a transient data glitch. The
 * fill is still booked (`fee_currency` recorded verbatim, #1220) and the
 * `error`-level log line still fires beside this alert, exactly the way
 * `redistributeOneFlatten`'s `warn` line stands beside
 * `FlattenOverfillAlertChannel`'s post — this channel is what turns that
 * durable row into something a phone rings on.
 *
 * ## Optional, with deliberately NO log-only form standing in
 *
 * Unlike `ResidualExposureAlertChannel`/`FlattenOverfillAlertChannel`/
 * `FlattenReconcileAlertChannel`, this field is OPTIONAL on `ExecutionInput`
 * and absent means "no second, audible copy" — the same posture
 * `ThresholdClampAlertChannel`/`TraderDiagnosticAlertChannel` take, and for
 * the same reason: `warnOnNonSterlingFee` already writes an `error`-level
 * `safeLog` line with this alert's own fields BEFORE reaching this port, so a
 * logging implementation behind it would emit every trip twice. Absent here
 * is not silent — the durable record is the log line and the `fee_currency`
 * column on the fill row itself.
 *
 * Fire-and-forget, awaited by its one caller so a rejected post cannot leave
 * an in-flight promise the process never accounts for, with the failure
 * itself only ever reaching a fixed, self-authored log line — never the
 * channel's own thrown error.
 *
 * CREDENTIALS: composed only of fields `warnOnNonSterlingFee` chose — the
 * same boundary `ResidualExposureAlert` documents. No broker response body,
 * no raw fill object reaches an implementation of this port.
 */

/** One fill whose reported fee currency is not the book currency */
export interface NonSterlingFeeAlert {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this alert was
   * raised on — the same control-arm-distinguishing role
   * `ResidualExposureAlert.trace_id` documents (#1348): a constant here would
   * log a control-arm (simulated-broker) fee identically to a live one
   */
  trace_id: string;
  /** The lot's own `idempotency_key` */
  idempotency_key: string;
  instrument: string;
  /** The venue's own fill identifier — greppable against the booked `fills` row */
  broker_fill_id: string;
  /**
   * The venue-reported fee, verbatim in `fee_currency` (#1220 does not
   * convert it) — the raw fill's own `fee`, not necessarily what gets
   * booked: on the `cumulativeTopUp` call site this is the venue's
   * cumulative total for the whole order, not the incremental delta
   * `chargeTopUpTo` charges this lot
   */
  fee: number;
  fee_currency: string;
  /** `BOOK_CURRENCY` at the time of the alert — named explicitly rather than assumed by the reader */
  book_currency: string;
}

export interface NonSterlingFeeAlertChannel {
  postNonSterlingFeeAlert(alert: NonSterlingFeeAlert): Promise<void>;
}
