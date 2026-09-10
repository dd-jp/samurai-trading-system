/**
 * The operator-escalation port for a permanently-unpriced fill (#298).
 *
 * Declared here, at the point of need, and implemented above — the same shape
 * `OrphanAlertChannel` takes in orchestrator/orphan-verdict-scan.ts (declared
 * beside its caller, implemented by the alert catalogue and wired at the
 * composition root). Execution therefore gains no dependency on a
 * transport: the adapter knows only that something can be told, not what.
 *
 * Fire-and-forget, not a round trip: there is nothing to approve here, only
 * something a human has to go and look at on the venue. (Contrast
 * `ApprovalChannel` in verdict/types.ts, which is the request/response shape.)
 *
 * CREDENTIALS: the payload is composed only of fields this module chose —
 * venue order id, symbol, quantity, timestamps. No broker error, no response
 * body, no header ever reaches it, for `BrokerError`'s reason (broker-error.ts):
 * what is not retained cannot leak into whatever an implementation posts this
 * to.
 */

/** One fill the venue has reported filled, and failed to price, for too long. */
export interface UnpricedFillAlert {
  /** Which adapter observed it — 'alpaca' today. */
  venue: string;
  /** Our idempotency key for the lot, i.e. `open_positions.idempotency_key`. */
  client_order_id: string;
  /** The venue order id to look up on the broker's own dashboard. */
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  instrument: string;
  /** The quantity the venue claims filled but will not price. */
  qty: number;
  /** When this fill was first seen unpriced — survives process restarts. */
  first_seen_at: Date;
  /** How long it has been unpriced, in ms: `now - first_seen_at`. */
  unpriced_for_ms: number;
  /** The age-out threshold this breached, so the alert explains itself. */
  age_out_ms: number;
}

export interface UnpricedFillAlertChannel {
  postUnpricedFillAlert(alert: UnpricedFillAlert): Promise<void>;
}
