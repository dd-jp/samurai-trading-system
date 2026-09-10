import { PIPELINE_STAGES } from '../../../contracts/index.js';
import type { Signal } from '../../pipeline/analysts/index.js';
import { LlmProviderError, LlmRefusalError } from '../../pipeline/debate-engine/index.js';
import type { Clock, OrderIntent } from '../../shared/index.js';
import { openSharedStore } from '../../shared/store/index.js';
import { DebateBarDecisionGate, type DecisionGate } from './decision-bar-gate.js';
import { paperStartingProfile } from './paper-profile.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import { runTickPlan } from './tick-loop.js';
import { SequentialTickRunner } from './tick-runner.js';
import type {
  AuditLog,
  CurrentTickStore,
  Logger,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
  TickSteps,
  UniverseInstrument,
} from './types.js';

const NOW = new Date('2026-07-15T14:00:00Z');
const CLOCK: Clock = { now: () => NOW };
const LOGGER: Logger = { log: vi.fn() };
const makeAuditLog = (): AuditLog => new SqliteAuditLog(openSharedStore(':memory:'));
const makeCurrentTickStore = (): CurrentTickStore =>
  new SqliteCurrentTickStore(openSharedStore(':memory:'));

function makePlan(...assets: string[]): TickPlan {
  const instruments: UniverseInstrument[] = assets.map((asset) => ({
    asset,
    asset_class: asset.endsWith('-USD') ? 'crypto' : 'stocks',
  }));
  return { instruments, tick_time: NOW };
}

/** Sequential trace IDs — replay needs a deterministic sequence, not UUIDs. */
function countingTraceIds(): () => string {
  let n = 0;
  return () => `trace-${++n}`;
}

/**
 * A runner whose passes block until released, so in-flight instruments can be
 * counted at a known point rather than raced against.
 */
function gatedRunner(): {
  runner: TickRunner;
  releaseAll: () => void;
  peakInFlight: () => number;
  started: () => string[];
} {
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  const started: string[] = [];

  const runner: TickRunner = {
    async runInstrument(signal: Signal, ctx: TickContext): Promise<TickOutcome> {
      started.push(signal.asset);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
      return { trace_id: ctx.trace_id, final_stage: 'analysts' };
    },
  };

  return {
    runner,
    releaseAll: () => {
      for (const release of gates.splice(0)) release();
    },
    peakInFlight: () => peak,
    started: () => started,
  };
}

