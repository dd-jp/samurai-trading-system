import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '../shared/types.js';
import type { VerdictDecision, VerdictInput } from './types.js';
import { buildVerdictLog, InMemoryVerdictLogStore } from './verdict-log-store.js';

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

function makeInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    trace_id: 'trace-1',
    risk_decision: {
      status: 'approved',
      order_intent: makeIntent(),
      modifications: null,
      binding_constraint: null,
      reasons: [],
      risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
    },
    clock: { now: () => new Date('2026-07-15T14:00:00Z') },
    marketData: undefined as never,
    tradingCalendar: undefined as never,
    positionStore: undefined as never,
    breakers: undefined as never,
    config: undefined as never,
    mode: 'live',
    approvals: undefined as never,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<VerdictDecision> = {}): VerdictDecision {
  return {
    status: 'go',
    order: makeIntent(),
    no_go_reason: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
    timestamp: new Date('2026-07-15T14:00:00Z'),
    ...overrides,
  };
}

describe('buildVerdictLog', () => {
  it('projects a go VerdictDecision into a verdict_log row', () => {
    const input = makeInput();
    const decision = makeDecision();

    expect(buildVerdictLog(input, decision)).toEqual({
      trace_id: 'trace-1',
      idempotency_key: 'AAPL-2026-07-15T13:55:00Z',
      instrument: 'AAPL',
      status: 'go',
      no_go_reason: null,
      hitl_override: false,
      timestamp: decision.timestamp,
    });
  });

  it('projects a no-go VerdictDecision, reading instrument from the input (decision.order is null)', () => {
    const input = makeInput({
      risk_decision: {
        status: 'approved',
        order_intent: makeIntent({ instrument: 'TSLA' }),
        modifications: null,
        binding_constraint: null,
        reasons: [],
        risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
      },
    });
    const decision = makeDecision({ status: 'no_go', order: null, no_go_reason: 'drift' });

    const log = buildVerdictLog(input, decision);

    expect(log.instrument).toBe('TSLA');
    expect(log.status).toBe('no_go');
    expect(log.no_go_reason).toBe('drift');
  });

  it('sets hitl_override true when approval_path is human, false when automated', () => {
    const input = makeInput();

    expect(buildVerdictLog(input, makeDecision({ approval_path: 'human' })).hitl_override).toBe(
      true,
    );
    expect(
      buildVerdictLog(input, makeDecision({ approval_path: 'human_timeout' })).hitl_override,
    ).toBe(true);
    expect(buildVerdictLog(input, makeDecision({ approval_path: 'automated' })).hitl_override).toBe(
      false,
    );
  });

  it('throws if the RiskDecision has a null order_intent', () => {
    const input = makeInput({
      risk_decision: {
        status: 'approved',
        order_intent: null,
        modifications: null,
        binding_constraint: null,
        reasons: [],
        risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
      },
    });

    expect(() => buildVerdictLog(input, makeDecision())).toThrow();
  });
});

describe('InMemoryVerdictLogStore', () => {
  it('a written decision: row exists and is joinable by trace_id', () => {
    const store = new InMemoryVerdictLogStore();
    const log = buildVerdictLog(makeInput(), makeDecision());

    store.writeLog(log);

    expect(store.getByTraceId('trace-1')).toEqual(log);
  });

  it('an unwritten trace_id: lookup is absent', () => {
    const store = new InMemoryVerdictLogStore();

    expect(store.getByTraceId('trace-never-written')).toBeUndefined();
  });

  it('does not conflate rows across distinct trace_ids', () => {
    const store = new InMemoryVerdictLogStore();
    const first = buildVerdictLog(makeInput({ trace_id: 'trace-1' }), makeDecision());
    const second = buildVerdictLog(
      makeInput({ trace_id: 'trace-2' }),
      makeDecision({ status: 'no_go', order: null, no_go_reason: 'breaker' }),
    );

    store.writeLog(first);
    store.writeLog(second);

    expect(store.getByTraceId('trace-1')).toEqual(first);
    expect(store.getByTraceId('trace-2')).toEqual(second);
  });
});
