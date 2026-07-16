import { describe, expect, it, vi } from 'vitest';
import type { Signal } from '../analysts/types.js';
import type { AnalystView, DebateResult } from '../debate-engine/types.js';
import type { ExecutionResult } from '../execution/types.js';
import type { RiskDecision } from '../risk-manager/types.js';
import type { Clock } from '../shared/clock.js';
import type { OrderIntent } from '../shared/types.js';
import type { VerdictDecision } from '../verdict/types.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { CurrentTick, CurrentTickStore, TickContext, TickSteps } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const TRACE_ID = 'trace-aapl-1400';
const CTX: TickContext = { clock: CLOCK, trace_id: TRACE_ID };
const SIGNAL: Signal = { asset: 'AAPL', asset_class: 'stocks' };

function makeView(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: TRACE_ID,
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
    ...overrides,
  };
}

function makeDebate(overrides: Partial<DebateResult> = {}): DebateResult {
  return {
    synthesis: 'bullish continuation',
    position: 'enter long',
    confidence: 0.7,
    contributions: [],
    disagreement_summary: '',
    open_items: [],
    converged: true,
    rounds_completed: 2,
    latency_ms: 1200,
    direction: 'bullish',
    debate_id: 'debate-1',
    ...overrides,
  };
}

function makeIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    idempotency_key: 'key-aapl-1355',
    instrument: 'AAPL',
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 100,
    entry: 100,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: NOW,
    metadata: {
      debate_id: 'debate-1',
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 0.75,
      },
      cosine_precedent: {
        neighbor_count: 0,
        weighted_mean_r: null,
        no_precedent: true,
      },
    },
    ...overrides,
  };
}

function approvedRisk(intent: OrderIntent): RiskDecision {
  return {
    status: 'approved',
    order_intent: intent,
    modifications: { original_size: intent.size, final_size: intent.size, stop_tightened: false },
    binding_constraint: null,
    reasons: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
  };
}

function rejectedRisk(): RiskDecision {
  return {
    status: 'rejected',
    order_intent: null,
    modifications: null,
    binding_constraint: 'circuit_breaker:portfolio',
    reasons: ['circuit_breaker:portfolio: new entries halted'],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: ['portfolio'] },
  };
}

function goVerdict(intent: OrderIntent): VerdictDecision {
  return {
    status: 'go',
    order: intent,
    no_go_reason: null,
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: intent.idempotency_key,
    timestamp: NOW,
  };
}

function noGoVerdict(): VerdictDecision {
  return {
    status: 'no_go',
    order: null,
    no_go_reason: 'drift',
    approval_path: 'automated',
    would_require_approval: false,
    idempotency_key: 'key-aapl-1355',
    timestamp: NOW,
  };
}

function makeExecutionResult(): ExecutionResult {
  return {
    status: 'submitted',
    idempotency_key: 'key-aapl-1355',
    broker_order_ids: ['broker-1'],
    order_state: 'submitted',
    reason: null,
    timestamp: NOW,
  };
}

/** Fake steps for the full happy path; override one to exercise a short-circuit. */
function makeSteps(overrides: Partial<TickSteps> = {}): TickSteps {
  const intent = makeIntent();
  return {
    analysts: vi.fn(async () => [makeView()]),
    debate: vi.fn(async () => makeDebate()),
    trader: vi.fn(async () => intent),
    risk: vi.fn(async () => approvedRisk(intent)),
    verdict: vi.fn(async () => goVerdict(intent)),
    execution: vi.fn(async () => makeExecutionResult()),
    ...overrides,
  };
}

