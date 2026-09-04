/**
 * `buildPipelineView` — the pure half of the Pipeline view (#411). Every case
 * the lanes have to survive is expressed as an event list here rather than as
 * database state, which is the whole point of the seam: the cell-state rules
 * (#414) are testable without a tick ever having run, including the ones the
 * current schema cannot yet produce in production.
 */

import { PIPELINE_STAGES } from '../../../contracts/pipeline.js';
import { buildPipelineView } from './pipeline-query.js';
import type { PipelineActivity, PipelineLiveTick, PipelineStageEvent } from './types.js';

const T0 = new Date('2026-08-05T12:00:00.000Z');

/** Seconds after `T0` — keeps the arithmetic in the assertions readable. */
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

/** The one lane of a single-instrument fixture, asserted to exist. */
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

    // #413: the idle frame. An instrument that has not ticked in the window
    // still gets its row — a missing row would read as "this instrument was
    // dropped from the universe", which is a different fact entirely.
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
    // #535: an idle lane's cells have no `audit_log` row to timestamp.
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
      // Sum of the five measurable gaps — 0->2, 2->5, 5->6, 6->7, 7->9.
      total_ms: 9_000,
    });
    expect(cell(view, 'analysts')).toMatchObject({
      state: 'done',
      duration_ms: 2_000,
      attempts: 1,
    });
    expect(cell(view, 'debate')).toMatchObject({ state: 'done', duration_ms: 3_000 });
    expect(cell(view, 'verdict')).toMatchObject({ state: 'done', duration_ms: 2_000 });
    // The terminal row of a completed trace has no successor to measure
    // against, so its duration is null rather than an invented 0.
    expect(cell(view, 'execution')).toMatchObject({ state: 'done', duration_ms: null });
    // #535: every `done`/`stopped` cell carries its `audit_log` row's own
    // timestamp, not the trace's `started_at` or the next row's time.
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

    // #414: `stopped` is "reached, and the tick ended here" — the cell that
    // carries the reason. Everything downstream is `not_reached`, not
    // `skipped`: nothing decided to omit those stages, the tick simply ended.
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
    // #535: cells the trace never reached have nothing to timestamp.
    expect(cell(view, 'risk').recorded_at).toBeNull();
    expect(cell(view, 'verdict').recorded_at).toBeNull();
    expect(cell(view, 'execution').recorded_at).toBeNull();
  });

  it('reports a quorum skip as its own outcome, not as a generic stop', () => {
    const view = buildPipelineView(
      activity({ events: [event('trace-1', 'analysts', 'quorum_skip', 0)] }),
    );

    // A quorum skip is normal traffic (analysts-spec.md story 21) — folding it
    // into `stopped` would report a routine quiet market as a halted pipeline.
    expect(onlyLane(view)).toMatchObject({
      outcome: 'quorum_skip',
      final_stage: 'analysts',
      total_ms: 0,
    });
    expect(cell(view, 'analysts')).toMatchObject({ state: 'stopped', decision: 'quorum_skip' });
  });

  it('keeps the quorum-skip outcome when the skip names its cause (#1080)', () => {
    // The lane outcome is one word for all three skip spellings — it is a
    // closed union that drives lane rendering — and the distinction rides on
    // the CELL's decision, which the drawer glosses from `DEGRADED_DECISIONS`.
    // Without this, a named skip would fall through to `stopped` and a starved
    // analyst budget would render as a halted pipeline.
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

    // #414's last question: the two DO read differently, in `outcome`. The
    // cell state stays `stopped` because the tick did end there, so a render
    // that keys on cells alone cannot claim the tick reached Execution.
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

    // `audit_log` has no primary key precisely so this is representable. The
    // cell keeps BOTH attempts' time (1->4 and 4->6) — a retry that costs six
    // seconds must not report as the two seconds of its last try.
    expect(cell(view, 'debate')).toMatchObject({
      state: 'done',
      attempts: 2,
      decision: 'bullish',
      duration_ms: 5_000,
      // #535: last write wins, matching `decision` — the retry's own row
      // (t=4), not the first attempt's (t=1).
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

    // `0` and `null` are different facts and both reach the wire: `0` is a
    // measurement (a stage that returned inside the clock's resolution — what
    // a fixed clock produces for every stage), `null` is the absence of one.
    // Folding zeroes into null would report the fastest stages as unmeasured.
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
    // The live stage has no `audit_log` row yet — the row is written after the
    // stage returns — so there is nothing to count or to time. The elapsed
    // clock is `live_entered_at`, run forward client-side.
    expect(cell(view, 'debate')).toMatchObject({
      state: 'live',
      duration_ms: null,
      decision: null,
      // #535: a live cell has no `audit_log` row yet — the row is written
      // after the stage returns — so it has nothing to timestamp.
      // `live_entered_at` is its clock instead.
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
    // A stage can legitimately be reached twice in one trace (#414's retry
    // case) — including a retry that is still in flight: the first attempt
    // wrote an `audit_log` row, and `current_tick` now points back at the
    // same stage for the second one. `decision` and `recorded_at` disagree on
    // purpose here: `decision` is pre-existing per-stage state, unconditional
    // on `state`, so it keeps reporting the last row's word until a new one
    // overwrites it — the operator sees why the first attempt is being
    // retried. `recorded_at` is gated on `state === 'live'` (#535, matching
    // `duration_ms`'s existing gate): the CURRENT attempt has no row yet, and
    // reporting the first attempt's timestamp would let the frontend replay
    // engine mistake a stale prior-attempt time for the live stage's
    // transition time. `live_entered_at` is the live clock, not this field.
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

    // A tick that has only just entered Analysts has written no audit row at
    // all. `entered_at` stands in for `started_at` so the lane still says when
    // it began rather than claiming it is idle.
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

    // Both lanes are in flight — `max_concurrent_instruments` > 1 is normal —
    // while the header's single live pointer names the newest, matching what
    // `getTickStatus` already shows on the Overview view.
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

    // A crash mid-tick deliberately leaves `current_tick` stale
    // (tick-runner.ts's header: a stale row must be visible, not cleaned up).
    // Pinning the lane to it would freeze the instrument on a dead trace, so
    // the most recent activity wins and the lane reads as settled.
    expect(onlyLane(view)).toMatchObject({ trace_id: 'trace-new', outcome: 'stopped' });
  });

  it('reads a gap in a stage the runtime CAN write as skipped', () => {
    const view = buildPipelineView(
      activity({
        events: [
          event('trace-1', 'analysts', 'quorum_met', 0),
          // no `debate` row, yet the trace carried on past it
          event('trace-1', 'trader', 'no_trade', 4),
        ],
      }),
    );

    // The forward-looking half of #414: once a stage that can be skipped
    // ships, "no row but the tick continued" is a deliberate skip, and must
    // never collapse into `stopped`. Unreachable through `tick-runner` today,
    // which records every stage it reaches — asserted here so the rule exists
    // before the stage that needs it does.
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

    // #413's ordering question: instrument-stable, never newest-first. A lane
    // that reordered itself on a 3-second poll would move under the pointer of
    // an operator trying to read it.
    expect(view.lanes.map((l) => l.instrument)).toEqual(['BTC-USD', 'ETH-USD', 'AAPL', 'TSLA']);
  });

  it('ignores events for instruments outside the lane universe', () => {
    const view = buildPipelineView(
      activity({
        events: [event('trace-x', 'analysts', 'quorum_met', 0, 'DOGE-USD')],
      }),
    );

    // The universe is what bounds the payload; an event whose instrument has
    // no lane has nowhere to go, and inventing a lane for it would let the
    // 3-second poll grow without a bound.
    expect(view.lanes).toHaveLength(1);
    expect(onlyLane(view).outcome).toBe('idle');
  });
});
