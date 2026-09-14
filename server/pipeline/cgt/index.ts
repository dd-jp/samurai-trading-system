/**
 * #1518 — UK CGT disposal-matching recordkeeping for the live Saxo GIA
 * equity leg. NOT tax advice — see `docs/cgt-disposal-matching.md`.
 *
 * `server/tools/report-cgt-disposals.ts` (`yarn report:cgt`) is the caller.
 */
export {
  ANNUAL_EXEMPT_AMOUNT_GBP,
  ANNUAL_EXEMPT_AMOUNT_SOURCED_FROM_TAX_YEAR,
  assertTaxYearIsSourced,
  type CgtFillLeg,
  type CgtTaxYearReport,
  cgtReportForTaxYear,
  disposalStillInThirtyDayWindow,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  type MatchedDisposal,
  matchDisposals,
  THIRTY_DAY_WINDOW_MS,
  taxYearLabelForStartYear,
  type UnconvertedCgtFill,
  ukTaxYearBounds,
  ukTaxYearLabel,
  unconvertedCgtFillsInTaxYear,
} from './cgt-disposal-matching.js';
export { openReadOnlyCgtStore } from './open-readonly-cgt-store.js';
export { type CgtFillLegs, SqliteCgtFillSource } from './sqlite-cgt-fill-source.js';
