import { describe, expect, it } from 'vitest';
import { isLseInstrument, LSE_LINES } from './lse-lines.js';

describe('LSE_LINES', () => {
  it('lists exactly the 22 committed lines (doc 70 §10.4), SGLN and SSLN the only complex ones', () => {
    expect(LSE_LINES).toHaveLength(22);
    expect(LSE_LINES.filter((line) => line.isComplex).map((line) => line.tidm)).toEqual([
      'SGLN',
      'SSLN',
    ]);
  });
});

describe('isLseInstrument', () => {
  it('recognises a committed tidm and rejects everything else, including the excluded IHCU/CMFP', () => {
    expect(isLseInstrument('ISF')).toBe(true);
    expect(isLseInstrument('SGLN')).toBe(true);
    expect(isLseInstrument('AAPL')).toBe(false);
    expect(isLseInstrument('IHCU')).toBe(false);
    expect(isLseInstrument('CMFP')).toBe(false);
  });
});
