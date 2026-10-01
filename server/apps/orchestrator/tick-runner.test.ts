import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { ExecutionResult } from '../../pipeline/execution/index.js';
import type { RiskDecision } from '../../pipeline/risk-manager/index.js';
import type { VerdictDecision } from '../../pipeline/verdict/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import { SequentialTickRunner } from './tick-runner.js';
import type { TickContext, TickSteps } from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const TRACE_ID = 'trace-aapl-1400';
const SIGNAL: Signal = { asset: 'AAPL', asset_class: 'stocks' };

const DECISION_BAR = {
  id: `${NOW.toISOString()}@3600000`,
  open_time: NOW,
  timeframe_ms: 3_600_000,
};

function makeCtx(overrides: { decision_bar?: TickContext['decision_bar'] } = {}): TickContext {
  const db = openSharedStore(':memory:');
  const decision_bar = 'decision_bar' in overrides ? overrides.decision_bar : DECISION_BAR;
  return {
    clock: CLOCK,
    trace_id: TRACE_ID,
    logger: { log: vi.fn() },
    auditLog: new SqliteAuditLog(db),
    currentTickStore: new SqliteCurrentTickStore(db),
    ...(decision_bar === undefined ? {} : { decision_bar }),
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
    bar_timestamp: NOW,
    read: true,
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
    decided_at: NOW,
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
    next_breaker_state: [],
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
    next_breaker_state: [],
  };
}

