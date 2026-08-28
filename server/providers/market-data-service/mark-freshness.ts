/**
 * Feed staleness — is the price we are about to act on actually current?
 *
 * ## Why this is not the staleness gate Verdict already had
 *
 * Verdict's `'staleness'` gate measures SIGNAL age: `now - decision_timestamp`,
 * i.e. how long ago *we* decided. This measures FEED age: `now -
 * mark.observed_at`, i.e. how long ago the *market* last spoke. They fail
 * independently, and the second is the one nothing checked. A signal decided
 * four seconds ago against a mark last observed at yesterday's close passes the
 * signal gate cleanly and is exactly the trade nobody wants placed.
 *
 * Feed staleness is not hypothetical on this universe. ADR-0016's LSE
 * leveraged ETPs are thin: an instrument can go many minutes between prints
 * inside a live session, and a halted or delisted name simply stops printing
 * while `getMark` keeps answering with the last trade it saw. `getMark` also
 * serves from a TTL cache in live mode, so its answer can be older than the
 * call that produced it, and the returned `Mark` carries no indication of
 * which case it is — only `observed_at` distinguishes them.
 *
 * ## One predicate, two bounds
 *
 * Verdict and the Risk Manager's portfolio valuation both need this, and both
 * carry their OWN bound (`VerdictConfig.max_mark_age`,
 * `PortfolioAccountingInput.max_mark_age`) rather than sharing one config
 * object: they gate different things — one instrument's mark at fire time
 * versus every held instrument's valuation mark — and threading a shared
 * structure through two different dependency graphs buys nothing. What is
 * shared is the arithmetic, so the two cannot disagree about what "age" means.
 */
import type { Mark } from './types.js';

/**
 * How far a mark may be observed AHEAD of `now` before `isMarkStale` treats it
 * as a clock disagreement rather than pass latency (#939).
 *
 * `now` (the `asOf` a caller passes in) is typically the tick's START instant,
 * while a mark is read some milliseconds or seconds later in the SAME pass —
 * a data source that stamps `observed_at` from a live quote clock (e.g.
 * `AlpacaDataSource`, from the venue's own quote timestamp) then legitimately
 * produces a mark "ahead" of `now` by however long the pass has taken so far.
 * That is ordering by construction, not evidence either clock is wrong.
 *
 * A few seconds comfortably covers realistic pass latency (soak observed
 * 149ms and 1083ms) while staying far below a genuine venue-vs-us skew, which
 * shows up in minutes, not milliseconds. Kept as its own named constant
 * rather than folded into `maxAgeMs` — the two bound different things: this
 * one caps ORDERING slop within a pass, `maxAgeMs` caps how OLD a mark may be.
 */
export const MARK_FORWARD_TOLERANCE_MS = 5_000;

/**
 * How old `mark` is at `now`, in milliseconds.
 *
 * Can be NEGATIVE: a mark observed after `now` is either normal pass latency
 * (within `MARK_FORWARD_TOLERANCE_MS`, see `isMarkStale`) or a genuine clock
 * disagreement between this process and the venue, not a fresh mark. Callers
 * must not treat a negative age as "very fresh" on their own — leave that
 * distinction to `isMarkStale`, which applies the tolerance.
 */
export function markAgeMs(mark: Mark, now: Date): number {
  return now.getTime() - mark.observed_at.getTime();
}

/**
 * True when `mark` must not be acted on: older than `maxAgeMs`, OR observed
 * further ahead of `now` than `MARK_FORWARD_TOLERANCE_MS` allows.
 *
 * The forward case is deliberately folded in here rather than left to each
 * caller, but it is NOT a bare `age < 0` check (#939). `now` is typically a
 * tick-start `asOf`, and marks are read later in the same pass, so a mark
 * legitimately lands a few hundred milliseconds "ahead" of `now` on every
 * busy tick — that is our own pipeline latency, not two clocks disagreeing.
 * Only once the mark is ahead by more than `MARK_FORWARD_TOLERANCE_MS` does
 * this stop being explainable by ordering and start being evidence that one
 * of the two clocks is actually wrong: if OUR clock is behind, the mark may
 * be genuinely fine, but every other time comparison in the pass — signal
 * age, the flatten window, the bar coordinate — is also being computed
 * against a clock we have just caught being wrong. Refusing costs one tick;
 * trusting it means trading on arithmetic we have direct evidence against.
 *
 * A `maxAgeMs` of 0 or less is rejected as a configuration error rather than
 * silently making every mark stale. That shape is how a gate becomes a
 * kill-switch nobody meant to arm: an omitted config key reads as 0 under
 * `Record` lookup, and "the system stopped trading and logged stale_feed on
 * every tick" is a very expensive way to discover a typo.
 */
export function isMarkStale(mark: Mark, now: Date, maxAgeMs: number): boolean {
  if (!(maxAgeMs > 0)) {
    throw new Error(
      `isMarkStale: max mark age must be a positive number of milliseconds, got ${maxAgeMs}. ` +
        'A non-positive bound would make every mark stale and halt trading entirely; if that ' +
        'is what you want, stop the process rather than configuring a gate to reject forever.',
    );
  }

  const age = markAgeMs(mark, now);
  return age < -MARK_FORWARD_TOLERANCE_MS || age > maxAgeMs;
}
