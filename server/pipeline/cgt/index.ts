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
