/**
 * The operator-escalation port for a `flatten_submissions` row `reconcile()`
 * could not settle (#519) — the same shape `ResidualExposureAlertChannel`
 * takes (residual-exposure-alert.ts): declared beside its caller, implemented
 * by `LoggingFlattenReconcileAlertChannel` and wired at the composition root.
 *
 * ## Why this exists
 *
 * `reconcile()`'s flatten sweep (reconcile.ts) reads every unresolved
 * `flatten_submissions` row and asks the venue about it via
 * `BrokerAdapter.resumeFlatten`. Two outcomes settle the row cleanly — the
 * venue names an order (adopted) or authoritatively has none under a
 * still-`'submitting'` write-ahead (rejected, mirroring the bracket path's
 * `'rejected'`). The third outcome is genuine ignorance: the adapter could
 * not answer at all (a transport/auth failure), or answered null for a row
 * the venue had ALREADY acked once (`broker_order_ids` on record) — neither
 * of which reconcile may treat as "never placed" without risking exactly the
 * inverted failure `BrokerAdapter.getOrder`'s own doc warns about: burying a
 * live, possibly-filled position.
 *
 * An operator has to look at those by hand — an unresolved flatten is a
 * held lot whose exit is stuck in ambiguity, which is squarely
 * paging-worthy, not a background diagnostic (`FlattenOverfillAlertChannel`'s
 * "should never happen" posture does not apply here: an unreachable venue
 * at startup is an ordinary operational condition, and the STAKES — a lot
 * that may or may not still be held — are what set this apart from that
 * channel's log-only precedent).
 *
 * Fire-and-forget, not a round trip — the same posture every other
 * escalation on this boundary takes: there is nothing to approve, only
 * something an operator has to go check on the venue.
 *
 * CREDENTIALS: composed only of fields this module chose — the flatten's own
 * idempotency key, its instrument, a sanitized reason, and (#1331) the
 * reconcile pass's own trace id, a fixed synthetic constant chosen at the
 * composition root. `reconcile()`'s
 * `undetermined` divergence already carries the adapter's error message
 * verbatim (reconcile.ts's own comment: `sanitizeBrokerError`, #297's H1,
 * makes that safe), the same text this alert forwards — never a raw response
 * body, never a credential. Since #1003 that curated message can also
 * include `BrokerError.venueMessage` — a venue diagnostic string read only
 * from a dedicated allowlisted property, bounded and truncated — so this
 * transport now widens slightly what reaches an operator's alert channel;
 * it stays within the same "sanitized, never raw" guarantee.
 */

/** One `flatten_submissions` row `reconcile()` could not settle this pass. */
export interface FlattenReconcileAlert {
  /**
   * The reconcile pass's own `ExecutionInput.trace_id`, and with it the ARM
   * that raised this alert (#1331).
   *
   * Every surface `reconcile()` can be called on is built by
   * `buildExecutionSurface` with a fixed per-arm id — `reconcile`/`fill-sync`
   * for the live arm, `control-arm-reconcile`/`control-arm-fill-sync` for the
   * control's (#1321) — and the tick-step Execution, whose id is a verdict's
   * idempotency key, never reaches this alert: `reconcile()` is the only
   * caller. So this field names the arm as long as that stays true.
   *
   * Carried on the alert rather than stamped at the log site because both
   * arms post through the SAME channel instance: `buildControlArmWiring`
   * spreads the live arm's execution deps and overrides the broker, the store
   * and five siblings, but the alert channels are `SAMURAI_ALERTS`-selected
   * once at the root and shared. A constant at the channel therefore logs a
   * control-arm flatten — a simulated broker's ambiguity — identically to a
   * live one at a real venue.
   */
  trace_id: string;
  /** The flatten's own `flatten_submissions.idempotency_key` (its `client_order_id`). */
  idempotency_key: string;
  instrument: string;
  /** Why it could not be settled — the adapter's own (sanitized) error, or the venue's contradiction. */
  reason: string;
  observed_at: Date;
}

export interface FlattenReconcileAlertChannel {
  postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void>;
}
