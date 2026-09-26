import { describe, expect, it } from 'vitest';
import { carriesToken, isConfiguredToken } from './auth.js';

describe('isConfiguredToken', () => {
  it('treats a missing, empty or blank token as not configured', () => {
    expect(isConfiguredToken(undefined)).toBe(false);
    expect(isConfiguredToken('')).toBe(false);
    expect(isConfiguredToken('  ')).toBe(false);
    expect(isConfiguredToken('t0ken')).toBe(true);
  });
});

describe('carriesToken', () => {
  it('accepts only the exact Bearer token', () => {
    expect(carriesToken('Bearer t0ken', 't0ken')).toBe(true);
    expect(carriesToken('Bearer t0ken2', 't0ken')).toBe(false);
    expect(carriesToken('Bearer t0ke', 't0ken')).toBe(false);
    expect(carriesToken('bearer t0ken', 't0ken')).toBe(false);
    expect(carriesToken('Basic t0ken', 't0ken')).toBe(false);
    expect(carriesToken('t0ken', 't0ken')).toBe(false);
  });

  it('refuses a missing header and an empty token after the prefix', () => {
    expect(carriesToken(undefined, 't0ken')).toBe(false);
    expect(carriesToken('Bearer ', 't0ken')).toBe(false);
  });

  it('compares the whole UTF-8 token, not a truncated or re-encoded form', () => {
    expect(carriesToken('Bearer tök€n', 'tök€n')).toBe(true);
    expect(carriesToken('Bearer tok€n', 'tök€n')).toBe(false);
  });
});
