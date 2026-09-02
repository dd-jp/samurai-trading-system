/**
 * TDD for #887: the dashboard's bind guard must refuse a non-loopback `HOST`
 * unless a credential is configured — and must NOT refuse the default
 * loopback bind just because no credential exists, since that default is
 * every `yarn dashboard` invocation today. Written before `bind-guard.ts`
 * existed; see that file's header for the full design rationale (ADR-0019).
 */
import {
  assertBindAllowed,
  DASHBOARD_CREDENTIAL_ENV_VAR,
  isBindAllowed,
  isLoopbackHost,
} from './bind-guard.js';

describe('isLoopbackHost', () => {
  it('accepts the two literal addresses ADR-0019/#887 named', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('rejects `localhost` — a hostname to resolve, not a literal loopback address', () => {
    // Deliberate, not an oversight: see bind-guard.ts's LOOPBACK_HOSTS comment
    // for why the allowlist is addresses only.
    expect(isLoopbackHost('localhost')).toBe(false);
  });

  it('rejects a non-loopback bind address', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
  });
});

describe('isBindAllowed — the conjunctive predicate', () => {
  it('permits loopback with no credential — the default path every yarn dashboard uses', () => {
    expect(isBindAllowed('127.0.0.1', undefined)).toBe(true);
    expect(isBindAllowed('::1', undefined)).toBe(true);
  });

  it('refuses a non-loopback bind with no credential configured', () => {
    expect(isBindAllowed('0.0.0.0', undefined)).toBe(false);
  });

  it('treats an empty or blank credential as not configured', () => {
    expect(isBindAllowed('0.0.0.0', '')).toBe(false);
    expect(isBindAllowed('0.0.0.0', '   ')).toBe(false);
  });

  it('permits a non-loopback bind once a non-empty credential is configured', () => {
    expect(isBindAllowed('0.0.0.0', 'fake-sim-token')).toBe(true);
  });

  it('permits loopback with a credential configured too — never a reason to refuse', () => {
    expect(isBindAllowed('127.0.0.1', 'fake-sim-token')).toBe(true);
  });
});

describe('assertBindAllowed — the throwing half wired into createDashboardServer', () => {
  it('throws a named error for a non-loopback bind with no credential', () => {
    expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(
      new RegExp(`HOST=0\\.0\\.0\\.0.*${DASHBOARD_CREDENTIAL_ENV_VAR}`, 's'),
    );
  });

  it('does not throw for a loopback bind with no credential (regression guard)', () => {
    expect(() => assertBindAllowed('127.0.0.1', undefined)).not.toThrow();
    expect(() => assertBindAllowed('::1', undefined)).not.toThrow();
  });

  it('does not throw for a non-loopback bind once a credential is configured', () => {
    expect(() => assertBindAllowed('0.0.0.0', 'fake-sim-token')).not.toThrow();
  });

  it('names the offending host and the env var to set, and nothing else identifying', () => {
    // The refusal message must be operator-legible (what's wrong, how to fix
    // it) without ever interpolating a credential value — there is no code
    // path where it could, since the message text below is fixed and never
    // reads `credential`.
    expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(/0\.0\.0\.0/);
    expect(() => assertBindAllowed('0.0.0.0', undefined)).toThrow(
      new RegExp(DASHBOARD_CREDENTIAL_ENV_VAR),
    );
  });
});
