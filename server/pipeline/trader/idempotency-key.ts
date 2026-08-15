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
 * Which SIDE of a position the intent is on — the discriminator, deliberately
 * coarser than `intent_type`.
 *
 * `entry` and `scale_in` collapse to one value on purpose. Hashing the full
 * `intent_type` would be more precise and **less safe**: within a single bar the
 * first tick can produce an `entry` and a later tick a `scale_in` (the position
 * now exists), and under a three-way key those are two different keys, so a
 * crash-replay of that bar would place BOTH rather than dedupe to one. Grouping
 * the opening intents keeps exactly the within-bar collapse #616 and #617 were
 * protecting, and separates only the closing side — which is the one that must
 * never be suppressed.
 */
export type IntentSide = 'open' | 'close';

/**
 * The opening/closing side of an intent type.
 *
 * The parameter union is spelled out rather than imported: `intent_type` is
 * declared inline in both `shared/types/records.ts` and
 * `shared/decision-records.ts` and has no shared named type, so importing one
 * would mean minting a contract type as a side effect of this fix.
 */
export function intentSideFor(intentType: 'entry' | 'scale_in' | 'exit'): IntentSide {
  return intentType === 'exit' ? 'close' : 'open';
}

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
 * **FIXED (#686) — the payload now carries `side`, an open/close discriminator.**
 * Before it did not, and once the key became stable within a bar (#616) while
 * #668 put a mandatory flat-by-close exit into a bar an entry can also be taken
 * in (bars are 1h, the flatten window is 5 minutes, and entries are blocked only
 * *inside* that window), an entry at 19:50 and the flatten at 19:56 hashed to the
 * SAME key. The flatten was second, so it was the one `findByKey` / the
 * `open_positions` PK / `client_order_id` suppressed — leaving a position carried
 * overnight, which ADR-0014 forbids outright and which #668 exists to prevent.
 * On a 3x leveraged ETP (ADR-0016's universe) that is the worst outcome the
 * intraday horizon has.
 */
export function computeIdempotencyKey(instrument: string, bar: Date, side: IntentSide): string {
  const payload = JSON.stringify({
    instrument,
    bar: bar.toISOString(),
    side,
  });

  return createHash('sha256').update(payload).digest('hex');
}