function goVerdict(intent: OrderIntent): VerdictDecision {
  return {
    status: 'go',
    order: intent,
    no_go_reason: null,
    no_go_detail: null,
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
    no_go_detail: null,
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

function makeSteps(overrides: Partial<TickSteps> = {}): TickSteps {
  const intent = makeIntent();
  return {
    exitCheck: vi.fn(async () => null),
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

  it('short-circuits at Analysts when the view set is empty (quorum skip), but still evaluates the flatten (#785)', async () => {
    const steps = makeSteps({ analysts: vi.fn(async () => []) });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
    expect(steps.execution).not.toHaveBeenCalled();
    expect(steps.exitCheck).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ trace_id: TRACE_ID, final_stage: 'position_check' });
  });

  it('names the cause of a quorum skip when the analysts step reports one (#1080)', async () => {
    const auditLog = new SqliteAuditLog(openSharedStore(':memory:'));
    const ctx = { ...makeCtx(), auditLog };
    const steps = makeSteps({
      analysts: vi.fn(async () => []),
      analystSkipKind: vi.fn(() => 'timeout' as const),
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(steps.analystSkipKind).toHaveBeenCalledWith(TRACE_ID);
    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    const analystsLine = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'analysts');
    expect(analystsLine.message).toBe('analysts: quorum_skip_timeout');
    expect(analystsLine.level).toBe('warn');

    const rows = auditLog.getByTraceId(TRACE_ID);
    expect(rows.find((row) => row.stage === 'analysts')?.decision).toBe('quorum_skip_timeout');
  });

  it('keeps the undifferentiated quorum_skip when no cause is reported', async () => {
    const ctx = makeCtx();
    const steps = makeSteps({ analysts: vi.fn(async () => []) });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    const analystsLine = log.mock.calls
      .map(([entry]) => entry)
      .find((entry) => entry.stage === 'analysts');
    expect(analystsLine.message).toBe('analysts: quorum_skip');
    expect(analystsLine.level).toBe('info');
  });

  it('does not ask for a skip cause on a pass that produced views', async () => {
    const steps = makeSteps({ analystSkipKind: vi.fn(() => undefined) });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.analystSkipKind).not.toHaveBeenCalled();
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

  it("threads the gate's decision bar onto the analysts step, unchanged and matching debate's bar (#811)", async () => {
    const steps = makeSteps();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(steps.analysts).toHaveBeenCalledWith(
      expect.objectContaining({ bar: DECISION_BAR.open_time }),
    );
    expect(steps.debate).toHaveBeenCalledWith(
      expect.objectContaining({ bar: DECISION_BAR.open_time }),
    );
  });

  it("warns, and still trades, when the debate claims a bar other than the gate's (#687/#743)", async () => {
    const debateBar = new Date(NOW.getTime() - 3_600_000);
    const steps = makeSteps({
      debate: vi.fn(async () => makeDebate({ bar_timestamp: debateBar })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(ctx.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: TRACE_ID,
        stage: 'debate',
        event: 'decision_bar_divergence',
        level: 'warn',
        payload: {
          instrument: 'AAPL',
          gate_bar: NOW.toISOString(),
          debate_bar: debateBar.toISOString(),
          debate_id: 'debate-1',
        },
      }),
    );
    expect(steps.trader).toHaveBeenCalled();
  });

  it('does not warn when the debate keys to the gate bar', async () => {
    const ctx = makeCtx();

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    expect(ctx.logger.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'decision_bar_divergence' }),
    );
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

  it('attributes every audit row to the instrument and asset class it came from', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows).not.toHaveLength(0);
    expect(
      rows.every(
        (row) => row.instrument === SIGNAL.asset && row.asset_class === SIGNAL.asset_class,
      ),
    ).toBe(true);
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

    expect(store.get('AAPL')).toMatchObject({ stage: 'debate', instrument: 'AAPL' });
  });
});

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
      advisory: true,
    });
  });

  it('marks the line advisory so a monitor paging on level:warn can exclude it by field', async () => {
    const intent = makeIntent();
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['correlation_warmup:MSFT'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)[0].payload).toMatchObject({ advisory: true });
  });

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

  it('surfaces a CII macro_risk_flag through the same reader (#205, unraised until now)', async () => {
    const intent = makeIntent();
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['macro_risk_flag:RU'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('macro_risk_flag:RU');
  });

  it('warns once per instrument on first sight, then stays quiet while the warning set is unchanged', async () => {
    const intent = makeIntent();
    const universe = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD'];
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['correlation_warmup:QQQ', 'correlation_warmup:ETH-USD'],
      })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    for (let tick = 0; tick < 3; tick++) {
      for (const asset of universe) {
        await runner.runInstrument({ asset, asset_class: 'stocks' }, ctx);
      }
    }

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(universe.length);
    expect(warns.map((entry) => entry.payload.instrument).sort()).toEqual([...universe].sort());
  });

  it('treats a reordered but identical warning set as unchanged', async () => {
    const intent = makeIntent();
    let warnings = ['correlation_warmup:MSFT', 'correlation_warmup:TSLA'];
    const steps = makeSteps({
      risk: vi.fn(async () => ({ ...approvedRisk(intent), warnings: [...warnings] })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    await runner.runInstrument(SIGNAL, ctx);
    warnings = ['correlation_warmup:TSLA', 'correlation_warmup:MSFT'];
    await runner.runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)).toHaveLength(1);
  });

  it('keeps the payload in the order the risk manager produced, not sorted', async () => {
    const intent = makeIntent();
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: ['correlation_warmup:TSLA', 'correlation_warmup:MSFT'],
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)[0].payload.warnings).toEqual([
      'correlation_warmup:TSLA',
      'correlation_warmup:MSFT',
    ]);
  });

  it('warns again when the warning set actually changes for that instrument', async () => {
    const intent = makeIntent();
    let warnings = ['correlation_warmup:MSFT', 'correlation_warmup:TSLA'];
    const steps = makeSteps({
      risk: vi.fn(async () => ({ ...approvedRisk(intent), warnings: [...warnings] })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    await runner.runInstrument(SIGNAL, ctx);
    await runner.runInstrument(SIGNAL, ctx);
    warnings = ['correlation_warmup:MSFT'];
    await runner.runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(2);
    expect(warns[1].payload.warnings).toEqual(['correlation_warmup:MSFT']);
  });

  it('confirms at info when the warnings clear, rather than just going silent', async () => {
    const intent = makeIntent();
    let warnings = ['correlation_warmup:MSFT'];
    const steps = makeSteps({
      risk: vi.fn(async () => ({ ...approvedRisk(intent), warnings: [...warnings] })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    await runner.runInstrument(SIGNAL, ctx);
    warnings = [];
    await runner.runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)).toHaveLength(1);
    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    const cleared = log.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.level === 'info' && entry.payload?.advisory === true);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ stage: 'risk', level: 'info' });
    expect(cleared[0].payload).toMatchObject({ instrument: 'AAPL', advisory: true, warnings: [] });
  });

  it('does not emit a cleared line for an instrument that never warned', async () => {
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(makeSteps());

    await runner.runInstrument(SIGNAL, ctx);
    await runner.runInstrument(SIGNAL, ctx);

    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    const advisory = log.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.payload?.advisory === true);
    expect(advisory).toEqual([]);
  });

  it('tracks each instrument independently, so one instrument does not mask another', async () => {
    const intent = makeIntent();
    const byInstrument: Record<string, string[]> = {
      AAPL: ['correlation_warmup:MSFT'],
      TSLA: ['correlation_warmup:MSFT'],
    };
    let current = 'AAPL';
    const steps = makeSteps({
      risk: vi.fn(async () => ({
        ...approvedRisk(intent),
        warnings: byInstrument[current] ?? [],
      })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    current = 'AAPL';
    await runner.runInstrument({ asset: 'AAPL', asset_class: 'stocks' }, ctx);
    current = 'TSLA';
    await runner.runInstrument({ asset: 'TSLA', asset_class: 'stocks' }, ctx);

    expect(warnEntries(ctx).map((entry) => entry.payload.instrument)).toEqual(['AAPL', 'TSLA']);
  });

  it('stays silent when the decision carries no warnings', async () => {
    const ctx = makeCtx();

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)).toEqual([]);
    expect(ctx.logger.log).toHaveBeenCalledTimes(6);
  });
});

