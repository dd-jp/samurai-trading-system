export type MacroSource = 'fomc' | 'boe_mpc' | 'bls_cpi' | 'bls_employment' | 'ons_cpi';

export interface MacroSourceCalendar {
  readonly source: MacroSource;
  readonly coverageFrom: string;
  readonly coverageThrough: string;
  readonly dates: readonly string[];
}

// Verified 2026-09-25 against federalreserve.gov (FOMC, decision = second meeting day),
// bankofengland.co.uk (MPC), bls.gov (2026 CPI, Employment Situation) and ons.gov.uk (UK CPI, read
// from 2026-10-21 on; Jul–Sep 2026 releases were not retrievable, so replay there under-gates)
// 2027 FOMC verified 2026-09-29 (tentative until confirmed at the preceding meeting). bls.gov
// published no 2027 schedule on 2026-09-29, so BLS coverageThrough stays 2026-12-31; never
// extrapolate BLS dates. coverageThrough is where each published schedule ends
export const MACRO_CALENDARS: readonly MacroSourceCalendar[] = [
  {
    source: 'fomc',
    coverageFrom: '2026-01-01',
    coverageThrough: '2027-12-31',
    dates: [
      '2026-01-28',
      '2026-03-18',
      '2026-04-29',
      '2026-06-17',
      '2026-07-29',
      '2026-09-16',
      '2026-10-28',
      '2026-12-09',
      '2027-01-27',
      '2027-03-17',
      '2027-04-28',
      '2027-06-09',
      '2027-07-28',
      '2027-09-15',
      '2027-10-27',
      '2027-12-08',
    ],
  },
  {
    source: 'boe_mpc',
    coverageFrom: '2026-01-01',
    coverageThrough: '2027-12-31',
    dates: [
      '2026-02-05',
      '2026-03-19',
      '2026-04-30',
      '2026-06-18',
      '2026-07-30',
      '2026-09-17',
      '2026-11-05',
      '2026-12-17',
      '2027-02-04',
      '2027-03-18',
      '2027-04-29',
      '2027-06-17',
      '2027-07-29',
      '2027-09-16',
      '2027-11-04',
      '2027-12-16',
    ],
  },
  {
    source: 'bls_cpi',
    coverageFrom: '2026-01-01',
    coverageThrough: '2026-12-31',
    dates: [
      '2026-01-13',
      '2026-02-13',
      '2026-03-11',
      '2026-04-10',
      '2026-05-12',
      '2026-06-10',
      '2026-07-14',
      '2026-08-12',
      '2026-09-11',
      '2026-10-14',
      '2026-11-10',
      '2026-12-10',
    ],
  },
  {
    source: 'bls_employment',
    coverageFrom: '2026-01-01',
    coverageThrough: '2026-12-31',
    dates: [
      '2026-01-09',
      '2026-02-11',
      '2026-03-06',
      '2026-04-03',
      '2026-05-08',
      '2026-06-05',
      '2026-07-02',
      '2026-08-07',
      '2026-09-04',
      '2026-10-02',
      '2026-11-06',
      '2026-12-04',
    ],
  },
  {
    source: 'ons_cpi',
    coverageFrom: '2026-01-01',
    coverageThrough: '2027-12-31',
    dates: [
      '2026-02-18',
      '2026-03-25',
      '2026-04-22',
      '2026-05-20',
      '2026-06-17',
      '2026-10-21',
      '2026-11-18',
      '2026-12-16',
      '2027-01-20',
      '2027-02-17',
      '2027-03-24',
      '2027-04-21',
      '2027-05-19',
      '2027-06-16',
      '2027-07-21',
      '2027-08-18',
      '2027-09-15',
      '2027-10-20',
      '2027-11-17',
      '2027-12-15',
    ],
  },
];

const MACRO_COVERAGE_HORIZON_DAYS = 30;
export const MACRO_DAY_SIZE_FRACTION = 0.5;

export interface MacroGateVerdict {
  readonly macroDay: boolean;
  readonly covered: boolean;
  readonly sources: readonly MacroSource[];
  readonly reason: string;
}

const MS_PER_DAY = 86_400_000;

export function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) throw new Error(`addDays: bad ISO date ${isoDate}`);
  return new Date(ms + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function macroCoverageThrough(
  calendars: readonly MacroSourceCalendar[] = MACRO_CALENDARS,
): string {
  return calendars.map((calendar) => calendar.coverageThrough).sort()[0] ?? '0000-00-00';
}

export function macroCoverageFrom(
  calendars: readonly MacroSourceCalendar[] = MACRO_CALENDARS,
): string {
  return (
    calendars
      .map((calendar) => calendar.coverageFrom)
      .sort()
      .at(-1) ?? '9999-99-99'
  );
}

export function macroGate(
  tradingDate: string,
  calendars: readonly MacroSourceCalendar[] = MACRO_CALENDARS,
): MacroGateVerdict {
  const from = macroCoverageFrom(calendars);
  if (tradingDate < from) {
    return {
      macroDay: true,
      covered: false,
      sources: [],
      reason: `macro calendar covers from ${from}, after ${tradingDate}; treating ${tradingDate} as a macro day (fail-closed)`,
    };
  }
  const horizon = addDays(tradingDate, MACRO_COVERAGE_HORIZON_DAYS);
  const coverage = macroCoverageThrough(calendars);
  if (horizon > coverage) {
    return {
      macroDay: true,
      covered: false,
      sources: [],
      reason: `macro calendar covers through ${coverage}, short of ${horizon}; treating ${tradingDate} as a macro day (fail-closed)`,
    };
  }
  const sources = calendars
    .filter((calendar) => calendar.dates.includes(tradingDate))
    .map((calendar) => calendar.source);
  return {
    macroDay: sources.length > 0,
    covered: true,
    sources,
    reason: sources.length > 0 ? `macro day: ${sources.join(', ')}` : 'no macro release',
  };
}
