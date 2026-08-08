// @vitest-environment jsdom
//
// The walk animation, tested against a browser-shaped DOM (issue #595).
//
// `App.test.tsx` drives the real composition root through its poller, which
// is the right instrument for everything except this: at a 20ms test poll the
// NEXT poll tears the walk down (Motion rule 9) before any assertion about it
// can run, and lengthening the interval makes every test multi-second. So the
// walk tests below mount `Theater` — the same derivation chain App performs,
// with the polling replaced by an explicit rerender — and the reduced-motion
// test at the bottom uses the real `App`, where there is no walk to be torn
// down and App's own wiring is what needs proving.
//
// Every test here installs `test-dom.ts`, without which none of this code is
// reachable: jsdom has no `ResizeObserver`, no `document.fonts`, no
// `matchMedia`, and returns an all-zero rect for every element.

import { render, screen, waitFor } from '@testing-library/react';
import { act, useMemo, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PipelineView } from '../../../dashboard/pipeline-types.ts';
import { App } from '../App.tsx';
import { RoomsGrid } from '../components/RoomsGrid.tsx';
import { computeLayout, type RoomId } from '../lib/room-layout.ts';
import { doneThrough, makeLane, makeView } from '../lib/test-support.ts';
import { computeWalkPlan, type WalkPlan } from '../lib/walk-plan.ts';
import {
  type DomHarness,
  type DomHarnessOptions,
  installDomHarness,
  isAnimated,
  isSnapped,
  recordAttribute,
  recordStyle,
  transformOf,
} from '../test-dom.ts';
import { fakeFetch, makeSnapshot } from '../test-fixtures.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';
import { useWalkAnimation } from './useWalkAnimation.ts';

/**
 * Recorded stages 50ms apart. Every gap is below `HOP_MIN_MS`, so every hop
 * lands on the 150ms floor and a four-hop walk finishes in well under a
 * second of real time — these tests run on real timers because the hop chain
 * is driven by `setTimeout` and `transitionend`, both of which a fake clock
 * would have to stand in for anyway.
 */
const STEP_MS = 50;
const INSTRUMENT = 'BTC-USD';

function laneReaching(stage: Parameters<typeof doneThrough>[2]): PipelineView {
  return makeView([doneThrough(INSTRUMENT, 'trace-btc', stage, { stepMs: STEP_MS })]);
}

/** Analysts → Debate: the single-stage advance a 3-second poll usually produces. */
const AT_ANALYSTS = laneReaching('analysts');
const AT_DEBATE = laneReaching('debate');
/** Analysts → Risk: four hops, the case that animated BACKWARDS on main. */
const AT_RISK = laneReaching('risk');

interface TheaterProps {
  view: PipelineView;
  previous: PipelineView | null;
  firstPaint: boolean;
  /**
   * The plan this render derived. Exposed because the DOM cannot answer the
   * reduced-motion question: a plan that degraded to snaps and a plan that
   * still contains a `walk` the hook then suppressed leave IDENTICAL markup
   * — chip placed, no walking class, no duration write. Only the plan itself
   * distinguishes the two halves of the wiring.
   */
  onPlan?: (plan: WalkPlan) => void;
}

/**
 * App's derivation chain with the poller removed: layout, plan and the walk
 * hook, over the real `RoomsGrid`. `usePrefersReducedMotion` is included
 * because the planner's `snapOnly` reads it, and that wiring is part of what
 * these tests cover.
 */
function Theater({ view, previous, firstPaint, onPlan }: TheaterProps) {
  const reducedMotion = usePrefersReducedMotion();
  const layout = useMemo(() => computeLayout(view), [view]);
  const plan = useMemo(
    () => computeWalkPlan(previous, view, { firstPaint, snapOnly: reducedMotion }),
    [previous, view, firstPaint, reducedMotion],
  );
  onPlan?.(plan);

  const floorRef = useRef<HTMLDivElement | null>(null);
  const roomRefs = useRef<Map<RoomId, HTMLElement>>(new Map());
  const chipRefs = useRef<Map<string, HTMLElement>>(new Map());

  useWalkAnimation({ plan, layout, reducedMotion, firstPaint, floorRef, roomRefs, chipRefs });

  return (
    <RoomsGrid
      view={view}
      layout={layout}
      selectedInstrument={null}
      onSelect={() => {}}
      floorRef={floorRef}
      registerRoomRef={(room, element) => {
        if (element === null) roomRefs.current.delete(room);
        else roomRefs.current.set(room, element);
      }}
      registerChipRef={(instrument, element) => {
        if (element === null) chipRefs.current.delete(instrument);
        else chipRefs.current.set(instrument, element);
      }}
    />
  );
}

