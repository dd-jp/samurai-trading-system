/**
 * The operator-escalation port for a position the VENUE holds and the store
 * has no open lot for (#1550) — `findUnrecordedVenuePositions`, reconcile.ts.
 *
 * ## Why a page, and not the `warn` that already existed
 *
 * The scan has reported this shape since #429, and #1506 raised its
 * `reconcileDivergenceLevel` from `info` to `warn`. Both are LOG levels:
 * `runPoll` (fill-sync.ts) feeds the divergence to `logger.log` and nothing
 * escalates off it, so the one exposure in this system that the Risk Manager
 * cannot see at all — Risk computes exposure from the store, and the store
 * has no row for this — was audible only to an operator reading the stream.
 * An unattended soak (#238) is precisely the case that has no such operator.
 *
 * ## Throttled, and why it has to be
 *
 * Unlike every other channel raised out of the execution layer, the condition
 * here is not an event: it is a STATE that persists until someone acts on it.
 * `findUnrecordedVenuePositions` re-derives it from a fresh venue read on
 * every reconcile pass, reconcile runs on the fill-sync poll (#921, 15s by
 * default), and nothing the system does resolves it. Unthrottled that is ~240
 * pages an hour, for as long as the position stands.
 * `UnrecordedVenuePositionThrottle` is what bounds it — see that class for the
 * interval and the precedent it is taken from.
 *
 * ## REQUIRED on `ExecutionInput`, unlike the two optional channels
 *
 * `nonSterlingFeeAlerts` and `unattributedFlattenFillAlerts` are optional
 * because their callers write an `error`-level `safeLog` line carrying the
 * same fields first, so absence costs only the second copy. Nothing writes an
 * `error` line for this one: the divergence reaches the log at `warn`, from a
 * DIFFERENT module (fill-sync.ts), on a path the backtest and the smoke run
 * do not take. So this follows `residualExposureAlerts`/`flattenReconcileAlerts`
 * instead — required, with `loggingAlertChannel` as the default stand-in, so
 * that a composition root cannot silently omit it (the missing-transport hole
 * CLAUDE.md's alert-channel memory records recurring eight times).
 *
 * Fire-and-forget, awaited by its one caller so a rejected post cannot leave
 * an in-flight promise the process never accounts for, with the failure itself
 * only ever reaching a fixed, self-authored log line — never the channel's own
 * thrown error.
 *
 * CREDENTIALS: identifiers and quantities the venue reported, only — the
 * boundary `ResidualExposureAlert` documents. No broker response body, no
 * account identifier, no store row reaches an implementation of this port.
 */

/** One instrument the venue holds a position in that no open lot explains */
export interface UnrecordedVenuePositionAlert {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this alert was
   * raised on — the control-arm-distinguishing role
   * `ResidualExposureAlert.trace_id` documents (#1348), and the field the
   * catalogue's `page` predicate reads to keep the control arm off the phone
   */
  trace_id: string;
  instrument: string;
  /** The venue's netted quantity, signed by direction exactly as `NormalizedPosition.qty` is */
  qty: number;
  /** The venue's netted direction, verbatim from `NormalizedPosition.side` */
  side: 'buy' | 'sell';
  observed_at: Date;
}

export interface UnrecordedVenuePositionAlertChannel {
  postUnrecordedVenuePositionAlert(alert: UnrecordedVenuePositionAlert): Promise<void>;
}
