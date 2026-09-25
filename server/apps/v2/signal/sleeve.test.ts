import { describe, expect, it } from 'vitest';
import type { Sleeve } from '../../../../contracts/index.js';
import { SleeveRegistry } from './sleeve.js';

const sleeve = (id: string): Sleeve => ({
  id,
  decide: () => Promise.resolve({ decisions: [], refusals: [] }),
});

describe('SleeveRegistry', () => {
  it('registers sleeves in order and lists their ids', () => {
    const registry = new SleeveRegistry();
    registry.register(sleeve('debate'));
    expect(registry.ids()).toEqual(['debate']);
    expect(registry.list().map((entry) => entry.id)).toEqual(['debate']);
  });

  it('refuses a duplicate id', () => {
    const registry = new SleeveRegistry();
    registry.register(sleeve('debate'));
    expect(() => registry.register(sleeve('debate'))).toThrow(/already registered/);
  });
});
