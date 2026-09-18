import { PIPELINE_STAGES } from '../../../contracts/index.js';
import { buildPipelineView } from './pipeline-query.js';
import type { PipelineActivity, PipelineLiveTick, PipelineStageEvent } from './types.js';

const T0 = new Date('2026-08-05T12:00:00.000Z');

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1_000);
}

function event(
  trace_id: string,
  stage: PipelineStageEvent['stage'],
  decision: string,
  seconds: number,
  instrument = 'BTC-USD',
  asset_class: PipelineStageEvent['asset_class'] = 'crypto',
): PipelineStageEvent {
  return { trace_id, instrument, asset_class, stage, decision, timestamp: at(seconds) };
}

function activity(overrides: Partial<PipelineActivity> = {}): PipelineActivity {
  return {
    universe: [{ instrument: 'BTC-USD', asset_class: 'crypto' }],
    events: [],
    live: [],
    ...overrides,
  };
}

function liveTick(overrides: Partial<PipelineLiveTick> = {}): PipelineLiveTick {
  return {
    instrument: 'BTC-USD',
    asset_class: 'crypto',
    stage: 'debate',
    trace_id: 'trace-live',
    entered_at: at(2),
    ...overrides,
  };
}

function onlyLane(view: ReturnType<typeof buildPipelineView>) {
  const lane = view.lanes[0];
  if (lane === undefined) {
    throw new Error('expected exactly one lane');
  }
  return lane;
}

function cell(view: ReturnType<typeof buildPipelineView>, stage: string) {
  const found = onlyLane(view).cells.find((c) => c.stage === stage);
  if (found === undefined) {
    throw new Error(`no cell for stage "${stage}"`);
  }
  return found;
}

