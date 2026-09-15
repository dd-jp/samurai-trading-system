/**
 * The phase split, end to end (#1040) — Analysts + Debate fanned out across
 * instruments, the portfolio-mutating tail serial and in plan order.
 *
 * The two halves are tested apart elsewhere (`tick-runner.test.ts` owns where
 * the runner enters the turnstile; `tick-loop.test.ts` owns the pool). This
 * file asserts the property that only exists when they are wired together, and
 * that neither half can state alone:
 *
 * 1. **The exposure race is closed within a pass.** Two instruments whose
 *    combined notional exceeds the gross cap: the second is REJECTED, because
 *    Risk saw the first one's fill. The same steps run without the turnstile
 *    (the pre-#1040 shape, and today's paper/live behaviour at
 *    `maxConcurrentInstruments: 6`) approve both and breach the cap — that
 *    contrast is in the test, so the assertion cannot pass vacuously.
 * 2. **Tail order is plan order, whatever phase 1 does.** Head completion is
 *    permuted across runs; the tail sequence and the outcomes do not move.
 *    ADR-0003 §2's replay-from-log rests on this: if phase-1 completion order
 *    leaked into tail sequencing, cap allocation would vary run to run.
 * 3. **Width 1 is unchanged.** The turnstile is supplied at every width; at 1
 *    every turn is already free when it is asked for.
 * 4. **The #669 per-instrument claim is held through the TAIL**, not released
 *    when the head finishes.
 *
 * Out of scope, deliberately: #1019's submit-time reservation ledger. The
 * serial tail closes the SAME-TICK sibling race only. Two overlapping PASSES
 * (the interval is re-armed ahead of the pass, #669) each carry their own
 * sequencer over their own plan and do not order against each other.
 */
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

/** One share at 100, so a notional is trivially countable in the assertions */
const NOTIONAL = 100;
/** Room for one entry, not two — the point of the exposure test */
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

/** Head completion under the test's control, so phase-1 order can be permuted */
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

/**
 * A fake book with a gross-exposure cap, plus the `TickSteps` that read and
 * write it — the smallest thing that reproduces `RiskManager.evaluate()`'s
 * shape: Risk reads a PRE-TRADE snapshot, Execution is what moves it.
 *
 * Every deliberate simplification is in the direction that makes the race
 * EASIER to pass, not harder: the fill lands synchronously inside the
 * execution step, where the real system has to wait for a fill poll. If the
 * tail were concurrent, the real system would race even more widely than this.
 */
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
      // The pre-trade read. Yields first, so a concurrent sibling has every
      // chance to interleave here — the failure this test must be able to see
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

/** Yields long enough for every pending microtask to settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('phase split — the exposure race within one pass (#1040)', () => {
  it('rejects the second instrument, because Risk saw the first one fill', async () => {
    const heads = deferredHeads(['SPY', 'QQQ']);
    const { steps, book, tailOrder } = bookSteps(heads);

    const pending = runTickPlan(makePlan('SPY', 'QQQ'), new SequentialTickRunner(steps), CLOCK, {
      ...loopConfig(),
      // Width 2: both heads genuinely overlap, so the serialisation under test
      // is the turnstile's, not the pool's
      max_concurrent_instruments: 2,
    });

    await settle();
    // Neither tail has started: both passes are parked in their heads
    expect(tailOrder).toEqual([]);

    // Phase 1 finishes in REVERSE plan order — the case that must not matter
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
    // The contrast case, so the assertion above cannot pass vacuously. This is
    // the pre-#1040 shape AND today's paper/live behaviour: #1013 set
    // `maxConcurrentInstruments: 6`, so sibling instruments already reach Risk
    // against the same pre-trade snapshot (#1019)
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
      // Released one at a time with a real yield between, so the completion
      // order is genuinely observed by the loop rather than collapsed into one
      // microtask drain
      await settle();
    }

    const outcomes = await pending;

    expect(tailOrder).toEqual(['SPY', 'QQQ', 'AAPL', 'TSLA']);
    // And the OUTCOMES are the same too, not just the sequence: with a cap
    // that fits one entry, the same instrument wins every time
    expect(outcomes.map((o) => o.final_stage)).toEqual(['execution', 'risk', 'risk', 'risk']);
  });

  it('degrades to today’s serial pass at width 1', async () => {
    const plan = makePlan('SPY', 'QQQ', 'AAPL');
    const heads = deferredHeads([]); // every head resolves immediately
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
    // A head that throws never asks for a turn. If settlement were reported
    // only from the success path, every later instrument in the plan would
    // wait out the tick and the plan would never settle
    const heads = deferredHeads([]); // every head resolves immediately
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
    // QQQ still ran its whole tail, and against an untouched book
    expect(tailOrder).toEqual(['QQQ']);
    expect(outcomes[1]).toMatchObject({ final_stage: 'execution' });
  });
});

describe('phase split — the turnstile is idempotent before the grant (#1040)', () => {
  it('hands a repeated pre-grant request the SAME promise, so neither await is orphaned', async () => {
    // A `Map` keyed on index holds one waiter per index. Storing only the
    // resolver would let a second `begin` overwrite the first, leaving the
    // first caller's `await` pending forever — a pass hung for the life of the
    // process, on a code path (two portfolio reads in one pass) that a future
    // change could easily add. So the pending PROMISE is kept and handed back.
    let releaseHead!: () => void;
    const headParked = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let bothResolved = false;

    const runner: TickRunner = {
      async runInstrument(_signal, ctx): Promise<TickOutcome> {
        if (ctx.trace_id.endsWith('-0')) {
          // Index 0 holds the turn, so index 1's requests must both queue
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
    // The other branch of the same claim: once granted, a second `begin` must
    // return immediately rather than queue behind a `finish` that will never
    // come for an index already running. Untested, this is a self-deadlock
    // waiting for the second portfolio read someone adds later
    //
    // Honest limit: this asserts the OUTCOME (no self-deadlock), not the
    // `#granted` branch specifically. While a pass holds the turn its index
    // still equals `#turn`, so `#granted` and the turn check agree and either
    // alone would resolve this. `#granted` is what keeps them agreeing after
    // `finish` advances the cursor past the index — a state no pass can reach
    // for itself, since `finish` runs only once `runInstrument` has returned
    let calls = 0;

    const runner: TickRunner = {
      async runInstrument(_signal, ctx): Promise<TickOutcome> {
        await ctx.beginPortfolioTail?.();
        calls++;
        // No `finish` can have run for this index — the pass is still inside
        // its own tail — so this resolves only via the granted-set shortcut
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
    // The claim is released in `buildGuardedRunner`'s `finally`, which wraps
    // the WHOLE `runInstrument` call — head and tail. This asserts the timing
    // the phase split must not have loosened: a pass parked in its tail is
    // still "running", so the next tick skips it rather than starting a second
    // concurrent pass on the same instrument
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

    // Second tick, while the first pass sits in its tail: skipped as busy
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