function exitIntent(reason: 'flatten' | 'signal_decay'): OrderIntent {
  const base = makeIntent({ intent_type: 'exit', side: 'sell' });
  return { ...base, metadata: { ...base.metadata, exit_reason: reason } };
}

describe('SequentialTickRunner tick pass (#743)', () => {
  function tickOnlySteps(overrides: Partial<TickSteps> = {}): TickSteps {
    return makeSteps({
      analysts: vi.fn(async () => {
        throw new Error('analysts must not run on a tick pass');
      }),
      debate: vi.fn(async () => {
        throw new Error('debate must not run on a tick pass');
      }),
      trader: vi.fn(async () => {
        throw new Error('the decision-entry Trader must not run on a tick pass');
      }),
      ...overrides,
    });
  }

  it('runs ONLY the exit check when no exit is due, and never touches the decision chain', async () => {
    const steps = tickOnlySteps();
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('position_check');
    expect(outcome.flatten_fired).toBeUndefined();
    expect(steps.exitCheck).toHaveBeenCalledTimes(1);
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
    expect(steps.risk).not.toHaveBeenCalled();

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual(['position_check']);
    expect(rows[0]?.decision).toBe('no_exit_due');
    expect(ctx.currentTickStore.get('AAPL')).toBeUndefined();
  });

  it('fires the flatten through Risk → Verdict → Execution and stamps flatten_fired', async () => {
    const exit = exitIntent('flatten');
    const steps = tickOnlySteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('execution');
    expect(outcome.flatten_fired).toBe(true);
    expect(outcome.execution_result?.status).toBe('submitted');
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual([
      'position_check',
      'risk',
      'verdict',
      'execution',
    ]);
    expect(rows[0]?.decision).toBe('flatten');
  });

  it('hands the exit check the tick bar on the debate grid', async () => {
    const midBar = new Date('2026-07-15T14:41:07Z');
    const steps = tickOnlySteps();
    const ctx = { ...makeCtx({ decision_bar: undefined }), clock: { now: () => midBar } };

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(steps.exitCheck).toHaveBeenCalledWith(
      expect.objectContaining({ bar: new Date('2026-07-15T14:00:00Z') }),
    );
  });

  it('keeps a rejected flatten observable: risk is the final stage, flatten_fired still set', async () => {
    const exit = exitIntent('flatten');
    const steps = tickOnlySteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => rejectedRisk()),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('risk');
    expect(outcome.flatten_fired).toBe(true);
  });

  it('fires an INDICATOR-BASED EARLY EXIT on a tick that performs no analyst run', async () => {
    const exit = exitIntent('signal_decay');
    const steps = tickOnlySteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('execution');
    expect(outcome.early_exit_fired).toBe(true);
    expect(outcome.flatten_fired).toBeUndefined();
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows[0]?.decision).toBe('signal_decay');
  });

  it('keeps a rejected early exit observable: risk is the final stage, early_exit_fired still set', async () => {
    const exit = exitIntent('signal_decay');
    const steps = tickOnlySteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => rejectedRisk()),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('risk');
    expect(outcome.early_exit_fired).toBe(true);
    expect(outcome.flatten_fired).toBeUndefined();
  });
});

