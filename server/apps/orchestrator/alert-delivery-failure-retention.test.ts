import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALERT_DELIVERY_FAILURE_WINDOW_MS,
  DEFAULT_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
} from './alert-delivery-log.js';
import {
  alertDeliveryFailureRetentionDaysFromEnvironment,
  ENV_ALERT_DELIVERY_FAILURE_RETENTION_DAYS,
} from './production/environment.js';

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

  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneAlertDeliveryFailuresWithLog\\(\\s*config\\.db,\\s*alertDeliveryFailureRetentionDays,\\s*clock,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
    );

  it('names both triggers, startup and daily, not one place only', () => {
    expect(source).toMatch(callSite('startup'));
    expect(source).toMatch(callSite('daily'));
  });

  it('spells the daily prune ABOVE the feedback cycle try block', () => {
    const cycleStart = source.indexOf('const runFeedbackCycle =');
    expect(cycleStart).toBeGreaterThan(-1);

    const dailyPrune = source.slice(cycleStart).search(callSite('daily'));
    const firstTry = source.slice(cycleStart).indexOf('try {');

    expect(dailyPrune).toBeGreaterThan(-1);
    expect(dailyPrune).toBeLessThan(firstTry);
  });

  it('spells the prune through the orchestrator stage guard, not a raw handle', () => {
    expect(source).toMatch(
      /guardedStore\(db, 'orchestrator'\)\)\.pruneOlderThan\(\s*cutoff,?\s*\)/,
    );
  });
});
