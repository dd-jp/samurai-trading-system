/**
 * A partial entry fill on a venue whose protective-leg resizing is UNVERIFIED
 * (Saxo, doc 43 "Not verified"): the adapter cannot resize the legs itself
 * and cannot confirm the venue did, so the lot may sit under a stop sized to
 * the ORIGINAL amount — an over-close into a reversed position if it fires.
 *
 * Posted instead of thrown, deliberately. `ingestFills` calls
 * `resizeProtectiveLegs` above `applyLotAdvance`, so a throw there wedges the
 * fill un-persisted (Risk sees zero exposure, flat-by-close sends nothing) —
 * worse than the leg-size doubt it was refusing. The same fail-toward-
 * visibility posture as `ResidualExposureAlert`.
 *
 * CREDENTIALS: composed only of fields this module chose — no venue error
 * text or response body reaches it.
 */
export interface LegResizeUnverifiedAlert {
  /** The lot's own `idempotency_key` (the bracket's `client_order_id`) */
  client_order_id: string;
  instrument: string;
  /** The bracket's journalled size, or `null` when the journal has no request for it */
  requested_qty: number | null;
  filled_qty: number;
  observed_at: Date;
}

export interface LegResizeUnverifiedAlertChannel {
  postLegResizeUnverifiedAlert(alert: LegResizeUnverifiedAlert): Promise<void>;
}
