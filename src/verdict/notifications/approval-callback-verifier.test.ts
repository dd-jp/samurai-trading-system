import { describe, expect, it } from 'vitest';
import type { ApprovalCallbackPayload } from './approval-callback-verifier.js';
import { signApprovalCallback, verifyApprovalCallback } from './approval-callback-verifier.js';

const SECRET = 'shared-secret-abc123';

function makePayload(overrides: Partial<ApprovalCallbackPayload> = {}): ApprovalCallbackPayload {
  const base = {
    trace_id: 'trace-1',
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    outcome: 'approved' as const,
  };
  const signature = signApprovalCallback(base, SECRET);
  return { ...base, signature, ...overrides };
}

describe('verifyApprovalCallback', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifyApprovalCallback(makePayload(), SECRET)).toBe(true);
  });

  it('accepts a correctly signed rejected outcome', () => {
    const base = {
      trace_id: 'trace-2',
      idempotency_key: 'TSLA-2026-07-15T13:55:00Z',
      outcome: 'rejected' as const,
    };
    const signature = signApprovalCallback(base, SECRET);
    expect(verifyApprovalCallback({ ...base, signature }, SECRET)).toBe(true);
  });

  it('rejects a missing signature', () => {
    expect(verifyApprovalCallback(makePayload({ signature: '' }), SECRET)).toBe(false);
  });

  it('rejects a tampered outcome (signature no longer matches the payload)', () => {
    const payload = makePayload({ outcome: 'rejected' });
    expect(verifyApprovalCallback(payload, SECRET)).toBe(false);
  });

  it('rejects a tampered trace_id', () => {
    const payload = makePayload({ trace_id: 'trace-attacker' });
    expect(verifyApprovalCallback(payload, SECRET)).toBe(false);
  });

  it('rejects a tampered idempotency_key', () => {
    const payload = makePayload({ idempotency_key: 'SPY-2026-07-15T13:55:00Z' });
    expect(verifyApprovalCallback(payload, SECRET)).toBe(false);
  });

  it('rejects a signature produced with the wrong secret (stolen-token / wrong-chat scenario)', () => {
    const base = {
      trace_id: 'trace-1',
      idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
      outcome: 'approved' as const,
    };
    const signature = signApprovalCallback(base, 'a-different-secret');
    expect(verifyApprovalCallback({ ...base, signature }, SECRET)).toBe(false);
  });

  it('does not throw and returns false on a non-hex signature', () => {
    expect(() =>
      verifyApprovalCallback(makePayload({ signature: 'not-hex-!!zz' }), SECRET),
    ).not.toThrow();
    expect(verifyApprovalCallback(makePayload({ signature: 'not-hex-!!zz' }), SECRET)).toBe(false);
  });

  it('does not throw and returns false on a signature of mismatched length', () => {
    const shortSig = signApprovalCallback(
      { trace_id: 'trace-1', idempotency_key: 'k', outcome: 'approved' },
      SECRET,
    ).slice(0, 10);
    expect(() =>
      verifyApprovalCallback(makePayload({ signature: shortSig }), SECRET),
    ).not.toThrow();
    expect(verifyApprovalCallback(makePayload({ signature: shortSig }), SECRET)).toBe(false);
  });

  it('does not throw and returns false on an empty-string secret mismatch', () => {
    expect(() => verifyApprovalCallback(makePayload(), '')).not.toThrow();
    expect(verifyApprovalCallback(makePayload(), '')).toBe(false);
  });
});

describe('signApprovalCallback', () => {
  it('is deterministic for the same inputs', () => {
    const base = { trace_id: 't', idempotency_key: 'k', outcome: 'approved' as const };
    expect(signApprovalCallback(base, SECRET)).toBe(signApprovalCallback(base, SECRET));
  });

  it('produces different signatures for different secrets', () => {
    const base = { trace_id: 't', idempotency_key: 'k', outcome: 'approved' as const };
    expect(signApprovalCallback(base, SECRET)).not.toBe(signApprovalCallback(base, 'other'));
  });
});
