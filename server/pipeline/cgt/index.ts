/**
 * #1518 — UK CGT disposal-matching recordkeeping for the live Saxo GIA
 * equity leg. NOT tax advice — see `docs/cgt-disposal-matching.md`.
 *
 * `server/tools/report-cgt-disposals.ts` (`npm run report:cgt`) is the caller.
 */
export {
  assertTaxYearIsSourced,
  type CgtTaxYearReport,
  cgtReportForTaxYear,
  disposalStillInThirtyDayWindow,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  matchDisposals,
  taxYearLabelForStartYear,
  type UnconvertedCgtFill,
  ukTaxYearLabel,
  unconvertedCgtFillsInTaxYear,
} from './cgt-disposal-matching.js';
export { openReadOnlyCgtStore } from './open-readonly-cgt-store.js';
export { SqliteCgtFillSource } from './sqlite-cgt-fill-source.js';
