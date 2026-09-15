/**
 * The operator-escalation port for a residual position that could not be
 * re-armed (#525) — the same shape `UnpricedFillAlertChannel` takes
 * (unpriced-fill-alert.ts): declared beside its callers, implemented by the
 * alert catalogue (orchestrator/alert-catalogue.ts) and wired at the
 * composition root.
 * Two producer paths reach it — `maybeRearmResidual` inside `ingestFills()`
 * itself, and `sweepResidualProtection`'s own re-arm attempt — see
 * `trace_id`'s doc below for which ids each can carry.
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
   * Reaches `postResidualExposureAlert` from two producer paths, both
   * stamped with the raising surface's own fixed `ExecutionInput.trace_id`:
   * `maybeRearmResidual` (residual-protection.ts), reached through `advanceLot`
   * inside `ingestFills()` itself when a partial flatten leaves a residual
   * mid-poll; and `sweepResidualProtection` (residual-protection-sweep.ts),
   * reached both unconditionally inside `reconcile()` (reconcile.ts) and,
   * standalone, again after the poll's own `ingestFills()` (fill-sync.ts).
   * In production this field is one of four ids: `reconcile` /
   * `control-arm-reconcile` from the one-shot startup reconcile, and
   * `fill-sync` / `control-arm-fill-sync` from the poll — every path that
   * runs during the poll (its `ingestFills()` call, its own `reconcile()`
   * call, and its standalone sweep) stamps the same fill-sync surface id, so
   * none of those three is distinguishable from this field alone. The smoke
   * harness (smoke-run.ts) also drives real `Execution` surfaces through a
   * recording channel and can add `smoke-exit-path` / `smoke-exit-path-restart`.
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
  /**
   * `true` when re-arming this residual is refused PERMANENTLY (#1214,
   * `isProtectiveRearmUnsupported`) — so the #549 sweep's retries can never
   * clear it and the operator is the only remedy. `false` is the ordinary
   * case: a re-arm that failed and will be retried on cadence, or a path that
   * could not safely attempt one.
   *
   * Two refusals earn it, and the flag deliberately does not distinguish them
   * because the operator's action is the same (#1570): a venue that cannot
   * express an entry-less protective pair AT ALL — Saxo, where every pool line
   * reports `IsOcoOrderSupported: false` (doc 43) — and a LOT that has spent
   * every re-arm wire id the venue will grant it, Alpaca having measurably
   * never released a `client_order_id` (#1346, doc 43 round 3).
   *
   * The distinction is the whole point of the page. Without it both cases
   * read "re-arming failed", and an operator who has learned that the sweep
   * usually fixes those has no way to tell the one that never will. A flag
   * chosen here, not the error's text — see the CREDENTIALS note below.
   */
  rearm_unsupported: boolean;
  /** The price levels re-arming was attempted at — the lot's own, unchanged by the resize. */
  stop: number;
  target: number;
  /** When the failed re-arm was observed. */
  observed_at: Date;
}

export interface ResidualExposureAlertChannel {
  postResidualExposureAlert(alert: ResidualExposureAlert): Promise<void>;
}