describe('buildPipelineView', () => {
  it('gives every lane exactly one cell per stage, in PIPELINE_STAGES order', () => {
    const view = buildPipelineView(activity());

    expect(onlyLane(view).cells.map((c) => c.stage)).toEqual([...PIPELINE_STAGES]);
  });

  it('renders an instrument with no trace as an idle lane', () => {
    const view = buildPipelineView(activity());
    const lane = onlyLane(view);

    expect(lane).toMatchObject({
      instrument: 'BTC-USD',
      asset_class: 'crypto',
      trace_id: null,
      outcome: 'idle',
      final_stage: null,
      started_at: null,
      total_ms: null,
    });
    expect(lane.cells.every((c) => c.state === 'not_reached')).toBe(true);
    expect(lane.cells.every((c) => c.duration_ms === null && c.decision === null)).toBe(true);
    expect(lane.cells.every((c) => c.recorded_at === null)).toBe(true);
    expect(view.live_trace_id).toBeNull();
    expect(view.live_entered_at).toBeNull();
  });

  it('walks a completed go trace to execution, timing each stage from the next row', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'debate', 'bullish', 2),
          event('trace-1', 'trader', 'entry', 5),
          event('trace-1', 'risk', 'approved', 6),
          event('trace-1', 'verdict', 'go', 7),
          event('trace-1', 'execution', 'filled', 9),
        ],
      }),
    );
    const lane = onlyLane(view);

    expect(lane).toMatchObject({
      trace_id: 'trace-1',
      outcome: 'go',
      final_stage: 'execution',
      started_at: at(0).toISOString(),
      total_ms: 9_000,
    });
    expect(cell(view, 'analysts')).toMatchObject({
      state: 'done',
      duration_ms: 2_000,
      attempts: 1,
    });
    expect(cell(view, 'debate')).toMatchObject({ state: 'done', duration_ms: 3_000 });
    expect(cell(view, 'verdict')).toMatchObject({ state: 'done', duration_ms: 2_000 });
    expect(cell(view, 'execution')).toMatchObject({ state: 'done', duration_ms: null });
    expect(cell(view, 'analysts').recorded_at).toBe(at(0).toISOString());
    expect(cell(view, 'debate').recorded_at).toBe(at(2).toISOString());
    expect(cell(view, 'execution').recorded_at).toBe(at(9).toISOString());
  });

  it('marks the stage a short-circuited trace ended at as stopped, the rest not_reached', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'debate', 'neutral', 1),
          event('trace-1', 'trader', 'no_trade', 3),
        ],
      }),
    );

    expect(cell(view, 'trader')).toMatchObject({
      state: 'stopped',
      decision: 'no_trade',
      duration_ms: null,
      recorded_at: at(3).toISOString(),
    });
    expect(cell(view, 'risk').state).toBe('not_reached');
    expect(cell(view, 'verdict').state).toBe('not_reached');
    expect(cell(view, 'execution').state).toBe('not_reached');
    expect(onlyLane(view)).toMatchObject({ outcome: 'stopped', final_stage: 'trader' });
    expect(cell(view, 'risk').recorded_at).toBeNull();
    expect(cell(view, 'verdict').recorded_at).toBeNull();
    expect(cell(view, 'execution').recorded_at).toBeNull();
  });

  it('reports a quorum skip as its own outcome, not as a generic stop', () => {
    const view = buildPipelineView(
      activity({ events: [event('trace-1', 'analysts', 'quorum_skip', 0)] }),
    );

    expect(onlyLane(view)).toMatchObject({
      outcome: 'quorum_skip',
      final_stage: 'analysts',
      total_ms: 0,
    });
    expect(cell(view, 'analysts')).toMatchObject({ state: 'stopped', decision: 'quorum_skip' });
  });

  it('keeps the quorum-skip outcome when the skip names its cause (#1080)', () => {
    for (const decision of ['quorum_skip_timeout', 'quorum_skip_fault'] as const) {
      const view = buildPipelineView(
        activity({ events: [event('trace-1', 'analysts', decision, 0)] }),
      );

      expect(onlyLane(view)).toMatchObject({ outcome: 'quorum_skip', final_stage: 'analysts' });
      expect(cell(view, 'analysts')).toMatchObject({ state: 'stopped', decision });
    }
  });

  it('reports a verdict no_go as a completed traversal, not a short-circuit', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'debate', 'bullish', 1),
          event('trace-1', 'trader', 'entry', 2),
          event('trace-1', 'risk', 'approved', 3),
          event('trace-1', 'verdict', 'no_go', 4),
        ],
      }),
    );

    expect(onlyLane(view)).toMatchObject({ outcome: 'no_go', final_stage: 'verdict' });
    expect(cell(view, 'verdict')).toMatchObject({ state: 'stopped', decision: 'no_go' });
    expect(cell(view, 'execution').state).toBe('not_reached');
  });

  it('counts repeated stage rows as attempts and keeps the last decision', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'debate', 'error_retry', 1),
          event('trace-1', 'debate', 'bullish', 4),
          event('trace-1', 'trader', 'no_trade', 6),
        ],
      }),
    );

    expect(cell(view, 'debate')).toMatchObject({
      state: 'done',
      attempts: 2,
      decision: 'bullish',
      duration_ms: 5_000,
      recorded_at: at(4).toISOString(),
    });
    expect(cell(view, 'analysts').attempts).toBe(1);
  });

  it('keeps a same-millisecond stage at 0ms, distinct from an unmeasured one', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'debate', 'bullish', 0),
          event('trace-1', 'trader', 'no_trade', 0),
        ],
      }),
    );

    expect(cell(view, 'analysts').duration_ms).toBe(0);
    expect(cell(view, 'debate').duration_ms).toBe(0);
    expect(cell(view, 'trader').duration_ms).toBeNull();
    expect(onlyLane(view).total_ms).toBe(0);
  });

  it('marks the current stage of an in-flight trace live, with no duration', () => {
    const view = buildPipelineView(
      activity({
        events: [event('trace-live', 'analysts', 'quorum_met', 0)],
        live: [liveTick({ trace_id: 'trace-live', stage: 'debate', entered_at: at(1) })],
      }),
    );

    expect(onlyLane(view)).toMatchObject({
      trace_id: 'trace-live',
      outcome: 'in_flight',
      final_stage: 'debate',
      started_at: at(0).toISOString(),
    });
    expect(cell(view, 'debate')).toMatchObject({
      state: 'live',
      duration_ms: null,
      decision: null,
      recorded_at: null,
      attempts: 0,
    });
    expect(cell(view, 'analysts')).toMatchObject({
      state: 'done',
      recorded_at: at(0).toISOString(),
    });
    expect(cell(view, 'trader').state).toBe('not_reached');
    expect(view.live_trace_id).toBe('trace-live');
    expect(view.live_entered_at).toBe(at(1).toISOString());
  });

  it('keeps the prior attempt decision word on a live cell mid-retry, but not its timestamp', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-live', 'analysts', 'quorum_met', 0),
          event('trace-live', 'debate', 'error_retry', 1),
        ],
        live: [liveTick({ trace_id: 'trace-live', stage: 'debate', entered_at: at(4) })],
      }),
    );

    expect(cell(view, 'debate')).toMatchObject({
      state: 'live',
      decision: 'error_retry',
      recorded_at: null,
      attempts: 1,
    });
  });

  it('starts an in-flight lane from current_tick when no stage row exists yet', () => {
    const view = buildPipelineView(
      activity({
        live: [liveTick({ trace_id: 'trace-live', stage: 'analysts', entered_at: at(3) })],
      }),
    );

    expect(onlyLane(view)).toMatchObject({
      outcome: 'in_flight',
      started_at: at(3).toISOString(),
      total_ms: 0,
    });
  });

  it('reports the newest live tick when several instruments are in flight', () => {
    const view = buildPipelineView(
      activity({
        universe: [
          { instrument: 'BTC-USD', asset_class: 'crypto' },
          { instrument: 'AAPL', asset_class: 'stocks' },
        ],
        live: [
          liveTick({
            instrument: 'AAPL',
            asset_class: 'stocks',
            trace_id: 'trace-b',
            entered_at: at(9),
          }),
          liveTick({ trace_id: 'trace-a', entered_at: at(4) }),
        ],
      }),
    );

    expect(view.lanes.map((l) => l.outcome)).toEqual(['in_flight', 'in_flight']);
    expect(view.live_trace_id).toBe('trace-b');
    expect(view.live_entered_at).toBe(at(9).toISOString());
  });

  it('prefers a newer settled trace over a stale current_tick row', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-old', 'analysts', 'quorum_met', 0),
          event('trace-new', 'analysts', 'quorum_met', 30),
          event('trace-new', 'debate', 'bearish', 31),
          event('trace-new', 'trader', 'no_trade', 32),
        ],
        live: [liveTick({ trace_id: 'trace-old', stage: 'debate', entered_at: at(1) })],
      }),
    );

    expect(onlyLane(view)).toMatchObject({ trace_id: 'trace-new', outcome: 'stopped' });
  });

  it('reads a gap in a stage the runtime CAN write as skipped', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          event('trace-1', 'trader', 'no_trade', 4),
        ],
      }),
    );

    expect(cell(view, 'debate')).toMatchObject({
      state: 'skipped',
      duration_ms: null,
      attempts: 0,
      recorded_at: null,
    });
    expect(cell(view, 'trader').state).toBe('stopped');
  });

  it('orders lanes by asset class then instrument, regardless of input order', () => {
    const view = buildPipelineView(
      activity({
        universe: [
          { instrument: 'TSLA', asset_class: 'stocks' },
          { instrument: 'ETH-USD', asset_class: 'crypto' },
          { instrument: 'AAPL', asset_class: 'stocks' },
          { instrument: 'BTC-USD', asset_class: 'crypto' },
        ],
      }),
    );

    expect(view.lanes.map((l) => l.instrument)).toEqual(['BTC-USD', 'ETH-USD', 'AAPL', 'TSLA']);
  });

  it('ignores events for instruments outside the lane universe', () => {
    const view = buildPipelineView(
      activity({
        events: [event('trace-x', 'analysts', 'quorum_met', 0, 'DOGE-USD')],
      }),
    );

    expect(view.lanes).toHaveLength(1);
    expect(onlyLane(view).outcome).toBe('idle');
  });
});