describe('SequentialTickRunner tick pass logging level (#1113)', () => {
  function recordLines(ctx: TickContext) {
    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    return log.mock.calls.map((call) => call[0]);
  }

  it('logs a no-exit tick at debug, not info', async () => {
    const steps = makeSteps();
    const ctx = makeCtx({ decision_bar: undefined });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const lines = recordLines(ctx).filter((entry) => entry.stage === 'position_check');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      stage: 'position_check',
      level: 'debug',
      message: 'position_check: no_exit_due',
    });

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual(['position_check']);
    expect(rows[0]?.decision).toBe('no_exit_due');
  });

  it('keeps a flatten at info, not debug', async () => {
    const exit = exitIntent('flatten');
    const steps = makeSteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const lines = recordLines(ctx).filter((entry) => entry.stage === 'position_check');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      stage: 'position_check',
      level: 'info',
      message: 'position_check: flatten',
    });
  });

  it('keeps an indicator-based early exit (signal_decay) at info, not debug', async () => {
    const exit = exitIntent('signal_decay');
    const steps = makeSteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const lines = recordLines(ctx).filter((entry) => entry.stage === 'position_check');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      stage: 'position_check',
      level: 'info',
      message: 'position_check: signal_decay',
    });
  });

  it('keeps an exit intent with no exit_reason at info — the whitelist is on the decision word, not on "any exit"', async () => {
    const exit: OrderIntent = {
      ...exitIntent('flatten'),
      metadata: { ...exitIntent('flatten').metadata },
    };
    delete (exit.metadata as { exit_reason?: string }).exit_reason;
    const steps = makeSteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const lines = recordLines(ctx).filter((entry) => entry.stage === 'position_check');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      stage: 'position_check',
      level: 'info',
      message: 'position_check: exit',
    });
  });
});

describe('SequentialTickRunner quorum-skip flatten (#785)', () => {
  function quorumSkipSteps(overrides: Partial<TickSteps> = {}): TickSteps {
    return makeSteps({
      analysts: vi.fn(async () => []),
      debate: vi.fn(async () => {
        throw new Error('unreachable: quorum-skipped, no Trader entry point runs');
      }),
      trader: vi.fn(async () => {
        throw new Error('unreachable: quorum-skipped, no Trader entry point runs');
      }),
      ...overrides,
    });
  }

  it('fires the flatten through Risk -> Verdict -> Execution on a quorum-skipped pass', async () => {
    const exit = exitIntent('flatten');
    const steps = quorumSkipSteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(outcome.final_stage).toBe('execution');
    expect(outcome.flatten_fired).toBe(true);
    expect(steps.exitCheck).toHaveBeenCalledTimes(1);
    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
  });

  it('keeps a rejected flatten observable on a quorum-skipped pass: risk is the final stage, flatten_fired still set', async () => {
    const exit = exitIntent('flatten');
    const steps = quorumSkipSteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => rejectedRisk()),
    });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, makeCtx());

    expect(outcome.final_stage).toBe('risk');
    expect(outcome.flatten_fired).toBe(true);
  });

  it('hands the exit check the GATE bar, not a fresh clock re-floor', async () => {
    const claimedOpen = new Date('2026-07-15T13:00:00Z');
    const steps = quorumSkipSteps();
    const ctx = makeCtx({
      decision_bar: {
        id: `${claimedOpen.toISOString()}@3600000`,
        open_time: claimedOpen,
        timeframe_ms: 3_600_000,
      },
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(steps.exitCheck).toHaveBeenCalledWith(expect.objectContaining({ bar: claimedOpen }));
  });
});

