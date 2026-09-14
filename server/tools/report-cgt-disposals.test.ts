import { cgtReportForTaxYear } from '../pipeline/cgt/index.js';
import {
  currentTaxYearStartYear,
  formatCgtReport,
  parseTaxYearStartYear,
} from './report-cgt-disposals.js';

describe('parseTaxYearStartYear', () => {
  it('defaults to the current UK tax year when --tax-year is absent', () => {
    expect(parseTaxYearStartYear([], new Date('2025-06-01T00:00:00Z'))).toBe(2025);
    expect(parseTaxYearStartYear([], new Date('2025-02-01T00:00:00Z'))).toBe(2024);
  });

  it('parses an explicit --tax-year', () => {
    expect(parseTaxYearStartYear(['--tax-year', '2023-24'], new Date())).toBe(2023);
  });

  it('rejects a malformed or non-consecutive --tax-year rather than silently defaulting', () => {
    expect(() => parseTaxYearStartYear(['--tax-year', '2023'], new Date())).toThrow();
    expect(() => parseTaxYearStartYear(['--tax-year', '2023-25'], new Date())).toThrow();
  });
});

describe('currentTaxYearStartYear', () => {
  it('is 6 April boundary-exact', () => {
    expect(currentTaxYearStartYear(new Date('2025-04-05T23:59:00Z'))).toBe(2024);
    expect(currentTaxYearStartYear(new Date('2025-04-06T00:00:00Z'))).toBe(2025);
  });
});

describe('formatCgtReport', () => {
  it('always prints the not-tax-advice disclaimer and the HMRC citations, even for an empty report', () => {
    const report = cgtReportForTaxYear([], 2025);
    const text = formatCgtReport(report, 'paper', '/tmp/samurai-paper.db');

    expect(text).toContain('NOT TAX ADVICE');
    expect(text).toContain('CG51560');
    expect(text).toContain('CG51570');
    expect(text).toContain('CG51575');
    expect(text).toContain('mode=paper');
    expect(text).toContain('(no disposals in this tax year)');
  });
});
