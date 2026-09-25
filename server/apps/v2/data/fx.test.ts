import { describe, expect, it } from 'vitest';
import { parseBoeGbpUsdCsv, yearStartGbpUsd } from './fx.js';

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
