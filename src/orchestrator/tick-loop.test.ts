import type { Signal } from '../analysts/index.js';
import type { Clock } from '../shared/index.js';
import { openSharedStore } from '../shared/store/index.js';
import { SqliteAuditLog } from './sqlite-audit-log.js';
import { SqliteCurrentTickStore } from './sqlite-current-tick-store.js';
import { runTickPlan } from './tick-loop.js';
import type {
  AuditLog,
  CurrentTickStore,
  Logger,
  TickContext,
  TickOutcome,
  TickPlan,
  TickRunner,
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
    });

    // QQQ and AAPL both complete before the slow SPY pass.
    expect(finished).toEqual(['QQQ', 'AAPL', 'SPY']);
  });

  it('handles an empty plan (stocks closed, no crypto configured)', async () => {
    const runner: TickRunner = { runInstrument: vi.fn() };

    const outcomes = await runTickPlan({ instruments: [], tick_time: NOW }, runner, CLOCK, {
      max_concurrent_instruments: 4,
      newTraceId: countingTraceIds(),
      logger: LOGGER,
      auditLog: makeAuditLog(),
      currentTickStore: makeCurrentTickStore(),
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
        // A real `Logger` can throw: `JsonLogger`'s own primary
        // `process.stdout.write` is deliberately unguarded (EPIPE on a
        // broken pipe), and a rotating file sink can hit a full disk
        // (rotating-file-sink.ts). Every `logger.log` call on this path must
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
        });

        expect(outcomes[1]).toEqual({ trace_id: 'trace-2', error: 'debate exploded' });
        expect(outcomes[0]).toEqual({ trace_id: 'trace-1', final_stage: 'execution' });
      });
    });
  });
});
