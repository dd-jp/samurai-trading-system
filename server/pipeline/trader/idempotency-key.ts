/**
 * Deterministic idempotency-key computation — see docs/specs/trader-spec.md
 * ("Key Interfaces" → OrderIntent.idempotency_key) and
 * docs/specs/cross-spec-contracts.md §7.
 *
 * Keyed on (instrument + bar), deliberately NOT on debate_id: the Debate
 * Engine re-runs debates from scratch on crash (no persistence, decision
 * #10), so a debate id is volatile. The market decision coordinate is stable
 * across a re-run, so Execution dedupes a replayed decision to exactly one
 * fill (CONTEXT.md idempotency invariant).
 *
 * Mirrors the hashing convention of server/pipeline/debate-engine/debate-id.ts: sha256
 * over a canonical JSON payload.
 */
import { createHash } from 'node:crypto';

/**
 * `bar` must be the decision bar's coordinate — a value on the BAR GRID, which
 * every tick sharing that bar computes identically. Never a raw wall-clock or
 * wire timestamp: both differ on a crash-restart re-run of the same bar, which
 * would defeat the whole point of the key.
 *
 * **CORRECTED (#616).** This previously read "(the mark's observation time /
 * last completed bar's close_time)", presenting those two as equivalent. They
 * are not, and that sentence is what licensed the call site that broke the
 * guarantee: in backtest the mark's observation time IS derived from the bar,
 * but in paper and live it is the venue's latest-quote wire timestamp at
 * millisecond resolution, so it changes on every tick. Every key-based dedup
 * layer — `findByKey`, the `open_positions` PK, the broker `client_order_id` —
 * was inert in production while the backtest path kept the invariant looking
 * held.
 *
 * `decisionBarFor` in `decide.ts` is the one supported way to produce this
 * value; it floors `clock.now()` onto the same grid `debate_id` uses.
 */
export function computeIdempotencyKey(instrument: string, bar: Date): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
  });

  return createHash('sha256').update(payload).digest('hex');
}
