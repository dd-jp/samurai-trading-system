/**
 * Deterministic idempotency-key computation — see docs/specs/trader-spec.md
 * ("The idempotency key, and why the arm is in the hash") — the authority,
 * per docs/specs/cross-spec-contracts.md §7's 2026-09-10 amendment.
 *
 * Keyed on `{ instrument, bar, side }`, plus `arm` off the live arm —
 * deliberately NOT on debate_id: the Debate Engine re-runs debates from
 * scratch on crash (no persistence, decision #10), so a debate id is
 * volatile. The market decision coordinate is stable across a re-run, so
 * Execution dedupes a replayed decision to exactly one fill (CONTEXT.md
 * idempotency invariant).
 *
 * Mirrors the hashing convention of server/pipeline/debate-engine/debate-id.ts: sha256
 * over a canonical JSON payload.
 */
import { createHash } from 'node:crypto';
import type { TradingArm } from '../../shared/index.js';

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
export type IntentSide = 'open' | 'close' | 'early_close';

/**
 * **`'early_close'` is #748's discriminator, and it is load-bearing exactly as
 * `'close'` was in #686.**
 *
 * The indicator-based early exit and the flat-by-close flatten can both fire in
 * the SAME debate bar — the bar is an hour and the flatten window is the last
 * five minutes of the session, so an early release at 15:40 and the mandatory
 * flatten at 16:25 share a bar whenever the session's last bar is the one the
 * decay landed in. Under a shared `'close'` key they hash identically, and
 * `findByKey` / the `open_positions` PK / the venue `client_order_id` all
 * suppress the SECOND — which is the flatten. That is the #686 failure verbatim:
 * a position carried overnight against ADR-0014, produced by the very change
 * that was supposed to release positions earlier.
 *
 * It suppresses the second whether or not the early exit fully closed the lot:
 * an early exit whose Risk or Verdict said `no_go`, or which closed only part of
 * the book, still writes the submission record the flatten's key would collide
 * with.
 */

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
 * value, and since #687 it PRODUCES nothing: it returns
 * `DebateResult.bar_timestamp`, the bar the Debate stage floored and hashed
 * into `debate_id`. It used to floor a `clock.now()` of its own onto the same
 * grid, which agreed with the debate's read only while both landed in the same
 * bar — a debate straddling an hour boundary keyed its intent to the NEXT bar
 * and took the key that bar's own genuine decision would need.
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
/**
 * **`arm` is #753's discriminator, and it is load-bearing for exactly the
 * reason `side` (#686) and `'early_close'` (#748) are.**
 *
 * Falsifier arm 2 runs over the SAME tape, the SAME names and the SAME bars as
 * the live arm — that is the entire point of a matched control. So on every
 * bar where the debate and the deterministic axis vote agree, the two arms
 * produce an intent for the same `(instrument, bar, side)` triple and, without
 * this field, the SAME key. `open_positions` and `closed_trades` both hold
 * `idempotency_key` as PRIMARY KEY and `execute()` gates on `findByKey`, so
 * the second arm's order would be silently deduped away — and it would be
 * deduped away *precisely on the ticks where the two arms agree*, which is the
 * subset a comparison of the two arms is most sensitive to. The loss would be
 * invisible: a suppressed control entry is indistinguishable from a control
 * that declined to trade.
 *
 * **The live arm's keys are byte-identical to their pre-#753 values**, because
 * `'live'` omits the field from the hashed payload entirely rather than
 * hashing the string `'live'`. That is deliberate and not cosmetic: every
 * `open_positions` / `closed_trades` / `flatten_submissions` row and every
 * venue-side `client_order_id` already in flight was keyed under the
 * three-field payload, and a re-keying of the live arm would make a
 * crash-restart replay re-place orders the store already holds under the old
 * key. Only the arm that did not exist before gets a new key space.
 */
export function computeIdempotencyKey(
  instrument: string,
  bar: Date,
  side: IntentSide,
  arm: TradingArm = 'live',
): string {
  const payload =
    arm === 'live'
      ? JSON.stringify({ instrument, bar: bar.toISOString(), side })
      : JSON.stringify({ instrument, bar: bar.toISOString(), side, arm });

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * **The MANDATORY flatten's key, and its coordinate is the SESSION CLOSE being
 * enforced — never a bar, never anything derived from the lot (#1389).**
 *
 * ## Why the bar coordinate was wrong for this one intent
 *
 * The flatten is not a decision taken in a bar; it is the enforcement of ONE
 * session close, and the same close is enforceable from either side of the
 * bell. #1389 extended the window `flatten_after_close_ms` past the close, so
 * a lot missed at `close − 10s` is targeted again at `close + 10s` — and under
 * the debate-bar coordinate those two ticks straddle a bar boundary whenever
 * the close sits on one (the US close, 20:00Z, sits exactly on the 1h grid).
 * Two keys for one obligation means `findByKey`, the `open_positions` PK and
 * the venue `client_order_id` all wave the second one through, and the lot is
 * flattened TWICE — sold into a short, since `executeExit` sizes to the held
 * quantity a still-unswept first flatten has not yet reduced.
 *
 * Keyed on the close instead, the two ticks hash identically and gate 3 dedups
 * across the boundary. `sessionEnd(now)` inside the window and
 * `sessionStart(now)` past it name that same instant — `withinFlattenWindow`
 * in `decide.ts` resolves which, and its `enforcing_close` is the only
 * supported way to produce this argument.
 *
 * ## Why not the lot
 *
 * Two designs anchored to lot state were built and discarded (#1389's
 * re-analysis): both admitted a second flatten against a partially-filled
 * first one, or dedupped a lot that had never been sent at all. The obligation
 * is per instrument per close, so that is what the coordinate says.
 *
 * ## Why this cannot collide with any bar-keyed key
 *
 * The payload's second field is named `session_close`, not `bar`. Two distinct
 * JSON shapes cannot serialize identically, so a flatten's key is in a
 * different key space from every `computeIdempotencyKey` value — including the
 * `'close'`-side keys the direction-flip exit still takes on the bar
 * coordinate, and the `'early_close'` keys #748 gave the decay exit.
 *
 * `arm` is omitted for `'live'` for exactly the reason it is above: the live
 * arm's keys must not be re-derived under a new payload while rows keyed the
 * old way are still in flight. This is a NEW key space for the flatten in both
 * arms, so no live row is re-keyed — the flatten of a lot that was already
 * submitted under a bar-keyed flatten key simply gets a fresh key once, at the
 * cutover, and gate 3's other two layers (`open_positions` PK, the broker
 * `client_order_id`) are untouched.
 */
export function computeFlattenIdempotencyKey(
  instrument: string,
  sessionClose: Date,
  arm: TradingArm = 'live',
): string {
  const session_close = sessionClose.toISOString();
  const payload =
    arm === 'live'
      ? JSON.stringify({ instrument, session_close, side: 'close' })
      : JSON.stringify({ instrument, session_close, side: 'close', arm });

  return createHash('sha256').update(payload).digest('hex');
}
