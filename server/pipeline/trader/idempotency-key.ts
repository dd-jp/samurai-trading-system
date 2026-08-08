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
 * `bar` must be the decision bar's coordinate (the mark's observation time /
 * last completed bar's close_time) and never `clock.now()` — wall-clock
 * differs on a crash-restart re-run of the same bar, which would defeat the
 * whole point of the key.
 */
export function computeIdempotencyKey(instrument: string, bar: Date): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
  });

  return createHash('sha256').update(payload).digest('hex');
}
