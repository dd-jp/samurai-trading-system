import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DAY_FIX_MAX_GAP_DAYS,
  dayFxSource,
  dayGbpUsd,
  parseBoeGbpUsdCsv,
  yearStartFxSource,
  yearStartGbpUsd,
} from './fx.js';

const FX_FILE = new URL(
  '../../../../data/bars/fx/gbpusd-boe-xudluss.snapshot.csv',
  import.meta.url,
);

const CSV = ['DATE,XUDLUSS', '30 Dec 2025,1.34', '31 Dec 2025,1.35', '02 Jan 2026,1.36', ''].join(
  '\n',
);

describe('fx', () => {
  it('parses BoE dates into ISO and keeps order', () => {
    expect(parseBoeGbpUsdCsv(CSV)).toEqual([
      { date: '2025-12-30', gbpUsd: 1.34 },
      { date: '2025-12-31', gbpUsd: 1.35 },
      { date: '2026-01-02', gbpUsd: 1.36 },
    ]);
  });

  it('fixes the year rate at the last observation on or before 1 January', () => {
    expect(yearStartGbpUsd(parseBoeGbpUsdCsv(CSV), 2026)).toBe(1.35);
    expect(yearStartGbpUsd([{ date: '2026-01-01', gbpUsd: 1.4 }], 2026)).toBe(1.4);
    expect(() => yearStartGbpUsd(parseBoeGbpUsdCsv(CSV), 2024)).toThrow(/no GBPUSD/);
  });

  it('tolerates CRLF, padding and blank lines and zero-pads single-digit days', () => {
    expect(parseBoeGbpUsdCsv('DATE,XUDLUSS\r\n 5 Jan 2026 ,1.3\r\n   \r\n')).toEqual([
      { date: '2026-01-05', gbpUsd: 1.3 },
    ]);
  });

  it('refuses a series out of date order, which every lookup by date relies on', () => {
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n02 Jan 2026,1.3\n01 Jan 2026,1.2')).toThrow(
      'fx: dates not strictly ascending at 2026-01-01 after 2026-01-02',
    );
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n02 Jan 2026,1.3\n02 Jan 2026,1.2')).toThrow(
      /not strictly ascending/,
    );
  });

  it('reads the committed BoE series in date order', () => {
    const series = parseBoeGbpUsdCsv(readFileSync(FX_FILE, 'utf8'));
    expect(series.length).toBeGreaterThan(1_000);
  });

  it('rejects a foreign header or a bad row', () => {
    expect(() => parseBoeGbpUsdCsv('')).toThrow(/unexpected header/);
    expect(() => parseBoeGbpUsdCsv('x,y\n1,2')).toThrow(/header/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n01 Jan 2026,0')).toThrow(/bad row/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\nJan 2026,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n1 Jan 26,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n1st Jan 2026,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\nx1 Jan 2026,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n1 Jan 12026,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n1 Jan 20261,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n1 jan 2026,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n,1.2')).toThrow(/unparseable/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n01 Jan 2026,abc')).toThrow(/bad row/);
    expect(() => parseBoeGbpUsdCsv('DATE,XUDLUSS\n01 Foo 2026,1.2')).toThrow(/unparseable/);
  });
});

describe('dayGbpUsd (#1947)', () => {
  const easter = [
    { date: '2026-04-02', gbpUsd: 1.31 },
    { date: '2026-04-07', gbpUsd: 1.32 },
    { date: '2026-04-08', gbpUsd: 1.33 },
  ];

  it('takes the fix of the day itself, the series’ last day included', () => {
    expect(dayGbpUsd(easter, '2026-04-07')).toEqual({
      ok: true,
      gbpUsd: 1.32,
      fixDate: '2026-04-07',
    });
    expect(dayGbpUsd(easter, '2026-04-08')).toEqual({
      ok: true,
      gbpUsd: 1.33,
      fixDate: '2026-04-08',
    });
  });

  it('takes the last fix before a day BoE publishes none, such as Easter Monday', () => {
    expect(dayGbpUsd(easter, '2026-04-06')).toEqual({
      ok: true,
      gbpUsd: 1.31,
      fixDate: '2026-04-02',
    });
  });

  it('refuses a date the series does not reach yet, rather than reuse a stale fix', () => {
    expect(dayGbpUsd(easter, '2026-04-09')).toEqual({
      ok: false,
      reason: 'BoE XUDLUSS series ends 2026-04-08, before 2026-04-09',
    });
    expect(dayGbpUsd([], '2026-04-09')).toEqual({
      ok: false,
      reason: 'BoE XUDLUSS series ends empty, before 2026-04-09',
    });
  });

  it('refuses a hole longer than any holiday gap, and a date before the series starts', () => {
    const holed = [
      { date: '2026-03-01', gbpUsd: 1.3 },
      { date: '2026-03-30', gbpUsd: 1.31 },
    ];
    expect(dayGbpUsd(holed, '2026-03-08')).toEqual({
      ok: true,
      gbpUsd: 1.3,
      fixDate: '2026-03-01',
    });
    expect(dayGbpUsd(holed, '2026-03-09')).toEqual({
      ok: false,
      reason: `no BoE XUDLUSS fix in the ${DAY_FIX_MAX_GAP_DAYS} days to 2026-03-09`,
    });
    expect(dayGbpUsd(holed, '2026-02-27')).toMatchObject({ ok: false });
  });

  it('names its sources', () => {
    expect(dayFxSource('2026-04-02')).toBe('boe-xudluss:2026-04-02');
    expect(yearStartFxSource(2026, '2025-12-31')).toBe('boe-xudluss:year-start:2026@2025-12-31');
    expect(yearStartFxSource(2026, undefined)).toBe('boe-xudluss:year-start:2026@unknown');
  });
});
