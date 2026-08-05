import type { RiskDecision } from '../../risk-manager/index.js';
import type { OrderIntent } from '../../shared/index.js';
import type { ApprovalRequest } from '../types.js';
import type { ApprovalCallbackPayload } from './approval-callback-verifier.js';
import { signApprovalCallback } from './approval-callback-verifier.js';
import type { ApprovalRequestSender } from './verified-approval-channel.js';
import { SignedApprovalChannel } from './verified-approval-channel.js';

const SECRET = 'shared-secret-abc123';

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: new Date('2026-07-15T13:55:00Z'),
    metadata: {
      debate_id: 'debate-abc123',
      conviction: 0.72,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1.2,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 1,
      },
      cosine_precedent: { neighbor_count: 5, weighted_mean_r: 0.4, no_precedent: false },
    },
    ...overrides,
  };
}

function makeRiskDecision(intent: OrderIntent): RiskDecision {
  return {
    status: 'approved',
    order_intent: intent,
    modifications: null,
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
    warnings: [],
    next_breaker_state: [],
  };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const intent = makeIntent();
  return {
    order_intent: intent,
    risk_decision: makeRiskDecision(intent),
    trace_id: 'trace-1',
    timeout_ms: 5000,
    ...overrides,
  };
}

function callbackFor(
  request: ApprovalRequest,
  outcome: 'approved' | 'rejected',
  secret: string,
): ApprovalCallbackPayload {
  const base = {
    trace_id: request.trace_id,
    idempotency_key: request.order_intent.idempotency_key,
    outcome,
  };
  return { ...base, signature: signApprovalCallback(base, secret) };
}

describe('SignedApprovalChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves approved when a validly signed approval callback arrives', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest();

    const outcomePromise = channel.requestApproval(request);
    channel.handleCallback(callbackFor(request, 'approved', SECRET), SECRET);

    await expect(outcomePromise).resolves.toBe('approved');
  });

  it('resolves rejected when a validly signed rejection callback arrives', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest();

    const outcomePromise = channel.requestApproval(request);
    channel.handleCallback(callbackFor(request, 'rejected', SECRET), SECRET);

    await expect(outcomePromise).resolves.toBe('rejected');
  });

  it('ignores a callback with a missing/invalid signature and falls through to timeout', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest({ timeout_ms: 1000 });

    const outcomePromise = channel.requestApproval(request);
    channel.handleCallback(
      { ...callbackFor(request, 'approved', SECRET), signature: 'not-a-real-signature' },
      SECRET,
    );

    // Not resolved by the bad callback — still pending until the timer fires.
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcomePromise).resolves.toBe('timeout');
  });

  it('ignores a tampered outcome and falls through to timeout', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest({ timeout_ms: 1000 });

    const outcomePromise = channel.requestApproval(request);
    const forged = callbackFor(request, 'approved', SECRET);
    channel.handleCallback({ ...forged, outcome: 'rejected' }, SECRET);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(outcomePromise).resolves.toBe('timeout');
  });

  it('ignores a replay signed with the wrong secret (stolen-token / wrong-chat scenario) and falls through to timeout', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest({ timeout_ms: 1000 });

    const outcomePromise = channel.requestApproval(request);
    channel.handleCallback(callbackFor(request, 'approved', 'attacker-secret'), SECRET);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(outcomePromise).resolves.toBe('timeout');
  });

  it('never throws from handleCallback on malformed payloads', () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest();
    void channel.requestApproval(request);

    expect(() =>
      channel.handleCallback(
        { ...callbackFor(request, 'approved', SECRET), signature: '' },
        SECRET,
      ),
    ).not.toThrow();
  });

  it('is a no-op for a callback that matches no pending request', () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest();

    expect(() =>
      channel.handleCallback(callbackFor(request, 'approved', SECRET), SECRET),
    ).not.toThrow();
  });

  it('invokes the injected sender when a request comes in', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sender: ApprovalRequestSender = { send };
    const channel = new SignedApprovalChannel(sender);
    const request = makeRequest();

    const outcomePromise = channel.requestApproval(request);
    expect(send).toHaveBeenCalledWith(request);

    channel.handleCallback(callbackFor(request, 'approved', SECRET), SECRET);
    await expect(outcomePromise).resolves.toBe('approved');
  });

  it('degrades to timeout (not an unhandled rejection) when the sender rejects', async () => {
    const send = vi.fn().mockRejectedValue(new Error('telegram down'));
    const sender: ApprovalRequestSender = { send };
    const channel = new SignedApprovalChannel(sender);
    const request = makeRequest({ timeout_ms: 500 });

    const outcomePromise = channel.requestApproval(request);
    await vi.advanceTimersByTimeAsync(500);

    await expect(outcomePromise).resolves.toBe('timeout');
  });

  it('does not let a stale timer from a superseded same-key request delete a newer pending entry', async () => {
    const channel = new SignedApprovalChannel();
    const requestA = makeRequest({ timeout_ms: 500 });
    const outcomeA = channel.requestApproval(requestA);

    // Same trace_id + idempotency_key as A, registered before A's timer fires.
    const requestB = makeRequest({ timeout_ms: 5000 });
    const outcomeB = channel.requestApproval(requestB);

    // A's timer fires first; it must only clean up its own entry, not B's.
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcomeA).resolves.toBe('timeout');

    // B is still reachable via a valid callback.
    channel.handleCallback(callbackFor(requestB, 'approved', SECRET), SECRET);
    await expect(outcomeB).resolves.toBe('approved');
  });

  it('does not resolve twice if a valid callback arrives after timeout already fired', async () => {
    const channel = new SignedApprovalChannel();
    const request = makeRequest({ timeout_ms: 500 });

    const outcomePromise = channel.requestApproval(request);
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcomePromise).resolves.toBe('timeout');

    // Late callback after the pending entry was already cleaned up — must not throw.
    expect(() =>
      channel.handleCallback(callbackFor(request, 'approved', SECRET), SECRET),
    ).not.toThrow();
  });
});
