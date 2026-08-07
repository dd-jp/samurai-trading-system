/**
 * The only DOM-imperative code in this app (issue #538; dashboard-spec.md
 * "Module: Web client", Motion rules 1-10). It takes a `WalkPlan` — a pure
 * function of two snapshots, computed in `lib/walk-plan.ts` — and applies it
 * to chip elements as `transform: translate()` transitions.
 *
 * ## Two passes, in this order, every time
 *
 * 1. **Place every mounted chip** at its laid-out room, with transitions off.
 *    Not just the chips the plan mentions: `computeWalkPlan` deliberately
 *    emits no motion for a lane that did not change room, and a chip that
 *    mounted this poll (an instrument that came back from behind a room's
 *    "+N" collapse, or the first paint) has no inline transform at all. A
 *    plan-only pass leaves those chips stacked at the grid's top-left corner.
 * 2. **Replay the walks on top**, each chip snapped back to its `from` room
 *    and then hopped forward through the plan's recorded rooms.
 *
 * The same placement pass is what handles a resize, a late font swap and a
 * hidden-tab return: all three re-place without animating.
 *
 * ## No `requestAnimationFrame`
 *
 * Motion rule 10, and a prototyping finding rather than a preference: rAF
 * never fired in the sandboxed artifact frame, and a page whose chips only
 * appear if a frame callback runs is a page that can render empty. Hops chain
 * on `transitionend` with a `setTimeout` fallback, and the forced-reflow read
 * (`offsetWidth`) used to commit a snap is a synchronous layout query, not a
 * frame callback.
 */

import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { RoomId, RoomsLayout } from '../lib/room-layout.ts';
import type { WalkPlan } from '../lib/walk-plan.ts';

/** Chip inset from the room's left edge, in px. Matches `App.css`'s room padding. */
const CHIP_INSET_X = 10;
/** Distance from the room's top edge to the first chip, in px — clears the heading. */
const CHIP_TOP_OFFSET = 58;
/** Vertical pitch between stacked chips in one room, in px. */
const CHIP_ROW_HEIGHT = 28;
/**
 * Grace added to a hop's own duration before the fallback timer fires. A
 * `transitionend` that never arrives (an interrupted transition, a chip moved
 * zero pixels because two rooms happen to align) must not strand the walk.
 */
const TRANSITION_FALLBACK_SLACK_MS = 90;
/** How long the settle ring stays on a chip that changed room without walking. */
export const SETTLE_RING_MS = 1_200;

export interface WalkAnimationInput {
  /**
   * This poll's plan, or `null` before the first snapshot. Its identity is
   * what re-runs the hook: the plan is memoized per successful poll, so a new
   * object here means new data, and an unrelated re-render (a selection
   * change) does not re-place or re-animate anything.
   */
  plan: WalkPlan | null;
  /** Where every chip stands after this poll. Drives the placement pass. */
  layout: RoomsLayout;
  /** Motion rule 5: snap and show a settle ring, never travel. */
  reducedMotion: boolean;
  /** Motion rule 3: the first paint places without walking AND without rings. */
  firstPaint: boolean;
  floorRef: RefObject<HTMLElement | null>;
  roomRefs: RefObject<Map<RoomId, HTMLElement>>;
  chipRefs: RefObject<Map<string, HTMLElement>>;
}

interface Point {
  x: number;
  y: number;
}

function applyTransform(element: HTMLElement, point: Point, animate: boolean, durationMs?: number) {
  if (!animate) {
    element.style.transition = 'none';
    element.style.transform = `translate(${point.x}px, ${point.y}px)`;
    // Read layout back to commit the transform under `transition: none`
    // before the transition property is restored — otherwise the browser
    // coalesces both writes into one style recalculation and animates the
    // snap. This is a synchronous layout query, not a frame callback.
    void element.offsetWidth;
    element.style.transition = '';
    element.style.transitionDuration = '';
    return;
  }
  if (durationMs !== undefined) element.style.transitionDuration = `${durationMs}ms`;
  element.style.transform = `translate(${point.x}px, ${point.y}px)`;
}

