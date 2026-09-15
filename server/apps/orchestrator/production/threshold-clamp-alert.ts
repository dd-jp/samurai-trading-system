/**
 * The operator-escalation port for #638's clamp tripping at runtime (#766).
 *
 * ## The gap this closes
 *
 * `assertThresholdsWithinBounds` (shared/threshold-bounds.ts) throws rather
 * than coerces, by design — that is what makes the clamp a refusal instead of
 * a silent downgrade. But a throw is only as audible as whatever catches it,
 * and two of the four seams it can reach caught it with a bare log line:
 *
 * - the per-cycle kill-line check (`computeMetrics`, called from
 *   `runFeedbackCycle` in production.ts) — caught, logged `daily feedback
 *   cycle failed`, nothing paged;
 * - the live-read clamp (`resolveRiskConfig`, called from
 *   `RiskManagerImpl.evaluate()` on every tick) — caught by `buildRiskStep`'s
 *   own catch (direct-bind.ts), which already exists for #726's
 *   `PerSubclassCapUnresolvableError` case, logged, and re-thrown for #507's
 *   catch in tick-loop.ts to record the crash. Nothing paged there either.
 *
 * Both are fail-closed on trading already — an out-of-bound threshold cannot
 * place an order — so this port is about DISCOVERABILITY, not safety: a run
 * in which every instrument crashes out of Risk on every tick looks, from the
 * outside, exactly like a quiet market with no setups (#625, #691's
 * signature).
 *
 * ## Why the decision is "alert and continue fail-closed"
 *
 * #766 also asks whether the live-read clamp blocks the exit and flatten
 * path, since `resolveRiskConfig` used to run before `RiskManagerImpl`'s exit
 * bypass — an out-of-bound threshold would abort an exit intent exactly like
 * an entry, stranding an open position through the close (ADR-0014's
 * load-bearing invariant). It measurably did: `evaluate()` called
 * `resolveRiskConfig` unconditionally, ahead of the `intent.intent_type ===
 * 'exit'` branch. `RiskManagerImpl.evaluate` (index.ts) now skips the
 * resolve for an exit intent — exits read no live threshold at all, so there
 * is nothing left to abort them.
 *
 * With that fixed, "alert and continue fail-closed" (the first of #766's
 * three options) is the only one that keeps a coherent run: new entries are
 * refused (the clamp doing its job), exits and the flat-by-close flatten are
 * unaffected (the fix above), and the operator is paged. Halting the run or
 * escalating to `installFaultHandlers` (which exits 1 under #714) would trade
 * a safe degraded mode for a dead process — and a dead process cannot flatten
 * anything either, so it is strictly worse, not merely equal.
 *
 * ## Same shape as `TraderDiagnosticAlertChannel`, and the same absence of a
 * log-only form
 *
 * Both catch sites already write an `error`-level log line before reaching
 * this port (`daily feedback cycle failed` in production.ts;
 * `buildRiskStep`'s own catch in direct-bind.ts). A log-only implementation
 * behind this port would duplicate that line, the same reason
 * `TraderDiagnosticAlertChannel` has none. Absent here means "no second,
 * audible copy" — never "silent": the durable record is the log line and the
 * `risk_log`/`audit_log` rows the surrounding catches already write.
 */

/** One clamp trip, at one of the two seams #766 makes audible */
export interface ThresholdClampAlert {
  /**
   * The trace the trip was observed under, threaded from the seam rather than
   * joined ambiently (#1280) — `trace-context.ts`'s "explicit remains the
   * preferred form" case. Both seams already hold the id the lines around them
   * log under: `buildRiskStep`'s catch (direct-bind.ts) holds the tick's, and
   * `runFeedbackCycle` (production.ts) holds `'feedback-cycle'`, which its own
   * surrounding lines use. Ambient would be wrong for the second: outside a
   * tick `currentTraceId()` is `undefined`, so the failed-send log would carry
   * a third label joining neither seam.
   */
  trace_id: string;
  /**
   * Which seam the violation reached. Not the full four #638 guards (boot-time
   * construction and the Feedback Loop's write door both already refuse
   * loudly at the moment of the attempt, in the caller's own stack — there is
   * no unattended gap to page on there). These two are the only ones a throw
   * lands inside a background timer or a tick with nobody watching.
   */
  where: 'live-read' | 'daily-kill-line-check';
  /**
   * The refusal's own message — carries the threshold name, the offending
   * value, and the bound it crossed (`ThresholdBoundViolationError`'s own
   * `message`, or the joined text of an aggregate crossing)
   */
  message: string;
  reported_at: Date;
}

export interface ThresholdClampAlertChannel {
  postThresholdClampAlert(alert: ThresholdClampAlert): void;
}
