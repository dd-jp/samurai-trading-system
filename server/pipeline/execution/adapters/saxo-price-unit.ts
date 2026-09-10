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
 * That Saxo wants order prices on a GBX line in the QUOTED unit (pence)
 * rather than in `CurrencyCode` (pounds) is MEASURED on SIM 2026-09-10,
 * `docs/research/44-saxo-data-surface.md` §2.1a (#1444): `POST
 * /trade/v2/orders/precheck` returns `EstimatedCashRequired` in the ACCOUNT
 * currency, and it scales as `OrderPrice x PriceToContractFactor` — 0.01 on
 * LQQ3, 1.0 on the 3USL control, same fixed term on both. So the symmetric
 * assumption holds: the unit an order price is expressed in is the unit the
 * venue quotes in. STILL OWED (#1302 AC3): the in-session marketability
 * probe, which tests the matching engine rather than precheck's arithmetic,
 * and the same reading against the LIVE gateway. This stays the only place
 * the assumption is encoded, so either can flip it here alone.
 *
 * A SECOND assumption rides on the first and is still UNVERIFIED, on SIM as
 * well as live — nothing above touches it: that
 * `saxo-adapter.ts`'s `ORDER_DECIMALS` (2, from the line's `Format.OrderDecimals`)
 * is a legal rounding for the number this returns. Applied to pence that is
 * 0.0001 GBP granularity, and `OrderDecimals` states precision rather than
 * the tick grid — a correctly scaled pence price can still be off-grid.
 *
 * The probe that settles what is left: place a `Limit` on a GBX line inside
 * the LSE continuous session, far enough from the market that it rests, and
 * read it back on `GET /port/v1/orders/me`. A rejection on price or tick
 * grounds is the tick grid answering, not the unit; the grid to round onto is
 * `TickSizeScheme` on the details response, which carries no flat `TickSize`
 * field (doc 44 §2.1a).
 */
export function saxoQuotedPrice(unit: SaxoQuoteUnit, cashPrice: number): number {
  return cashPrice / unit.price_to_contract_factor;
}
