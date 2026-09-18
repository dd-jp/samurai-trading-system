import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MI_ARCHIVE_RETENTION_DAYS } from '../../providers/market-intelligence/index.js';
import {
  ENV_MI_ARCHIVE_RETENTION_DAYS,
  miArchiveRetentionDaysFromEnvironment,
} from './production/environment.js';

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

  const callSite = (trigger: string): RegExp =>
    new RegExp(
      `pruneMiArchiveWithLog\\(\\s*config\\.miArchive,\\s*miArchiveRetentionDays,\\s*clock,\\s*logger,\\s*'${trigger}',?\\s*\\)`,
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
});