let harness: DomHarness;

function useHarness(options: DomHarnessOptions = {}) {
  harness = installDomHarness(options);
}

afterEach(() => {
  harness?.restore();
});

function chip(instrument = INSTRUMENT): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-instrument="${instrument}"]`);
  if (element === null) throw new Error(`no chip for ${instrument}`);
  return element;
}

/** Let queued microtasks (the `observe()` callback, `fonts.ready`) run. */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

interface Point {
  x: number;
  y: number;
}

/** The planned walk, plus the points this harness's geometry puts it through. */
function plannedWalk(previous: PipelineView, next: PipelineView) {
  const plan = computeWalkPlan(previous, next, { firstPaint: false, snapOnly: false });
  const motion = plan.motions.find((m) => m.kind === 'walk' && m.instrument === INSTRUMENT);
  if (motion === undefined || motion.kind !== 'walk') throw new Error('no walk was planned');
  const placement = computeLayout(next).chips[INSTRUMENT];
  if (placement === undefined) throw new Error('no placement for the walking chip');
  return {
    hops: motion.hops,
    slot: placement.slot,
    origin: harness.pointFor(motion.from, placement.slot),
    points: motion.hops.map((hop) => harness.pointFor(hop.room, placement.slot)),
  };
}

/** The distinct positions a recorded style trace passed through, in order. */
function trail(states: readonly string[]): Point[] {
  const path: Point[] = [];
  for (const state of states) {
    const point = transformOf(state);
    if (point === null) continue;
    const last = path[path.length - 1];
    if (last !== undefined && last.x === point.x && last.y === point.y) continue;
    path.push(point);
  }
  return path;
}

/** Index of the first state that carries a per-hop duration: the walk starting. */
function walkStartsAt(states: readonly string[]): number {
  const index = states.findIndex(isAnimated);
  expect(index, 'no animated write — the walk never started').toBeGreaterThanOrEqual(0);
  return index;
}

describe('useWalkAnimation — re-placement must not cancel the walk (#595)', () => {
  beforeEach(() => {
    useHarness();
  });

  it('runs a 1-hop walk to its destination with no snap after it starts', async () => {
    const walk = plannedWalk(AT_ANALYSTS, AT_DEBATE);
    expect(walk.hops).toHaveLength(1);

    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    const log = recordStyle(chip());
    view.rerender(<Theater view={AT_DEBATE} previous={AT_ANALYSTS} firstPaint={false} />);
    // `observe()`'s initial callback and `fonts.ready` both land here, before
    // the browser would have painted the walk's first frame.
    await flushMicrotasks();

    const started = walkStartsAt(log.states());
    // The finding, stated as an invariant: once the walk has started, nothing
    // may write `transition: none` — that commits the chip to wherever the
    // write puts it and cancels the transition, which is the teleport.
    expect(
      log
        .states()
        .slice(started + 1)
        .filter(isSnapped),
    ).toEqual([]);

    await waitFor(
      () => expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[0]),
      { timeout: 2_000 },
    );
    // Snap to the origin, then travel to the one hop — and nothing else.
    expect(trail(log.states().slice(started))).toEqual([walk.origin, ...walk.points]);
    log.stop();
  });

  it('runs a 4-hop walk forwards through every room, never backwards', async () => {
    const walk = plannedWalk(AT_ANALYSTS, AT_RISK);
    expect(walk.hops.map((hop) => hop.room)).toEqual(['debate', 'trader', 'invalidation', 'risk']);

    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    const log = recordStyle(chip());
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    await flushMicrotasks();

    const started = walkStartsAt(log.states());
    expect(
      log
        .states()
        .slice(started + 1)
        .filter(isSnapped),
    ).toEqual([]);

    await waitFor(
      () => expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[3]),
      { timeout: 3_000 },
    );

    const path = trail(log.states().slice(started));
    // On main this read [analysts, debate, RISK, trader, invalidation, risk]:
    // the re-placement snapped the chip to its destination, then the fallback
    // timer walked it back to hop 1 and forwards again.
    expect(path).toEqual([walk.origin, ...walk.points]);
    // Said the other way round, because it is the symptom the issue reports:
    // the chip reaches Risk once, at the END. On main it arrived there first
    // and then animated backwards to Trader.
    const destination = walk.points[3];
    expect(path.at(-1)).toEqual(destination);
    expect(
      path.filter((point) => point.x === destination?.x && point.y === destination?.y),
    ).toHaveLength(1);
    log.stop();
  });

  it('does not treat the ResizeObserver initial callback as a resize', async () => {
    render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    // Recording starts AFTER the placement pass, so anything captured here was
    // written by the `observe()` callback that lands one microtask later.
    const log = recordStyle(chip());
    await flushMicrotasks();

    // `states()` always reports the current value, so one entry means no write.
    expect(log.states()).toHaveLength(1);
    log.stop();
  });

  it('ignores a later delivery that reports the size already placed against', async () => {
    render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    // Let the initial observation land first, so the delivery below is an
    // ordinary one — the case a resize-less `resize` event produces on mobile,
    // where the URL bar collapses and the floor does not move at all.
    await flushMicrotasks();
    const log = recordStyle(chip());
    harness.notifyObservers();

    // `states()` always reports the current value, so one entry means no write.
    expect(log.states()).toHaveLength(1);
    log.stop();
  });

  it('ignores sub-pixel jitter, then re-places once the drift accumulates', async () => {
    const placement = computeLayout(AT_ANALYSTS).chips[INSTRUMENT];
    if (placement === undefined) throw new Error('no placement for the chip');

    render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    await flushMicrotasks();
    const log = recordStyle(chip());
    const placed = chip().getAttribute('style');

    // Four columns, so +0.1px of room is +0.4px of floor: under the threshold,
    // and a `contentRect` comparison by `===` would have re-placed on it.
    harness.resizeRoomsTo(200.1);
    expect(chip().getAttribute('style')).toBe(placed);
    expect(log.states()).toHaveLength(1);

    // Drift is measured against the size the placement was derived from, not
    // against the previous delivery, so the next nudge is +0.8px of floor and
    // does cross — jitter is ignored without the guard going deaf.
    harness.resizeRoomsTo(200.2);
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(
      harness.pointFor(placement.room, placement.slot),
    );
    log.stop();
  });

  it('does not re-place on a window resize that moved nothing', async () => {
    render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    await flushMicrotasks();
    const log = recordStyle(chip());

    // A mobile URL-bar collapse fires `resize` with no geometry change at all.
    // The floor observer is the only re-placement trigger and it stays silent;
    // a `window` listener beside it could not share the observer's guard
    // (`placedAgainst` is content-box, `clientWidth` is not) and would
    // force-reflow every non-walking chip for nothing. A resize that DOES move
    // the rooms still re-places — the jitter test above and the re-aim test
    // below assert that half.
    window.dispatchEvent(new Event('resize'));

    // `states()` always reports the current value, so one entry means no write.
    expect(log.states()).toHaveLength(1);
    log.stop();
  });

  it('re-aims a walking chip at a genuine resize instead of snapping it', async () => {
    const walk = plannedWalk(AT_ANALYSTS, AT_RISK);
    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    const log = recordStyle(chip());
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    // Let the initial observation land, so the next delivery is a real change.
    await flushMicrotasks();

    const started = walkStartsAt(log.states());
    harness.resizeRoomsTo(320);

    // The rooms moved, so the chip's target moved with them: it must now be
    // aimed at hop 0's room under the NEW geometry...
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(
      harness.pointFor('debate', walk.slot),
    );
    // ...and it must have got there by writing a transform, not by snapping.
    expect(
      log
        .states()
        .slice(started + 1)
        .filter(isSnapped),
    ).toEqual([]);
    expect(chip().classList.contains('chip-walking')).toBe(true);
    log.stop();
  });

  it('survives a webfont that finishes loading mid-walk', async () => {
    harness.restore();
    useHarness({ fonts: 'loading' });
    const walk = plannedWalk(AT_ANALYSTS, AT_RISK);

    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    const log = recordStyle(chip());
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    await flushMicrotasks();

    const started = walkStartsAt(log.states());
    harness.loadFonts();
    await flushMicrotasks();

    expect(
      log
        .states()
        .slice(started + 1)
        .filter(isSnapped),
    ).toEqual([]);
    await waitFor(
      () => expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[3]),
      { timeout: 3_000 },
    );
    expect(trail(log.states().slice(started))).toEqual([walk.origin, ...walk.points]);
    log.stop();
  });
});

describe('useWalkAnimation — transitionend guards (#596 item 2)', () => {
  beforeEach(() => {
    useHarness();
  });

  function transitionEnd(target: Element): void {
    target.dispatchEvent(
      new TransitionEvent('transitionend', { bubbles: true, propertyName: 'transform' }),
    );
  }

  it('ignores a transform transitionend that bubbled up from a descendant', async () => {
    const walk = plannedWalk(AT_ANALYSTS, AT_RISK);
    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    await flushMicrotasks();

    const callsign = chip().querySelector('.chip-callsign');
    expect(callsign).not.toBeNull();
    transitionEnd(callsign as Element);

    // Still travelling to hop 0. `transitionend` bubbles, and a descendant
    // that ever transitions `transform` would otherwise advance the chain.
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[0]);
  });

  it('ignores a late transitionend once the fallback timer has advanced the hop', async () => {
    const walk = plannedWalk(AT_ANALYSTS, AT_RISK);
    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    await flushMicrotasks();

    // jsdom fires no `transitionend`, so hop 0 is advanced by its fallback
    // timer — exactly the janked-tab case #596 describes.
    await waitFor(
      () => expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[1]),
      { timeout: 2_000 },
    );

    // Hop 0's `transitionend`, arriving after its own fallback already fired.
    transitionEnd(chip());
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[1]);

    // And the chain still completes, on timers.
    await waitFor(
      () => expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(walk.points[3]),
      { timeout: 3_000 },
    );
    await waitFor(() => expect(chip().classList.contains('chip-walking')).toBe(false), {
      timeout: 2_000,
    });
  });
});

describe('useWalkAnimation — room placement is real geometry (#595)', () => {
  beforeEach(() => {
    useHarness();
  });

  it('puts a chip in Risk at a different x from a chip in the Lobby', async () => {
    const inRisk = doneThrough('AAA', 'trace-a', 'risk', { outcome: 'stopped' });
    const idle = makeLane({ instrument: 'BBB' });
    const view = makeView([inRisk, idle]);
    expect(computeLayout(view).chips.BBB?.room).toBe('lobby');

    render(<Theater view={view} previous={null} firstPaint={true} />);
    await flushMicrotasks();

    const risk = transformOf(chip('AAA').getAttribute('style') ?? '');
    const lobby = transformOf(chip('BBB').getAttribute('style') ?? '');
    // Room 05 sits on the grid's second row, second column; the Lobby is
    // first row, first column. Different x AND different y — the assertion
    // PR #591 could not make, because every jsdom rect is zero and both
    // chips resolved to the same point plus slot pitch.
    expect(risk).toEqual(harness.pointFor('risk', 0));
    expect(lobby).toEqual(harness.pointFor('lobby', 0));
    expect(risk?.x).not.toBe(lobby?.x);
    expect(risk?.y).not.toBe(lobby?.y);
  });

  it('stacks two chips in one room by slot, measured from that room rect', async () => {
    const first = doneThrough('AAA', 'trace-a', 'risk', { outcome: 'stopped' });
    const second = doneThrough('BBB', 'trace-b', 'risk', { outcome: 'stopped' });
    render(<Theater view={makeView([first, second])} previous={null} firstPaint={true} />);
    await flushMicrotasks();

    expect(transformOf(chip('AAA').getAttribute('style') ?? '')).toEqual(
      harness.pointFor('risk', 0),
    );
    expect(transformOf(chip('BBB').getAttribute('style') ?? '')).toEqual(
      harness.pointFor('risk', 1),
    );
  });
});

describe('usePrefersReducedMotion → the planner and the hook (#595)', () => {
  it('snaps instead of walking, all the way through the real App', async () => {
    useHarness({ reducedMotion: true });
    const POLL_MS = 150;
    render(
      <App
        snapshotOptions={{
          fetchImpl: fakeFetch([
            makeSnapshot({ pipeline: AT_ANALYSTS }),
            makeSnapshot({
              pipeline: AT_RISK,
              as_of: '2026-08-07T12:00:03.000Z',
              generated_at: '2026-08-07T12:00:03.000Z',
            }),
          ]),
          intervalMs: POLL_MS,
        }}
      />,
    );

    await screen.findByRole('button', { name: /BTC-USD, crypto, in flight, in Analysts/ });
    const styleLog = recordStyle(chip());
    const classLog = recordAttribute(chip(), 'class');

    // The second poll lands: same lane, four rooms further on.
    await screen.findByText('12:00:03Z');
    await flushMicrotasks();

    // `computeWalkPlan` got `snapOnly` (no walk was planned) AND the hook
    // suppressed pass 2 — between them, nothing animated and no chip ever
    // carried the walking class.
    expect(styleLog.states().filter(isAnimated)).toEqual([]);
    expect(classLog.states().filter((state) => state.includes('chip-walking'))).toEqual([]);
    // The chip is in Risk, it just got there without travelling.
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(harness.pointFor('risk', 0));
    styleLog.stop();
    classLog.stop();
  });

  it('degrades the PLAN to snaps, not just the hook to silence (rule 5)', async () => {
    useHarness({ reducedMotion: true });
    const plans: WalkPlan[] = [];
    const onPlan = (plan: WalkPlan) => plans.push(plan);
    const view = render(
      <Theater view={AT_ANALYSTS} previous={null} firstPaint={true} onPlan={onPlan} />,
    );
    view.rerender(
      <Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} onPlan={onPlan} />,
    );
    await flushMicrotasks();

    // Without reduced motion this poll is a four-hop walk (the tests above run
    // exactly it). `usePrefersReducedMotion` reached `computeWalkPlan`, so the
    // planner emitted a snap — the half no DOM assertion can see.
    const last = plans.at(-1);
    expect(last?.motions.map((motion) => motion.kind)).toEqual(['snap']);
    expect(last?.total_ms).toBe(0);
    // And the hook's own rule-5 half: snap into place, wear the settle ring.
    expect(chip().classList.contains('chip-walking')).toBe(false);
    expect(chip().classList.contains('chip-settled')).toBe(true);
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(harness.pointFor('risk', 0));
  });

  it('snaps an in-flight walk when reduced motion turns on mid-session', async () => {
    // The flip test below sequences the flip BEFORE the walk starts, so the
    // hook's `walking` map is empty and no in-flight teardown runs. Here the
    // chip is mid-hop when the OS setting changes, which is the case rule 5
    // has to survive: the walk is torn down, not left running.
    useHarness();
    const view = render(<Theater view={AT_ANALYSTS} previous={null} firstPaint={true} />);
    const log = recordStyle(chip());
    view.rerender(<Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} />);
    await flushMicrotasks();

    walkStartsAt(log.states());
    expect(chip().classList.contains('chip-walking')).toBe(true);

    await act(async () => {
      harness.setReducedMotion(true);
    });

    // `finish()` ran from the effect's teardown: the walking class is off and
    // the pending hop's fallback timer is cleared, so the chip stands where
    // the layout says instead of travelling the rest of the way there.
    expect(chip().classList.contains('chip-walking')).toBe(false);
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(harness.pointFor('risk', 0));
    log.stop();
  });

  it('degrades a session that starts with motion allowed and flips mid-run', async () => {
    // The install-time reads above never exercise the `change` subscription:
    // a user turning reduced motion on while the dashboard is open is a live
    // event, and the plan has to follow it without a remount.
    useHarness({ reducedMotion: false });
    const plans: WalkPlan[] = [];
    const onPlan = (plan: WalkPlan) => plans.push(plan);
    const view = render(
      <Theater view={AT_ANALYSTS} previous={null} firstPaint={true} onPlan={onPlan} />,
    );
    await flushMicrotasks();

    act(() => {
      harness.setReducedMotion(true);
    });
    view.rerender(
      <Theater view={AT_RISK} previous={AT_ANALYSTS} firstPaint={false} onPlan={onPlan} />,
    );
    await flushMicrotasks();

    // Same poll that walks four hops when motion is allowed.
    const last = plans.at(-1);
    expect(last?.motions.map((motion) => motion.kind)).toEqual(['snap']);
    expect(last?.total_ms).toBe(0);
    expect(chip().classList.contains('chip-walking')).toBe(false);
    expect(transformOf(chip().getAttribute('style') ?? '')).toEqual(harness.pointFor('risk', 0));
  });
});
