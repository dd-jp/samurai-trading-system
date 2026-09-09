/**
 * TDD for #1038's client-side token acquisition — pure boundary checks, no
 * DOM. `App.test.tsx` covers the wiring (URL scrub + header on a real poll).
 */
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_TOKEN_STORAGE_KEY,
  resolveDashboardToken,
  stripTokenParam,
} from './dashboard-token.ts';

function fakeStorage(initial: Record<string, string> = {}): {
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    storage: {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
    },
  };
}

describe('resolveDashboardToken', () => {
  it('reads a fresh token from ?token= and persists it to storage', () => {
    const { storage, data } = fakeStorage();
    expect(resolveDashboardToken('?token=fixture-dashboard-token', storage)).toBe(
      'fixture-dashboard-token',
    );
    expect(data[DASHBOARD_TOKEN_STORAGE_KEY]).toBe('fixture-dashboard-token');
  });

  it('falls back to storage when the URL carries no token param', () => {
    const { storage } = fakeStorage({ [DASHBOARD_TOKEN_STORAGE_KEY]: 'stored-token' });
    expect(resolveDashboardToken('', storage)).toBe('stored-token');
    expect(resolveDashboardToken('?other=1', storage)).toBe('stored-token');
  });

  it('returns null when neither the URL nor storage carries a token — the default path', () => {
    const { storage } = fakeStorage();
    expect(resolveDashboardToken('', storage)).toBeNull();
  });

  it('treats a blank ?token= as absent, and does not clear a stored token', () => {
    const { storage } = fakeStorage({ [DASHBOARD_TOKEN_STORAGE_KEY]: 'stored-token' });
    expect(resolveDashboardToken('?token=', storage)).toBe('stored-token');
  });

  it('a fresh URL token overrides whatever storage already held', () => {
    const { storage, data } = fakeStorage({ [DASHBOARD_TOKEN_STORAGE_KEY]: 'old-token' });
    expect(resolveDashboardToken('?token=new-token', storage)).toBe('new-token');
    expect(data[DASHBOARD_TOKEN_STORAGE_KEY]).toBe('new-token');
  });
});

describe('stripTokenParam', () => {
  it('removes the token param and leaves an otherwise-empty search as ""', () => {
    expect(stripTokenParam('?token=fixture-dashboard-token')).toBe('');
  });

  it('preserves every other query param, in URLSearchParams-normalised form', () => {
    expect(stripTokenParam('?token=fixture-dashboard-token&tab=live')).toBe('?tab=live');
  });

  it('is a no-op when there is no token param to strip', () => {
    expect(stripTokenParam('')).toBe('');
    expect(stripTokenParam('?tab=live')).toBe('?tab=live');
  });
});
