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

function countingTraceIds(): () => string {
  let n = 0;
  return () => `trace-${++n}`;
}

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

  it("runs the paper profile's universe concurrently, up to its configured width, not one instrument at a time", async () => {
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

    const width = profile.maxConcurrentInstruments ?? plan.instruments.length;
    const expectedFirstGroup = Math.min(width, plan.instruments.length);
    expect(started()).toEqual(
      plan.instruments.slice(0, expectedFirstGroup).map((instrument) => instrument.asset),
    );
    expect(peakInFlight()).toBe(expectedFirstGroup);

    let drains = 0;
    let settled = false;
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

    expect(outcomes).toHaveLength(2);
  });

  it('does not stall a fast instrument behind a slow one', async () => {
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

    expect(finished).toEqual(['QQQ', 'AAPL', 'SPY']);
  });

  it.each([1, 6])(
    'supplies the portfolio-tail turnstile to every instrument at width %i (#1040)',
    async (width) => {
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
    },
  );

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

      expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      expect(outcomes[2]).toEqual({ trace_id: 'trace-3', final_stage: 'execution' });
      expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
    });

    it('resolves only after every worker has settled — a slow worker outlives a fast worker throwing', async () => {
      let releaseSlow!: () => void;
      const runner: TickRunner = {
        async runInstrument(signal, ctx) {
          if (signal.asset === 'FAST') throw new Error('fast worker exploded');
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
      expect(typeof auditLog.records[0]?.input_digest).toBe('string');
      expect(auditLog.records[0]?.input_digest.length).toBeGreaterThan(0);
      expect(typeof auditLog.records[0]?.output_digest).toBe('string');
      expect(auditLog.records[0]?.output_digest.length).toBeGreaterThan(0);
    });

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

      expect(auditLog.records.map((record) => record.instrument)).toEqual(['QQQ']);
    });

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

        const outcomes = await runTickPlan(makePlan('SPY', 'QQQ'), runner, CLOCK, {
          max_concurrent_instruments: 2,
          newTraceId: countingTraceIds(),
          logger: LOGGER,
          auditLog,
          currentTickStore: makeCurrentTickStore(),
          decisionGate: new DebateBarDecisionGate(),
        });

        expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
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
        expect(logger.entries.some((entry) => entry.message === 'instrument failed: QQQ')).toBe(
          true,
        );
      });

      it('survives logger.log throwing on the same path — worker still returns a failed outcome, siblings still run', async () => {
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
    const steps: TickSteps = {
      exitCheck: vi.fn(async () => null),
      analysts: vi.fn(async () => []),
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

    const nextBar = new Date(barOpen.getTime() + 3_600_000);
    await runTickPlan(planAt(nextBar, 'BTC-USD'), runner, { now: () => nextBar }, config);
    expect(steps.analysts).toHaveBeenCalledTimes(2);
  });

  it('a grace-only plan never claims a decision bar — the runner takes the tick path (#1499)', async () => {
    const seen: Array<TickContext['decision_bar']> = [];
    const runner: TickRunner = {
      async runInstrument(_signal, ctx) {
        seen.push(ctx.decision_bar);
        return { trace_id: ctx.trace_id, final_stage: 'position_check' };
      },
    };
    const gate = new DebateBarDecisionGate();
    const config = loopConfig(gate);
    const usClose = new Date('2026-07-15T20:00:00Z');

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

    const laterClock: Clock = { now: () => new Date('2026-07-15T15:10:00Z') };
    await runTickPlan(planAt(midBar, 'BTC-USD'), runner, laterClock, config);
    await runTickPlan(planAt(midBar, 'BTC-USD'), runner, laterClock, config);

    expect(seen[0]?.open_time).toEqual(new Date('2026-07-15T14:00:00Z'));
    expect(seen[0]?.timeframe_ms).toBe(3_600_000);
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

    const second = await runTickPlan(
      planAt(new Date('2026-07-15T14:02:00Z'), 'BTC-USD'),
      runner,
      CLOCK,
      config,
    );
    expect(second[0]?.final_stage).toBe('trader');

    const third = await runTickPlan(
      planAt(new Date('2026-07-15T14:04:00Z'), 'BTC-USD'),
      runner,
      CLOCK,
      config,
    );
    expect(third[0]?.final_stage).toBe('position_check');
  });

  describe('bounded decision-pass retry (#785)', () => {
    it('stops retrying after the budget and reports the forfeit loudly, over a full bar of ticks', async () => {
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

      const decisionAttempts = outcomes.filter((o) => o?.error !== undefined).length;
      expect(decisionAttempts).toBe(maxRetries);
      expect(outcomes.slice(maxRetries).every((o) => o?.final_stage === 'position_check')).toBe(
        true,
      );

      const forfeitEntry = logger.entries.find((entry) =>
        entry.message.includes('retry budget exhausted'),
      );
      expect(forfeitEntry).toBeDefined();
      expect(forfeitEntry?.level).toBe('error');
      expect(forfeitEntry?.payload).toMatchObject({ instrument: 'BTC-USD' });

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
      const gate = new DebateBarDecisionGate(1);
      const config = loopConfig(gate);

      const barOpen = new Date('2026-07-15T14:00:00Z');
      const first = await runTickPlan(planAt(barOpen, 'BTC-USD'), runner, CLOCK, config);
      expect(first[0]?.error).toContain('decision pass failure #1');

      const midBar = new Date(barOpen.getTime() + TICK_INTERVAL_MS);
      const second = await runTickPlan(planAt(midBar, 'BTC-USD'), runner, CLOCK, config);
      expect(second[0]?.final_stage).toBe('position_check');
      expect(second[0]?.error).toBeUndefined();

      const nextBar = new Date(barOpen.getTime() + 3_600_000);
      const third = await runTickPlan(planAt(nextBar, 'BTC-USD'), runner, CLOCK, config);
      expect(third[0]?.error).toContain('decision pass failure #2');
    });
  });

  describe('a refused decision pass does not consume the retry budget (#1391)', () => {
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
