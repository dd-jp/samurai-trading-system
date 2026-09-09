/**
 * The quote-unit boundary for Saxo (#1302).
 *
 * Saxo quotes some LSE lines in PENCE while reporting the line's currency as
 * `GBP`: `GET /ref/v1/instruments` (the search endpoint `lse-etp-pool.ts` was
 * built from) and `DisplayAndFormat.Currency` on `infoprices` both say `GBP`
 * for a GBX line, so neither can tell a £24.35 instrument from a £2,435 one.
 * Only `GET /ref/v1/instruments/details/{Uic}/{AssetType}` carries the unit,
 * as `PriceCurrency` (`GBX`) beside `PriceToContractFactor` (`0.01`) —
 * MEASURED on SIM 2026-09-08, `docs/research/44-saxo-data-surface.md` §2.1.
 * The invariant that endpoint publishes:
 *
 *     cash per share = quoted price x PriceToContractFactor,
 *     denominated in CurrencyCode
 *
 * So: NEVER COMPUTE CASH FROM `CurrencyCode` ALONE. Every price crossing the
 * Saxo boundary in either direction goes through one of the two functions
 * below; nothing else may compare, scale or sum a venue price against a cash
 * amount. A hand-maintained GBX flag on the pool's rows was rejected for the
 * same reason doc 44 §2.1 gives: Saxo lists 146 ETNs and 127 ETCs on
 * `LSE_ETF` against the pool's 13, so rows will be added, and a flag goes
 * stale where a field read at resolve time cannot.
 */

/**
 * The one fact a price needs to become cash. Structural rather than the whole
 * `SaxoInstrumentRef` so this module stays free of the adapter it serves.
 */
export interface SaxoQuoteUnit {
  /**
   * `PriceToContractFactor`: `0.01` on a GBX line, `1.0` on a GBP or USD one.
   * Always the venue's own value for THIS instrument — never a default, which
   * is the 100x guess this module exists to remove.
   */
  readonly price_to_contract_factor: number;
}

/** Venue quote -> cash per share, in the instrument's `CurrencyCode`. */
export function saxoCashPerShare(unit: SaxoQuoteUnit, quotedPrice: number): number {
  return quotedPrice * unit.price_to_contract_factor;
}

/**
 * Cash per share -> the number to send back to the venue on an order.
 *
 * UNVERIFIED, SIM AND LIVE (#1302 AC3): that Saxo wants order prices on a GBX
 * line in the QUOTED unit (pence) rather than in `CurrencyCode` (pounds).
 * Nothing in doc 44 or doc 43 measured the write path — every probe there was
 * on a USD line, where `PriceToContractFactor` is 1.0 and the two readings
 * coincide. This is the symmetric assumption: the unit an order price is
 * expressed in is the unit the venue quotes in. It is deliberately the only
 * place that assumption is encoded, so one live probe can flip it here alone.
 *
 * The probe that settles it: place a `Limit` on a GBX line far enough from the
 * market that it rests, read it back on `GET /port/v1/orders/me`, and compare
 * the returned `Price` with the number sent. Equal in pence confirms this
 * function; equal in pounds means delete the division.
 */
export function saxoQuotedPrice(unit: SaxoQuoteUnit, cashPrice: number): number {
  return cashPrice / unit.price_to_contract_factor;
}
