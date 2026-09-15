/**
 * #1518's export: every CGT disposal on the live Saxo GIA equity book, for
 * one UK tax year, matched same-day → 30-day → Section 104 — `yarn
 * report:cgt`.
 *
 * NOT TAX ADVICE. This is a recordkeeping aid, not a filing. Every figure
 * must be verified against the operator's own broker contract notes before
 * use in a Self Assessment return — see `docs/cgt-disposal-matching.md`.
 *
 * Opens the store read-only (`openReadOnlyCgtStore`), unlike
 * `report-arm-comparison.ts`'s `openSharedStore` — this report must never
 * take a write handle on the live-money store or run migrations against it
 * (review round 1, check 4), so a schema gap is refused by name instead.
 */
import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import {
  assertTaxYearIsSourced,
  type CgtTaxYearReport,
  cgtReportForTaxYear,
  disposalStillInThirtyDayWindow,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  matchDisposals,
  openReadOnlyCgtStore,
  SqliteCgtFillSource,
  taxYearLabelForStartYear,
  type UnconvertedCgtFill,
  ukTaxYearLabel,
  unconvertedCgtFillsInTaxYear,
} from '../pipeline/cgt/index.js';
import { resolveStoreMode, type StoreHandle, sharedStorePath } from '../shared/store/index.js';

function gbp(value: number): string {
  return value.toFixed(2);
}

/**
 * The current UK tax year's start year (`ukTaxYearLabel`'s inverse), the
 * default when `--tax-year` is not given
 */
export function currentTaxYearStartYear(now: Date): number {
  const label = ukTaxYearLabel(now);
  return Number(label.slice(0, 4));
}

/**
 * Parses `--tax-year 2025-26`; rejects anything that is not two consecutive
 * years, and (review round 1, finding 3) anything before the tax year
 * `ANNUAL_EXEMPT_AMOUNT_GBP` is sourced for — an earlier year used a
 * different Annual Exempt Amount this report does not have on file, and
 * printing the current constant under an earlier year's heading would be a
 * confidently wrong figure on a document headed for HMRC. Delegates that
 * check to `assertTaxYearIsSourced` rather than re-deriving the same
 * condition here, so the CLI and `cgtReportForTaxYear` cannot drift apart on
 * where the cutoff is.
 */
export function parseTaxYearStartYear(argv: readonly string[], now: Date): number {
  const index = argv.indexOf('--tax-year');
  if (index === -1) return currentTaxYearStartYear(now);

  const raw = argv[index + 1];
  const match = raw !== undefined ? /^(\d{4})-(\d{2})$/.exec(raw) : null;
  if (match === null) {
    throw new Error(`--tax-year must look like 2025-26, got ${JSON.stringify(raw)}.`);
  }
  const startYear = Number(match[1]);
  if (raw !== taxYearLabelForStartYear(startYear)) {
    throw new Error(`--tax-year ${raw} is not two consecutive years.`);
  }
  assertTaxYearIsSourced(startYear);
  return startYear;
}

/**
 * Refuses a non-live store rather than printing a paper/backtest run's fills
 * under a heading that reads as the operator's real tax position (review
 * round 1, finding 16) — every other integrity fault this report can hit
 * throws rather than mis-reporting, and a misfiled paper report handed to an
 * accountant would be the worst version of that failure
 */
export function assertLiveMode(mode: string): void {
  if (mode !== 'live') {
    throw new Error(
      `CGT report: SAMURAI_MODE=${mode}, but only the LIVE store holds real disposals — a ` +
        `${mode}-mode store's fills are paper/backtest data, not CGT events. Re-run with SAMURAI_MODE=live.`,
    );
  }
}

export interface CgtReportResult {
  report: CgtTaxYearReport;
  unconverted: UnconvertedCgtFill[];
}

/**
 * Composes the whole read → match → window chain once, so a production
 * caller exists for it (this project's dominant defect class is a tested
 * mechanism nothing calls) and so a test can exercise the composed chain
 * against `:memory:` without going through `isMain`
 */
export function buildCgtReport(db: StoreHandle, startYear: number): CgtReportResult {
  const { legs, unconverted } = new SqliteCgtFillSource(db).getLiveEquityFillLegs();
  const disposals = matchDisposals(legs);
  return {
    report: cgtReportForTaxYear(disposals, startYear),
    unconverted: unconvertedCgtFillsInTaxYear(unconverted, startYear),
  };
}

/**
 * The report, as text. The store mode/path line, the disclaimer, and the
 * unconverted-fills section are all unconditional — a paper-mode store's
 * rows are not CGT events at all, an accountant needs to see what is NOT
 * covered as clearly as what is, and a report that silently dropped a
 * fill it could not price in sterling would be worse than a refusal.
 */
