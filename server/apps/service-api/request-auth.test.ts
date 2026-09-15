/**
 * TDD for #1038: `isAuthorizedRequest` must refuse a request lacking a valid
 * bearer token once `SAMURAI_DASHBOARD_TOKEN` is configured, and must NOT
 * refuse any request when no credential is configured — that regression
 * would brick the default `npm run dashboard` path this repo runs today. See
 * `request-auth.ts`'s header for the full design (scope, host-agnosticism,
 * the constant-time approach).
 *
 * `'fixture-dashboard-token'` throughout is a fixture value only — never a
 * real credential, per this repo's test-secret convention.
 */
import { extractBearerToken, isAuthorizedRequest } from './request-auth.js';

const FIXTURE_TOKEN = 'fixture-dashboard-token';

describe('extractBearerToken', () => {
  it('reads the token out of a well-formed Bearer header', () => {
    expect(extractBearerToken(`Bearer ${FIXTURE_TOKEN}`)).toBe(FIXTURE_TOKEN);
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(extractBearerToken(`Basic ${FIXTURE_TOKEN}`)).toBeNull();
  });

  it('returns null for "Bearer" with no token following it', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
  });
});

describe('isAuthorizedRequest — the request-time half of #887/#1038', () => {
  it('permits every request when no credential is configured — the default path regression guard', () => {
    expect(isAuthorizedRequest(undefined, undefined)).toBe(true);
    expect(isAuthorizedRequest(`Bearer ${FIXTURE_TOKEN}`, undefined)).toBe(true);
    expect(isAuthorizedRequest('Bearer wrong-token', undefined)).toBe(true);
  });

  it('treats a blank/whitespace-only configured credential as unset too, matching isConfiguredCredential', () => {
    expect(isAuthorizedRequest(undefined, '')).toBe(true);
    expect(isAuthorizedRequest(undefined, '   ')).toBe(true);
  });

  it('REFUSES a request with no Authorization header once a credential is configured', () => {
    // This is the load-bearing case David's decision named explicitly: a test
    // that only asserted the valid-credential case would still pass against
    // the pre-#1038 behaviour, which accepts every request unconditionally.
    expect(isAuthorizedRequest(undefined, FIXTURE_TOKEN)).toBe(false);
  });

  it('refuses a request bearing the wrong token', () => {
    expect(isAuthorizedRequest('Bearer not-the-token', FIXTURE_TOKEN)).toBe(false);
  });

  it('refuses a malformed Authorization header (wrong scheme, or Bearer with nothing after it)', () => {
    expect(isAuthorizedRequest(`Basic ${FIXTURE_TOKEN}`, FIXTURE_TOKEN)).toBe(false);
    expect(isAuthorizedRequest('Bearer ', FIXTURE_TOKEN)).toBe(false);
  });

  it('permits a request bearing the exact configured token', () => {
    expect(isAuthorizedRequest(`Bearer ${FIXTURE_TOKEN}`, FIXTURE_TOKEN)).toBe(true);
  });

  it('is case-sensitive on the token itself', () => {
    expect(isAuthorizedRequest(`Bearer ${FIXTURE_TOKEN.toUpperCase()}`, FIXTURE_TOKEN)).toBe(false);
  });
});
