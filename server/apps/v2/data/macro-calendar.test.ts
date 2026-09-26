import { describe, expect, it } from 'vitest';
import {
  addDays,
  MACRO_CALENDARS,
  MACRO_DAY_SIZE_FRACTION,
  macroCoverageFrom,
  macroCoverageThrough,
  macroGate,
} from './macro-calendar.js';

describe('macro calendar', () => {
  it('holds sorted unique ISO dates inside each source coverage', () => {
    for (const calendar of MACRO_CALENDARS) {
      const sorted = [...calendar.dates].sort();
      expect(calendar.dates).toEqual(sorted);
      expect(new Set(calendar.dates).size).toBe(calendar.dates.length);
      for (const date of calendar.dates) {
        expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(date <= calendar.coverageThrough).toBe(true);
        expect(date >= calendar.coverageFrom).toBe(true);
      }
    }
  });

  it('coverage is the earliest source horizon regardless of order', () => {
    expect(macroCoverageThrough()).toBe('2026-12-31');
    expect(
      macroCoverageThrough([
        { source: 'boe_mpc', coverageFrom: '2026-01-01', coverageThrough: '2027-12-31', dates: [] },
        { source: 'fomc', coverageFrom: '2026-01-01', coverageThrough: '2026-06-30', dates: [] },
      ]),
    ).toBe('2026-06-30');
    expect(macroCoverageThrough([])).toBe('0000-00-00');
  });

  it('flags FOMC, BoE and CPI days and clears an ordinary day', () => {
    expect(macroGate('2026-09-16')).toEqual({
      macroDay: true,
      covered: true,
      sources: ['fomc'],
      reason: 'macro day: fomc',
    });
    expect(macroGate('2026-09-17')).toMatchObject({ macroDay: true, sources: ['boe_mpc'] });
    expect(macroGate('2026-10-14')).toMatchObject({ macroDay: true, sources: ['bls_cpi'] });
    expect(macroGate('2026-09-25')).toEqual({
      macroDay: false,
      covered: true,
      sources: [],
      reason: 'no macro release',
    });
  });

  it('fails closed when the 30-day horizon leaves coverage', () => {
    expect(
      macroGate('2026-03-03', [
        { source: 'fomc', coverageFrom: '2026-01-01', coverageThrough: '2027-12-31', dates: ['2026-03-03'] },
        { source: 'bls_cpi', coverageFrom: '2026-01-01', coverageThrough: '2027-12-31', dates: ['2026-03-03'] },
      ]),
    ).toMatchObject({
      macroDay: true,
      sources: ['fomc', 'bls_cpi'],
      reason: 'macro day: fomc, bls_cpi',
    });
    const verdict = macroGate('2026-12-02');
    expect(verdict).toMatchObject({ macroDay: true, covered: false, sources: [] });
    expect(verdict.reason).toContain('fail-closed');
    expect(macroGate('2026-12-01').covered).toBe(true);
  });

  it('fails closed before the latest source starts', () => {
    expect(macroCoverageFrom()).toBe('2026-01-01');
    expect(
      macroCoverageFrom([
        { source: 'fomc', coverageFrom: '2026-03-01', coverageThrough: '2027-12-31', dates: [] },
        { source: 'boe_mpc', coverageFrom: '2025-01-01', coverageThrough: '2027-12-31', dates: [] },
      ]),
    ).toBe('2026-03-01');
    expect(macroCoverageFrom([])).toBe('9999-99-99');
    const verdict = macroGate('2025-12-31');
    expect(verdict).toMatchObject({ macroDay: true, covered: false, sources: [] });
    expect(verdict.reason).toBe(
      'macro calendar covers from 2026-01-01, after 2025-12-31; treating 2025-12-31 as a macro day (fail-closed)',
    );
    expect(macroGate('2026-01-01').covered).toBe(true);
  });

  it('adds calendar days across a month boundary and rejects junk', () => {
    expect(addDays('2026-09-25', 30)).toBe('2026-10-25');
    expect(addDays('2026-12-02', 30)).toBe('2027-01-01');
    expect(() => addDays('nope', 1)).toThrow(/bad ISO date/);
  });

  it('halves size on a macro day', () => {
    expect(MACRO_DAY_SIZE_FRACTION).toBe(0.5);
  });
});
