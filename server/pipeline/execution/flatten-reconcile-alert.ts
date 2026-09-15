/**
 * The operator-escalation port for a `flatten_submissions` row `reconcile()`
 * could not settle (#519) — the same shape `ResidualExposureAlertChannel`
 * takes (residual-exposure-alert.ts): declared beside its caller, implemented
 * by the alert catalogue (orchestrator/alert-catalogue.ts) and wired at the
 * composition root.
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
 * idempotency key, its instrument, a sanitized reason, and (#1331) the trace
 * id of the Execution surface the pass ran on, which every caller fixes to a
 * literal it wrote itself (see `trace_id` below). `reconcile()`'s
 * `undetermined` divergence already carries the adapter's error message
 * verbatim (reconcile.ts's own comment: `sanitizeBrokerError`, #297's H1,
 * makes that safe), the same text this alert forwards — never a raw response
 * body, never a credential. Since #1003 that curated message can also
 * include `BrokerError.venueMessage` — a venue diagnostic string read only
 * from a dedicated allowlisted property, bounded and truncated — so this
 * transport now widens slightly what reaches an operator's alert channel;
 * it stays within the same "sanitized, never raw" guarantee.
 */

/** One `flatten_submissions` row `reconcile()` could not settle this pass */
export interface FlattenReconcileAlert {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this pass ran on,
   * and with it the ARM that raised the alert (#1331).
   *
   * ## What actually makes this an arm label
   *
   * Every Execution that reaches this alert is built by
   * `buildExecutionSurface` with a fixed synthetic id its caller wrote as a
   * literal. At the composition root that is four ids, not two — the live
   * arm's `reconcile`/`fill-sync` and the control arm's
   * `control-arm-reconcile`/`control-arm-fill-sync` (#1321) — plus smoke's
   * own scenario surfaces (`smoke-exit-path`, `smoke-exit-path-restart`,
   * `smoke-filled-zero-size-wedge`), which are fixed literals too — seven in
   * all, and every one of them written at a call site. The ARM is
   * readable on all of them by the `control-arm-` prefix, which is the
   * property this field exists for; the exact id is not one value per arm.
   *
   * The tick-step Execution is the one whose id is a verdict's idempotency
   * key, and it cannot reach here — but NOT because `reconcile()` is this
   * alert's only caller. `ExecutionImpl.reconcile()` is public, and
   * `buildExecutionStep` (direct-bind.ts) constructs an `ExecutionImpl` with
   * `trace_id: verdict.idempotency_key` like any other. What holds is that
   * that instance NEVER ESCAPES its closure: it is constructed and
   * `execute(verdict)` returned in the same expression, so no caller ever
   * holds a reference to call `reconcile()` on. Exposing that instance, or
   * calling `.reconcile()` on it inside the closure, would put a verdict key
   * in this field and silently end the guarantee.
   *
   * ## Correlating two lines on the poll
   *
   * On the forever-running poll the value is `fill-sync` /
   * `control-arm-fill-sync`, not `reconcile` — the poll calls `reconcile()`
   * on the FILL-SYNC surface (production.ts, `startFillSync`). So one
   * unresolved flatten emits the loop's own `warn` divergence line under
   * `reconcile` and this `error` line under `fill-sync` in the same pass.
   * That is `fill-sync.ts`'s deliberate split of the loop's labelling from
   * the surface's (see `FILL_SYNC_TRACE_ID`'s doc there), not a drift — but a
   * reader correlating the two lines has to know they differ. Only the
   * startup reconcile logs this alert under `reconcile`.
   *
   * ## Why on the alert, not at the log site
   *
   * Both arms post through the SAME channel instance: `buildControlArmWiring`
   * spreads the live arm's execution deps and overrides the broker, the store
   * and five siblings, but the alert channels are `SAMURAI_ALERTS`-selected
   * once at the root and shared. A constant at the channel therefore logs a
   * control-arm flatten — a simulated broker's ambiguity — identically to a
   * live one at a real venue.
   */
  trace_id: string;
  /** The flatten's own `flatten_submissions.idempotency_key` (its `client_order_id`) */
  idempotency_key: string;
  instrument: string;
  /** Why it could not be settled — the adapter's own (sanitized) error, or the venue's contradiction */
  reason: string;
  observed_at: Date;
}

export interface FlattenReconcileAlertChannel {
  postFlattenReconcileAlert(alert: FlattenReconcileAlert): Promise<void>;
}
