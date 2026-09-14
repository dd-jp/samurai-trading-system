/**
 * #1518 — UK CGT disposal-matching recordkeeping for the live Saxo GIA
 * equity leg. NOT tax advice — see `docs/cgt-disposal-matching.md`.
 *
 * `server/tools/report-cgt-disposals.ts` (`yarn report:cgt`) is the caller.
 */
export {
  ANNUAL_EXEMPT_AMOUNT_GBP,
  type CgtFillLeg,
  type CgtTaxYearReport,
  cgtReportForTaxYear,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  type MatchedDisposal,
  matchDisposals,
  ukTaxYearBounds,
  ukTaxYearLabel,
} from './cgt-disposal-matching.js';
export { SqliteCgtFillSource } from './sqlite-cgt-fill-source.js';
