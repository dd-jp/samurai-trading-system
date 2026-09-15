/**
 * Which verdicts interrupt an operator (#465).
 *
 * The volume arithmetic is the whole reason this filter exists, so the first
 * test is the one that would fail if someone reverted to story 14's literal
 * "fills and no-gos".
 */
import type { VerdictDecision } from '../types.js';
import { isNotableVerdict } from './notable-verdict.js';

function decision(overrides: Partial<VerdictDecision> = {}): VerdictDecision {
  return {
    status: 'no_go',
    order: null,
    no_go_reason: 'staleness',
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: 'k',
    timestamp: new Date('2026-08-06T00:00:00Z'),
    next_breaker_state: [],
    ...overrides,
  } as VerdictDecision;
}

describe('isNotableVerdict', () => {
  it('always notifies a go — money moved', () => {
    expect(isNotableVerdict(decision({ status: 'go', no_go_reason: null }))).toBe(true);
  });

  it('notifies a breaker no-go — the system halted its own trading', () => {
    expect(isNotableVerdict(decision({ no_go_reason: 'breaker' }))).toBe(true);
  });

  it('stays SILENT on the routine gates', () => {
    // The arithmetic this filter exists for: at ADR-0008's ~296
    // instrument-passes/day the large majority end here, so notifying on these
    // is ~300 Telegram messages a day — alert fatigue by construction, and the
    // failure #342 split the heartbeat chat to avoid. An operator who mutes on
    // day two loses the escalations that matter along with the noise
    for (const reason of ['staleness', 'drift', 'dedup', 'market_closed'] as const) {
      expect(isNotableVerdict(decision({ no_go_reason: reason }))).toBe(false);
    }
  });

  it('notifies the HITL outcomes, reachable only if the dial is turned back', () => {
    expect(isNotableVerdict(decision({ no_go_reason: 'human_rejected' }))).toBe(true);
    expect(isNotableVerdict(decision({ no_go_reason: 'timeout' }))).toBe(true);
  });

  it('is an ALLOWLIST — an unrecognised reason stays silent', () => {
    // Deliberate default. A `no_go_reason` added later quietly joining the
    // alert stream is the fatigue this exists to prevent; one quietly staying
    // out is a row in `verdict_log` that someone reads later. The second
    // failure is recoverable and the first is not
    expect(isNotableVerdict(decision({ no_go_reason: 'something_new' as never }))).toBe(false);
  });

  it('does not notify a no_go with a null reason', () => {
    expect(isNotableVerdict(decision({ no_go_reason: null }))).toBe(false);
  });
});
