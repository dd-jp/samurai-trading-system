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
 *
 * **KNOWN GAP (#686) — the payload has no intent-kind discriminator.** Since the
 * key became stable within a bar, and since #668 put a mandatory flat-by-close
 * exit in the same bar an entry can be taken in (bars are 1h, the flatten window
 * is 5 minutes, and entries are blocked only inside that window), an entry at
 * 19:50 and the flatten at 19:56 hash to the SAME key. The flatten is second, so
 * it is the one `findByKey` / the `open_positions` PK / `client_order_id`
 * suppress — leaving a position carried overnight, which is what ADR-0014
 * forbids. Confirmed by a passing characterisation test in `decide.test.ts`, not
 * argued. Not fixed here because this payload is a `cross-spec-contracts.md` §7
 * contract and changing it requires a migration for in-flight records.
 */
export function computeIdempotencyKey(instrument: string, bar: Date): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
  });

  return createHash('sha256').update(payload).digest('hex');
}
