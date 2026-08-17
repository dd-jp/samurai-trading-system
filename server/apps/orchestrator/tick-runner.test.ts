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

/**
 * The decision bar a gate would grant at NOW (14:00 is bar-aligned on the 1h
 * grid, so the bar's open IS the tick instant).
 */
const DECISION_BAR = {
  id: `${NOW.toISOString()}@3600000`,
  open_time: NOW,
  timeframe_ms: 3_600_000,
};

/**
 * A fresh no-op logger + a SQLite audit log + SQLite current_tick store, each
 * over its own `:memory:` DB, so rows never leak across tests.
 *
 * Carries `decision_bar` by default (#743): the pre-split tests in this file
 * all exercise the decision chain, which now only runs on a granted claim.
 * Tick-path tests pass `{ decision_bar: undefined }` to strip it.
 */
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
    // #687: NOW is bar-aligned, so this is the bar the Trader now inherits
    // instead of flooring a clock read of its own.
    bar_timestamp: NOW,
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
    // Tick-path exits: null = no position to flatten. Decision-chain tests
    // never reach this step (their ctx carries `decision_bar`).
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

  it('attributes every audit row to the instrument and asset class it came from', async () => {
    const steps = makeSteps();
    const ctx = makeCtx();

    await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    // Migration 0013. Asserted on the RUNNER rather than only on the store,
    // because the store happily accepts a row without them: this is the caller
    // that has to pass them, and until it did, every tick that short-circuited
    // before Verdict was attributable to no instrument at all.
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
      advisory: true,
    });
  });

  /**
   * `advisory: true` is the field a generic log pipeline filters on. Level
   * alone is not enough: a monitor that pages on `level:warn` has no other way
   * to tell an advisory apart from a stuck fill or a kill-threshold breach.
   */
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

  /**
   * The reader is warning-agnostic, not correlation-specific. `macro_risk_flag`
   * has been produced since #205 and, like the warm-up tag, had no reader — it
   * rode along in the risk stage's `info` payload. This pins that the same fix
   * surfaces it, so the claim is checked rather than assumed.
   */
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

  /**
   * The #381 day-1 soak, costed. `DEFAULT_TICK_INTERVAL_MS` is 60s, so six
   * instruments repeating a warn every tick is ~8,640 warn lines a day — and
   * with `min_bars: 20` on a `1d` timeframe the condition does not clear
   * inside a 14-day run, so that is essentially the whole soak's warn volume.
   * An operator who sees thousands of identical warns stops reading warns,
   * and then misses the stuck fill. Same defect #362 fixed at startup.
   *
   * So the warn marks a CHANGE, not a state. The state itself is already in
   * the log every tick: `record('risk', ...)` writes the whole `RiskDecision`,
   * `warnings` included, to its `info` payload. Nothing is lost by going quiet.
   */
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

    // Three ticks over the whole universe — 18 instrument-passes.
    for (let tick = 0; tick < 3; tick++) {
      for (const asset of universe) {
        await runner.runInstrument({ asset, asset_class: 'stocks' }, ctx);
      }
    }

    // Six warns, not eighteen: one per instrument, on its first sight.
    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(universe.length);
    expect(warns.map((entry) => entry.payload.instrument).sort()).toEqual([...universe].sort());
  });

  /**
   * `insufficient_history` follows `Object.keys(exposure_by_instrument)`, whose
   * insertion order follows `getOpenPositions()`'s `ORDER BY opened_at` — no
   * tiebreak, and the order shifts whenever a position closes and reopens. An
   * order-sensitive signature would read a reordering as a change and re-fire,
   * defeating the suppression outright. The set is what matters, not its order.
   */
  it('treats a reordered but identical warning set as unchanged', async () => {
    const intent = makeIntent();
    let warnings = ['correlation_warmup:MSFT', 'correlation_warmup:TSLA'];
    const steps = makeSteps({
      risk: vi.fn(async () => ({ ...approvedRisk(intent), warnings: [...warnings] })),
    });
    const ctx = makeCtx();
    const runner = new SequentialTickRunner(steps);

    await runner.runInstrument(SIGNAL, ctx);
    warnings = ['correlation_warmup:TSLA', 'correlation_warmup:MSFT']; // same set, reordered
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
    await runner.runInstrument(SIGNAL, ctx); // unchanged — suppressed
    warnings = ['correlation_warmup:MSFT']; // TSLA gained coverage
    await runner.runInstrument(SIGNAL, ctx);

    const warns = warnEntries(ctx);
    expect(warns).toHaveLength(2);
    expect(warns[1].payload.warnings).toEqual(['correlation_warmup:MSFT']);
  });

  /**
   * If the warn simply stopped, an operator would have no positive
   * confirmation that coverage completed — only an absence, which is
   * indistinguishable from the reader having broken. One transition line
   * closes that. It is `info`, not `warn`: good news must never page.
   */
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

    expect(warnEntries(ctx)).toHaveLength(1); // no warn for the clear
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

    // Same warning text, different instruments — both must be raised.
    expect(warnEntries(ctx).map((entry) => entry.payload.instrument)).toEqual(['AAPL', 'TSLA']);
  });

  it('stays silent when the decision carries no warnings', async () => {
    const ctx = makeCtx();

    await new SequentialTickRunner(makeSteps()).runInstrument(SIGNAL, ctx);

    expect(warnEntries(ctx)).toEqual([]);
    // ...and the one-line-per-stage invariant is untouched on the quiet path.
    expect(ctx.logger.log).toHaveBeenCalledTimes(6);
  });
});