/** Yields long enough for every pending microtask to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runTickPlan', () => {
  it('bounds simultaneous instrument passes to the cap', async () => {
    const { runner, releaseAll, peakInFlight, started } = gatedRunner();
    const plan = makePlan('SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD');

    const pending = runTickPlan(plan, runner, CLOCK, {
      max_concurrent_instruments: 2,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });
    await settle();

    // Only the cap has started; the rest are still queued behind them.
    expect(started()).toEqual(['SPY', 'QQQ']);
    expect(peakInFlight()).toBe(2);

    releaseAll();
    await settle();
    releaseAll();
    await settle();
    releaseAll();
    await pending;

    expect(peakInFlight()).toBe(2);
  });

  /**
   * #1013: the pool mechanism above (`max_concurrent_instruments` bounding
   * simultaneous passes) was never the gap — `buildProductionOrchestrator`
   * feeding it a config-derived `?? 1` was. This pins the wiring at the level
   * that regresses silently: if the paper profile's explicit width is ever
   * dropped back to the implicit default, this fails with `peakInFlight() ===
   * 1` and `started()` showing one instrument at a time, exactly the
   * behaviour #1013 measured (SPY at 19:56:42, QQQ at 19:57:07, TSLA at
   * 19:58:02 — the issue's own timestamps, ~25-55s apart; it did not report
   * AAPL's) against a running orchestrator.
   *
   * Uses the REAL configured universe and width, not stand-ins, so a change
   * to either value is exercised here rather than assumed.
   */
  it("runs the paper profile's universe concurrently, up to its configured width, not one instrument at a time", async () => {
    // Width is now BELOW the universe size (20 names, width 6), so the pass
    // walks in `ceil(20 / 6)` groups rather than starting every instrument in
    // one instant. The property under test is unchanged and is the one that
    // matters: concurrency is the configured width, not 1.
    const profile = paperStartingProfile('paper');
    const universe = profile.universe;
    if (universe === undefined) {
      throw new Error("paperStartingProfile('paper') always carries a universe");
    }
    const { runner, releaseAll, peakInFlight, started } = gatedRunner();
    const plan = makePlan(...universe.map((instrument) => instrument.asset));

    const pending = runTickPlan(plan, runner, CLOCK, {
      max_concurrent_instruments: profile.maxConcurrentInstruments,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });
    await settle();

    // The first group started together, in plan order, and saturated the
    // configured width — not one instrument at a time.
    const width = profile.maxConcurrentInstruments ?? plan.instruments.length;
    const expectedFirstGroup = Math.min(width, plan.instruments.length);
    expect(started()).toEqual(
      plan.instruments.slice(0, expectedFirstGroup).map((instrument) => instrument.asset),
    );
    expect(peakInFlight()).toBe(expectedFirstGroup);

    // The universe no longer fits in one group, so `releaseAll` has to be
    // pumped: it splices the gates that exist NOW, and each released worker
    // lets the next instrument start and park on a gate that did not exist
    // when the splice ran. One call would release only the first group and
    // hang the rest.
    let drains = 0;
    let settled = false;
    // Both branches flip the flag. If only the fulfil branch did, a REJECTED
    // `pending` would spin the pump until the drain guard threw — masking the
    // real failure behind a bookkeeping error — and the detached promise would
    // reject unhandled on top of it. `await pending` below is what surfaces the
    // rejection, so this handler must not swallow it, only observe it.
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      releaseAll();
      await settle();
      if (++drains > plan.instruments.length) {
        throw new Error('runTickPlan did not settle after draining every instrument');
      }
    }
    await pending;
  });

  it('runs every instrument in the plan', async () => {
    const runner: TickRunner = {
      runInstrument: vi.fn(async (_signal, ctx) => ({
        trace_id: ctx.trace_id,
        final_stage: 'analysts' as const,
      })),
    };
    const plan = makePlan('SPY', 'QQQ', 'AAPL', 'TSLA', 'BTC-USD', 'ETH-USD');

    const outcomes = await runTickPlan(plan, runner, CLOCK, {
      max_concurrent_instruments: 3,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(runner.runInstrument).toHaveBeenCalledTimes(6);
    expect(outcomes).toHaveLength(6);
  });

  it('returns outcomes in plan order, not completion order', async () => {
    // First instrument finishes last: completion order is the reverse of the plan.
    const delays: Record<string, number> = { SPY: 20, QQQ: 10, AAPL: 0 };
    const runner: TickRunner = {
      async runInstrument(signal, ctx) {
        await new Promise((resolve) => setTimeout(resolve, delays[signal.asset]));
        return { trace_id: `${ctx.trace_id}:${signal.asset}`, final_stage: 'analysts' };
      },
    };

    const outcomes = await runTickPlan(makePlan('SPY', 'QQQ', 'AAPL'), runner, CLOCK, {
      max_concurrent_instruments: 3,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(outcomes.map((outcome) => outcome.trace_id)).toEqual([
      'trace-1:SPY',
      'trace-2:QQQ',
      'trace-3:AAPL',
    ]);
  });

  it('runs one instrument at a time at a cap of 1 (backtest determinism)', async () => {
    const { runner, releaseAll, peakInFlight, started } = gatedRunner();

    const pending = runTickPlan(makePlan('SPY', 'BTC-USD'), runner, CLOCK, {
      max_concurrent_instruments: 1,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });
    await settle();

    expect(started()).toEqual(['SPY']);

    releaseAll();
    await settle();
    releaseAll();
    await pending;

    expect(peakInFlight()).toBe(1);
    expect(started()).toEqual(['SPY', 'BTC-USD']);
  });

  it('emits one Signal per instrument, carrying its asset class', async () => {
    const signals: Signal[] = [];
    const runner: TickRunner = {
      async runInstrument(signal, ctx) {
        signals.push(signal);
        return { trace_id: ctx.trace_id, final_stage: 'analysts' };
      },
    };

    await runTickPlan(makePlan('SPY', 'BTC-USD'), runner, CLOCK, {
      max_concurrent_instruments: 2,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(signals).toEqual([
      { asset: 'SPY', asset_class: 'stocks' },
      { asset: 'BTC-USD', asset_class: 'crypto' },
    ]);
  });

  it('generates a distinct trace_id per instrument and injects the clock', async () => {
    const contexts: TickContext[] = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        contexts.push(ctx);
        return { trace_id: ctx.trace_id, final_stage: 'analysts' };
      },
    };

    await runTickPlan(makePlan('SPY', 'QQQ', 'AAPL'), runner, CLOCK, {
      max_concurrent_instruments: 2,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(contexts.map((ctx) => ctx.trace_id)).toEqual(['trace-1', 'trace-2', 'trace-3']);
    expect(contexts.every((ctx) => ctx.clock === CLOCK)).toBe(true);
  });

  it('forwards the currentTickStore into every instrument TickContext', async () => {
    const contexts: TickContext[] = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        contexts.push(ctx);
        return { trace_id: ctx.trace_id, final_stage: 'analysts' };
      },
    };
    const currentTickStore = makeCurrentTickStore();

    await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
      max_concurrent_instruments: 2,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore,
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(contexts.every((ctx) => ctx.currentTickStore === currentTickStore)).toBe(true);
  });

  it('defaults to a unique trace_id per instrument when none is injected', async () => {
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        return { trace_id: ctx.trace_id, final_stage: 'analysts' };
      },
    };

    const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
      max_concurrent_instruments: 2,
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    const traceIds = outcomes.map((outcome) => outcome.trace_id);
    expect(new Set(traceIds).size).toBe(2);
    expect(traceIds.every((id) => id.length > 0)).toBe(true);
  });

  it('clamps a cap below 1 rather than stalling the tick', async () => {
    const runner: TickRunner = {
      runInstrument: vi.fn(async (_signal, ctx) => ({
        trace_id: ctx.trace_id,
        final_stage: 'analysts' as const,
      })),
    };

    const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
      max_concurrent_instruments: 0,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    // A literal 0-worker pool would run nothing and resolve empty.
    expect(outcomes).toHaveLength(2);
  });

  it('does not stall a fast instrument behind a slow one', async () => {
    // Cap 1 would serialize these; cap 2 lets AAPL finish while SPY blocks.
    //
    // Gated rather than timed (#528, see docs/coding-standards.md "Async
    // test assertions"): SPY does not resume until AFTER AAPL has pushed to
    // `finished`, so the assertion is a happens-before relationship with no
    // wall-clock dependence.
    //
    // Deliberate deadlock at a cap of 1: with one worker, SPY runs first and
    // never yields its slot, so AAPL never starts, `aaplRan` never resolves,
    // and the test times out instead of passing by accident. Do not "fix"
    // this back to a sleep.
    //
    // That deadlock assumes SPY is dispatched FIRST, which it is only because
    // `makePlan` below lists it first and the pool dispatches in plan order.
    // Reorder the plan so AAPL leads and a cap of 1 would still pass — AAPL
    // would push, release, and SPY would resume on an already-resolved
    // promise. The ordering is load-bearing, not cosmetic.
    const finished: string[] = [];
    let releaseSpy!: () => void;
    const aaplRan = new Promise<void>((resolve) => {
      releaseSpy = resolve;
    });
    const runner: TickRunner = {
      async runInstrument(signal, ctx) {
        if (signal.asset === 'SPY') {
          await aaplRan;
        }
        finished.push(signal.asset);
        // Release AFTER pushing, never before: SPY's resume is only a
        // microtask away, so this ordering is what makes "AAPL pushed before
        // SPY resumed" true rather than merely likely. Do not hoist.
        if (signal.asset === 'AAPL') {
          releaseSpy();
        }
        return { trace_id: ctx.trace_id, final_stage: 'analysts' };
      },
    };

    await runTickPlan(makePlan('SPY', 'QQQ', 'AAPL'), runner, CLOCK, {
      max_concurrent_instruments: 2,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    // QQQ and AAPL both complete before the slow SPY pass.
    expect(finished).toEqual(['QQQ', 'AAPL', 'SPY']);
  });

  it.each([
    1, 6,
  ])('supplies the portfolio-tail turnstile to every instrument at width %i (#1040)', async (width) => {
    // This repo's dominant defect is a mechanism nothing calls. The runner's
    // `await ctx.beginPortfolioTail?.()` is optional-chained, so a loop that
    // stopped supplying it would go silently back to a concurrent tail — and
    // every existing test in this file would still pass. Asserted at BOTH
    // widths because the narrow one is the replay path: it must take the
    // same route through the runner, not a second untested one.
    const seen: Array<TickContext['beginPortfolioTail']> = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        seen.push(ctx.beginPortfolioTail);
        await ctx.beginPortfolioTail?.();
        return { trace_id: ctx.trace_id, final_stage: 'position_check' };
      },
    };

    await runTickPlan(makePlan('SPY', 'QQQ', 'AAPL'), runner, CLOCK, {
      max_concurrent_instruments: width,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(seen).toHaveLength(3);
    expect(seen.every((turnstile) => typeof turnstile === 'function')).toBe(true);
  });

  it('handles an empty plan (stocks closed, no crypto configured)', async () => {
    const runner: TickRunner = { runInstrument: vi.fn() };

    const outcomes = await runTickPlan({ instruments: [], tick_time: NOW }, runner, CLOCK, {
      max_concurrent_instruments: 4,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate: new DebateBarDecisionGate(),
    });

    expect(outcomes).toEqual([]);
    expect(runner.runInstrument).not.toHaveBeenCalled();
  });

  // #507: a failed tick used to declare itself finished (its rejected
  // `Promise.all` entry) while sibling workers were still mid-pipeline —
  // still billing LLM debates unattributed to any live tick. These pin the
  // fix: one instrument's throw becomes a failed `TickOutcome` for that
  // instrument alone, and `runTickPlan` never resolves early.
  describe('worker isolation (#507)', () => {
    it('does not abort other instruments when one throws', async () => {
      const runner: TickRunner = {
        async runInstrument(signal, ctx) {
          if (signal.asset === 'QQQ') throw new Error('debate exploded');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ', 'AAPL'), runner, CLOCK, {
        max_concurrent_instruments: 3,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      // The two healthy instruments ran to completion — the throw cost only
      // the instrument that threw.
      expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      expect(outcomes[2]).toEqual({ trace_id: 'trace-3', final_stage: 'execution' });
      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
    });

    it('resolves only after every worker has settled — a slow worker outlives a fast worker throwing', async () => {
      let releaseSlow!: () => void;
      const runner: TickRunner = {
        async runInstrument(signal, ctx) {
          if (signal.asset === 'FAST') throw new Error('fast worker exploded');
          // The slow worker blocks until explicitly released, so the test
          // can prove `runTickPlan` has NOT settled while it is still
          // in-flight — not just that it eventually returns.
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      let settled = false;
      const pending = runTickPlan(makePlan('FAST', 'SLOW'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });
      pending.then(() => {
        settled = true;
      });

      // The fast worker has already thrown and been caught; the slow worker
      // is still blocked on its gate. Before the old bug's fix, the throw
      // alone would have settled `Promise.all` here.
      await settle();
      expect(settled).toBe(false);

      releaseSlow();
      const outcomes = await pending;

      expect(settled).toBe(true);
      expect(outcomes).toEqual([
        { trace_id: 'trace-1', error: 'fast worker exploded' },
        { trace_id: 'trace-2', final_stage: 'execution' },
      ]);
    });

    it('logs the failure and records it on the outcome — no silent swallow', async () => {
      const logger: Logger & { entries: Parameters<Logger['log']>[0][] } = {
        entries: [],
        log(entry) {
          this.entries.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('debate exploded');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
      const failureEntry = logger.entries.find((entry) => entry.level === 'error');
      expect(failureEntry).toBeDefined();
      expect(failureEntry?.message).toBe('instrument failed: QQQ');
      expect(failureEntry?.payload).toEqual({
        instrument: 'QQQ',
        asset_class: 'stocks',
        error: 'debate exploded',
      });
    });

    it('wraps a thrown non-Error value into a string message', async () => {
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw 'a string rejection';
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'a string rejection' });
    });

    // Kimi review (#507 PR #515): a plain-object throw would otherwise
    // degrade through `String(error)` to the useless "[object Object]".
    it('preserves detail from a thrown plain object via JSON.stringify', async () => {
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw { code: 'RATE_LIMIT', retryAfterMs: 5000 };
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(outcomes[1]).toEqual({
        trace_id: 'trace-2',
        error: '{"code":"RATE_LIMIT","retryAfterMs":5000}',
      });
    });

    // A circular structure is exactly the shape most likely to reach the
    // JSON.stringify fallback (an object graph with a `cause`/`parent` back
    // reference), so it gets its own degrade-once-more path rather than
    // throwing out of error handling itself.
    it('falls back to String() when a thrown plain object is circular', async () => {
      const circular: Record<string, unknown> = { code: 'LOOP' };
      circular.self = circular;
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw circular;
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: '[object Object]' });
    });

    // Kimi review (#507 PR #515): `tick-runner.ts`'s own `record()` only
    // fires after a stage's step function RETURNS, so a crash mid-stage
    // leaves no `audit_log` row at all unless this layer writes one — the
    // logger line above is real-time visibility, not a durable, queryable
    // record an operator can find after the fact.
    it('writes a durable audit_log record for the crash, not just the log line', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('debate exploded');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(auditLog.records).toHaveLength(1);
      expect(auditLog.records[0]).toMatchObject({
        trace_id: 'trace-2',
        stage: 'tick-loop',
        decision: 'crashed',
        instrument: 'QQQ',
        asset_class: 'stocks',
        timestamp: NOW,
      });
      // Digested, not raw — same convention `tick-runner.ts`'s own `record()`
      // calls follow (`input_digest`/`output_digest`, never the payload
      // itself in the audit row).
      expect(typeof auditLog.records[0]?.input_digest).toBe('string');
      expect(auditLog.records[0]?.input_digest.length).toBeGreaterThan(0);
      expect(typeof auditLog.records[0]?.output_digest).toBe('string');
      expect(auditLog.records[0]?.output_digest.length).toBeGreaterThan(0);
    });

    // #1380: `tick-runner.ts`'s `markStage` upserts `current_tick` BEFORE each
    // stage's step function runs, and a crash mid-stage never reaches the
    // matching `delete` — so the row left behind names exactly the stage the
    // pass was in when it threw. Before this, the crash record always read
    // `stage: 'tick-loop'` regardless of where the throw happened.
    it('names the pipeline stage the crashed pass was in, read off current_tick', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const currentTickStore = makeCurrentTickStore();
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') {
            ctx.currentTickStore.upsert({
              instrument: signal.asset,
              asset_class: signal.asset_class,
              stage: 'debate',
              trace_id: ctx.trace_id,
              updated_at: ctx.clock.now(),
            });
            throw new Error('debate exploded');
          }
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore,
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(auditLog.records).toHaveLength(1);
      // Prefixed rather than bare `'debate'`: the dashboard's live-lane query
      // (`sqlite-query-store.ts`) filters `stage IN (…PIPELINE_STAGES)`, and a
      // crash row is not a completed stage — folding it into that six-stage
      // set is a rendering change this ticket does not make. Prefixing with
      // the pre-existing `tick-loop` sentinel keeps this row provably outside
      // that filter's match set while still naming the real `TickStage`.
      expect(auditLog.records[0]?.stage).toBe('tick-loop:debate');
      expect(auditLog.records[0]?.decision).toBe('crashed');
    });

    it('ignores a stale current_tick row left by a different trace_id', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const currentTickStore = makeCurrentTickStore();
      // A row a PRIOR crashed pass on the same instrument left behind —
      // never cleared, since current_tick is deleted only on success. This
      // pass gets a fresh trace_id and crashes before writing its own row,
      // so the only row present at read time belongs to someone else's pass.
      currentTickStore.upsert({
        instrument: 'QQQ',
        asset_class: 'stocks',
        stage: 'debate',
        trace_id: 'stale-trace-from-earlier-crash',
        updated_at: NOW,
      });
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('exploded before this pass marked a stage');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore,
        decisionGate: new DebateBarDecisionGate(),
      });

      // Must fall back to the bare pre-#1380 stage, not the stale row's
      // `'debate'` — a mismatched trace_id means the row cannot be trusted
      // as this pass's own attribution.
      expect(auditLog.records[0]?.stage).toBe('tick-loop');
    });

    it('never writes a bare PIPELINE_STAGES value as the crash stage', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') {
            ctx.currentTickStore.upsert({
              instrument: signal.asset,
              asset_class: signal.asset_class,
              stage: 'trader',
              trace_id: ctx.trace_id,
              updated_at: ctx.clock.now(),
            });
            throw new Error('trader exploded');
          }
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      // Named to the exact prefixed value, not just "absent from
      // PIPELINE_STAGES" — the bare pre-#1380 sentinel `'tick-loop'` also
      // satisfies that weaker check, so it alone cannot tell this fix apart
      // from its absence.
      expect(auditLog.records[0]?.stage).toBe('tick-loop:trader');
      expect(PIPELINE_STAGES).not.toContain(auditLog.records[0]?.stage);
    });

    it('includes the crashed stage on the structured log line, not only the audit row', async () => {
      const logger: Logger & { entries: Parameters<Logger['log']>[0][] } = {
        entries: [],
        log(entry) {
          this.entries.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') {
            ctx.currentTickStore.upsert({
              instrument: signal.asset,
              asset_class: signal.asset_class,
              stage: 'debate',
              trace_id: ctx.trace_id,
              updated_at: ctx.clock.now(),
            });
            throw new Error('debate exploded');
          }
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger,
        auditLog: makeAuditLog(),
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      const failureEntry = logger.entries.find((entry) => entry.event === 'instrument_pass_failed');
      expect(failureEntry?.payload).toMatchObject({ stage: 'debate' });
    });

    it('falls back to the pre-#1380 bare stage when current_tick has no row for the instrument', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('exploded before any markStage');
          return { trace_id: 'trace-1', final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(auditLog.records[0]?.stage).toBe('tick-loop');
    });

    it('does not let a current_tick read failure crash the worker — falls back to the bare stage', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const throwingStore: CurrentTickStore = {
        upsert: () => {},
        delete: () => {},
        get: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('debate exploded');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore: throwingStore,
        decisionGate: new DebateBarDecisionGate(),
      });

      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
      expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      expect(auditLog.records[0]?.stage).toBe('tick-loop');
    });

    it('does not write an audit_log record for an instrument that succeeds', async () => {
      const auditLog: AuditLog & { records: Parameters<AuditLog['record']>[0][] } = {
        records: [],
        record(entry) {
          this.records.push(entry);
        },
      };
      const runner: TickRunner = {
        async runInstrument(signal, ctx): Promise<TickOutcome> {
          if (signal.asset === 'QQQ') throw new Error('debate exploded');
          return { trace_id: ctx.trace_id, final_stage: 'execution' };
        },
      };

      await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
        max_concurrent_instruments: 2,
        newTraceId: countingTraceIds(),
        logger: LOGGER,
        auditLog,
        currentTickStore: makeCurrentTickStore(),
        decisionGate: new DebateBarDecisionGate(),
      });

      // Only QQQ (the throw) gets an audit row from THIS layer — SPY's
      // successful pass writes its own audit trail from inside
      // `SequentialTickRunner`, not duplicated here.
      expect(auditLog.records.map((record) => record.instrument)).toEqual(['QQQ']);
    });

    // Kimi review (#507 PR #515, cycle 2): the audit write added above is a
    // database call sitting inside the very catch block whose job is to
    // guarantee a worker cannot reject. An unguarded SQLite failure there
    // would reopen the orphaned-worker leak this whole issue exists to close.
    describe('the failure handler cannot itself reject the worker', () => {
      it('survives auditLog.record throwing — worker still returns a failed outcome, siblings still run', async () => {
        const auditLog: AuditLog = {
          record: vi.fn(() => {
            throw new Error('SQLITE_BUSY: database is locked');
          }),
        };
        const runner: TickRunner = {
          async runInstrument(signal, ctx): Promise<TickOutcome> {
            if (signal.asset === 'QQQ') throw new Error('debate exploded');
            return { trace_id: ctx.trace_id, final_stage: 'execution' };
          },
        };

        // If the audit-write throw escaped the catch, this whole call would
        // reject (or — post-fix — the sibling SPY worker would still be
        // resolved by `Promise.all`'s rejection semantics, but `outcomes`
        // would never be returned to assert against). Asserting the promise
        // RESOLVES is itself part of the proof.
        const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
          max_concurrent_instruments: 2,
          newTraceId: countingTraceIds(),
          logger: LOGGER,
          auditLog,
          currentTickStore: makeCurrentTickStore(),
          decisionGate: new DebateBarDecisionGate(),
        });

        expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
        // SPY — the sibling sharing the same tick — still ran to completion.
        expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      });

      it('logs the audit-write failure at error level rather than swallowing it', async () => {
        const logger: Logger & { entries: Parameters<Logger['log']>[0][] } = {
          entries: [],
          log(entry) {
            this.entries.push(entry);
          },
        };
        const auditLog: AuditLog = {
          record: vi.fn(() => {
            throw new Error('SQLITE_BUSY: database is locked');
          }),
        };
        const runner: TickRunner = {
          async runInstrument(signal, ctx): Promise<TickOutcome> {
            if (signal.asset === 'QQQ') throw new Error('debate exploded');
            return { trace_id: ctx.trace_id, final_stage: 'execution' };
          },
        };

        await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
          max_concurrent_instruments: 2,
          newTraceId: countingTraceIds(),
          logger,
          auditLog,
          currentTickStore: makeCurrentTickStore(),
          decisionGate: new DebateBarDecisionGate(),
        });

        const auditFailureEntry = logger.entries.find((entry) =>
          entry.message.startsWith('audit_log record failed'),
        );
        expect(auditFailureEntry).toBeDefined();
        expect(auditFailureEntry?.level).toBe('error');
        expect(auditFailureEntry?.payload).toEqual({
          instrument: 'QQQ',
          asset_class: 'stocks',
          original_error: 'debate exploded',
          audit_error: 'SQLITE_BUSY: database is locked',
        });
        // The original instrument-crash line is unaffected — both are
        // reported, neither replaces the other.
        expect(logger.entries.some((entry) => entry.message === 'instrument failed: QQQ')).toBe(
          true,
        );
      });

      it('survives logger.log throwing on the same path — worker still returns a failed outcome, siblings still run', async () => {
        // A real `Logger` can throw: `JsonLogger` degrades a failing sink but
        // throws once NO sink is left to record the failure on (#714), and an
        // injected one can throw for any reason at all. Every `logger.log` call on this path must
        // be safe against that, not just the audit write.
        const logger: Logger = {
          log: vi.fn(() => {
            throw new Error('EPIPE');
          }),
        };
        const runner: TickRunner = {
          async runInstrument(signal, ctx): Promise<TickOutcome> {
            if (signal.asset === 'QQQ') throw new Error('debate exploded');
            return { trace_id: ctx.trace_id, final_stage: 'execution' };
          },
        };

        const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
          max_concurrent_instruments: 2,
          newTraceId: countingTraceIds(),
          logger,
          auditLog: makeAuditLog(),
          currentTickStore: makeCurrentTickStore(),
          decisionGate: new DebateBarDecisionGate(),
        });

        expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
        expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      });

      it('survives both logger.log and auditLog.record throwing on the same instrument', async () => {
        const logger: Logger = {
          log: vi.fn(() => {
            throw new Error('EPIPE');
          }),
        };
        const auditLog: AuditLog = {
          record: vi.fn(() => {
            throw new Error('SQLITE_BUSY: database is locked');
          }),
        };
        const runner: TickRunner = {
          async runInstrument(signal, ctx): Promise<TickOutcome> {
            if (signal.asset === 'QQQ') throw new Error('debate exploded');
            return { trace_id: ctx.trace_id, final_stage: 'execution' };
          },
        };

        const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
          max_concurrent_instruments: 2,
          newTraceId: countingTraceIds(),
          logger,
          auditLog,
          currentTickStore: makeCurrentTickStore(),
          decisionGate: new DebateBarDecisionGate(),
        });

        expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
        expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      });
    });
  });
});