export function formatCgtReport(
  report: CgtTaxYearReport,
  unconverted: readonly UnconvertedCgtFill[],
  mode: string,
  dbPath: string,
  now: Date,
): string {
  const lines: string[] = [
    `CGT DISPOSAL REPORT — tax year ${report.taxYear} (#1518)`,
    `  store: mode=${mode} path=${dbPath}`,
    `  window: ${report.from.toISOString()} ≤ disposal date < ${report.to.toISOString()}`,
    `  generated: ${now.toISOString()}`,
    '',
    '  *** NOT TAX ADVICE. Verify every figure against broker contract notes',
    '  before using it in a Self Assessment return. See',
    '  docs/cgt-disposal-matching.md. ***',
    '',
    `  Share identification rules applied, in order (HMRC CGT manual):`,
    `    1. Same-day rule (${HMRC_SAME_DAY_RULE_CITATION})`,
    `    2. 30-day / bed-and-breakfast rule (${HMRC_30_DAY_RULE_CITATION})`,
    `    3. Section 104 pool (${HMRC_SECTION_104_CITATION})`,
    '',
    '  PROVISIONAL: a row marked (provisional) below is section-104-priced but',
    "  still inside its own 30-day window as of 'generated' above — an",
    '  acquisition of the same instrument before that window closes would',
    '  reclassify it (different rule, allowableCost and gain). Re-run this',
    '  report after the window closes before treating that row as final.',
    '',
    '  instrument       disposal date  acquired      rule          qty      proceeds   allowable cost       gain',
  ];

  for (const d of report.disposals) {
    const provisional =
      d.rule === 'section-104' && disposalStillInThirtyDayWindow(d.disposalDate, now);
    const acquired =
      d.acquisitionDate === undefined
        ? '-'.padEnd(10)
        : d.acquisitionDate.toISOString().slice(0, 10);
    lines.push(
      `  ${d.instrument.padEnd(16)} ${d.disposalDate.toISOString().slice(0, 10)}    ${acquired}    ${d.rule.padEnd(12)}` +
        `${String(d.quantity).padStart(6)}${gbp(d.proceeds).padStart(13)}${gbp(d.allowableCost).padStart(17)}${gbp(d.gain).padStart(11)}` +
        (provisional ? '  (provisional)' : ''),
    );
  }

  if (report.disposals.length === 0) {
    lines.push('  (no disposals in this tax year)');
  }

  lines.push(
    '',
    `  TOTAL proceeds:        ${gbp(report.totalProceeds)}`,
    `  TOTAL allowable cost:  ${gbp(report.totalAllowableCost)}`,
    `  TOTAL gain:            ${gbp(report.totalGain)}`,
    `  Annual Exempt Amount:  ${gbp(report.annualExemptAmountGbp)} (HMRC CGT allowance — NOT netted off above; the` +
      ' operator applies it, alongside any other disposals outside this system, when filing)',
    '',
    '  This report computes GAIN only. It does not compute tax owed — the rate',
    "  depends on the operator's income band, which this system has no way to",
    '  know, and stating one would be tax advice.',
    '',
    '  UNCONVERTED — FX rate not captured at fill time',
    '  These fills are NOT included in any figure above: their fee_currency is',
    '  neither GBP nor a pence sub-unit (GBX/gbx/GBp/p), and this report has no',
    '  usable transaction-date FX rate to convert them with (see the reason',
    '  column). Convert each by hand from its native-currency amount before',
    '  including it in a return.',
    '  instrument       fill date    kind          qty   native amount  native charges  currency  reason',
  );

  for (const f of unconverted) {
    lines.push(
      `  ${f.instrument.padEnd(16)} ${f.date.toISOString().slice(0, 10)}   ${f.kind.padEnd(12)}` +
        `${String(f.quantity).padStart(6)}${gbp(f.grossAmount).padStart(15)}${gbp(f.charges).padStart(16)}  ${f.currency.padEnd(8)}  ${f.fxRateToGbpSource}`,
    );
  }
  if (unconverted.length === 0) {
    lines.push('  (none this tax year)');
  }

  return lines.join('\n');
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  import.meta.url ===
    new URL(`file://${isAbsolute(invokedPath) ? invokedPath : resolve(invokedPath)}`).href;

if (isMain) {
  const startYear = parseTaxYearStartYear(process.argv.slice(2), new Date());
  const mode = resolveStoreMode();
  assertLiveMode(mode);
  const dbPath = sharedStorePath(mode);
  // Same resolution the orchestrator uses, for the reason `report-arm-
  // comparison.ts` gives: a report that opened a different database than the
  // running process writes would be confidently wrong rather than empty
  assertStorePathMatchesMode({ dbPath, mode });
  const db = openReadOnlyCgtStore(dbPath);

  const { report, unconverted } = buildCgtReport(db, startYear);
  console.log(formatCgtReport(report, unconverted, mode, dbPath, new Date()));
}
