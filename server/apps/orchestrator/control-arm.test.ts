import type { Signal } from '../../pipeline/analysts/index.js';
import type { AnalystView } from '../../pipeline/debate-engine/index.js';
import { SimulatedClock } from '../../shared/index.js';
import {
  AnalystViewRelay,
  buildControlAnalystsStep,
  buildControlArmStep,
  buildControlDebateStep,
  CONTROL_TRACE_SUFFIX,
  InMemoryCurrentTickStore,
} from './control-arm.js';
import type { TickContext, TickOutcome, TickRunner } from './types.js';

const BAR = new Date('2026-09-01T09:00:00.000Z');
const SIGNAL: Signal = { asset: 'BTC-USD', asset_class: 'crypto' };

function view(overrides: Partial<AnalystView> = {}): AnalystView {
  return {
    trace_id: 'trace-1',
    analyst_id: 'technical-1',
    analyst_type: 'technical',
    direction: 'bullish',
    confidence: 0.7,
    key_points: ['trend up'],
    timestamp: BAR,
    ...overrides,
  };
}

function recordingLogger() {
  const entries: { trace_id: string; stage: string; level: string; message: string }[] = [];
  return {
    entries,
    log: (entry: {
      trace_id: string;
      stage: string;
      level: string;
      message: string;
      payload?: unknown;
    }) => {
      entries.push(entry);
    },
  };
}

function tickContext(overrides: Partial<TickContext> = {}): TickContext {
  return {
    clock: new SimulatedClock(BAR),
    trace_id: 'trace-live',
    logger: recordingLogger(),
    auditLog: { record: () => undefined },
    currentTickStore: new InMemoryCurrentTickStore(),
    ...overrides,
  };
}

describe('AnalystViewRelay', () => {
  it('hands back the views set for THIS pass and nothing else', () => {
    const relay = new AnalystViewRelay();
    relay.set('a:control', [view({ confidence: 0.1 })]);
    relay.set('b:control', [view({ confidence: 0.9 })]);

    expect(relay.get('a:control')[0]?.confidence).toBe(0.1);
    expect(relay.get('b:control')[0]?.confidence).toBe(0.9);
    expect(relay.get('c:control')).toEqual([]);
  });

  it('cleared views do not leak into a later pass', () => {
    const relay = new AnalystViewRelay();
    relay.set('a:control', [view()]);
    relay.clear('a:control');

    expect(relay.get('a:control')).toEqual([]);
  });
});

describe('buildControlAnalystsStep', () => {
  it('relays rather than re-running — no market data, no MI agent, no second read of the tape', async () => {
    const relay = new AnalystViewRelay();
    const views = [view()];
    relay.set('trace-live:control', views);

    const step = buildControlAnalystsStep(relay);
    const relayed = await step({
      trace_id: 'trace-live:control',
      signal: SIGNAL,
      clock: new SimulatedClock(BAR),
      bar: BAR,
    });

    expect(relayed).toEqual(views);
  });
});

describe('buildControlDebateStep', () => {
  it('produces the axis vote as a DebateResult, with no round run', async () => {
    const relay = new AnalystViewRelay();
    relay.set('trace-live:control', [view({ direction: 'bearish', confidence: 0.64 })]);

    const result = await buildControlDebateStep(relay)({
      trace_id: 'trace-live:control',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      clock: new SimulatedClock(BAR),
      views: [],
      bar: BAR,
    });

    expect(result.direction).toBe('bearish');
    expect(result.confidence).toBe(0.64);
    expect(result.rounds_completed).toBe(0);
    expect(result.debate_id.startsWith('control:')).toBe(true);
  });

  it('decides from the relay, not from whatever the runner passes as views', async () => {
    const relay = new AnalystViewRelay();
    relay.set('trace-live:control', [view({ direction: 'bullish', confidence: 0.8 })]);

    const result = await buildControlDebateStep(relay)({
      trace_id: 'trace-live:control',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      clock: new SimulatedClock(BAR),
      views: [view({ direction: 'bearish', confidence: 0.99 })],
      bar: BAR,
    });

    expect(result.direction).toBe('bullish');
  });

  it('falls to a neutral result — not a throw — when no axis vote is available', async () => {
    const result = await buildControlDebateStep(new AnalystViewRelay())({
      trace_id: 'trace-live:control',
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      clock: new SimulatedClock(BAR),
      views: [],
      bar: BAR,
    });

    expect(result.direction).toBe('neutral');
    expect(result.confidence).toBe(0);
  });
});

