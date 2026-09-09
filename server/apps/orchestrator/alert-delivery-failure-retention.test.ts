/**
 * `alert_delivery_failures`'s retention window, and the wiring that makes it
 * real (#1131).
 *
 * Follow-up from #1129/#1108: the Rail's alert-channel tile was an all-time
 * `SELECT COUNT(*)` with no lower bound (fixed in `alert-delivery-log.ts` by
 * windowing `countFailures`), and the table itself had no pruning at all —
 * unlike `llm_call_log` (#1045) and the MI archive (#1060), both of which
 * shipped a retention sweep AND two asserted composition-root call sites
 * after #313's observed-fill prune shipped as a mechanism nothing called
 * (retired unused by #1059). This file mirrors `mi-archive-retention.test.ts`
 * exactly.
 *
 * WHAT THE SOURCE-TEXT BLOCK BELOW PINS, AND WHAT IT DOES NOT (#1313).
 * A unit test of `pruneOlderThan` cannot catch a missing caller, because the
 * defect is the ABSENCE of a call. But matching `production.ts` as text does
 * not catch it either: #1306's review wrapped the daily call site in a `/*
 * ... *\/` block comment and all 11 tests here stayed green, since the call
 * text is still in the source the regex reads. So the block below pins the
 * ARGUMENT SEQUENCE and the textual placement of each call — worth keeping,
 * and all it claims. That the calls RUN is pinned by execution in
 * `production/retention-wiring.test.ts`, which seeds an over-age row and
 * observes it deleted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALERT_DELIVERY_FAILURE_WINDOW_MS,
  DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
} from './alert-delivery-log.js';
import {
  alertDeliveryFailureRetentionDaysFromEnvironment,
  ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
} from './production.js';

describe('alertDeliveryFailureRetentionDaysFromEnvironment', () => {
  it('defaults to 30 days when unset', () => {
    expect(alertDeliveryFailureRetentionDaysFromEnvironment(undefined)).toBe(
      DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    );
    expect(DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS).toBe(30);
  });

  it('accepts an operator override', () => {
    expect(alertDeliveryFailureRetentionDaysFromEnvironment('14')).toBe(14);
    expect(alertDeliveryFailureRetentionDaysFromEnvironment(' 14 ')).toBe(14);
  });

  it('treats whitespace as unset rather than as zero', () => {
    expect(alertDeliveryFailureRetentionDaysFromEnvironment('   ')).toBe(
      DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    );
    expect(alertDeliveryFailureRetentionDaysFromEnvironment('')).toBe(
      DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
    );
  });

  it('refuses a malformed value instead of defaulting', () => {
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('lots')).toThrow(
      /SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS must be an integer/,
    );
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('12.5')).toThrow(
      /must be an integer/,
    );
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('-1')).toThrow(
      /must be an integer/,
    );
  });

  // #1131's load-bearing bound: unlike the MI archive and llm_call_log
  // resolvers (both `min = 1`), this one refuses 1 as well as 0. A 1-day
  // retention is exactly the 24h Rail window, and at that equality the raw
  // table stops outliving the tile — so the raw-table read
  // `contracts/snapshot.ts` leaves in place of the lifetime total it
  // dropped, "answerable over the retention window by reading
  // `alert_delivery_failures` directly", would answer nothing the tile does
  // not already show. `alertDeliveryFailureRetentionDaysFromEnvironment`'s doc
  // carries the full argument, including why the INTUITIVE reason for this
  // floor — that a 1-day sweep would delete a row the tile still counts —
  // is far too narrow to be the one: the two predicates overlap only for a
  // prune committing after a live request's `asOf`, which is reachable only
  // inside the sub-second gap between sampling `asOf` and reading the count.
  //
  // This case is also the LOWERED-MINIMUM half of the guard on "retention
  // outlives the window"; the last case in this block is the widened-window
  // half.
  it('refuses a 1-day retention — retention must outlive the window it backstops', () => {
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('1')).toThrow(
      /must be an integer >= 2/,
    );
  });

  it('refuses zero — this is a day window, not a row ceiling with its own off spelling', () => {
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('0')).toThrow(
      /must be an integer >= 2/,
    );
  });

  it('names the variable an operator has to fix', () => {
    expect(ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS).toBe(
      'SAMURAI_ALERT_DELIVERY_FAILURE_RETENTION_DAYS',
    );
    expect(() => alertDeliveryFailureRetentionDaysFromEnvironment('nope')).toThrow(
      /retention window \(#1131\)/,
    );
  });

  // The WIDENED-WINDOW half of that guard. `minRetentionMs` restates the
  // resolver's `2` as its own literal rather than reading it from
  // `production.ts`, so this does not derive the bound from the resolver —
  // it is the assertion that goes red if `ALERT_DELIVERY_FAILURE_WINDOW_MS`
  // is later widened past 48h (or past the 30-day default). The `min = 2`
  // floor alone would not catch that: at a 48h window retention and window
  // are equal, not ordered.
  it('keeps the minimum retention strictly longer than the count window', () => {
    const minRetentionMs = 2 * 24 * 60 * 60 * 1000;
    expect(minRetentionMs).toBeGreaterThan(ALERT_DELIVERY_FAILURE_WINDOW_MS);
    expect(DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toBeGreaterThan(
      ALERT_DELIVERY_FAILURE_WINDOW_MS,
    );
  });
});

describe('the alert_delivery_failures purge is spelled at the composition root, in full', () => {
  const source = readFileSync(fileURLToPath(new URL('./production.ts', import.meta.url)), 'utf8');

  // Matched by regex, not exact string, and requiring the FULL argument
  // sequence in order — see mi-archive-retention.test.ts's comment on
  // `callSite` for why a lazy scan anchored only on the function name proved
  // insufficient there; the same failure mode applies here.
  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneAlertDeliveryFailuresWithLog\\(\\s*config\\.db,\\s*alertDeliveryFailureRetentionDays,\\s*clock,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
    );

  it('names both triggers, startup and daily, not one place only', () => {
    expect(source).toMatch(callSite('startup'));
    expect(source).toMatch(callSite('daily'));
  });

  it('spells the daily prune ABOVE the feedback cycle try block', () => {
    // Inside it, a persistently throwing `runDailyCycle` would silently
    // disable retention as well: the catch would fire every day while the
    // table grew forever and the log showed only a feedback failure.
    const cycleStart = source.indexOf('const runFeedbackCycle =');
    expect(cycleStart).toBeGreaterThan(-1);

    const dailyPrune = source.slice(cycleStart).search(callSite('daily'));
    const firstTry = source.slice(cycleStart).indexOf('try {');

    expect(dailyPrune).toBeGreaterThan(-1);
    expect(dailyPrune).toBeLessThan(firstTry);
  });

  it('spells the prune through the orchestrator stage guard, not a raw handle', () => {
    // `alert_delivery_failures` is in `STAGE_OWNED_TABLES.orchestrator`
    // (write-guard.ts) — the prune must go through `guardedStore(db,
    // 'orchestrator')` like every other orchestrator-owned table's
    // housekeeping, not bypass the guard with a raw `SqliteHandle`.
    expect(source).toMatch(
      /guardedStore\(db, 'orchestrator'\)\)\.pruneOlderThan\(\s*cutoff,?\s*\)/,
    );
  });
});
