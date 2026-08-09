import type { Scheduler, TickContext, TickRunner } from '../../apps/orchestrator/index.js';
import type { Signal } from '../../pipeline/analysts/index.js';
import { type Clock, SimulatedClock } from '../../shared/index.js';
import { type BacktestDeps, BacktestHarness } from './backtest.js';
import { LookaheadAuditor, LookaheadViolationError } from './lookahead.js';
import type { BacktestConfig, CostConfig, ReplayTimeline } from './types.js';
import {
  type InstrumentListing,
  type InstrumentRegistry,
  SurvivorshipViolationError,
} from './universe.js';

const WINDOW = {
  start: new Date('2024-01-02T00:00:00.000Z'),
  end: new Date('2024-01-02T03:00:00.000Z'),
};

const BAR_1 = new Date('2024-01-02T01:00:00.000Z');
const BAR_2 = new Date('2024-01-02T02:00:00.000Z');

const COST_CONFIG: CostConfig = {
  crypto: {
    spreadVolatilityCoefficient: 0.1,
    commissionRate: 0.001,
    slippageCoefficient: 0.05,
    impactK: 0.5,
  },
  stocks: {
    spreadVolatilityCoefficient: 0.05,
    commissionRate: 0.0005,
    slippageCoefficient: 0.02,
    impactK: 0.3,
  },
};

function configOf(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    config_hash: 'cfg-abc123',
    window: WINDOW,
    universe: ['BTC-USD'],
    cost_config: COST_CONFIG,
    seed: 42,
    ...overrides,
  };
}

function registryOf(...membership: InstrumentListing[]): InstrumentRegistry {
  return { membershipDuring: async () => membership };
}

function timelineOf(...bars: Date[]): ReplayTimeline {
  return { barTimestamps: async () => bars };
}

/** Fires every instrument in `universe` on every bar (crypto: 24/7). */
function schedulerOf(...universe: string[]): Scheduler {
  return {
    nextTick: (clock) => ({
      instruments: universe.map((asset) => ({ asset, asset_class: 'crypto' as const })),
      tick_time: clock.now(),
    }),
  };
}

/** Deterministic context factory: trace_id is a pure function of asset + T. */
function newTickContext(signal: Signal, clock: Clock): TickContext {
  return {
    clock,
    trace_id: `${signal.asset}@${clock.now().toISOString()}`,
    logger: { log: () => {} },
    auditLog: { record: () => {} },
    // The backtest harness has no live tick to publish; the dashboard's
    // current_tick row is a live-run concern. Inert, not omitted, so the
    // context stays structurally complete.
    currentTickStore: { upsert: () => {}, delete: () => {}, get: () => undefined },
  };
}

/** Records the T it saw at each call, so we can assert the harness stepped the clock. */
function recordingTickRunner(): TickRunner & { seen: { asset: string; t: string }[] } {
  const seen: { asset: string; t: string }[] = [];
  return {
    seen,
    runInstrument: async (signal, ctx) => {
      seen.push({ asset: signal.asset, t: ctx.clock.now().toISOString() });
      return { trace_id: ctx.trace_id, final_stage: 'verdict', verdict_status: 'no_go' };
    },
  };
}

function depsOf(overrides: Partial<BacktestDeps> = {}): BacktestDeps {
  return {
    scheduler: schedulerOf('BTC-USD'),
    tickRunner: recordingTickRunner(),
    timeline: timelineOf(BAR_1, BAR_2),
    registry: registryOf({ symbol: 'BTC-USD' }),
    newTickContext,
    ...overrides,
  };
}

