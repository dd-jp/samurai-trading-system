/**
 * The MI archive's specced 90-day retention window, and the wiring that
 * makes it real (#1060).
 *
 * Follow-up from #1043/#1045: #313's observed-fill prune and the MI archive's
 * specced 90-day purge both shipped as implemented-tested-exported mechanisms
 * nothing on the shipped path ever called. #1045/PR #1050 fixed that shape for
 * `llm_call_log` with two asserted call sites at the composition root; this
 * does the same for the MI archive, which — unlike the dead code #1059 went on
 * to retire — IS written on the live path, so it grows for real.
 *
 * WHAT THE SOURCE-TEXT BLOCK BELOW PINS, AND WHAT IT DOES NOT (#1313).
 * A unit test of `MiArchiveStore.purgeOlderThan` cannot catch a missing
 * caller, because the defect is the ABSENCE of a call. Asserting the call
 * sites against the composition root's SOURCE, as this file does (mirroring
 * `llm-call-log-retention.test.ts` exactly), does not catch it either:
 * wrapping the daily `pruneMiArchiveWithLog` call site in a `/* ... *\/`
 * block comment leaves all 8 tests here green (run on this branch), because
 * the call text is still in the source the regex reads — the same gap #1306's
 * review found in `alert-delivery-failure-retention.test.ts`. So the block
 * below pins the ARGUMENT SEQUENCE and the textual placement of each call —
 * worth keeping, and all it claims.
 * That the calls RUN is pinned by execution in
 * `production/retention-wiring.test.ts`, which seeds an over-age archive row
 * and observes it purged.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MI_ARCHIVE_RETENTION_DAYS } from '../../providers/market-intelligence/index.js';
import {
  ENV_MI_ARCHIVE_RETENTION_DAYS,
  miArchiveRetentionDaysFromEnvironment,
} from './production.js';

describe('miArchiveRetentionDaysFromEnvironment', () => {
  it('defaults to the specced 90-day window when unset', () => {
    expect(miArchiveRetentionDaysFromEnvironment(undefined)).toBe(
      DEFAULT_MI_ARCHIVE_RETENTION_DAYS,
    );
    expect(DEFAULT_MI_ARCHIVE_RETENTION_DAYS).toBe(90);
  });

  it('accepts an operator override', () => {
    expect(miArchiveRetentionDaysFromEnvironment('30')).toBe(30);
    expect(miArchiveRetentionDaysFromEnvironment(' 30 ')).toBe(30);
  });

  it('treats whitespace as unset rather than as zero', () => {
    // `Number(' ')` is `0` — without the trim-to-undefined rule a stray space
    // would parse as a real, in-range window of zero days, purging the table
    // on every sweep. Same near-miss the file sink's and #1045's settings
    // both name.
    expect(miArchiveRetentionDaysFromEnvironment('   ')).toBe(DEFAULT_MI_ARCHIVE_RETENTION_DAYS);
    expect(miArchiveRetentionDaysFromEnvironment('')).toBe(DEFAULT_MI_ARCHIVE_RETENTION_DAYS);
  });

  it('refuses a malformed value instead of defaulting', () => {
    expect(() => miArchiveRetentionDaysFromEnvironment('lots')).toThrow(
      /SAMURAI_MI_ARCHIVE_RETENTION_DAYS must be an integer/,
    );
    expect(() => miArchiveRetentionDaysFromEnvironment('12.5')).toThrow(/must be an integer/);
    expect(() => miArchiveRetentionDaysFromEnvironment('-1')).toThrow(/must be an integer/);
  });

  it('refuses zero — this is a day window, not a row ceiling with its own off spelling', () => {
    expect(() => miArchiveRetentionDaysFromEnvironment('0')).toThrow(/must be an integer >= 1/);
  });

  it('names the variable an operator has to fix', () => {
    expect(ENV_MI_ARCHIVE_RETENTION_DAYS).toBe('SAMURAI_MI_ARCHIVE_RETENTION_DAYS');
    expect(() => miArchiveRetentionDaysFromEnvironment('nope')).toThrow(
      /retention window \(#1060\)/,
    );
  });
});

describe('the MI archive purge is spelled at the composition root, in full', () => {
  const source = readFileSync(fileURLToPath(new URL('./production.ts', import.meta.url)), 'utf8');

  // Matched by regex, not exact string: the formatter is free to wrap a call
  // across lines, and a retention guard that fails on reformatting would be
  // deleted by the first person it inconvenienced.
  //
  // The FULL known argument list is required, in order, rather than a lazy
  // `[\s\S]*?` scan from the function name to the trigger literal. A lazy
  // scan anchored only on the function name also matches the function's own
  // DECLARATION (whose signature contains the literal text `'startup'`) and
  // then keeps scanning forward past it — and even a scan anchored on
  // `config.miArchive` as the first argument still keeps scanning forward
  // from a MATCHING call (e.g. the daily one) straight past its own closing
  // paren into a later, unrelated `'startup')` elsewhere in the file (a
  // string literal, another call). Both were tried and both left this test
  // green after the real call site was deleted — proven by actually deleting
  // it. Requiring the full parameter sequence bounds the match to one
  // statement and nothing an unrelated later line can satisfy.
  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneMiArchiveWithLog\\(\\s*config\\.miArchive,\\s*miArchiveRetentionDays,\\s*clock,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
    );

  it('names both triggers, startup and daily, not one place only', () => {
    // Startup alone fires once when the table is smallest and never again
    // during the unattended run the window exists to bound; the daily sweep
    // alone leaves a restart-heavy loop pruning nothing.
    expect(source).toMatch(callSite('startup'));
    expect(source).toMatch(callSite('daily'));
  });

  it('spells the daily prune ABOVE the feedback cycle try block', () => {
    // Inside it, a persistently throwing `runDailyCycle` would silently
    // disable retention as well: the catch would fire every day while the
    // archive grew forever and the log showed only a feedback failure.
    const cycleStart = source.indexOf('const runFeedbackCycle =');
    expect(cycleStart).toBeGreaterThan(-1);

    const dailyPrune = source.slice(cycleStart).search(callSite('daily'));
    const firstTry = source.slice(cycleStart).indexOf('try {');

    expect(dailyPrune).toBeGreaterThan(-1);
    expect(dailyPrune).toBeLessThan(firstTry);
  });
});
