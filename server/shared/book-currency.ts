/**
 * The book currency and its accepted quote codes (#1465) — a domain fact, not
 * a market-data-service fact, so it lives here rather than under
 * `market-data-service/`.
 *
 * Two call sites need "is this currency one the GBP book can carry without an
 * FX rate": `ingest-fills.ts`'s `warnOnNonSterlingFee` (a fill fee reported
 * outside book currency) and `universe-pool/lse-etp-pool.ts`'s
 * `isSterlingQuoted` (the second tradeable-universe gate, #1220). Before
 * #1465 the pool duplicated the code list as `STERLING_QUOTE_CODES` rather
 * than importing `market-data-service`'s `isBookCurrency`, because that
 * barrel runs `assertValidPool` at import and would pull the whole service
 * into three analysts, the MI ingest agent, and the orchestrator defaults.
 * `server/shared/` carries no such side effect, so both sites can now import
 * the one definition instead of keeping two in agreement by hand.
 *
 * `market-data-service/sources/lse-mark-source.ts` re-exports `BOOK_CURRENCY`
 * and `isBookCurrency` from here for its own existing consumers (its test,
 * the module barrel) — it is a legitimate third caller, not a duplicate.
 */

/** The account/book currency every mark and every booked fee is denominated in. */
export const BOOK_CURRENCY = 'GBP';

/**
 * Codes that mean "pence sterling" — a SUB-UNIT of `GBP`, worth exactly 1/100
 * of it.
 *
 * `GBX` is the ISO-style code the universe pool records; `GBp` (lowercase
 * `p`) is what vendor payloads probed for doc 34 actually carry; `p` appears
 * on exchange factsheets. All three name the same unit, and treating only one
 * of them as pence would silently 100x the others.
 *
 * **`GBp` differs from `GBP` by capitalisation alone and means one hundredth
 * of it**, which is why `isPenceCurrency` must be checked before any
 * case-insensitive `GBP` comparison.
 */
const PENCE_CODES: readonly string[] = ['GBX', 'gbx', 'GBp', 'p'];

/** Whether `currency` is a pence sub-unit of `BOOK_CURRENCY` — checked case-sensitively, see `PENCE_CODES`. */
export function isPenceCurrency(currency: string): boolean {
  return PENCE_CODES.includes(currency.trim());
}

/** Whether `currency` can be carried into the `BOOK_CURRENCY` book without an FX rate: pence, or GBP in any case. */
export function isBookCurrency(currency: string): boolean {
  const code = currency.trim();
  return isPenceCurrency(code) || code.toUpperCase() === BOOK_CURRENCY;
}
