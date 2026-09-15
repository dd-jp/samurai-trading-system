/**
 * `nous-wire.ts` — the endpoint-agnostic half both Nous transports import.
 *
 * Most of this module is already exercised indirectly through
 * `nous-chat.test.ts` (error envelope, token coercion, metered-model
 * resolution). `clampTimeoutToBudget` (#1533) is pinned directly here because
 * it is pure arithmetic with no HTTP around it to exercise it incidentally.
 */
import { describe, expect, it } from 'vitest';
import { clampTimeoutToBudget } from './nous-wire.js';

describe('clampTimeoutToBudget', () => {
  it('returns the configured timeout unchanged when no gate budget is set', () => {
    expect(clampTimeoutToBudget(5_000, undefined, 800)).toBe(5_000);
  });

  it('shrinks the timeout to whatever budget the gate wait left behind', () => {
    // 1000ms budget, 800ms already spent waiting -> 200ms left for the call
    expect(clampTimeoutToBudget(5_000, 1_000, 800)).toBe(200);
  });

  it('never returns more than the configured timeout, even with budget to spare', () => {
    // A generous budget must not WIDEN the network timeout past what the
    // caller configured — clamping only ever shrinks
    expect(clampTimeoutToBudget(5_000, 100_000, 0)).toBe(5_000);
  });

  it('floors at zero rather than going negative when the wait already exceeded the budget', () => {
    // A negative timeoutMs passed to `fetchWithTimeout`'s `setTimeout` would
    // fire immediately in practice, but the contract should say so rather
    // than rely on that incidental behaviour
    expect(clampTimeoutToBudget(5_000, 1_000, 1_500)).toBe(0);
  });
});
