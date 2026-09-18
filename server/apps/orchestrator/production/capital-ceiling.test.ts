import { toCapitalCeilingUsd } from './capital-ceiling.js';

describe('toCapitalCeilingUsd', () => {
  it('returns the figure unchanged when it is positive and finite', () => {
    expect(toCapitalCeilingUsd(2_000, 'test')).toBe(2_000);
    expect(toCapitalCeilingUsd(0.5, 'test')).toBe(0.5);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -1_000],
  ])('refuses %s — `Math.min` would otherwise size off it silently (#569)', (_label, value) => {
    expect(() => toCapitalCeilingUsd(value, 'test')).toThrow(/positive, finite number/);
  });

  it('names the caller-supplied source, not a variable the value never came from', () => {
    expect(() => toCapitalCeilingUsd(0, 'liveStartingProfile(ceilingUsd)')).toThrow(
      /liveStartingProfile\(ceilingUsd\)/,
    );
  });
});