describe('SequentialTickRunner.runInstrument', () => {
  it('drives the stages in pipeline order on the happy path', async () => {
    const order: string[] = [];
    const intent = makeIntent();
    const steps = makeSteps({
      analysts: async () => {
        order.push('analysts');
        return [makeView()];
      },
      debate: async () => {
        order.push('debate');
        return makeDebate();
      },
      trader: async () => {
        order.push('trader');
        return intent;
      },
      risk: async () => {
        order.push('risk');
        return approvedRisk(intent);
      },
      verdict: async () => {
        order.push('verdict');
        return goVerdict(intent);
      },
      execution: async () => {
        order.push('execution');
        return makeExecutionResult();
      },
    });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(order).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(outcome).toEqual({
      trace_id: TRACE_ID,
      final_stage: 'execution',
      verdict_status: 'go',
      execution_result: makeExecutionResult(),
    });
  });

  it('calls Execution with the go verdict', async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.execution).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'go', order: makeIntent() }),
    );
  });

  it('short-circuits before Execution on a Risk reject', async () => {
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.verdict).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'risk' });
  });

  it('short-circuits before Execution on a Verdict no-go', async () => {
    const steps = makeSteps({ verdict: vi.fn(async () => noGoVerdict()) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      trace_id: TRACE_ID,
      final_stage: 'verdict',
      verdict_status: 'no_go',
    });
  });

  it('short-circuits at Analysts when the view set is empty (quorum skip)', async () => {
    const steps = makeSteps({ analysts: vi.fn(async () => []) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'analysts' });
  });

  it('short-circuits at the Trader on a null intent (no-trade)', async () => {
    const steps = makeSteps({ trader: vi.fn(async () => null) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.risk).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'trader' });
  });

  it('threads the trace_id and clock into every stage call', async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    for (const step of [steps.analysts, steps.debate, steps.trader, steps.risk, steps.verdict]) {
      expect(step).toHaveBeenCalledWith(
        expect.objectContaining({ trace_id: TRACE_ID, clock: CLOCK }),
      );
    }
  });

  it('emits the Signal to Analysts and the instrument onward', async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.analysts).toHaveBeenCalledWith(expect.objectContaining({ signal: SIGNAL }));
    expect(steps.debate).toHaveBeenCalledWith(expect.objectContaining({ instrument: 'AAPL' }));
    expect(steps.trader).toHaveBeenCalledWith(expect.objectContaining({ instrument: 'AAPL' }));
  });

  it('passes the Analyst views to the Debate and the debate to the Trader', async () => {
    const views = [makeView(), makeView({ analyst_id: 'sentiment-1' })];
    const debate = makeDebate({ debate_id: 'debate-xyz' });
    const steps = makeSteps({
      analysts: vi.fn(async () => views),
      debate: vi.fn(async () => debate),
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.debate).toHaveBeenCalledWith(expect.objectContaining({ views }));
    expect(steps.trader).toHaveBeenCalledWith(expect.objectContaining({ debate }));
  });

  it('hands Verdict the approved RiskDecision, trimmed size and all', async () => {
    const trimmed = makeIntent({ size: 40 });
    const riskDecision: RiskDecision = {
      ...approvedRisk(trimmed),
      modifications: { original_size: 100, final_size: 40, stop_tightened: false },
      binding_constraint: 'per_asset_cap',
    };
    const steps = makeSteps({ risk: vi.fn(async () => riskDecision) });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, CTX);

    expect(steps.verdict).toHaveBeenCalledWith(
      expect.objectContaining({ risk_decision: riskDecision }),
    );
  });
});

/** Records every upsert/delete call in order for lifecycle assertions. */
function makeCurrentTickStore(): CurrentTickStore & { calls: string[]; rows: CurrentTick[] } {
  const rows: CurrentTick[] = [];
  const calls: string[] = [];
  return {
    calls,
    rows,
    async upsert(row) {
      calls.push(`upsert:${row.stage}`);
      rows.push(row);
    },
    async delete() {
      calls.push('delete');
    },
  };
}

describe('SequentialTickRunner.runInstrument — current_tick lifecycle', () => {
  it('upserts a row per stage in order, then deletes it on happy-path completion', async () => {
    const store = makeCurrentTickStore();
    const ctx: TickContext = { ...CTX, currentTickStore: store };
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(store.calls).toEqual([
      'upsert:analysts',
      'upsert:debate',
      'upsert:trader',
      'upsert:risk',
      'upsert:verdict',
      'upsert:execution',
      'delete',
    ]);
  });

  it('upserts rows carrying instrument, asset_class, trace_id and updated_at', async () => {
    const store = makeCurrentTickStore();
    const ctx: TickContext = { ...CTX, currentTickStore: store };

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    for (const row of store.rows) {
      expect(row).toEqual(
        expect.objectContaining({
          instrument: 'AAPL',
          asset_class: 'stocks',
          trace_id: TRACE_ID,
          updated_at: NOW,
        }),
      );
    }
  });

  it('deletes the row on a short-circuit exit without reaching later stages', async () => {
    const store = makeCurrentTickStore();
    const ctx: TickContext = { ...CTX, currentTickStore: store };
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(store.calls).toEqual([
      'upsert:analysts',
      'upsert:debate',
      'upsert:trader',
      'upsert:risk',
      'delete',
    ]);
  });

  it('is a no-op when no store is injected', async () => {
    await expect(
      new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, CTX),
    ).resolves.toBeDefined();
  });
});
