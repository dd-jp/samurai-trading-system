/**
 * The operator-escalation port for a flatten fill whose named lot has already
 * left `getOpenPositions()` (#1506).
 *
 * ## The exposure this names
 *
 * `redistributeOneFlatten` (ingest-fills.ts) splits a flatten's raw fill
 * across the lots its write-ahead named. Those splits are pushed into `byLot`,
 * which `ingestFills` then reads ONLY through the `positions` snapshot it took
 * at the top of the poll. A named lot that has since reached `closed` is
 * absent from that snapshot — and, because `lot_idempotency_keys` is fixed at
 * the flatten's own write-ahead, no later snapshot will ever name it either.
 * Before #1506 that split was written into a Map nothing read and dropped,
 * while `markFlattenFillsSwept` retired the journal row that would have led
 * back to it.
 *
 * The quantity is not a bookkeeping rounding: the venue SOLD it against a lot
 * the store already believes flat, so the account is short stock nothing in
 * the store accounts for — the reverse-position risk #1506 is named for, and
 * the same class of invisible exposure `findUnrecordedVenuePositions`
 * (reconcile.ts) reports from the other direction.
 *
 * ## Optional, with deliberately NO log-only form standing in
 *
 * Like `NonSterlingFeeAlertChannel` (#1465) and unlike
 * `ResidualExposureAlertChannel`/`FlattenOverfillAlertChannel`, this field is
 * OPTIONAL on `ExecutionInput`, and for the same reason: the fill is persisted
 * against the lot and an `error`-level `safeLog` line carrying this alert's
 * own fields is written BEFORE this port is reached, so a logging
 * implementation behind it would emit every trip twice. Absent means "no
 * second, audible copy", never "silent".
 *
 * Fires ONCE per split fill, not once per poll: the persist that precedes it
 * puts the fill's `(idempotency_key, broker_fill_id)` into `fills`, and every
 * later poll's re-offer of the same fill is recognised by `hasFill` and stays
 * quiet — the same dedup-by-durable-record posture #527's over-fill warning
 * takes in the same function.
 *
 * Fire-and-forget, awaited by its one caller so a rejected post cannot leave
 * an in-flight promise the process never accounts for, with the failure itself
 * only ever reaching a fixed, self-authored log line — never the channel's own
 * thrown error.
 *
 * CREDENTIALS: identifiers and computed quantities only — the boundary
 * `ResidualExposureAlert` documents. No raw fill, no `flatten_submissions`
 * row, no broker response body reaches an implementation of this port.
 */

/** One flatten split fill booked against a lot that is no longer open. */
export interface UnattributedFlattenFillAlert {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this alert was
   * raised on — the control-arm-distinguishing role
   * `ResidualExposureAlert.trace_id` documents (#1348).
   */
  trace_id: string;
  /** The flatten's own `client_order_id`, which is its `flatten_submissions` key. */
  flatten_idempotency_key: string;
  /** The named lot the split was booked against, already terminal in the store. */
  lot_idempotency_key: string;
  /**
   * #1550: the instrument the exposure is IN, read off the flatten's
   * write-ahead row (`FlattenAttribution.instrument`) rather than off an
   * `OpenPosition` that no longer exists.
   *
   * Without it the operator text named two opaque idempotency keys and no
   * ticker, so the "check the venue" instruction it ends on could not be
   * acted on without a store query.
   */
  instrument: string;
  /**
   * #1550: the CLOSING side the venue transacted — `'sell'` closing a long,
   * `'buy'` closing a short (`FlattenAttribution.side`).
   *
   * The text hardcoded "sold" and "REVERSE" before this field existed, which
   * is right for a sell-to-close and exactly inverted for a buy-to-close: a
   * buy that over-runs a closed short leaves the account LONG, not short.
   */
  side: 'buy' | 'sell';
  /** The venue's own fill identifier for the split — greppable against the booked `fills` row. */
  broker_fill_id: string;
  /** The split's share, in instrument units: the quantity the venue sold with no live lot behind it. */
  qty: number;
  observed_at: Date;
}

export interface UnattributedFlattenFillAlertChannel {
  postUnattributedFlattenFillAlert(alert: UnattributedFlattenFillAlert): Promise<void>;
}
