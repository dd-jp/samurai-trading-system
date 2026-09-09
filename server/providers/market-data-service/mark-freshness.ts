/**
 * Feed staleness — is the price we are about to act on actually current?
 *
 * ## Why this is not the staleness gate Verdict already had
 *
 * Verdict's `'staleness'` gate measures SIGNAL age: `now - decided_at` (#1190;
 * `decision_timestamp` is the bar-floored idempotency coordinate, not this),
 * i.e. how long ago *we* decided. This measures FEED age: `readAt -
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
 * How far a mark may be observed AHEAD of the instant it was RECEIVED before
 * `classifyMarkFreshness` calls it a venue-vs-us clock disagreement.
 *
 * Measured against the read instant, a forward offset can no longer be our own
 * elapsed time: the mark was already in hand when that instant was taken, so
 * whatever is still ahead of it is the venue's stamp disagreeing with our
 * clock. What remains to absorb is receipt-side slop — the stamp is made at
 * the venue, this instant is taken after the response is parsed, and a quote
 * stamped a moment ahead by a venue running slightly fast is not a fault. Five
 * seconds covers that with room while staying far below a genuine skew, which
 * shows up in minutes.
 *
 * Its own named constant rather than folded into `maxAgeMs`: the two bound
 * different things — this one caps CLOCK disagreement, `maxAgeMs` caps how OLD
 * a mark may be.
 */
export const MARK_CLOCK_SKEW_TOLERANCE_MS = 5_000;

/**
 * How old `mark` is at `readAt`, in milliseconds.
 *
 * Negative when the mark is stamped ahead of `readAt`. Callers must not read a
 * negative age as "very fresh" on their own — leave that to
 * `classifyMarkFreshness`, which separates receipt slop from real skew.
 */
export function markAgeMs(mark: Mark, readAt: Date): number {
  return readAt.getTime() - mark.observed_at.getTime();
}

/**
 * Why a mark may not be acted on — or that it may.
 *
 * `stale` and `ahead` are separate members because they call for opposite
 * responses: `stale` means the market has gone quiet and the price in hand has
 * stopped being true, `ahead` means our clock and the venue's disagree and
 * every other time comparison in the pass is suspect with it. A boolean
 * collapsed the two, and the collapsed form is what let a refusal report the
 * wrong cause. The numbers ride along so a caller can say BY HOW MUCH without
 * re-deriving the arithmetic.
 */
export type MarkFreshness =
  | { status: 'fresh'; age_ms: number }
  | { status: 'stale'; age_ms: number; bound_ms: number }
  | { status: 'ahead'; age_ms: number; tolerance_ms: number };

/**
 * Judges `mark` against `readAt` — THE INSTANT THE MARK WAS RECEIVED, not the
 * tick's `asOf` (#1111).
 *
 * ## Why the read instant, and not a wider forward tolerance (#939's option 2)
 *
 * #939 ranked three fixes for a mark stamped after the tick's `asOf` and took
 * the first: a constant forward tolerance, 5000ms, calibrated against two
 * observations of 149ms and 1083ms. What that constant bounds is the elapsed
 * time between `asOf` and the read, and that is not a constant — the
 * 2026-09-04 paper session produced 67 such refusals, from 5020ms to 145s
 * ahead, not one of them a mark past its own age bound, because the
 * valuation's mark batch itself was taking minutes. Any constant loses this
 * race at the next latency step; #939 said as much when it noted the artifact
 * "gets worse under load".
 *
 * `readAt` removes the dependence rather than re-tuning it. Freshness asks how
 * old the price is AT THE MOMENT IT IS USED, which is when the read returned.
 * That is a different question from `asOf`, which is the point-in-time
 * coordinate for WHICH data may be used — and `asOf` keeps that meaning
 * untouched for every other consumer (bar windows, the indicator cache key,
 * the account and volatility reads). This adds a second coordinate, read by
 * this predicate alone; it does not redefine the first.
 *
 * Option 3 (clamp forward-stamped marks at the source, as `getSpreadEstimate`
 * does) was rejected here: clamping makes a genuine skew unrepresentable, so
 * it would be silently absorbed rather than reported. `getSpreadEstimate` can
 * afford that because it declines one optional value; this predicate is what
 * refuses to value the book.
 *
 * The change is STRICTLY MORE CONSERVATIVE in the stale direction — `readAt`
 * is never earlier than `asOf`, so every age computed here is at least as
 * large as the one the old coordinate gave. #640's refusal is tightened by
 * this, not weakened.
 *
 * A `maxAgeMs` of 0 or less is rejected as a configuration error rather than
 * silently making every mark stale. That shape is how a gate becomes a
 * kill-switch nobody meant to arm: an omitted config key reads as 0 under
 * `Record` lookup, and "the system stopped trading and logged stale_feed on
 * every tick" is a very expensive way to discover a typo.
 */
export function classifyMarkFreshness(mark: Mark, readAt: Date, maxAgeMs: number): MarkFreshness {
  if (!(maxAgeMs > 0)) {
    throw new Error(
      `classifyMarkFreshness: max mark age must be a positive number of milliseconds, got ` +
        `${maxAgeMs}. A non-positive bound would make every mark stale and halt trading ` +
        'entirely; if that is what you want, stop the process rather than configuring a gate ' +
        'to reject forever.',
    );
  }

  const age_ms = markAgeMs(mark, readAt);
  if (age_ms < -MARK_CLOCK_SKEW_TOLERANCE_MS) {
    return { status: 'ahead', age_ms, tolerance_ms: MARK_CLOCK_SKEW_TOLERANCE_MS };
  }
  if (age_ms > maxAgeMs) {
    return { status: 'stale', age_ms, bound_ms: maxAgeMs };
  }
  return { status: 'fresh', age_ms };
}
