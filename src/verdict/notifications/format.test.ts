import { describe, expect, it } from 'vitest';
import type { RiskDecision } from '../../risk-manager/types.js';
import type { OrderIntent } from '../../shared/types.js';
import type { ApprovalRequest, VerdictDecision } from '../types.js';
import { formatApprovalRequest, formatDecisionMessage, formatHeartbeatMessage } from './format.js';

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
      cosine_precedent: {
        neighbor_count: 5,
        weighted_mean_r: 0.4,
        no_precedent: false,
      },
    },
    ...overrides,
  };
}

function makeRiskDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    status: 'approved',
    order_intent: makeIntent(),
    modifications: null,
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0.02, armed_breakers: [] },
    ...overrides,
  };
}

function makeDecision(overrides: Partial<VerdictDecision> = {}): VerdictDecision {
  return {
    status: 'go',
    order: makeIntent(),
    no_go_reason: null,
    approval_path: 'human',
    would_require_approval: true,
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

describe('formatDecisionMessage', () => {
  it('includes go/no-go status, reason, and full order context', () => {
    const message = formatDecisionMessage(
      makeDecision({ status: 'no_go', no_go_reason: 'drift', order: null }),
      makeRiskDecision(),
    );

    expect(message).toContain('NO-GO (drift)');
    expect(message).toContain('AAPL');
    expect(message).toContain('Entry: 100');
    expect(message).toContain('Conviction: 0.72');
    expect(message).toContain('Cosine precedent');
    expect(message).toContain('Risk snapshot');
    expect(message).toContain('AAPL-2026-07-15T13:55:00Z');
  });

  it('reports GO for a passing decision', () => {
    const message = formatDecisionMessage(makeDecision(), makeRiskDecision());
    expect(message).toContain('Verdict: GO');
  });
});

describe('formatApprovalRequest', () => {
  it('includes order context and the timeout window', () => {
    const request: ApprovalRequest = {
      order_intent: makeIntent(),
      risk_decision: makeRiskDecision(),
      trace_id: 'trace-1',
      timeout_ms: 300_000,
    };

    const message = formatApprovalRequest(request);

    expect(message).toContain('Approval requested');
    expect(message).toContain('AAPL');
    expect(message).toContain('Timeout: 300000ms');
  });
});

describe('formatHeartbeatMessage', () => {
  it('includes the ISO timestamp', () => {
    const message = formatHeartbeatMessage(new Date('2026-07-15T14:00:00Z'));
    expect(message).toContain('2026-07-15T14:00:00.000Z');
  });
});
