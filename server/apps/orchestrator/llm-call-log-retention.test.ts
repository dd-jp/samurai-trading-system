/**
 * The retention setting, and the wiring that makes it real (#1045).
 *
 * The second describe block is the reason this file exists. #313 shipped an
 * observed-fill prune — implemented, tested, exported — and never called it
 * from anything on the shipped path; it sat dead behind a green test suite
 * until #1059 retired the whole mechanism. The specced 90-day purge for the
 * MI archive went the same way and has no implementation at all. That is this
 * repo's dominant defect: a mechanism nothing reaches.
 *
 * A unit test of `pruneLlmCallLog` cannot catch it, because the defect is the
 * absence of a caller rather than a fault in the callee. So the call sites are
 * asserted directly against the composition root's source, which is crude but
 * fails loudly the day someone deletes the line during a refactor — the exact
 * event that produced #313's dead code.
 *
 * WHAT THAT BLOCK PINS, AND WHAT IT DOES NOT (#1313). Matching `production.ts`
 * as text does not catch a missing caller either: #1306's review wrapped the
 * daily `alert_delivery_failures` prune call in a `/* ... *\/` block comment
 * and every case in THAT table's source-text file stayed green, because the
 * call text is still in the source the regex reads. The block below has the
 * identical shape, so it likewise pins the ARGUMENT SEQUENCE and the textual
 * placement of each call, and claims nothing about whether they run.
 * `production/retention-wiring.test.ts` pins that by execution for
 * `alert_delivery_failures` (#1131) and the MI archive (#1060); #1313 scoped
 * `llm_call_log` out, so no test observes THIS sweep's side effect.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_LLM_CALL_ROWS } from '../../shared/store/index.js';
import { ENV_LLM_CALL_LOG_MAX_ROWS, llmCallLogMaxRowsFromEnvironment } from './production.js';

describe('llmCallLogMaxRowsFromEnvironment', () => {
  it('defaults to the shipped ceiling when unset', () => {
    expect(llmCallLogMaxRowsFromEnvironment(undefined)).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
  });

  it('accepts an operator override', () => {
    expect(llmCallLogMaxRowsFromEnvironment('250')).toBe(250);
    expect(llmCallLogMaxRowsFromEnvironment(' 250 ')).toBe(250);
  });

  it('treats whitespace as unset rather than as zero', () => {
    // `Number(' ')` is `0`. Without the trim-to-undefined rule a stray space
    // in a compose file would parse as a real, in-range ceiling of zero — the
    // near-miss documented on the file sink's identical setting (#349), which
    // is why both now share one validator.
    expect(llmCallLogMaxRowsFromEnvironment('   ')).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
    expect(llmCallLogMaxRowsFromEnvironment('')).toBe(DEFAULT_MAX_LLM_CALL_ROWS);
  });

  it('refuses a malformed value instead of defaulting', () => {
    // Fail-fast, deliberately: silently falling back would leave an operator
    // believing they had set a retention policy they had not.
    expect(() => llmCallLogMaxRowsFromEnvironment('lots')).toThrow(
      /SAMURAI_LLM_CALL_LOG_MAX_ROWS must be an integer/,
    );
    expect(() => llmCallLogMaxRowsFromEnvironment('12.5')).toThrow(/must be an integer/);
    expect(() => llmCallLogMaxRowsFromEnvironment('-1')).toThrow(/must be an integer/);
  });

  it('refuses zero, which the file sink accepts for its own setting', () => {
    // The one deliberate divergence from `SAMURAI_LOG_MAX_FILES`, where `0`
    // legally means "keep nothing". Here that intention is already spelled
    // `SAMURAI_LLM_CAPTURE=off`, and a zero ceiling would mean writing every
    // prompt to disk purely to delete it on the next sweep.
    expect(() => llmCallLogMaxRowsFromEnvironment('0')).toThrow(/must be an integer >= 1/);
  });

  it('names the variable an operator has to fix', () => {
    expect(ENV_LLM_CALL_LOG_MAX_ROWS).toBe('SAMURAI_LLM_CALL_LOG_MAX_ROWS');
    // And the message points at THIS policy, not the log sink's — the reason
    // the shared validator takes the purpose clause as an argument.
    expect(() => llmCallLogMaxRowsFromEnvironment('nope')).toThrow(/row ceiling \(#1045\)/);
  });
});

describe('the llm_call_log prune is spelled at the composition root, in full', () => {
  const source = readFileSync(fileURLToPath(new URL('./production.ts', import.meta.url)), 'utf8');

  // Matched by regex, not exact string: the formatter is free to wrap a call
  // across lines, and a retention guard that fails on reformatting would be
  // deleted by the first person it inconvenienced.
  //
  // The FULL known argument list is required, in order, rather than a lazy
  // `[\s\S]*?` scan from the function name to the trigger literal. A lazy
  // scan anchored only on the function name also matches the function's own
  // DECLARATION (whose signature contains the literal text `'startup'` by
  // way of the `trigger: 'startup' | 'daily'` parameter type) and then keeps
  // scanning forward past it into whatever `'startup')` text comes next in
  // the file — proven by actually deleting the real call site and watching
  // this test stay green. Requiring the full parameter sequence, anchored on
  // `config.db` as the first argument, bounds the match to one statement and
  // nothing an unrelated later line can satisfy. Mirrors
  // `mi-archive-retention.test.ts` (#1060).
  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneLlmCallLogWithLog\\(\\s*config\\.db,\\s*llmCallLogMaxRows,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
    );

  it('names both triggers, startup and daily, not one place only', () => {
    // Startup alone fires once when the table is smallest and never again
    // during the unattended run the ceiling exists to bound; the daily sweep
    // alone leaves a restart-heavy loop pruning nothing. Both call sites are
    // load-bearing, so both are asserted.
    expect(source).toMatch(callSite('startup'));
    expect(source).toMatch(callSite('daily'));
  });

  it('spells the sweep through the owning stage rather than a raw handle', () => {
    // The guard is default-permissive (#1048), so dropping the wrap would make
    // the prune bypass the sole-writer check silently and every other test here
    // would still pass — the exact shape this file exists to catch, one level
    // down. `llm_call_log` is the debate engine's table; the orchestrator runs
    // the sweep but does not own the rows.
    expect(source).toMatch(/pruneLlmCallLog\(\s*guardedStore\(db, 'debate-engine'\)/);
  });

  it('spells the daily prune ABOVE the feedback cycle try block', () => {
    // Inside it, a persistently throwing `runDailyCycle` would silently
    // disable retention as well: the catch would fire every day while the
    // table grew forever and the log showed only a feedback failure.
    // Housekeeping must not depend on unrelated work succeeding.
    const cycleStart = source.indexOf('const runFeedbackCycle =');
    expect(cycleStart).toBeGreaterThan(-1);

    const dailyPrune = source.slice(cycleStart).search(callSite('daily'));
    const firstTry = source.slice(cycleStart).indexOf('try {');

    expect(dailyPrune).toBeGreaterThan(-1);
    expect(dailyPrune).toBeLessThan(firstTry);
  });
});
