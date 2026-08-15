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
 * How old `mark` is at `now`, in milliseconds.
 *
 * Can be NEGATIVE: a mark observed after `now` is a clock disagreement between
 * this process and the venue, not a fresh mark. Callers must treat that as its
 * own failure rather than as "very fresh" — `isMarkStale` does.
 */
export function markAgeMs(mark: Mark, now: Date): number {
  return now.getTime() - mark.observed_at.getTime();
}

/**
 * True when `mark` must not be acted on: older than `maxAgeMs`, OR observed in
 * the future.
 *
 * The future case is deliberately folded in here rather than left to each
 * caller. An `observed_at` ahead of our clock means one of the two clocks is
 * wrong, and neither answer is safe: if OUR clock is behind, the mark may be
 * genuinely fine, but every other time comparison in the pass — signal age,
 * the flatten window, the bar coordinate — is also being computed against a
 * clock we have just caught being wrong. Refusing costs one tick; trusting it
 * means trading on arithmetic we have direct evidence against.
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
  return age < 0 || age > maxAgeMs;
}
