import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView, DebateResult } from '../../pipeline/debate-engine/index.js';
import type { ExecutionResult } from '../../pipeline/execution/index.js';
import type { RiskDecision } from '../../pipeline/risk-manager/index.js';
import type { VerdictDecision } from '../../pipeline/verdict/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import { SimulatedClock } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { DebateBarDecisionGate } from './decision-bar-gate.js';
import { startTickLoop } from './production.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import { runTickPlan } from './tick-loop.js';
import { SequentialTickRunner } from './tick-runner.js';
import type {
  Logger,
  Scheduler,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickSteps,
} from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const LOGGER: Logger = { log: vi.fn() };

const NOTIONAL = 100;
const GROSS_CAP = 150;

function makePlan(...assets: string[]): TickPlan {
  return {
    instruments: assets.map((asset) => ({ asset, asset_class: 'stocks' as const })),
    tick_time: NOW,
  };
}

function loopConfig() {
  const db = openSharedStore(':memory:');
  return {
    newTraceId: (() => {
      let n = 0;
      return () => `trace-${++n}`;
    })(),
    logger: LOGGER,
    auditLog: new SqliteAuditLog(db),
    currentTickStore: new SqliteCurrentTickStore(db),
    decisionGate: new DebateBarDecisionGate(),
  };
}

function makeView(instrument: string): AnalystView {
  return {
    trace_id: `trace-${instrument}`,
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.8,
    key_points: ['price above the 50d'],
    timestamp: NOW,
  };
}

function makeDebate(instrument: string): DebateResult {
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
    debate_id: `debate-${instrument}`,
    bar_timestamp: NOW,
    read: true,
  };
}

