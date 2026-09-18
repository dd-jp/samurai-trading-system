import {
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS_CEILING,
} from '../../providers/market-intelligence/index.js';
import { positiveIntegerFromEnv } from '../../shared/index.js';
import { ENV_X_MAX_SEARCH_RESULTS } from './production/environment.js';

function readDial(raw: string | undefined): number {
  return positiveIntegerFromEnv(
    raw,
    ENV_X_MAX_SEARCH_RESULTS,
    DEFAULT_MAX_SEARCH_RESULTS,
    1,
    'test',
  );
}

describe('SAMURAI_X_MAX_RESULTS', () => {
  it('names the variable an operator actually types', () => {
    expect(ENV_X_MAX_SEARCH_RESULTS).toBe('SAMURAI_X_MAX_RESULTS');
  });

  it('falls back to the default when unset or blank', () => {
    expect(readDial(undefined)).toBe(DEFAULT_MAX_SEARCH_RESULTS);
    expect(readDial('   ')).toBe(DEFAULT_MAX_SEARCH_RESULTS);
  });

  it('accepts a real value, whitespace and all', () => {
    expect(readDial('5')).toBe(5);
    expect(readDial(' 5 ')).toBe(5);
  });

  it('REFUSES a malformed value rather than defaulting, naming the variable', () => {
    expect(() => readDial('ten')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('0')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('-1')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('2.5')).toThrow(/SAMURAI_X_MAX_RESULTS/);
  });

  it('does NOT refuse a value above the ceiling — that one clamps', () => {
    expect(readDial('100')).toBe(100);
    expect(MAX_SEARCH_RESULTS_CEILING).toBeLessThan(100);
  });
});
