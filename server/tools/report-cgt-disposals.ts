/**
 * #1518's export: every CGT disposal on the live Saxo GIA equity book, for
 * one UK tax year, matched same-day → 30-day → Section 104 — `yarn
 * report:cgt`.
 *
 * NOT TAX ADVICE. This is a recordkeeping aid, not a filing. Every figure
 * must be verified against the operator's own broker contract notes before
 * use in a Self Assessment return — see `docs/cgt-disposal-matching.md`.
 *
 * Follows `report-arm-comparison.ts`'s shape: a pure formatter, opened
 * against the shared store only under `isMain`, so `yarn test` never touches
 * `data/`.
 */
import { isAbsolute, resolve } from 'node:path';
import { assertStorePathMatchesMode } from '../apps/orchestrator/index.js';
import {
  type CgtTaxYearReport,
  cgtReportForTaxYear,
  HMRC_30_DAY_RULE_CITATION,
  HMRC_SAME_DAY_RULE_CITATION,
  HMRC_SECTION_104_CITATION,
  matchDisposals,
  SqliteCgtFillSource,
  ukTaxYearLabel,
} from '../pipeline/cgt/index.js';
import { openSharedStore, resolveStoreMode, sharedStorePath } from '../shared/store/index.js';

function gbp(value: number): string {
  return value.toFixed(2);
}

/**
 * The current UK tax year's start year (`ukTaxYearLabel`'s inverse), the
 * default when `--tax-year` is not given.
 */
export function currentTaxYearStartYear(now: Date): number {
  const label = ukTaxYearLabel(now);
  return Number(label.slice(0, 4));
}

/** Parses `--tax-year 2025-26`; rejects anything that is not two consecutive years. */
export function parseTaxYearStartYear(argv: readonly string[], now: Date): number {
  const index = argv.indexOf('--tax-year');
  if (index === -1) return currentTaxYearStartYear(now);

  const raw = argv[index + 1];
  const match = raw !== undefined ? /^(\d{4})-(\d{2})$/.exec(raw) : null;
  if (match === null) {
    throw new Error(`--tax-year must look like 2025-26, got ${JSON.stringify(raw)}.`);
  }
  const startYear = Number(match[1]);
  const expectedEnd = (startYear + 1) % 100;
  if (Number(match[2]) !== expectedEnd) {
    throw new Error(
      `--tax-year ${raw} is not two consecutive years (expected ${startYear}-${String(expectedEnd).padStart(2, '0')}).`,
    );
  }
  return startYear;
}

/**
 * The report, as text. The store mode/path line and the disclaimer are both
 * unconditional — a paper-mode store's rows are not CGT events at all, so a
 * misfiled paper report must say so on its own page, and a report an
 * operator might hand to an accountant must say what it is not on every
 * render, not only in a doc alongside it.
 */
export function formatCgtReport(report: CgtTaxYearReport, mode: string, dbPath: string): string {
  const lines: string[] = [
    `CGT DISPOSAL REPORT — tax year ${report.taxYear} (#1518)`,
    `  store: mode=${mode} path=${dbPath}`,
    `  window: ${report.from.toISOString()} ≤ disposal date < ${report.to.toISOString()}`,
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
    '  instrument       disposal date  rule          qty      proceeds   allowable cost       gain',
  ];

  for (const d of report.disposals) {
    lines.push(
      `  ${d.instrument.padEnd(16)} ${d.disposalDate.toISOString().slice(0, 10)}    ${d.rule.padEnd(12)}` +
        `${String(d.quantity).padStart(6)}${gbp(d.proceeds).padStart(13)}${gbp(d.allowableCost).padStart(17)}${gbp(d.gain).padStart(11)}`,
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
  );

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
  const dbPath = sharedStorePath(mode);
  assertStorePathMatchesMode({ dbPath, mode });
  const db = openSharedStore(dbPath);

  const legs = new SqliteCgtFillSource(db).getLiveEquityFillLegs();
  const disposals = matchDisposals(legs);
  const report = cgtReportForTaxYear(disposals, startYear);

  console.log(formatCgtReport(report, mode, dbPath));
}
