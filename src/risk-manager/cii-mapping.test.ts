import { describe, expect, it } from 'vitest';
import { countryForInstrument } from './cii-mapping.js';

describe('countryForInstrument', () => {
  it('resolves a mapped instrument to its static country code', () => {
    expect(countryForInstrument('YNDX')).toBe('RU');
    expect(countryForInstrument('BABA')).toBe('CN');
  });

  it('returns null for an unmapped instrument', () => {
    expect(countryForInstrument('AAPL')).toBeNull();
  });
});
