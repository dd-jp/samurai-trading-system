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
    for (const reason of ['staleness', 'drift', 'dedup', 'market_closed'] as const) {
      expect(isNotableVerdict(decision({ no_go_reason: reason }))).toBe(false);
    }
  });

  it('notifies the HITL outcomes, reachable only if the dial is turned back', () => {
    expect(isNotableVerdict(decision({ no_go_reason: 'human_rejected' }))).toBe(true);
    expect(isNotableVerdict(decision({ no_go_reason: 'timeout' }))).toBe(true);
  });

  it('is an ALLOWLIST — an unrecognised reason stays silent', () => {
    expect(isNotableVerdict(decision({ no_go_reason: 'something_new' as never }))).toBe(false);
  });

  it('does not notify a no_go with a null reason', () => {
    expect(isNotableVerdict(decision({ no_go_reason: null }))).toBe(false);
  });
});
