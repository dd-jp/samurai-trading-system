/**
 * The operator-visibility port for a flatten that filled MORE than its named
 * lots' journalled held quantity (#527) — the same shape
 * `ResidualExposureAlertChannel` takes (residual-exposure-alert.ts): declared
 * beside its caller, implemented by `LoggingFlattenOverfillAlertChannel`
 * (orchestrator/console-channels.ts — log-only by design, so no catalogue
 * entry) and wired at the composition root.
 *
 * ## Why this exists
 *
 * `redistributeOneFlatten` (ingest-fills.ts) splits a flatten's raw fill
 * across the lot(s) it named, up to each lot's fixed journalled share. Any
 * `leftover` past that sum is dropped — never guessed onto a lot, because a
 * split invented here would mis-assign quantity on the money path, which is
 * worse than leaving it unattributed. `execute()`'s `order.size === heldSize`
 * guard means this should never happen in normal operation, but "should
 * never happen" is exactly the condition that needs a trace: a venue
 * over-fill, a store/venue divergence, or a future change to that guard
 * would otherwise make quantity vanish from the accounting with no record,
 * unnoticed through a 14-day unattended soak (#238).
 *
 * `warn`, not `error` — the same distinction the `loosenNotices` log line
 * draws: nothing this call does is broken, the split still completes and the
 * poll still succeeds. This is a diagnostic trail for an invariant violation
 * elsewhere, not itself a failure of `ingestFills()`.
 *
 * Fire-and-forget, and the caller wraps every call in its own swallow: unlike
 * `ResidualExposureAlertChannel` (the last-resort fallback with nothing left
 * to fall back to), a rejection here must not turn a SUCCESSFUL
 * redistribution into a contained failure — see `redistributeOneFlatten`'s
 * call site.
 *
 * CREDENTIALS: composed only of the flatten's own identifier and a computed
 * quantity — no raw fill object, no attribution-row content. Same boundary
 * `ContainedFailure.key` documents: an identifier only, never untrusted
 * column content, so a corrupted `flatten_submissions` row (#524's own test)
 * cannot leak through this message either.
 */

/** One flatten fill whose quantity exceeded its named lots' journalled share */
export interface FlattenOverfillWarning {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this warning was
   * raised on, and with it the ARM that raised it (#1348, following #1331's
   * `FlattenReconcileAlert.trace_id`) — this channel is `SAMURAI_ALERTS`-
   * selected once at the root and shared between arms (see
   * `control-arm-wiring.ts`), so a constant here would log a control-arm
   * warning identically to a live one.
   *
   * `redistributeOneFlatten`, this warning's only producer, runs solely
   * inside `ingestFills()` — never inside `reconcile()`. Measured: unlike
   * `ResidualExposureAlert.trace_id`, the startup reconcile ids (`reconcile`,
   * `control-arm-reconcile`) cannot appear here at all, because
   * `runStartupReconcile` (fill-sync.ts) calls only `execution.reconcile()`,
   * never `ingestFills()`. In production this field is always `fill-sync` or
   * `control-arm-fill-sync` (the fill-sync poll's own surface).
   */
  trace_id: string;
  /** The flatten's own `flatten_submissions.idempotency_key` (its `client_order_id`) */
  idempotency_key: string;
  /** The quantity this poll could not attribute to any named lot */
  unattributed_qty: number;
  observed_at: Date;
}

export interface FlattenOverfillAlertChannel {
  postFlattenOverfillWarning(warning: FlattenOverfillWarning): Promise<void>;
}
