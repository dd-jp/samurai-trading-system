import type { Signal } from '../analysts/index.js';
import type { AnalystView, DebateResult } from '../debate-engine/index.js';
import type { ExecutionResult } from '../execution/index.js';
import type { RiskDecision } from '../risk-manager/index.js';
import type { Clock, OrderIntent } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import type { VerdictDecision } from '../verdict/index.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { TickContext, TickSteps } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const TRACE_ID = 'trace-aapl-1400';
const SIGNAL: Signal = { asset: 'AAPL', asset_class: 'stocks' };

/**
 * A fresh no-op logger + a SQLite audit log + SQLite current_tick store, each
 * over its own `:memory:` DB, so rows never leak across tests.
 */
function makeCtx(): TickContext {
  const db = openSharedStore(':memory:');
  return {
    clock: CLOCK,
    trace_id: TRACE_ID,
    logger: { log: vi.fn() },
    auditLog: new SqliteAuditLog(db),
    currentTickStore: new SqliteCurrentTickStore(db),
  };
}

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
    warnings: [],
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
    warnings: [],
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

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

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

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.execution).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'go', order: makeIntent() }),
    );
  });

  it('short-circuits before Execution on a Risk reject', async () => {
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.verdict).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'risk' });
  });

  it('short-circuits before Execution on a Verdict no-go', async () => {
    const steps = makeSteps({ verdict: vi.fn(async () => noGoVerdict()) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      trace_id: TRACE_ID,
      final_stage: 'verdict',
      verdict_status: 'no_go',
    });
  });

  it('short-circuits at Analysts when the view set is empty (quorum skip)', async () => {
    const steps = makeSteps({ analysts: vi.fn(async () => []) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'analysts' });
  });

  it('short-circuits at the Trader on a null intent (no-trade)', async () => {
    const steps = makeSteps({ trader: vi.fn(async () => null) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.risk).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'trader' });
  });

  it('threads the trace_id and clock into every stage call', async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    for (const step of [steps.analysts, steps.debate, steps.trader, steps.risk, steps.verdict]) {
      expect(step).toHaveBeenCalledWith(
        expect.objectContaining({ trace_id: TRACE_ID, clock: CLOCK }),
      );
    }
  });

  it('emits the Signal to Analysts and the instrument onward', async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

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

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

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

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.verdict).toHaveBeenCalledWith(
      expect.objectContaining({ risk_decision: riskDecision }),
    );
  });

  it('produces a complete, correctly-ordered audit_log trail for a full pass', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);
    expect(rows.every((row) => row.trace_id === TRACE_ID)).toBe(true);
    expect(rows).toHaveLength(new Set(rows.map((row) => row.stage)).size);
  });

  it('records only the stages reached before a short-circuit', async () => {
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual(['analysts', 'debate', 'trader', 'risk']);
  });

  it('logs every stage call with the same trace_id', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    expect(log).toHaveBeenCalledTimes(6);
    for (const call of log.mock.calls) {
      expect(call[0]).toMatchObject({ trace_id: TRACE_ID });
    }
    expect(log.mock.calls.map((call) => call[0].stage)).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);
  });

  it('upserts the current_tick row per stage and deletes it on completion', async () => {
    const seen: string[] = [];
    const intent = makeIntent();
    const ctx = makeCtx();
    const store = ctx.currentTickStore as SqliteCurrentTickStore;
    const steps = makeSteps({
      analysts: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return [makeView()];
      },
      debate: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return makeDebate();
      },
      trader: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return intent;
      },
      risk: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return approvedRisk(intent);
      },
      verdict: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return goVerdict(intent);
      },
      execution: async () => {
        seen.push(store.get('AAPL')?.stage ?? 'none');
        return makeExecutionResult();
      },
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    // Each stage observes the row already marked with its own name, upserted
    // just before that stage was called.
    expect(seen).toEqual(['analysts', 'debate', 'trader', 'risk', 'verdict', 'execution']);
    expect(store.get('AAPL')).toBeUndefined();
  });

  it('current_tick row carries the instrument, asset_class, and trace_id', async () => {
    const ctx = makeCtx();
    const store = ctx.currentTickStore as SqliteCurrentTickStore;
    let sawDuringDebate: ReturnType<SqliteCurrentTickStore['get']>;
    const steps = makeSteps({
      debate: async () => {
        sawDuringDebate = store.get('AAPL');
        return makeDebate();
      },
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(sawDuringDebate).toEqual({
      instrument: 'AAPL',
      asset_class: 'stocks',
      stage: 'debate',
      trace_id: TRACE_ID,
      updated_at: NOW,
    });
  });

  it('deletes the current_tick row on a short-circuit, not just the happy path', async () => {
    const ctx = makeCtx();
    const store = ctx.currentTickStore as SqliteCurrentTickStore;
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(store.get('AAPL')).toBeUndefined();
  });

  it('leaves a stale current_tick row in place if a stage throws (crash mid-tick)', async () => {
    const ctx = makeCtx();
    const store = ctx.currentTickStore as SqliteCurrentTickStore;
    const steps = makeSteps({
      debate: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx)).rejects.toThrow(
      'boom',
    );

    // The row is left exactly as it was before the throw — a stale progress
    // indicator, safely overwritten by the next tick's upsert, not cleared.
    expect(store.get('AAPL')).toMatchObject({ stage: 'debate', instrument: 'AAPL' });
  });
});

/**
 * #303: before this, `RiskDecision.warnings` had no production reader at all —
 * it rode along inside the `info` payload of the risk stage line and nothing
 * ever raised it. This is the consumer that observes it, and it is the reason
 * the correlation warm-up gap is now visible to an operator rather than
 * merely representable.
 */
describe('SequentialTickRunner.runInstrument — risk warnings surfacing (#303)', () => {
  function warnEntries(ctx: TickContext) {
    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    return log.mock.calls.map((call) => call[0]).filter((entry) => entry.level === 'warn');
  }

  it('raises a warn-level line naming every warning an approved RiskDecision carries', async () => {
    const intent = makeIntent();
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['correlation_warmup:MSFT', 'correlation_warmup:TSLA'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ trace_id: TRACE_ID, stage: 'risk', level: 'warn' });
    expect(warns[0].message).toContain('correlation_warmup:MSFT');
    expect(warns[0].message).toContain('correlation_warmup:TSLA');
    expect(warns[0].payload).toEqual({
      instrument: 'AAPL',
      warnings: ['correlation_warmup:MSFT', 'correlation_warmup:TSLA'],
    });
  });

  /**
   * A `correlation_warmup:` tag names one side of a PAIR, and the side short
   * on history may be this tick's own instrument. Without the intent's
   * instrument on the line, `correlation_warmup:MSFT` reads as "MSFT is new"
   * when the truth may be "AAPL is new and MSFT is fine".
   */
  it('names the tick instrument on the line, so a pair-scoped tag is not read as peer-scoped', async () => {
    const intent = makeIntent();
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['correlation_warmup:MSFT'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns[0].message).toContain('AAPL');
    expect(warns[0].payload).toMatchObject({ instrument: 'AAPL' });
  });

  it('raises the warning even when the decision is rejected and the tick short-circuits', async () => {
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...rejectedRisk(),
        warnings: ['correlation_warmup:BTC-USD'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('correlation_warmup:BTC-USD');
  });

  it('stays silent when the decision carries no warnings', async () => {
    const ctx = makeCtx();

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)).toEqual([]);
    // ...and the one-line-per-stage invariant is untouched on the quiet path.
    expect(ctx.logger.log).toHaveBeenCalledTimes(6);
  });
});
