import { describe, expect, it } from 'vitest';
import { at, doneThrough, makeLane, makeView } from './test-support.ts';
import { computeWalkPlan, HOP_MAX_MS, HOP_MIN_MS, WALK_BUDGET_MS } from './walk-plan.ts';

const NO_OPTS = { firstPaint: false, snapOnly: false };

function walkFor(plan: ReturnType<typeof computeWalkPlan>, instrument: string) {
  const motion = plan.motions.find((m) => m.instrument === instrument);
  if (motion?.kind !== 'walk')
    throw new Error(`expected walk for ${instrument}, got ${motion?.kind}`);
  return motion;
}

describe('computeWalkPlan — snap cases', () => {
  it('snaps every chip into place on first paint', () => {
    const next = makeView([doneThrough('BTC-USD', 't1', 'risk'), makeLane({ instrument: 'SPY' })]);
    const plan = computeWalkPlan(null, next, { firstPaint: true, snapOnly: false });
    expect(plan.motions).toEqual([
      { kind: 'snap', instrument: 'BTC-USD', room: 'risk' },
      { kind: 'snap', instrument: 'SPY', room: 'lobby' },
    ]);
    expect(plan.total_ms).toBe(0);
  });

  it('snaps everything when snapOnly is set (hidden tab / reduced motion)', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'analysts')]);
    const next = makeView([doneThrough('BTC-USD', 't1', 'verdict')]);
    const plan = computeWalkPlan(prev, next, { firstPaint: false, snapOnly: true });
    expect(plan.motions).toEqual([{ kind: 'snap', instrument: 'BTC-USD', room: 'verdict' }]);
    expect(plan.total_ms).toBe(0);
  });

  it('snaps a lane that aged to idle into the Lobby, as a non-event', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'execution', { outcome: 'go' })]);
    const next = makeView([makeLane({ instrument: 'BTC-USD', outcome: 'idle' })]);
    const plan = computeWalkPlan(prev, next, NO_OPTS);
    expect(plan.motions).toEqual([{ kind: 'snap', instrument: 'BTC-USD', room: 'lobby' }]);
  });

  it('emits no motion for an unchanged lane', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'risk')]);
    const next = makeView([doneThrough('BTC-USD', 't1', 'risk')]);
    expect(computeWalkPlan(prev, next, NO_OPTS).motions).toEqual([]);
  });
});

describe('computeWalkPlan — appear / depart', () => {
  it('fades in a lane that appeared, placed in its room', () => {
    const prev = makeView([]);
    const next = makeView([doneThrough('ETH-USD', 't9', 'debate')]);
    expect(computeWalkPlan(prev, next, NO_OPTS).motions).toEqual([
      { kind: 'appear', instrument: 'ETH-USD', room: 'debate' },
    ]);
  });

  it('fades out a lane that departed, from the room it stood in', () => {
    const prev = makeView([doneThrough('ETH-USD', 't9', 'debate')]);
    const next = makeView([]);
    expect(computeWalkPlan(prev, next, NO_OPTS).motions).toEqual([
      { kind: 'depart', instrument: 'ETH-USD', room: 'debate' },
    ]);
  });
});

describe('computeWalkPlan — same-trace walks', () => {
  it('hops one room forward when the trace advanced one recorded stage', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'analysts')]);
    const next = makeView([doneThrough('BTC-USD', 't1', 'debate')]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.from).toBe('analysts');
    expect(walk.hops.map((h) => h.room)).toEqual(['debate']);
  });

  it('never walks through a skipped stage — a null recorded_at room is hopped over', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'trader')]);
    // Same trace, advanced to execution; verdict was skipped (null recorded_at).
    const next = makeView([
      makeLane({
        instrument: 'BTC-USD',
        trace_id: 't1',
        outcome: 'go',
        cells: {
          analysts: { state: 'done', recorded_at: at(1_000) },
          debate: { state: 'done', recorded_at: at(2_000) },
          trader: { state: 'done', recorded_at: at(3_000) },
          risk: { state: 'done', recorded_at: at(4_000) },
          verdict: { state: 'skipped' },
          execution: { state: 'done', recorded_at: at(5_000) },
        },
        started_at: at(0),
      }),
    ]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.hops.map((h) => h.room)).toEqual(['risk', 'execution']);
  });

  it('walks into a live destination room using live_entered_at as its clock', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'trader')]);
    const next = makeView(
      [
        makeLane({
          instrument: 'BTC-USD',
          trace_id: 't1',
          outcome: 'in_flight',
          cells: {
            analysts: { state: 'done', recorded_at: at(1_000) },
            debate: { state: 'done', recorded_at: at(2_000) },
            trader: { state: 'done', recorded_at: at(3_000) },
            risk: { state: 'live' },
          },
          started_at: at(0),
        }),
      ],
      { live_trace_id: 't1', live_entered_at: at(3_400) },
    );
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.hops.map((h) => h.room)).toEqual(['risk']);
  });

  it('snaps rather than walking backwards when a retry regressed the room', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'risk')]);
    const next = makeView([doneThrough('BTC-USD', 't1', 'debate')]);
    expect(computeWalkPlan(prev, next, NO_OPTS).motions).toEqual([
      { kind: 'snap', instrument: 'BTC-USD', room: 'debate' },
    ]);
  });
});