/**
 * The tick/decision split (#743): a ctx WITHOUT `decision_bar` is a tick pass
 * — the exit check and, on an intent, the Risk → Verdict → Execution tail.
 * Nothing else.
 */
/**
 * An in-process exit intent, named by WHY it exists (#748). The runner reads
 * `metadata.exit_reason` to decide which flag to stamp and what to write into
 * the audit row, so a test fixture that omitted it would exercise a shape no
 * Trader entry point can produce.
 */
function exitIntent(reason: 'flatten' | 'signal_decay'): OrderIntent {
  const base = makeIntent({ intent_type: 'exit', side: 'sell' });
  return { ...base, metadata: { ...base.metadata, exit_reason: reason } };
}

describe('SequentialTickRunner tick pass (#743)', () => {
  /** Steps whose decision chain is UNREACHABLE — analysts and debate throw. */
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
    // The structural half of the assertion: the exit branch CANNOT read
    // analyst views or debate output because those steps never ran — they
    // throw if touched, and `TickSteps.exitCheck`'s input carries neither.
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();
    expect(steps.risk).not.toHaveBeenCalled();

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    expect(rows.map((row) => row.stage)).toEqual(['position_check']);
    expect(rows[0]?.decision).toBe('no_exit_due');
    // Terminal return: the progress row is cleared, not left stale.
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

    // HAZARD 1 of #743 (the 2f22033 defect shape): the flatten must reach the
    // broker from the CHEAP path — no analysts, no debate, no decision claim.
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
    // 14:41:07 floors to 14:00 on the 1h debate grid — the SAME grid the
    // decision gate claims on, so a tick-pass flatten and a decision-pass
    // flatten inside one bar key their idempotent exits to one coordinate.
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

  // ── #748: the indicator-based early exit rides the SAME cheap path. ──────
  it('fires an INDICATOR-BASED EARLY EXIT on a tick that performs no analyst run', async () => {
    const exit = exitIntent('signal_decay');
    const steps = tickOnlySteps({
      exitCheck: vi.fn(async () => exit),
      risk: vi.fn(async () => approvedRisk(exit)),
      verdict: vi.fn(async () => goVerdict(exit)),
    });
    const ctx = makeCtx({ decision_bar: undefined });

    const outcome = await new SequentialTickRunner(steps).runInstrument(SIGNAL, ctx);

    // The acceptance criterion, asserted rather than assumed: the release
    // reached the broker on a pass where the analyst step would have THROWN if
    // anything had touched it, and the debate step likewise. An early exit that
    // needed either could not have completed this pass at all.
    expect(outcome.final_stage).toBe('execution');
    expect(outcome.early_exit_fired).toBe(true);
    expect(outcome.flatten_fired).toBeUndefined();
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();
    expect(steps.trader).not.toHaveBeenCalled();

    const rows = (ctx.auditLog as SqliteAuditLog).getByTraceId(TRACE_ID);
    // Named apart from a flatten in the audit spine, not merged into it.
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

/**
 * #743's bar-identity assertion: on a decision pass the gate's bar is the
 * single source, and a `DebateResult` disagreeing with it must be LOUD —
 * the downstream failure mode (an intent suppressed as a duplicate) is
 * otherwise indistinguishable from a healthy no-trade tick.
 */
describe('SequentialTickRunner decision bar identity (#743)', () => {
  function warnLines(ctx: TickContext): string[] {
    return (ctx.logger.log as ReturnType<typeof vi.fn>).mock.calls
      .map(([entry]) => entry as { level: string; message: string })
      .filter((entry) => entry.level === 'warn')
      .map((entry) => entry.message);
  }

  it('passes the GATE bar down to the debate step, not a clock re-floor', async () => {
    // The gate claimed 13:00's bar; by the time this pass runs, the clock is
    // in 14:00's. A runner that re-floors `clock.now()` hands the debate
    // 14:00 and passes anyway when the two agree — this ctx is built so they
    // do not (#687's straddle, at the runner seam).
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
    // Observable, not fatal: the pass proceeds and downstream gates refuse.
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