describe('BacktestHarness.run', () => {
  it('steps the clock bar-by-bar and drives the tick runner at each T', async () => {
    const tickRunner = recordingTickRunner();
    const harness = new BacktestHarness(depsOf({ tickRunner }));

    await harness.run(configOf(), new SimulatedClock(WINDOW.start));

    expect(tickRunner.seen).toEqual([
      { asset: 'BTC-USD', t: BAR_1.toISOString() },
      { asset: 'BTC-USD', t: BAR_2.toISOString() },
    ]);
  });

  it('leaves the clock at the final bar', async () => {
    const clock = new SimulatedClock(WINDOW.start);

    await new BacktestHarness(depsOf()).run(configOf(), clock);

    expect(clock.now()).toEqual(BAR_2);
  });

  it('collects one outcome per instrument per bar, in replay order', async () => {
    const harness = new BacktestHarness(depsOf({ scheduler: schedulerOf('BTC-USD', 'ETH-USD') }));

    const report = await harness.run(
      configOf({ universe: ['BTC-USD', 'ETH-USD'] }),
      new SimulatedClock(WINDOW.start),
    );

    expect(report.tick_outcomes.map((outcome) => outcome.trace_id)).toEqual([
      `BTC-USD@${BAR_1.toISOString()}`,
      `ETH-USD@${BAR_1.toISOString()}`,
      `BTC-USD@${BAR_2.toISOString()}`,
      `ETH-USD@${BAR_2.toISOString()}`,
    ]);
  });

  it('records config_hash, seed and the passed audit on the report', async () => {
    const report = await new BacktestHarness(depsOf()).run(
      configOf({ config_hash: 'cfg-xyz', seed: 7 }),
      new SimulatedClock(WINDOW.start),
    );

    expect(report).toMatchObject({
      config_hash: 'cfg-xyz',
      seed: 7,
      lookahead_audit: 'passed',
    });
  });

  it('runs instruments sequentially, never concurrently, for deterministic ordering', async () => {
    const events: string[] = [];
    const tickRunner: TickRunner = {
      runInstrument: async (signal, ctx) => {
        events.push(`start:${signal.asset}`);
        await Promise.resolve();
        events.push(`end:${signal.asset}`);
        return { trace_id: ctx.trace_id, final_stage: 'verdict', verdict_status: 'no_go' };
      },
    };

    await new BacktestHarness(
      depsOf({
        scheduler: schedulerOf('BTC-USD', 'ETH-USD'),
        tickRunner,
        timeline: timelineOf(BAR_1),
      }),
    ).run(configOf({ universe: ['BTC-USD', 'ETH-USD'] }), new SimulatedClock(WINDOW.start));

    expect(events).toEqual(['start:BTC-USD', 'end:BTC-USD', 'start:ETH-USD', 'end:ETH-USD']);
  });

  // AC4 (partial): the harness's own contribution to determinism. The full
  // fixed-window pipeline replay needs the real TickRunner (#94) + the Debate
  // core, and is deferred with them.
  it('reproduces an identical report across two runs with the same seed and clock', async () => {
    const run = () =>
      new BacktestHarness(depsOf()).run(configOf(), new SimulatedClock(WINDOW.start));

    expect(await run()).toEqual(await run());
  });

  describe('no-lookahead audit (AC2)', () => {
    it('fails the run when a stage read peeks at the future', async () => {
      // Stands in for the composition root wrapping a data source with the
      // auditor: the stage reads a bar stamped after T, the auditor throws,
      // and the throw must take the whole run down.
      const tickRunner: TickRunner = {
        runInstrument: async (_signal, ctx) => {
          new LookaheadAuditor(ctx.clock).auditRead('bars', new Date('2024-06-01T00:00:00.000Z'));
          throw new Error('unreachable: the audit above must throw');
        },
      };

      await expect(
        new BacktestHarness(depsOf({ tickRunner })).run(
          configOf(),
          new SimulatedClock(WINDOW.start),
        ),
      ).rejects.toThrow(LookaheadViolationError);
    });

    it('produces no report or trades from a violating run', async () => {
      const tickRunner: TickRunner = {
        runInstrument: async (_signal, ctx) => {
          new LookaheadAuditor(ctx.clock).auditRead('bars', new Date('2024-06-01T00:00:00.000Z'));
          throw new Error('unreachable: the audit above must throw');
        },
      };

      const report = await new BacktestHarness(depsOf({ tickRunner }))
        .run(configOf(), new SimulatedClock(WINDOW.start))
        .catch(() => undefined);

      expect(report).toBeUndefined();
    });
  });

  describe('survivorship-free universe (AC3)', () => {
    it('rejects a universe that dropped a delisted member before stepping any bar', async () => {
      const tickRunner = recordingTickRunner();
      const harness = new BacktestHarness(
        depsOf({
          tickRunner,
          registry: registryOf(
            { symbol: 'BTC-USD' },
            { symbol: 'LUNA-USD', delisted_at: new Date('2024-01-02T00:30:00.000Z') },
          ),
        }),
      );

      await expect(harness.run(configOf(), new SimulatedClock(WINDOW.start))).rejects.toThrow(
        SurvivorshipViolationError,
      );
      expect(tickRunner.seen).toEqual([]);
    });

    it('keeps a delisted instrument in the replay when the universe retains it', async () => {
      const tickRunner = recordingTickRunner();
      const harness = new BacktestHarness(
        depsOf({
          tickRunner,
          scheduler: schedulerOf('BTC-USD', 'LUNA-USD'),
          timeline: timelineOf(BAR_1),
          registry: registryOf(
            { symbol: 'BTC-USD' },
            { symbol: 'LUNA-USD', delisted_at: new Date('2024-01-02T00:30:00.000Z') },
          ),
        }),
      );

      await harness.run(
        configOf({ universe: ['BTC-USD', 'LUNA-USD'] }),
        new SimulatedClock(WINDOW.start),
      );

      expect(tickRunner.seen.map((s) => s.asset)).toContain('LUNA-USD');
    });
  });

  describe('timeline guards', () => {
    it('fails the run on a bar after the window end', async () => {
      const harness = new BacktestHarness(
        depsOf({ timeline: timelineOf(BAR_1, new Date('2024-03-01T00:00:00.000Z')) }),
      );

      await expect(harness.run(configOf(), new SimulatedClock(WINDOW.start))).rejects.toThrow(
        /outside the configured window/,
      );
    });

    it('fails the run on a bar before the window start', async () => {
      const harness = new BacktestHarness(
        depsOf({ timeline: timelineOf(new Date('2023-12-31T00:00:00.000Z'), BAR_1) }),
      );

      await expect(harness.run(configOf(), new SimulatedClock(WINDOW.start))).rejects.toThrow(
        /outside the configured window/,
      );
    });

    it('fails the run on an unsorted timeline rather than rewinding T', async () => {
      const harness = new BacktestHarness(depsOf({ timeline: timelineOf(BAR_2, BAR_1) }));

      await expect(harness.run(configOf(), new SimulatedClock(WINDOW.start))).rejects.toThrow(
        /refusing to step backwards/,
      );
    });

    it('produces an empty report for a window with no bars', async () => {
      const report = await new BacktestHarness(depsOf({ timeline: timelineOf() })).run(
        configOf(),
        new SimulatedClock(WINDOW.start),
      );

      expect(report.tick_outcomes).toEqual([]);
      expect(report.lookahead_audit).toBe('passed');
    });
  });
});