/**
 * The tick/decision split, at the loop seam (#743): the gate is consulted per
 * instrument on the PLAN's tick time, a granted claim rides into
 * `TickContext.decision_bar`, and a claimed pass that THROWS hands the claim
 * back so the bar is retried rather than forfeited.
 */
describe('runTickPlan decision gate (#743)', () => {
  const TICK_INTERVAL_MS = paperStartingProfile('paper').tickIntervalMs;

  function planAt(tickTime: Date, ...assets: string[]): TickPlan {
    return { ...makePlan(...assets), tick_time: tickTime };
  }

  function loopConfig(decisionGate: DecisionGate) {
    return {
      max_concurrent_instruments: 1,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
      decisionGate,
    };
  }

  it('runs the analysts ONCE over a full debate bar of production-interval ticks', async () => {
    // The acceptance criterion of the split, stated as a count: a full 1h bar
    // of ticks at the production cadence (2 minutes — read off the paper
    // profile so a retune keeps this test honest) runs the analysts exactly
    // once. Every tick still runs the exit check exactly once (#785): the
    // bar's one decision pass quorum-skips and evaluates the flatten itself
    // (no Trader entry point of its own to carry it), and every other tick
    // takes the tick path, which always runs it.
    const steps: TickSteps = {
      exitCheck: vi.fn(async () => null),
      analysts: vi.fn(async () => []), // quorum skip — the chain ends here
      debate: vi.fn(async () => {
        throw new Error('unreachable: quorum-skipped');
      }),
      trader: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      risk: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      verdict: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      execution: vi.fn(async () => {
        throw new Error('unreachable');
      }),
    };
    const runner = new SequentialTickRunner(steps);
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);

    const barOpen = new Date('2026-07-15T14:00:00Z');
    const ticksPerBar = 3_600_000 / TICK_INTERVAL_MS;
    for (let i = 0; i < ticksPerBar; i++) {
      const at = new Date(barOpen.getTime() + i * TICK_INTERVAL_MS);
      await runTickPlan(planAt(at, 'BTC-USD'), runner, { now: () => at }, config);
    }

    expect(steps.analysts).toHaveBeenCalledTimes(1);
    expect(steps.exitCheck).toHaveBeenCalledTimes(ticksPerBar);

    // ...and the NEXT bar's first tick decides again.
    const nextBar = new Date(barOpen.getTime() + 3_600_000);
    await runTickPlan(planAt(nextBar, 'BTC-USD'), runner, { now: () => nextBar }, config);
    expect(steps.analysts).toHaveBeenCalledTimes(2);
  });

  it('a grace-only plan never claims a decision bar — the runner takes the tick path (#1499)', async () => {
    // The direct seam: the loop must not even ASK the gate to claim when the
    // plan was admitted only by the post-close grace, or a bar-aligned close
    // (the US 20:00Z case #1499 measured) claims a fresh decision bar exactly
    // like an ordinary window tick would.
    const seen: Array<TickContext['decision_bar']> = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        seen.push(ctx.decision_bar);
        return { trace_id: ctx.trace_id, final_stage: 'position_check' };
      },
    };
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);
    const usClose = new Date('2026-07-15T20:00:00Z'); // bar-aligned on the 1h grid

    await runTickPlan(
      { ...planAt(usClose, 'AAPL'), grace_only: true },
      runner,
      { now: () => usClose },
      config,
    );

    expect(seen[0]).toBeUndefined();
  });

  it('a grace tick runs no analyst or debate step and still reaches exitCheck (#1499)', async () => {
    const steps: TickSteps = {
      exitCheck: vi.fn(async () => null),
      analysts: vi.fn(async () => {
        throw new Error('unreachable: a grace tick must not run analysts');
      }),
      debate: vi.fn(async () => {
        throw new Error('unreachable: a grace tick must not run debate');
      }),
      trader: vi.fn(async () => {
        throw new Error('unreachable: a grace tick has no Trader entry point of its own');
      }),
      risk: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      verdict: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      execution: vi.fn(async () => {
        throw new Error('unreachable');
      }),
    };
    const runner = new SequentialTickRunner(steps);
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);
    const usClose = new Date('2026-07-15T20:00:00Z');

    const outcomes = await runTickPlan(
      { ...planAt(usClose, 'AAPL'), grace_only: true },
      runner,
      { now: () => usClose },
      config,
    );

    expect(steps.exitCheck).toHaveBeenCalledTimes(1);
    expect(steps.analysts).not.toHaveBeenCalled();
    expect(steps.debate).not.toHaveBeenCalled();
    expect(outcomes[0]?.final_stage).toBe('position_check');
  });

  it('a window tick (isOpen, not grace-admitted) still runs analysts and debate on a fresh bar (#1499)', async () => {
    const intent: OrderIntent = {
      idempotency_key: 'key-aapl-1400',
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
        cosine_precedent: { neighbor_count: 0, weighted_mean_r: null, no_precedent: true },
      },
    };
    const barOpen = new Date('2026-07-15T14:00:00Z');
    const steps: TickSteps = {
      exitCheck: vi.fn(async () => {
        throw new Error('unreachable: a fresh-bar window tick takes the decision path');
      }),
      analysts: vi.fn(async () => [
        {
          trace_id: 'trace-1',
          analyst_id: 'technical-1',
          analyst_type: 'technical' as const,
          direction: 'bullish' as const,
          confidence: 0.8,
          key_points: ['price above the 50d'],
          timestamp: barOpen,
        },
      ]),
      debate: vi.fn(async () => ({
        synthesis: 'bullish continuation',
        position: 'enter long',
        confidence: 0.7,
        contributions: [],
        disagreement_summary: '',
        open_items: [],
        converged: true,
        rounds_completed: 2,
        latency_ms: 1200,
        direction: 'bullish' as const,
        debate_id: 'debate-1',
        bar_timestamp: barOpen,
        read: true,
      })),
      trader: vi.fn(async () => intent),
      risk: vi.fn(async () => ({
        status: 'approved' as const,
        order_intent: intent,
        modifications: {
          original_size: intent.size,
          final_size: intent.size,
          stop_tightened: false,
        },
        binding_constraint: null,
        reasons: [],
        warnings: [],
        risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
        next_breaker_state: [],
      })),
      verdict: vi.fn(async () => ({
        status: 'go' as const,
        order: intent,
        no_go_reason: null,
        no_go_detail: null,
        approval_path: 'automated' as const,
        would_require_approval: false,
        idempotency_key: intent.idempotency_key,
        timestamp: barOpen,
      })),
      execution: vi.fn(async () => ({
        status: 'submitted' as const,
        idempotency_key: intent.idempotency_key,
        broker_order_ids: ['broker-1'],
        order_state: 'submitted' as const,
        reason: null,
        timestamp: barOpen,
      })),
    };
    const runner = new SequentialTickRunner(steps);
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);

    // `grace_only` absent — the property `makePlan`/`planAt` already produce.
    const outcomes = await runTickPlan(
      planAt(barOpen, 'AAPL'),
      runner,
      { now: () => barOpen },
      config,
    );

    expect(steps.analysts).toHaveBeenCalledTimes(1);
    expect(steps.debate).toHaveBeenCalledTimes(1);
    expect(outcomes[0]?.final_stage).toBe('execution');
  });

  it('still fires the flatten on every tick when the gate NEVER opens', async () => {
    // Mutation discriminator, hazard 1: force the gate permanently closed —
    // the decision chain is dead, and the flatten must still reach Execution
    // from the cheap path. This is the 2f22033 defect shape: an exit path
    // accidentally coupled to the decision path strands a live position.
    const closedGate: DecisionGate = { claim: () => undefined, rescind: () => 'stale' };
    const exit: OrderIntent = {
      idempotency_key: 'key-btc-flatten',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      side: 'sell',
      intent_type: 'exit',
      size: 1,
      entry: 100,
      stop: 95,
      target: 110,
      time_in_force: 'gtc',
      decision_timestamp: NOW,
      decided_at: NOW,
      metadata: {
        debate_id: 'debate-prior-bar',
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
    const steps: TickSteps = {
      exitCheck: vi.fn(async () => exit),
      analysts: vi.fn(async () => {
        throw new Error('unreachable: the gate never opens');
      }),
      debate: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      trader: vi.fn(async () => {
        throw new Error('unreachable');
      }),
      risk: vi.fn(async () => ({
        status: 'approved' as const,
        order_intent: exit,
        modifications: { original_size: 1, final_size: 1, stop_tightened: false },
        binding_constraint: null,
        reasons: [],
        warnings: [],
        risk_snapshot: { exposure: {}, drawdown_pct: 0, armed_breakers: [] },
        next_breaker_state: [],
      })),
      verdict: vi.fn(async () => ({
        status: 'go' as const,
        order: exit,
        no_go_reason: null,
        no_go_detail: null,
        approval_path: 'automated' as const,
        would_require_approval: false,
        idempotency_key: exit.idempotency_key,
        timestamp: NOW,
      })),
      execution: vi.fn(async () => ({
        status: 'submitted' as const,
        idempotency_key: exit.idempotency_key,
        broker_order_ids: ['broker-1'],
        order_state: 'submitted' as const,
        reason: null,
        timestamp: NOW,
      })),
    };
    const runner = new SequentialTickRunner(steps);
    const config = loopConfig(closedGate);

    for (let i = 0; i < 3; i++) {
      const at = new Date(NOW.getTime() + i * TICK_INTERVAL_MS);
      const outcomes = await runTickPlan(planAt(at, 'BTC-USD'), runner, { now: () => at }, config);
      expect(outcomes[0]?.final_stage).toBe('execution');
      expect(outcomes[0]?.flatten_fired).toBe(true);
    }

    expect(steps.execution).toHaveBeenCalledTimes(3);
    expect(steps.analysts).not.toHaveBeenCalled();
  });

  it('consults the gate on the PLAN tick time and passes the claim into ctx', async () => {
    const seen: Array<TickContext['decision_bar']> = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        seen.push(ctx.decision_bar);
        return { trace_id: ctx.trace_id, final_stage: 'position_check' };
      },
    };
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);
    const midBar = new Date('2026-07-15T14:32:00Z');

    // A clock deliberately in a DIFFERENT bar than the plan: the gate must key
    // off `plan.tick_time` — every instrument in one plan gated on the same
    // instant, and in replay the plan time is the deterministic coordinate.
    const laterClock: Clock = { now: () => new Date('2026-07-15T15:10:00Z') };
    await runTickPlan(planAt(midBar, 'BTC-USD'), runner, laterClock, config);
    await runTickPlan(planAt(midBar, 'BTC-USD'), runner, laterClock, config);

    expect(seen[0]?.open_time).toEqual(new Date('2026-07-15T14:00:00Z'));
    expect(seen[0]?.timeframe_ms).toBe(3_600_000);
    // Second tick in the same bar: no claim, tick path only — the property
    // whose absence was #617 (every tick a decision).
    expect(seen[1]).toBeUndefined();
  });

  it('rescinds the claim when the claimed pass throws, so the next tick retries the bar', async () => {
    let call = 0;
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        call++;
        if (ctx.decision_bar !== undefined && call === 1) {
          throw new Error('transient LLM failure at bar open');
        }
        return {
          trace_id: ctx.trace_id,
          final_stage: ctx.decision_bar === undefined ? 'position_check' : 'trader',
        };
      },
    };
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);

    const first = await runTickPlan(
      planAt(new Date('2026-07-15T14:00:00Z'), 'BTC-USD'),
      runner,
      CLOCK,
      config,
    );
    expect(first[0]?.error).toContain('transient LLM failure');

    // Without the rescind this tick would be a tick pass and the bar's
    // decision would be silently forfeited — a quiet hour indistinguishable
    // from a quiet market (#625's signature).
    const second = await runTickPlan(
      planAt(new Date('2026-07-15T14:02:00Z'), 'BTC-USD'),
      runner,
      CLOCK,
      config,
    );
    expect(second[0]?.final_stage).toBe('trader');

    // And a SUCCESSFUL pass keeps its claim: the third tick is a tick pass.
    const third = await runTickPlan(
      planAt(new Date('2026-07-15T14:04:00Z'), 'BTC-USD'),
      runner,
      CLOCK,
      config,
    );
    expect(third[0]?.final_stage).toBe('position_check');
  });

  // ── The retry bound (#785): a PERSISTENTLY failing decision pass must not
  // rescind for the rest of the bar — up to ~30 analyst rebuilds at the
  // production cadence, exactly the churn #743 exists to remove. ───────────
  describe('bounded decision-pass retry (#785)', () => {
    it('stops retrying after the budget and reports the forfeit loudly, over a full bar of ticks', async () => {
      // Every decision pass throws — a PERSISTENT fault, not a transient one.
      const runner: TickRunner = {
        async runInstrument(_signal, ctx) {
          if (ctx.decision_bar !== undefined) {
            throw new Error('persistently broken decision pass');
          }
          return { trace_id: ctx.trace_id, final_stage: 'position_check' };
        },
      };
      const maxRetries = 3;
      const gate = new DebateBarDecisionGate(maxRetries);
      const logger: Logger & { entries: Parameters<Logger['log']>[0][] } = {
        entries: [],
        log(entry) {
          this.entries.push(entry);
        },
      };
      const config = { ...loopConfig(gate), logger };

      const barOpen = new Date('2026-07-15T14:00:00Z');
      const ticksPerBar = 3_600_000 / TICK_INTERVAL_MS;
      const outcomes = [];
      for (let i = 0; i < ticksPerBar; i++) {
        const at = new Date(barOpen.getTime() + i * TICK_INTERVAL_MS);
        outcomes.push(
          (await runTickPlan(planAt(at, 'BTC-USD'), runner, { now: () => at }, config))[0],
        );
      }

      // Every claimed decision pass throws until the budget is exhausted;
      // after that the gate refuses further claims for the rest of the bar,
      // so the runner never sees `decision_bar` again this bar and every
      // remaining tick is a cheap, SUCCEEDING tick pass — not a retry.
      const decisionAttempts = outcomes.filter((o) => o?.error !== undefined).length;
      expect(decisionAttempts).toBe(maxRetries);
      expect(outcomes.slice(maxRetries).every((o) => o?.final_stage === 'position_check')).toBe(
        true,
      );

      // NAMED, loud forfeit report — this is what #785's acceptance criterion
      // ("an explicit forfeit state that alerts") demands: distinguishable
      // from the ordinary per-attempt "instrument failed" line already
      // emitted by the catch block.
      const forfeitEntry = logger.entries.find((entry) =>
        entry.message.includes('retry budget exhausted'),
      );
      expect(forfeitEntry).toBeDefined();
      expect(forfeitEntry?.level).toBe('error');
      expect(forfeitEntry?.payload).toMatchObject({ instrument: 'BTC-USD' });

      // Bounded, not unbounded: `runInstrument` was claimed (and threw) only
      // `maxRetries` times over the WHOLE bar, not once per remaining tick
      // (which would be `ticksPerBar` at the production cadence).
      expect(decisionAttempts).toBeLessThan(ticksPerBar);
    });

    it('the next bar claims and retries fresh after the previous bar forfeited', async () => {
      let call = 0;
      const runner: TickRunner = {
        async runInstrument(_signal, ctx) {
          if (ctx.decision_bar !== undefined) {
            call++;
            throw new Error(`decision pass failure #${call}`);
          }
          return { trace_id: ctx.trace_id, final_stage: 'position_check' };
        },
      };
      const gate = new DebateBarDecisionGate(1); // forfeits on the FIRST failure
      const config = loopConfig(gate);

      const barOpen = new Date('2026-07-15T14:00:00Z');
      const first = await runTickPlan(planAt(barOpen, 'BTC-USD'), runner, CLOCK, config);
      expect(first[0]?.error).toContain('decision pass failure #1');

      // Same bar, later tick: forfeited — no more claims, no more throws.
      const midBar = new Date(barOpen.getTime() + TICK_INTERVAL_MS);
      const second = await runTickPlan(planAt(midBar, 'BTC-USD'), runner, CLOCK, config);
      expect(second[0]?.final_stage).toBe('position_check');
      expect(second[0]?.error).toBeUndefined();

      // The NEXT bar opens with a fresh claim and a fresh budget.
      const nextBar = new Date(barOpen.getTime() + 3_600_000);
      const third = await runTickPlan(planAt(nextBar, 'BTC-USD'), runner, CLOCK, config);
      expect(third[0]?.error).toContain('decision pass failure #2');
    });
  });

  describe('a refused decision pass does not consume the retry budget (#1391)', () => {
    /**
     * Two personas answer before the third refuses — the shape that decides
     * the cost. A retried pass re-bills the two that answered, because a pass
     * that threw never persisted the `debate_log` row the same-bar replay
     * short-circuits on.
     */
    function refusingRunner(billed: { calls: number }, makeError: () => Error): TickRunner {
      return {
        async runInstrument(_signal, ctx) {
          if (ctx.decision_bar === undefined) {
            return { trace_id: ctx.trace_id, final_stage: 'position_check' };
          }
          billed.calls += 2;
          throw makeError();
        },
      };
    }

    async function runOneBar(runner: TickRunner, config: ReturnType<typeof loopConfig>) {
      const barOpen = new Date('2026-07-15T14:00:00Z');
      const ticksPerBar = 3_600_000 / TICK_INTERVAL_MS;
      const outcomes = [];
      for (let i = 0; i < ticksPerBar; i++) {
        const at = new Date(barOpen.getTime() + i * TICK_INTERVAL_MS);
        outcomes.push(
          (await runTickPlan(planAt(at, 'BTC-USD'), runner, { now: () => at }, config))[0],
        );
      }
      return outcomes;
    }

    it('bills the provider once for the whole bar, and forfeits it loudly', async () => {
      const billed = { calls: 0 };
      const runner = refusingRunner(
        billed,
        () => new LlmRefusalError('LLM refused to answer', 'stop_reason="refusal"'),
      );
      const logger: Logger & { entries: Parameters<Logger['log']>[0][] } = {
        entries: [],
        log(entry) {
          this.entries.push(entry);
        },
      };
      const config = { ...loopConfig(new DebateBarDecisionGate(5)), logger };

      const outcomes = await runOneBar(runner, config);

      expect(outcomes.filter((o) => o?.error !== undefined)).toHaveLength(1);
      expect(billed.calls).toBe(2);

      const forfeit = logger.entries.find((entry) => entry.event === 'decision_pass_bar_forfeit');
      expect(forfeit?.level).toBe('error');
      expect(forfeit?.payload).toMatchObject({ instrument: 'BTC-USD', reason: 'refusal' });
    });

    it('leaves an ordinary provider failure retrying, so the carve-out stays narrow', async () => {
      // The mutation this pins: skipping the rescind for EVERY error would
      // disable #743's retry mechanism wholesale and still pass the test above.
      const billed = { calls: 0 };
      const maxRetries = 5;
      const runner = refusingRunner(billed, () => new LlmProviderError('nous responded 503'));
      const config = loopConfig(new DebateBarDecisionGate(maxRetries));

      const outcomes = await runOneBar(runner, config);

      expect(outcomes.filter((o) => o?.error !== undefined)).toHaveLength(maxRetries);
      expect(billed.calls).toBe(2 * maxRetries);
    });
  });
});
