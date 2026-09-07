/**
 * Throttle for `FILLED_WITH_ZERO_SIZE` (#1087, ingest-fills.ts) — a lot
 * `reconcile()` adopted as `filled`/`partially_filled` whose `filled_size`
 * is still zero. Unthrottled, this fires on EVERY poll for as long as the
 * lot stays wedged: at the 2026-09-03 incident's 15-second cadence that is
 * thousands of identical lines over the ~14.6h the affected lot went
 * unnoticed.
 *
 * Same bounded-repeat shape as `MiCoverageMonitor` (mi-coverage.ts, #752) and
 * `TickSkipThrottle` (tick-skip-alert.ts, #1084): alert after a short grace
 * window (unlike those two, NOT the first occurrence here — see
 * `ALERT_AFTER_CONSECUTIVE_ZERO_SIZE`'s own doc), then every Nth poll while
 * the condition persists — never a new pattern.
 */

/**
 * Consecutive wedged polls required before the FIRST warning — NOT 1
 * (#1087 review, pass 2). `ingest-fills.ts`'s own doc on this branch names a
 * genuinely benign case: on the live arm, Alpaca can report `filled_qty > 0`
 * on the order a poll or two before its separate fill feed catches up, so a
 * lot "can legitimately pass through this branch once or twice and
 * self-clear." At threshold 1 that benign lag is not an edge case — it is
 * the FIRST poll of every normally-filling live-arm entry whose venue status
 * update happens to land ahead of its own fill record in the same poll,
 * which the propagation-lag comment describes as ordinary, not rare. 3
 * covers that "once or twice" with one poll of margin (45s at the 15s
 * cadence) before the detector escalates — negligible added detection
 * latency against a genuine wedge: #1087's META lot ran undetected for
 * 14.6h, not 45s.
 */
export const ALERT_AFTER_CONSECUTIVE_ZERO_SIZE = 3;

/**
 * How often the warning repeats while the lot stays wedged, counted in
 * further consecutive wedged polls after the first. Every 8th poll, the same
 * repeat interval `ALERT_REPEAT_EVERY_NO_DATA`/`ALERT_REPEAT_EVERY_DEGRADED_TICKS`
 * use — frequent enough to stay visible, rare enough that the log stream
 * (this mechanism's channel — see `FILLED_WITH_ZERO_SIZE`'s own doc) is not
 * flooded with an unbroken run of identical lines.
 */
export const ALERT_REPEAT_EVERY_ZERO_SIZE = 8;

function shouldWarnAt(consecutive: number): boolean {
  if (consecutive < ALERT_AFTER_CONSECUTIVE_ZERO_SIZE) return false;
  return (consecutive - ALERT_AFTER_CONSECUTIVE_ZERO_SIZE) % ALERT_REPEAT_EVERY_ZERO_SIZE === 0;
}

/**
 * Per-lot consecutive-poll counter, keyed by `idempotency_key` — one lot's
 * wedge says nothing about another's, unlike `TickSkipThrottle`'s single
 * whole-pass scalar. In memory and restart-clean, the same posture
 * `MiCoverageMonitor`/`TraderDiagnosticThrottle` take: a process that just
 * restarted has no evidence about the previous process's polls, and a crash
 * is already alarmed by the heartbeat's silence.
 *
 * One instance per composition root, constructed wherever that root wires
 * an `Execution` caller's dependencies — `ExecutionInput.filledZeroSizeThrottle`
 * — and threaded through every `Execution` surface built from that same
 * object: the tick-driven `execute()` step (`buildExecutionStep`,
 * production/direct-bind.ts, which rebuilds a fresh `ExecutionImpl` per
 * verdict) and the fill-sync loop's `reconcile()`/`ingestFills()` surfaces
 * (`buildExecutionSurface`, built once and held for that root's lifetime).
 * Today: `production.ts`'s live root, `control-arm-wiring.ts`'s control
 * arm, each of `smoke-run.ts`'s scenario harnesses, and
 * `place-soak-position.ts`'s probe — not a list this doc has to track,
 * since wiring the dependencies at all means constructing this too. As
 * `production.ts`'s own `filledZeroSizeThrottle:` comment puts it: one
 * throttle for that root's whole process lifetime — process-scoped, not
 * surface-scoped — so it is not scoped to any single `ExecutionImpl`,
 * including the per-verdict ones `buildExecutionStep` keeps rebuilding.
 * NOT a module-level singleton. The live and control arms are NOT the
 * collision case: `computeIdempotencyKey` (#753, idempotency-key.ts) hashes
 * `arm` into the payload for every non-live arm (`TradingArm` is only
 * `'live' | 'control'`), so the two arms' keys never collide even if one
 * instance were shared — `control-arm-wiring.ts`'s own comment gives its
 * separate throttle a different reason, process-scoped state matching each
 * root's own instance lifetime, the same symmetry `broker`/`store`/
 * `costModel` get there, not cross-arm leakage. The real collision risk is
 * a root that bypasses `computeIdempotencyKey` and hand-assigns a literal
 * `idempotency_key` instead, the way every scenario in `smoke-run.ts` and
 * every `seedPosition`/fixture helper in this directory's own test files
 * do: `smoke-run.ts`'s own restart scenario builds a SECOND throttle
 * (`restartExecutionAndReconcile`) and calls `ingestFills()` again over the
 * SAME store the first throttle already polled, using the same literal lot
 * keys — sharing one instance there would carry a pre-"restart" consecutive
 * count across the simulated restart, which the restart-clean posture above
 * exists to prevent. Every test file constructing its own throttle per test
 * guards the same thing: a handful of literal keys ('key-1', 'key-flaky',
 * …) recur across many independently-built instances in the one test
 * process, and a shared instance would leak one test's count into
 * another's.
 */
export class FilledZeroSizeThrottle {
  readonly #consecutive = new Map<string, number>();

  /**
   * Records this poll's wedged observation for one lot and reports whether
   * the warning is due. Callers must call `clear` once the lot is no longer
   * wedged (advanceLot's zero-size branch), or a lot that goes on to close
   * healthily leaves an orphaned entry here for the life of the process —
   * bounded by total positions ever opened, not by anything that recovers on
   * its own.
   */
  observe(idempotencyKey: string): { warn: boolean; consecutive: number } {
    const consecutive = (this.#consecutive.get(idempotencyKey) ?? 0) + 1;
    this.#consecutive.set(idempotencyKey, consecutive);
    return { warn: shouldWarnAt(consecutive), consecutive };
  }

  /** Clears one lot's counter — call once it is no longer observed wedged. */
  clear(idempotencyKey: string): void {
    this.#consecutive.delete(idempotencyKey);
  }
}
