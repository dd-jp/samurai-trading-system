/**
 * HMAC-authenticated `ApprovalChannel` (ticket #207). See
 * docs/specs/verdict-spec.md ("Module: Human-in-the-Loop"): the live
 * Telegram/Discord bot listener that will actually receive inbound
 * approve/reject webhooks is an ops/setup task (spec "Out of Scope: Channel
 * provisioning") — there is no live SDK wiring anywhere in `server/` yet
 * (mirrors server/providers/market-intelligence/worldmonitor-adapter/cii-consumer.ts's
 * "the seam that work will plug into"). This class is that seam: it owns
 * the pending-approval bookkeeping and the fail-safe timeout, and exposes
 * `handleCallback` for whatever future transport receives the raw inbound
 * payload to call.
 *
 * `handleCallback` verifies the HMAC signature (./approval-callback-verifier.js)
 * before trusting anything in the payload. A callback that fails
 * verification is silently ignored — never resolves the pending promise —
 * so an unauthenticated approve/reject (spoofed webhook, stolen token,
 * wrong chat) can only ever produce the request's own `timeout_ms` expiry,
 * never a trusted outcome.
 *
 * No separate nonce/expiry scheme is layered on top: the signed
 * `trace_id` is itself a fresh per-tick correlation ID (verdict/types.ts),
 * so a captured signature cannot authorize a future decision, and a
 * resolved/expired pending entry is removed from `#pending` immediately —
 * a same-tick replay lands with no matching entry and is a no-op.
 */
import type { ApprovalChannel, ApprovalOutcome, ApprovalRequest } from '../types.js';
import type { ApprovalCallbackPayload } from './approval-callback-verifier.js';
import { verifyApprovalCallback } from './approval-callback-verifier.js';

/** Whatever pushes the human-readable approval request out (Telegram/Discord/email); intentionally minimal and transport-agnostic. */
export interface ApprovalRequestSender {
  send(request: ApprovalRequest): Promise<void>;
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Stable identifier for a request, matching what a callback payload must echo back (verdict/types.ts's `ApprovalRequest`/`OrderIntent`). */
function pendingKey(trace_id: string, idempotency_key: string): string {
  return `${trace_id}:${idempotency_key}`;
}

export class SignedApprovalChannel implements ApprovalChannel {
  readonly #sender: ApprovalRequestSender | undefined;
  readonly #pending = new Map<string, PendingApproval>();

  constructor(sender?: ApprovalRequestSender) {
    this.#sender = sender;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const key = pendingKey(request.trace_id, request.order_intent.idempotency_key);

    return new Promise<ApprovalOutcome>((resolve) => {
      // Declared before the timer body so the closure can confirm it's still
      // the current pending entry for `key` — otherwise a stale timer from a
      // superseded same-key request would delete a *different* request's
      // entry out from under it (see requestApproval's key-collision note).
      let entry: PendingApproval;
      const timer = setTimeout(() => {
        if (this.#pending.get(key) === entry) {
          this.#pending.delete(key);
        }
        resolve('timeout');
      }, request.timeout_ms);

      entry = { resolve, timer };
      this.#pending.set(key, entry);

      // A failed send (channel down, bad token) must not crash the process —
      // it just leaves the request pending, same as a human never responding;
      // it still expires via the timer above.
      this.#sender?.send(request).catch(() => {
        // Intentionally swallowed: falls through to the timeout fail-safe.
      });
    });
  }

  /**
   * Entry point for a future webhook/bot-listener with the raw inbound
   * payload. On a valid signature, resolves the matching pending approval
   * (if any — a late or unmatched callback is also a no-op). On an
   * invalid/missing/tampered signature, this silently does nothing: the
   * pending approval, if any, is left untouched and will resolve `'timeout'`
   * on its own once `timeout_ms` elapses.
   */
  handleCallback(payload: ApprovalCallbackPayload, secret: string): void {
    if (!verifyApprovalCallback(payload, secret)) {
      return;
    }

    const key = pendingKey(payload.trace_id, payload.idempotency_key);
    const pending = this.#pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(key);
    pending.resolve(payload.outcome);
  }
}
