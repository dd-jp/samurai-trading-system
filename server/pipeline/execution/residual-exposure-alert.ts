/**
 * The operator-escalation port for a residual position `ingestFills()` could
 * not re-arm (#525) — the same shape `UnpricedFillAlertChannel` takes
 * (unpriced-fill-alert.ts): declared beside its caller, implemented by
 * `LoggingResidualExposureAlertChannel` and wired at the composition root.
 *
 * ## Why this exists
 *
 * `executeExit` (execute.ts) cancels a held lot's stop/target legs BEFORE
 * submitting its flatten (#516 — a resting leg fires into a now-flat
 * position and opens a REVERSE one). When the flatten fills completely that
 * is safe; when it fills PARTIALLY, the legs are already gone and some
 * quantity is still held. `ingestFills()` re-arms fresh protective legs
 * against that residual, sized and priced by the resize path
 * `resizeProtectiveLegs` already reasons about (#525's recorded decision:
 * option 1 — re-arm, not retry-the-flatten, not alert-and-leave-it).
 *
 * This alert is the FALLBACK for when that re-arm itself fails, never the
 * primary mechanism — a successful re-arm posts nothing here, because a
 * 14-day unattended soak (#238) that logs a handled condition on every
 * partial fill trains the operator to stop reading it. A failed re-arm must
 * fail toward VISIBILITY (the #312 precedent this decision cites): an
 * unprotected residual nobody was told about is worse than one that could
 * not be re-armed at all.
 *
 * Fire-and-forget, not a round trip — the same posture `UnpricedFillAlert`
 * takes, for the same reason: there is nothing to approve, only something an
 * operator has to go look at on the venue.
 *
 * CREDENTIALS: composed only of fields this module chose — instrument,
 * quantity, the lot's own idempotency key, the levels it tried to arm at.
 * No broker error text, no response body reaches it, mirroring
 * `UnpricedFillAlert`'s same boundary: what is not retained cannot leak into
 * whatever an implementation posts this to. The underlying failure reason
 * is for the logger, not this channel.
 */

/** One residual position left without protective legs after a partial flatten. */
export interface ResidualExposureAlert {
  /**
   * The `ExecutionInput.trace_id` of the Execution SURFACE this alert was
   * raised on, and with it the ARM that raised it (#1348, following #1331's
   * `FlattenReconcileAlert.trace_id`) — both channels are `SAMURAI_ALERTS`-
   * selected once at the root and shared between arms (see
   * `control-arm-wiring.ts`), so a constant here would log a control-arm
   * (simulated-broker) residual identically to a live one.
   *
   * `sweepResidualProtection` (residual-protection-sweep.ts), this alert's
   * only path to `postResidualExposureAlert`, runs from TWO call sites, both
   * inside `ExecutionImpl` and so both stamped with the surface's own fixed
   * id: unconditionally inside `reconcile()` (reconcile.ts), and again,
   * directly, after every `ingestFills()` on the fill-sync poll
   * (fill-sync.ts). Measured reachable set, four ids: `reconcile` /
   * `control-arm-reconcile` from the one-shot startup reconcile, and
   * `fill-sync` / `control-arm-fill-sync` from the poll — whether the poll's
   * own `reconcile()` call or its standalone sweep raised this particular
   * one, both stamp the same fill-sync surface id, so the two are not
   * distinguishable from this field alone.
   */
  trace_id: string;
  /** The lot's own `idempotency_key` — what `getOpenPositions()`/the store key on. */
  idempotency_key: string;
  instrument: string;
  /** The lot's held (entry) side — the same side a fresh flatten would need to close. */
  side: 'buy' | 'sell';
  /** The quantity left open after the partial flatten, still uncovered by any leg. */
  residual_qty: number;
  /**
   * `true` when `residual_qty` is an UPPER BOUND rather than the exact
   * residual (#569 review): the fill read needed to compute the exact figure
   * failed, so the lot's whole requested size is reported instead. It can
   * only over-state what is at risk, never under-state it.
   *
   * A flag rather than the caught error's text, deliberately — see the
   * CREDENTIALS note below: this channel carries only fields chosen here.
   * Without it an operator cannot tell an exact residual from an estimate,
   * and a persistent store outage reads as a stream of confident alerts.
   */
  residual_qty_is_upper_bound: boolean;
  /** The price levels re-arming was attempted at — the lot's own, unchanged by the resize. */
  stop: number;
  target: number;
  /** When the failed re-arm was observed. */
  observed_at: Date;
}

export interface ResidualExposureAlertChannel {
  postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void>;
}
