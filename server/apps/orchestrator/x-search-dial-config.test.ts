/**
 * The composition root's reading of `SAMURAI_X_MAX_RESULTS` (#969).
 *
 * This branch originally shipped its own `readPositiveInteger` beside the
 * shared `positiveIntegerFromEnv` that landed on main (#1045) while it was
 * open. Two validators for the same shape is precisely what `env-integer.ts`'s
 * header argues against — "how two env vars in one system come to disagree
 * about whether `"abc"` means abc, the default, or 0" — so the branch-local
 * one was deleted at the merge rather than kept.
 *
 * The two behaviours below are what that decision buys, and they differ on
 * purpose. Unusable input REFUSES; excessive input CLAMPS. The distinction is
 * about what the operator plausibly meant: `ten` is a mistake with no
 * defensible reading, while `100` is a well-formed integer someone may well
 * have meant as "as many as you can" — and refusing to boot a trading process
 * over the second would be worse than capping it and saying so.
 *
 * The clamp itself is pinned in `x-search-client.test.ts` ("clamps an operator
 * result count above the ceiling, loudly"); this file pins the env end, which
 * nothing else reaches on the shipped path.
 */
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS_CEILING,
} from '../../providers/market-intelligence/index.js';
import { positiveIntegerFromEnv } from '../../shared/index.js';
import { ENV_X_MAX_SEARCH_RESULTS } from './production/environment.js';

/** The call the composition root makes, kept in one place so it cannot drift */
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
    // A rename here silently stops reading the operator's setting while every
    // test that passes the value directly keeps passing
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
    // The behaviour the branch-local validator did not have: it returned
    // `undefined` and the run continued at 3. A spend dial that silently
    // ignores what the operator typed is the failure worth being loud about —
    // they meant to change the cost and would find out days later that
    // nothing changed
    expect(() => readDial('ten')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('0')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('-1')).toThrow(/SAMURAI_X_MAX_RESULTS/);
    expect(() => readDial('2.5')).toThrow(/SAMURAI_X_MAX_RESULTS/);
  });

  it('does NOT refuse a value above the ceiling — that one clamps', () => {
    // The asymmetry, asserted so it cannot be "tidied" into consistency:
    // parsing lets 100 through, and `XSearchClient` caps it at 10 with a
    // warning. Making this throw would be a boot failure over a value with a
    // sensible reading
    expect(readDial('100')).toBe(100);
    expect(MAX_SEARCH_RESULTS_CEILING).toBeLessThan(100);
  });
});