export function useWalkAnimation(input: WalkAnimationInput): void {
  const { plan, layout, reducedMotion, firstPaint, floorRef, roomRefs, chipRefs } = input;

  /** Where each chip was last placed — the comparison a settle ring needs. */
  const lastRooms = useRef<Map<string, RoomId>>(new Map());

  useLayoutEffect(() => {
    const floor = floorRef.current;
    const rooms = roomRefs.current;
    const chips = chipRefs.current;
    if (floor === null || rooms === null || chips === null) return;

    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const teardown: (() => void)[] = [];

    const pointFor = (room: RoomId, slot: number): Point | null => {
      const roomElement = rooms.get(room);
      if (roomElement === undefined) return null;
      const roomRect = roomElement.getBoundingClientRect();
      const floorRect = floor.getBoundingClientRect();
      return {
        x: roomRect.left - floorRect.left + CHIP_INSET_X,
        y: roomRect.top - floorRect.top + CHIP_TOP_OFFSET + slot * CHIP_ROW_HEIGHT,
      };
    };

    /** Pass 1 — place every mounted chip where the layout says it stands. */
    const placeAll = () => {
      if (cancelled) return;
      for (const placement of Object.values(layout.chips)) {
        const element = chips.get(placement.instrument);
        if (element === undefined) continue;
        const point = pointFor(placement.room, placement.slot);
        if (point === null) continue;
        applyTransform(element, point, false);
      }
    };

    placeAll();

    /**
     * Settle rings, from the placement pass rather than from the plan: the
     * question a ring answers is "did this chip change room", and only the
     * previous placement can answer it. Skipped on first paint (nothing
     * changed — the page just appeared) and for a snap into the Lobby, which
     * is a trace ageing out of the 15-minute window: the clock passing, not
     * something the system did (Motion rule 8).
     */
    const noRing = new Set<string>();
    for (const motion of plan?.motions ?? []) {
      // Rule 8: a snap into the Lobby is a trace ageing out of the window.
      if (motion.kind === 'snap' && motion.room === 'lobby') noRing.add(motion.instrument);
      // A chip that is about to walk shows the change by walking; ringing it
      // as well would double-signal the one event the replay already tells.
      if (motion.kind === 'walk' && !reducedMotion) noRing.add(motion.instrument);
    }
    const nextRooms = new Map<string, RoomId>();
    for (const placement of Object.values(layout.chips)) {
      nextRooms.set(placement.instrument, placement.room);
      const previousRoom = lastRooms.current.get(placement.instrument);
      const element = chips.get(placement.instrument);
      if (element === undefined) continue;
      const changed = previousRoom !== undefined && previousRoom !== placement.room;
      if (firstPaint || !changed || noRing.has(placement.instrument)) continue;
      element.classList.add('chip-settled');
      const timer = setTimeout(() => element.classList.remove('chip-settled'), SETTLE_RING_MS);
      timers.add(timer);
      teardown.push(() => element.classList.remove('chip-settled'));
    }
    lastRooms.current = nextRooms;

    /** Pass 2 — replay the recorded walks. Suppressed entirely under rule 5. */
    if (plan !== null && !reducedMotion) {
      for (const motion of plan.motions) {
        // `appear` and `depart` are the renderer's fade, not this hook's:
        // React mounts and unmounts those chips, and a departed chip has no
        // element left to translate.
        if (motion.kind !== 'walk') continue;
        const element = chips.get(motion.instrument);
        if (element === undefined) continue;
        const placement = layout.chips[motion.instrument];
        if (placement === undefined) continue;
        const origin = pointFor(motion.from, placement.slot);
        if (origin === null) continue;

        applyTransform(element, origin, false);
        element.classList.add('chip-walking');

        let index = 0;
        let fallback: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          element.classList.remove('chip-walking');
          element.style.transitionDuration = '';
          element.removeEventListener('transitionend', onTransitionEnd);
        };

        const step = () => {
          if (cancelled) return;
          const hop = motion.hops[index];
          index += 1;
          if (hop === undefined) {
            finish();
            return;
          }
          const point = pointFor(hop.room, placement.slot);
          if (point === null) {
            finish();
            return;
          }
          applyTransform(element, point, true, hop.duration_ms);
          fallback = setTimeout(step, hop.duration_ms + TRANSITION_FALLBACK_SLACK_MS);
          timers.add(fallback);
        };

        function onTransitionEnd(event: TransitionEvent) {
          // Only the transform transition advances the chain; a chip also
          // transitions opacity when it appears, and letting that event count
          // as a completed hop would run the walk at double speed.
          if (event.propertyName !== 'transform') return;
          if (fallback !== undefined) clearTimeout(fallback);
          step();
        }

        element.addEventListener('transitionend', onTransitionEnd);
        teardown.push(() => {
          if (fallback !== undefined) clearTimeout(fallback);
          finish();
        });
        step();
      }
    }

    // Re-place (never re-animate) whenever the geometry the placement was
    // measured against can have moved underneath it.
    const onResize = () => placeAll();
    window.addEventListener('resize', onResize);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => placeAll());
    observer?.observe(floor);
    // A late webfont swap reflows the rooms after the first measurement, and
    // no resize event fires for it.
    void document.fonts?.ready.then(() => placeAll());

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      for (const timer of timers) clearTimeout(timer);
      // Motion rule 9: a new poll mid-walk wins. Outstanding hops are
      // cancelled here and the next effect's placement pass snaps every chip
      // to the observed state before any new walk starts.
      for (const undo of teardown) undo();
    };
  }, [layout, plan, reducedMotion, firstPaint, floorRef, roomRefs, chipRefs]);
}
