import { describe, expect, it } from 'vitest';
import { V2_CONTRACT_VERSION } from '../../../../contracts/index.js';
import { parseTaxQuery, reconcileWire, TAX_CSV_NOT_FED, taxWire } from './records.js';

describe('parseTaxQuery', () => {
  it('defaults to JSON for no year', () => {
    expect(parseTaxQuery(new URLSearchParams())).toEqual({
      ok: true,
      query: { year: null, format: 'json' },
    });
  });

  it('takes a year and a format', () => {
    expect(parseTaxQuery(new URLSearchParams('year=2026&format=csv'))).toEqual({
      ok: true,
      query: { year: 2026, format: 'csv' },
    });
  });

  it.each([
    ['year=26', 'year is invalid'],
    ['year=1999', 'year is invalid'],
    ['year=x2026', 'year is invalid'],
    ['year=2026x', 'year is invalid'],
    ['format=xlsx', 'format is invalid'],
    ['year=2026&year=2027', 'year is given more than once'],
    ['from=2026', 'unknown parameter; allowed: year, format'],
  ])('refuses %s', (raw, reason) => {
    expect(parseTaxQuery(new URLSearchParams(raw))).toEqual({ ok: false, reason });
  });
});

describe('records panels not yet fed', () => {
  it('names the owner of the reconcile log and the tax log', () => {
    expect(reconcileWire()).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      reconcile: { status: 'not-yet-fed', owner: 'Step 4 / Step 3e', ticket: '#1784' },
    });
    expect(taxWire({ year: 2026, format: 'json' })).toEqual({
      contract_version: V2_CONTRACT_VERSION,
      year: 2026,
      disposals: { status: 'not-yet-fed', owner: 'Step 4', ticket: '#1746' },
    });
    expect(TAX_CSV_NOT_FED).toBe('tax log not yet fed: Step 4 (#1746)');
  });
});
