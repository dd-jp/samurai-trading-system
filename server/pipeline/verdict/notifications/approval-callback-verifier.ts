/**
 * HMAC-SHA256 authn/authz verifier for inbound HITL approval-channel
 * callbacks (ticket #207). See docs/specs/verdict-spec.md ("Module:
 * Human-in-the-Loop"): approve/reject callbacks must carry a signature over
 * the request's stable identifier (`trace_id` + `order_intent.idempotency_key`,
 * ../types.js) plus the claimed `outcome`, computed with a pre-shared secret.
 * A callback whose signature does not verify is never trusted — the caller
 * (`SignedApprovalChannel`, ./verified-approval-channel.js) treats it as a
 * no-op and lets the pending approval fall through to its own timeout,
 * rather than resolving with an unauthenticated outcome.
 *
 * Comparison is timing-safe (`crypto.timingSafeEqual`) so a bad signature
 * can't be brute-forced byte-by-byte via response timing; malformed input
 * (wrong length, non-hex, missing) returns `false` rather than throwing, so
 * callers never need a try/catch around verification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovalCallbackPayload {
  trace_id: string;
  idempotency_key: string;
  outcome: 'approved' | 'rejected';
  signature: string;
}

type SignableFields = Pick<ApprovalCallbackPayload, 'trace_id' | 'idempotency_key' | 'outcome'>;

function canonicalString(payload: SignableFields): string {
  return `${payload.trace_id}:${payload.idempotency_key}:${payload.outcome}`;
}

/**
 * Computes the expected signature for a payload's stable fields. Used both
 * to sign outbound fixtures in tests and internally by
 * `verifyApprovalCallback`.
 */
export function signApprovalCallback(payload: SignableFields, secret: string): string {
  return createHmac('sha256', secret).update(canonicalString(payload)).digest('hex');
}

/**
 * Verifies that `payload.signature` is the correct HMAC-SHA256 of the
 * payload's stable fields under `secret`. Returns `false` (never throws) on
 * any malformed or mismatched signature, including length mismatches that
 * would otherwise make `timingSafeEqual` throw.
 */
export function verifyApprovalCallback(payload: ApprovalCallbackPayload, secret: string): boolean {
  if (typeof payload.signature !== 'string' || payload.signature.length === 0) {
    return false;
  }

  const expected = Buffer.from(signApprovalCallback(payload, secret), 'hex');
  const actual = Buffer.from(payload.signature, 'hex');

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