describe('computeWalkPlan — trace rotation', () => {
  it('returns to Analysts, then forward through the new trace’s recorded stages', () => {
    const prev = makeView([doneThrough('BTC-USD', 'old', 'verdict', { outcome: 'no_go' })]);
    const next = makeView([doneThrough('BTC-USD', 'new', 'trader', { startMs: 60_000 })]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.from).toBe('verdict');
    expect(walk.hops.map((h) => h.room)).toEqual(['analysts', 'debate', 'trader']);
  });

  it('snaps when the rotated-to trace has no reached cells yet', () => {
    // PR #582 review: a lane with a trace_id but no reached cells stands in
    // the Lobby, so the hop range was empty and this emitted a 0-hop `walk`
    // — a placement the renderer would "animate" for 0ms — instead of a snap.
    const prev = makeView([doneThrough('BTC-USD', 'old', 'verdict', { outcome: 'no_go' })]);
    const next = makeView([
      makeLane({ instrument: 'BTC-USD', trace_id: 'new', outcome: 'in_flight', started_at: at(0) }),
    ]);
    expect(computeWalkPlan(prev, next, NO_OPTS).motions).toEqual([
      { kind: 'snap', instrument: 'BTC-USD', room: 'lobby' },
    ]);
  });

  it('walks a chip leaving the Lobby to Analysts and forward when a trace starts', () => {
    const prev = makeView([makeLane({ instrument: 'SPY', outcome: 'idle' })]);
    const next = makeView([doneThrough('SPY', 'fresh', 'debate')]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'SPY');
    expect(walk.from).toBe('lobby');
    expect(walk.hops.map((h) => h.room)).toEqual(['analysts', 'debate']);
  });
});

describe('computeWalkPlan — durations', () => {
  it('clamps each hop to [150, 450] ms', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'analysts', { stepMs: 10 })]);
    // debate recorded 10ms after analysts (tiny gap), risk 30s after (huge gap).
    const next = makeView([
      makeLane({
        instrument: 'BTC-USD',
        trace_id: 't1',
        outcome: 'in_flight',
        cells: {
          analysts: { state: 'done', recorded_at: at(10) },
          debate: { state: 'done', recorded_at: at(20) },
          trader: { state: 'done', recorded_at: at(30_020) },
        },
        started_at: at(0),
      }),
    ]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.hops.map((h) => h.room)).toEqual(['debate', 'trader']);
    expect(walk.hops[0]?.duration_ms).toBe(HOP_MIN_MS);
    expect(walk.hops[1]?.duration_ms).toBe(HOP_MAX_MS);
  });

  it('gives a hop with a longer recorded gap a longer duration', () => {
    const prev = makeView([doneThrough('BTC-USD', 't1', 'analysts', { stepMs: 200 })]);
    const next = makeView([
      makeLane({
        instrument: 'BTC-USD',
        trace_id: 't1',
        outcome: 'in_flight',
        cells: {
          analysts: { state: 'done', recorded_at: at(200) },
          debate: { state: 'done', recorded_at: at(400) }, // 200ms gap
          trader: { state: 'done', recorded_at: at(800) }, // 400ms gap
        },
        started_at: at(0),
      }),
    ]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    const [d1, d2] = walk.hops.map((h) => h.duration_ms);
    expect(d1).toBeDefined();
    expect(d2).toBeDefined();
    if (d1 === undefined || d2 === undefined) throw new Error('unreachable');
    expect(d2).toBeGreaterThan(d1);
    expect(d1).toBeGreaterThanOrEqual(HOP_MIN_MS);
    expect(d2).toBeLessThanOrEqual(HOP_MAX_MS);
  });

  it('keeps a full-pipeline replay inside the 1.2s budget with every hop >= 150ms', () => {
    // Rotation from execution: 6 hops, each with a whole minute recorded gap —
    // unclamped that is 6 x 450 = 2700ms, which must scale down to <= 1200.
    const prev = makeView([doneThrough('BTC-USD', 'old', 'execution', { outcome: 'go' })]);
    const next = makeView([
      doneThrough('BTC-USD', 'new', 'execution', {
        startMs: 600_000,
        stepMs: 60_000,
        outcome: 'go',
      }),
    ]);
    const walk = walkFor(computeWalkPlan(prev, next, NO_OPTS), 'BTC-USD');
    expect(walk.hops).toHaveLength(6);
    const total = walk.hops.reduce((sum, h) => sum + h.duration_ms, 0);
    expect(total).toBeLessThanOrEqual(WALK_BUDGET_MS);
    for (const hop of walk.hops) {
      expect(hop.duration_ms).toBeGreaterThanOrEqual(HOP_MIN_MS);
      expect(hop.duration_ms).toBeLessThanOrEqual(HOP_MAX_MS);
    }
    expect(walk.total_ms).toBe(total);
    expect(computeWalkPlan(prev, next, NO_OPTS).total_ms).toBe(total);
  });
});