function makeIntent(instrument: string): OrderIntent {
  return {
    idempotency_key: `key-${instrument}`,
    instrument,
    asset_class: 'stocks',
    side: 'buy',
    intent_type: 'entry',
    size: 1,
    entry: NOTIONAL,
    stop: 95,
    target: 110,
    time_in_force: 'day',
    decision_timestamp: NOW,
    decided_at: NOW,
    metadata: {
      debate_id: `debate-${instrument}`,
      conviction: 0.7,
      converged: true,
      sizing: {
        base_risk_fraction: 0.01,
        conviction_multiplier: 1,
        vol_floor_factor: 1,
        non_converged_haircut: 1,
        cosine_multiplier: 0.75,
      },
      cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
    },
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
    binding_constraint: 'portfolio:gross_exposure',
    reasons: ['portfolio:gross_exposure: the entry would breach the gross cap'],
    warnings: [],
    risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
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

function submitted(intent: OrderIntent): ExecutionResult {
  return {
    status: 'submitted',
    idempotency_key: intent.idempotency_key,
    broker_order_ids: [`broker-${intent.instrument}`],
    order_state: 'submitted',
    reason: null,
    timestamp: NOW,
  };
}

function deferredHeads(assets: readonly string[]): {
  wait: (asset: string) => Promise<void>;
  release: (asset: string) => void;
} {
  const resolvers = new Map<string, () => void>();
  const promises = new Map<string, Promise<void>>();
  for (const asset of assets) {
    promises.set(asset, new Promise<void>((resolve) => resolvers.set(asset, resolve)));
  }
  return {
    wait: (asset) => promises.get(asset) ?? Promise.resolve(),
    release: (asset) => resolvers.get(asset)?.(),
  };
}

function bookSteps(heads: ReturnType<typeof deferredHeads>): {
  steps: TickSteps;
  book: { gross: number };
  tailOrder: string[];
} {
  const book = { gross: 0 };
  const tailOrder: string[] = [];

  const steps: TickSteps = {
    exitCheck: async () => null,
    analysts: async ({ signal }) => {
      await heads.wait(signal.asset);
      return [makeView(signal.asset)];
    },
    debate: async ({ instrument }) => makeDebate(instrument),
    trader: async ({ instrument }) => {
      tailOrder.push(instrument);
      return makeIntent(instrument);
    },
    risk: async ({ intent }) => {
      await Promise.resolve();
      const notional = intent.size * intent.entry;
      return book.gross + notional > GROSS_CAP ? rejectedRisk() : approvedRisk(intent);
    },
    verdict: async ({ risk_decision }) => goVerdict(risk_decision.order_intent as OrderIntent),
    execution: async (verdict) => {
      const order = verdict.order as OrderIntent;
      book.gross += order.size * order.entry;
      return submitted(order);
    },
  };

  return { steps, book, tailOrder };
}

function decisionCtx(signal: Signal, overrides: Partial<TickContext> = {}): TickContext {
  const db = openSharedStore(':memory:');
  return {
    clock: CLOCK,
    trace_id: `trace-${signal.asset}`,
    logger: LOGGER,
    auditLog: new SqliteAuditLog(db),
    currentTickStore: new SqliteCurrentTickStore(db),
    decision_bar: { id: `${NOW.toISOString()}@3600000`, open_time: NOW, timeframe_ms: 3_600_000 },
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('phase split — the exposure race within one pass (#1040)', () => {
  it('rejects the second instrument, because Risk saw the first one fill', async () => {
    const heads = deferredHeads(['SPY', 'QQQ']);
    const { steps, book, tailOrder } = bookSteps(heads);

    const pending = runTickPlan(makePlan('SPY', 'QQQ'), new SequentialTickRunner(steps), CLOCK, {
      ...loopConfig(),
      max_concurrent_instruments: 2,
    });

    await settle();
    expect(tailOrder).toEqual([]);

    heads.release('QQQ');
    heads.release('SPY');

    const outcomes = await pending;

    expect(tailOrder).toEqual(['SPY', 'QQQ']);
    expect(outcomes[0]).toMatchObject({ final_stage: 'execution', verdict_status: 'go' });
    expect(outcomes[1]).toMatchObject({ final_stage: 'risk' });
    expect(book.gross).toBe(NOTIONAL);
    expect(book.gross).toBeLessThanOrEqual(GROSS_CAP);
  });

  it('breaches the cap without the turnstile — the defect this closes', async () => {
    const heads = deferredHeads(['SPY', 'QQQ']);
    const { steps, book } = bookSteps(heads);
    const runner = new SequentialTickRunner(steps);

    const passes = Promise.all([
      runner.runInstrument(
        { asset: 'SPY', asset_class: 'stocks' },
        decisionCtx({ asset: 'SPY', asset_class: 'stocks' }),
      ),
      runner.runInstrument(
        { asset: 'QQQ', asset_class: 'stocks' },
        decisionCtx({ asset: 'QQQ', asset_class: 'stocks' }),
      ),
    ]);

    heads.release('SPY');
    heads.release('QQQ');
    const outcomes = await passes;

    expect(outcomes[0]?.final_stage).toBe('execution');
    expect(outcomes[1]?.final_stage).toBe('execution');
    expect(book.gross).toBe(2 * NOTIONAL);
    expect(book.gross).toBeGreaterThan(GROSS_CAP);
  });
});

describe('phase split — tail order is plan order, not completion order (#1040)', () => {
  const PERMUTATIONS: ReadonlyArray<readonly string[]> = [
    ['SPY', 'QQQ', 'AAPL', 'TSLA'],
    ['TSLA', 'AAPL', 'QQQ', 'SPY'],
    ['QQQ', 'TSLA', 'SPY', 'AAPL'],
    ['AAPL', 'SPY', 'TSLA', 'QQQ'],
  ];

  it.each(PERMUTATIONS)('is identical when phase 1 completes %s-first', async (...completion) => {
    const plan = makePlan('SPY', 'QQQ', 'AAPL', 'TSLA');
    const heads = deferredHeads(plan.instruments.map((i) => i.asset));
    const { steps, tailOrder } = bookSteps(heads);

    const pending = runTickPlan(plan, new SequentialTickRunner(steps), CLOCK, {
      ...loopConfig(),
      max_concurrent_instruments: 4,
    });
    await settle();

    for (const asset of completion) {
      heads.release(asset);
      await settle();
    }

    const outcomes = await pending;

    expect(tailOrder).toEqual(['SPY', 'QQQ', 'AAPL', 'TSLA']);
    expect(outcomes.map((o) => o.final_stage)).toEqual(['execution', 'risk', 'risk', 'risk']);
  });

  it('degrades to today’s serial pass at width 1', async () => {
    const plan = makePlan('SPY', 'QQQ', 'AAPL');
    const heads = deferredHeads([]);
    const { steps, tailOrder, book } = bookSteps(heads);

    const outcomes = await runTickPlan(plan, new SequentialTickRunner(steps), CLOCK, {
      ...loopConfig(),
      max_concurrent_instruments: 1,
    });

    expect(tailOrder).toEqual(['SPY', 'QQQ', 'AAPL']);
    expect(outcomes.map((o) => o.final_stage)).toEqual(['execution', 'risk', 'risk']);
    expect(book.gross).toBe(NOTIONAL);
  });

  it('does not strand the queue when a head throws', async () => {
    const heads = deferredHeads([]);
    const { steps, tailOrder } = bookSteps(heads);
    const failing: TickSteps = {
      ...steps,
      analysts: async (input) => {
        if (input.signal.asset === 'SPY') throw new Error('analysts exploded');
        return steps.analysts(input);
      },
    };

    const outcomes = await runTickPlan(
      makePlan('SPY', 'QQQ'),
      new SequentialTickRunner(failing),
      CLOCK,
      {
        ...loopConfig(),
        max_concurrent_instruments: 2,
      },
    );

    expect(outcomes[0]?.error).toContain('analysts exploded');
    expect(tailOrder).toEqual(['QQQ']);
    expect(outcomes[1]).toMatchObject({ final_stage: 'execution' });
  });
});

describe('phase split — the turnstile is idempotent before the grant (#1040)', () => {
  it('hands a repeated pre-grant request the SAME promise, so neither await is orphaned', async () => {
    let releaseHead!: () => void;
    const headParked = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let bothResolved = false;

    const runner: TickRunner = {
      async runInstrument(_signal, ctx): Promise<TickOutcome> {
        if (ctx.trace_id.endsWith('-0')) {
          await headParked;
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        }
        const first = ctx.beginPortfolioTail?.();
        const second = ctx.beginPortfolioTail?.();
        await Promise.all([first, second]);
        bothResolved = true;
        return { trace_id: ctx.trace_id, final_stage: 'execution' };
      },
    };

    let n = 0;
    const pending = runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
      ...loopConfig(),
      max_concurrent_instruments: 2,
      newTraceId: () => `trace-${n++}`,
    });

    await settle();
    expect(bothResolved).toBe(false);

    releaseHead();
    await pending;

    expect(bothResolved).toBe(true);
  });

  it('resolves a repeated request from the index that already HOLDS the turn', async () => {
    let calls = 0;

    const runner: TickRunner = {
      async runInstrument(_signal, ctx): Promise<TickOutcome> {
        await ctx.beginPortfolioTail?.();
        calls++;
        await ctx.beginPortfolioTail?.();
        calls++;
        return { trace_id: ctx.trace_id, final_stage: 'execution' };
      },
    };

    const outcomes = await runTickPlan(makePlan('SPY'), runner, CLOCK, {
      ...loopConfig(),
      max_concurrent_instruments: 1,
    });

    expect(calls).toBe(2);
    expect(outcomes[0]).toMatchObject({ final_stage: 'execution' });
  });
});

describe('phase split — the #669 claim is held through the tail (#1040)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not free an instrument when its head finishes, only when its pass does', async () => {
    let releaseTail!: () => void;
    const tailParked = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let headsDone = 0;

    const runner: TickRunner = {
      async runInstrument(_signal, ctx): Promise<TickOutcome> {
        headsDone++;
        await ctx.beginPortfolioTail?.();
        await tailParked;
        return { trace_id: ctx.trace_id, final_stage: 'execution' };
      },
    };
    const plan = makePlan('SPY');
    const scheduler: Scheduler = { nextTick: () => plan };
    const logger = { log: vi.fn() };

    const loop = startTickLoop({
      scheduler,
      runner,
      clock: new SimulatedClock(NOW),
      logger,
      persistence: {
        auditLog: { record: vi.fn() },
        currentTickStore: { upsert: vi.fn(), delete: vi.fn(), get: vi.fn() },
      } as never,
      decisionGate: new DebateBarDecisionGate(),
      tickIntervalMs: 1_000,
      maxConcurrentInstruments: 6,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(headsDone).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(headsDone).toBe(1);
    expect(
      logger.log.mock.calls.some(([entry]) =>
        String(entry.message).includes('still running from a previous pass'),
      ),
    ).toBe(true);

    releaseTail();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(headsDone).toBe(2);

    releaseTail();
    await loop.stop();
  });
});