describe('SequentialTickRunner decision bar identity (#743)', () => {
  function warnLines(ctx: TickContext): string[] {
    return (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([entry]) => entry as { level: string; message: string })
      .filter((entry) => entry.level === 'warn')
      .map((entry) => entry.message);
  }

  it('passes the GATE bar down to the debate step, not a clock re-floor', async () => {
    const claimedOpen = new Date('2026-07-15T13:00:00Z');
    const steps = makeSteps({
      debate: vi.fn(async () => makeDebate({ bar_timestamp: claimedOpen })),
    });
    const ctx = makeCtx({
      decision_bar: {
        id: `${claimedOpen.toISOString()}@3600000`,
        open_time: claimedOpen,
        timeframe_ms: 3_600_000,
      },
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(steps.debate).toHaveBeenCalledWith(expect.objectContaining({ bar: claimedOpen }));
  });

  it('warns loudly when the debate result claims a different bar than the gate opened', async () => {
    const divergedBar = new Date(NOW.getTime() + 3_600_000);
    const steps = makeSteps({
      debate: vi.fn(async () => makeDebate({ bar_timestamp: divergedBar })),
    });
    const ctx = makeCtx();

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const warns = warnLines(ctx).filter((message) => message.includes('decision bar divergence'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(NOW.toISOString());
    expect(warns[0]).toContain(divergedBar.toISOString());
    expect(outcome.final_stage).toBe('execution');
  });

  it('stays silent when the debate result carries the gate bar', async () => {
    const ctx = makeCtx();

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    expect(warnLines(ctx).filter((m) => m.includes('decision bar divergence'))).toEqual([]);
  });

  it('never calls the exit check on a decision pass — one Trader entry point per pass', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(steps.exitCheck).not.toHaveBeenCalled();
    expect(steps.trader).toHaveBeenCalledTimes(1);
  });
});

describe('SequentialTickRunner.runInstrument — execution stage error log level (#921)', () => {
  function recordLines(ctx: TickContext) {
    const log = ctx.logger.log as ReturnType<typeof vi.fn>;
    return log.mock.calls.map((call) => call[0]);
  }

  it('logs at error level when the execution stage reports status: error', async () => {
    const steps = makeSteps({
      execution: vi.fn(async () => ({
        status: 'error' as const,
        idempotency_key: 'key-aapl-1355',
        broker_order_ids: null,
        order_state: null,
        reason: 'cancelling held lot failed, so the flatten was refused',
        timestamp: NOW,
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const executionLines = recordLines(ctx).filter((entry) => entry.stage === 'execution');
    expect(executionLines).toHaveLength(1);
    expect(executionLines[0]).toMatchObject({
      stage: 'execution',
      level: 'error',
      message: 'execution: error',
    });
  });

  it('keeps the execution stage at info level for a non-error outcome (submitted)', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const executionLines = recordLines(ctx).filter((entry) => entry.stage === 'execution');
    expect(executionLines).toHaveLength(1);
    expect(executionLines[0]).toMatchObject({ stage: 'execution', level: 'info' });
  });

  it('keeps a deduped execution outcome at info level — the escalation is scoped to status: error alone', async () => {
    const steps = makeSteps({
      execution: vi.fn(async () => ({
        status: 'deduped' as const,
        idempotency_key: 'key-aapl-1355',
        broker_order_ids: null,
        order_state: null,
        reason: 'an order or fill already exists for this idempotency_key',
        timestamp: NOW,
      })),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const executionLines = recordLines(ctx).filter((entry) => entry.stage === 'execution');
    expect(executionLines[0]).toMatchObject({ stage: 'execution', level: 'info' });
  });

  it('does not broaden the escalation to other stages: a Risk rejection still logs at info', async () => {
    const steps = makeSteps({ risk: vi.fn(async () => rejectedRisk()) });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const riskLines = recordLines(ctx).filter(
      (entry) => entry.stage === 'risk' && entry.message === 'risk: rejected',
    );
    expect(riskLines).toHaveLength(1);
    expect(riskLines[0]).toMatchObject({ stage: 'risk', level: 'info' });
  });

  it('does not broaden the escalation to other stages: a Verdict no_go still logs at info', async () => {
    const steps = makeSteps({ verdict: vi.fn(async () => noGoVerdict()) });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const verdictLines = recordLines(ctx).filter((entry) => entry.stage === 'verdict');
    expect(verdictLines).toHaveLength(1);
    expect(verdictLines[0]).toMatchObject({ stage: 'verdict', level: 'info' });
  });
});

describe('SequentialTickRunner.runInstrument — the portfolio-tail turnstile (#1040)', () => {
  function ctxWithTurnstile(
    order: string[],
    overrides: { decision_bar?: TickContext['decision_bar'] } = {},
  ): TickContext {
    return {
      ...makeCtx(overrides),
      beginPortfolioTail: async () => {
        order.push('turnstile');
      },
    };
  }

  it('enters the turnstile AFTER the debate and BEFORE the trader on a decision pass', async () => {
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

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctxWithTurnstile(order));

    expect(order).toEqual([
      'analysts',
      'debate',
      'turnstile',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);
  });

  it('never enters the turnstile on a tick pass with no exit due', async () => {
    const order: string[] = [];
    const steps = makeSteps({
      exitCheck: async () => {
        order.push('exitCheck');
        return null;
      },
    });

    const outcome = await new SequentialTickRunner(steps).runInstrument(
      SIGNAL,
      ctxWithTurnstile(order, { decision_bar: undefined }),
    );

    expect(order).toEqual(['exitCheck']);
    expect(outcome.final_stage).toBe('position_check');
  });

  it('enters the turnstile after the exit check when the check produces an intent', async () => {
    const order: string[] = [];
    const intent = exitIntent('flatten');
    const steps = makeSteps({
      exitCheck: async () => {
        order.push('exitCheck');
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

    const outcome = await new SequentialTickRunner(steps).runInstrument(
      SIGNAL,
      ctxWithTurnstile(order, { decision_bar: undefined }),
    );

    expect(order).toEqual(['exitCheck', 'turnstile', 'risk', 'verdict', 'execution']);
    expect(outcome.final_stage).toBe('execution');
  });

  it('takes no turn on a quorum-skipped pass that produces no exit intent', async () => {
    const order: string[] = [];
    const steps = makeSteps({
      analysts: async () => {
        order.push('analysts');
        return [];
      },
      exitCheck: async () => {
        order.push('exitCheck');
        return null;
      },
    });

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctxWithTurnstile(order));

    expect(order).toEqual(['analysts', 'exitCheck']);
  });

  it('runs the whole pass when no turnstile is supplied (backtest, smoke, control arm)', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();
    expect(ctx.beginPortfolioTail).toBeUndefined();

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    expect(outcome.final_stage).toBe('execution');
    expect(steps.execution).toHaveBeenCalledTimes(1);
  });
});

describe('SequentialTickRunner degraded-debate legibility (#1080)', () => {
  function starvedDebate(): DebateResult {
    return makeDebate({
      synthesis: 'Debate terminated before any round completed; no synthesis available.',
      confidence: 0,
      converged: false,
      rounds_completed: 0,
      direction: 'neutral',
      open_items: ['debate did not complete within latency budget'],
      timed_out: { budget_ms: 60_000, elapsed_ms: 60_002 },
    });
  }

  it('records a starved debate as budget_exhausted, not as a neutral direction', async () => {
    const steps = makeSteps({
      debate: vi.fn(async () => starvedDebate()),
      trader: vi.fn(async () => null),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    const debateRow = rows.find((row) => row.stage === 'debate');
    expect(debateRow?.decision).toBe('budget_exhausted');
    expect(rows.find((row) => row.stage === 'trader')?.decision).toBe('no_trade');
  });

  it('raises the log level for a starved debate above ordinary stage traffic', async () => {
    const steps = makeSteps({
      debate: vi.fn(async () => starvedDebate()),
      trader: vi.fn(async () => null),
    });
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const logged = (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls.map(
      ([entry]) => entry as { stage: string; level: string; message: string },
    );
    const debateLine = logged.find((entry) => entry.message === 'debate: budget_exhausted');
    expect(debateLine?.level).toBe('warn');
    expect(logged.find((entry) => entry.message === 'analysts: quorum_met')?.level).toBe('info');
    expect(logged.find((entry) => entry.message === 'trader: no_trade')?.level).toBe('info');
  });

  it('keeps a debate that resolved on its own terms recording its direction', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.find((row) => row.stage === 'debate')?.decision).toBe('bullish');
  });
});