describe('InMemoryCurrentTickStore', () => {
  it('upserts and deletes per instrument, holding one row each', () => {
    const store = new InMemoryCurrentTickStore();
    store.upsert({
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      trace_id: 't',
      stage: 'analysts',
      updated_at: BAR,
    });
    store.upsert({
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      trace_id: 't',
      stage: 'verdict',
      updated_at: BAR,
    });

    expect(store.get('BTC-USD')?.stage).toBe('verdict');
    store.delete('BTC-USD');
    expect(store.get('BTC-USD')).toBeUndefined();
  });
});

describe('buildControlArmStep', () => {
  function harness(runInstrument: TickRunner['runInstrument']) {
    const relay = new AnalystViewRelay();
    const logger = recordingLogger();
    const currentTickStore = new InMemoryCurrentTickStore();
    const step = buildControlArmStep({
      runner: { runInstrument },
      relay,
      currentTickStore,
      logger,
    });
    return { step, relay, logger, currentTickStore };
  }

  it('runs the control pass under a suffixed trace id, on its own progress store', async () => {
    const seen: TickContext[] = [];
    const { step, currentTickStore } = harness(async (_signal, ctx) => {
      seen.push(ctx);
      return { trace_id: ctx.trace_id, final_stage: 'execution' } as TickOutcome;
    });

    const ctx = tickContext();
    await step({ signal: SIGNAL, ctx, views: [view()] });

    expect(seen[0]?.trace_id).toBe(`trace-live${CONTROL_TRACE_SUFFIX}`);
    expect(seen[0]?.currentTickStore).toBe(currentTickStore);
    expect(seen[0]?.currentTickStore).not.toBe(ctx.currentTickStore);
    expect(seen[0]?.clock).toBe(ctx.clock);
    expect(seen[0]?.auditLog).toBe(ctx.auditLog);
  });

  it('takes the decision path on exactly the bars the live arm does', async () => {
    const seen: TickContext[] = [];
    const { step } = harness(async (_signal, ctx) => {
      seen.push(ctx);
      return { trace_id: ctx.trace_id, final_stage: 'execution' } as TickOutcome;
    });

    const decisionBar = { id: 'bar-1', open_time: BAR, timeframe_ms: 3_600_000 };
    await step({
      signal: SIGNAL,
      ctx: tickContext({ decision_bar: decisionBar }),
      views: [view()],
    });
    await step({ signal: SIGNAL, ctx: tickContext() });

    expect(seen[0]?.decision_bar).toBe(decisionBar);
    expect(seen[1]).not.toHaveProperty('decision_bar');
  });

  it('relays the live pass views and clears them afterwards', async () => {
    let duringPass: readonly AnalystView[] = [];
    const { step, relay } = harness(async (_signal, ctx) => {
      duringPass = relay.get(ctx.trace_id);
      return { trace_id: ctx.trace_id, final_stage: 'execution' } as TickOutcome;
    });

    await step({ signal: SIGNAL, ctx: tickContext(), views: [view({ confidence: 0.55 })] });

    expect(duringPass[0]?.confidence).toBe(0.55);
    expect(relay.get(`trace-live${CONTROL_TRACE_SUFFIX}`)).toEqual([]);
  });

  it('contains a control-arm failure, logs it at error, and clears the relay', async () => {
    const { step, relay, logger } = harness(async () => {
      throw new Error('control blew up');
    });

    await expect(
      step({ signal: SIGNAL, ctx: tickContext(), views: [view()] }),
    ).resolves.toBeUndefined();

    const logged = logger.entries.filter((entry) => entry.stage === 'control_arm');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('error');
    expect(logged[0]?.trace_id).toBe(`trace-live${CONTROL_TRACE_SUFFIX}`);
    expect(logged[0]?.message).toContain('BTC-USD');
    expect(relay.get(`trace-live${CONTROL_TRACE_SUFFIX}`)).toEqual([]);
  });

  it('runs the control pass exactly once per call — no duplicate control trades', async () => {
    const runInstrument = vi.fn(async (_signal: Signal, ctx: TickContext) => ({
      trace_id: ctx.trace_id,
      final_stage: 'execution' as const,
    })) as unknown as TickRunner['runInstrument'];
    const { step } = harness(runInstrument);

    await step({ signal: SIGNAL, ctx: tickContext(), views: [view()] });

    expect(runInstrument).toHaveBeenCalledTimes(1);
  });
});
