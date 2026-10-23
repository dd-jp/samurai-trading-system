import { describe, expect, it } from 'vitest';
import { saxoWireReference } from './saxo-wire-reference.js';

describe('saxoWireReference', () => {
  it('fits Saxo 50-character ExternalReference cap even with a leg suffix', () => {
    const reference = saxoWireReference(`drill-${'x'.repeat(200)}`);
    expect(reference).toMatch(/^[0-9a-f]{40}$/);
    expect(`${reference}:target`.length).toBeLessThanOrEqual(50);
  });

  it('is stable for one client order id and distinct across retry suffixes', () => {
    const base = 'drill-1761226500000-311';
    const references = [base, `${base}:r1`, `${base}:r2`, `${base}:flat`].map(saxoWireReference);
    expect(saxoWireReference(base)).toBe(references[0]);
    expect(new Set(references).size).toBe(references.length);
  });
});
