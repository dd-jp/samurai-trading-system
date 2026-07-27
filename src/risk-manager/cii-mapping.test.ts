import { describe, expect, it } from 'vitest';
import { countryForInstrument, trackedCountries } from './cii-mapping.js';

describe('countryForInstrument', () => {
  it('resolves a mapped instrument to its static country code', () => {
    expect(countryForInstrument('YNDX')).toBe('RU');
    expect(countryForInstrument('BABA')).toBe('CN');
  });

  it('returns null for an unmapped instrument', () => {
    expect(countryForInstrument('AAPL')).toBeNull();
  });
});

describe('trackedCountries', () => {
  it('returns the distinct country codes the mapping resolves to', () => {
    expect(new Set(trackedCountries())).toEqual(new Set(['RU', 'SA', 'CN']));
  });

  it('has no duplicates even though multiple instruments share a country', () => {
    const countries = trackedCountries();
    expect(countries).toHaveLength(new Set(countries).size);
  });
});
