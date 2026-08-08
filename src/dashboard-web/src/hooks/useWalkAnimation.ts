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
 * ## Re-placement must not cancel a walk
 *
 * A re-placement snaps — `transition: none`, write the transform, force a
 * reflow — and a snap applied to a chip mid-walk cancels the transition and
 * commits it to wherever the snap put it. Both re-placement triggers fire
 * before the browser's next paint (a `ResizeObserver` always delivers one
 * initial callback on `observe()`; `document.fonts.ready` is already resolved
 * in the steady state, so `.then()` is a microtask), which is why every walk
 * this hook started teleported on a real browser (#595). Pass 2 registers
 * each walking chip with a re-aim callback, and pass 1 calls that instead of
 * snapping: a genuine resize still re-derives the chip's target from the new
 * geometry, it just writes the transform and lets the running transition
 * carry the chip there.
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

// The three geometry constants below are exported for `test-dom.ts`, which
// derives the point a chip SHOULD land on from its own model of the room grid
// (issue #595). Sharing the insets rather than duplicating them keeps that
// harness about room placement — which room a chip stands in — instead of
// silently re-testing three numbers.

/** Chip inset from the room's left edge, in px. Matches `App.css`'s room padding. */
export const CHIP_INSET_X = 10;
/** Distance from the room's top edge to the first chip, in px — clears the heading. */
export const CHIP_TOP_OFFSET = 58;
/** Vertical pitch between stacked chips in one room, in px. */
export const CHIP_ROW_HEIGHT = 28;
/**
 * Grace added to a hop's own duration before the fallback timer fires. A
 * `transitionend` that never arrives (an interrupted transition, a chip moved
 * zero pixels because two rooms happen to align) must not strand the walk.
 */
const TRANSITION_FALLBACK_SLACK_MS = 90;
/** How long the settle ring stays on a chip that changed room without walking. */
export const SETTLE_RING_MS = 1_200;
/**
 * How far the floor must actually move before a `ResizeObserver` delivery
 * counts as a resize, in px. `contentRect` is fractional, so an exact
 * comparison is defeated by sub-pixel oscillation — pinch zoom, an animated
 * sidebar — and would re-place every chip on every delivery.
 */
const RESIZE_EPSILON_PX = 0.5;

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

    /**
     * Chips with a walk in flight, and how to re-aim each one at the room it
     * is currently travelling to under freshly-measured geometry.
     *
     * A re-placement must never SNAP a walking chip: `applyTransform(…,
     * false)` writes `transition: none` and forces a reflow, which commits
     * the chip to its destination and cancels the transition the walk just
     * created. Both re-placement triggers below fire before the browser
     * paints, so on a real browser that cancelled every walk this hook ever
     * started — the whole feature teleported (#595).
     */
    const walking = new Map<HTMLElement, () => void>();

    /**
     * Pass 1 — place every mounted chip where the layout says it stands, and
     * re-aim (never re-place) the ones that are mid-walk.
     */
    const placeAll = () => {
      if (cancelled) return;
      for (const placement of Object.values(layout.chips)) {
        const element = chips.get(placement.instrument);
        if (element === undefined) continue;
        const reaim = walking.get(element);
        if (reaim !== undefined) {
          reaim();
          continue;
        }
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
        let finished = false;
        /**
         * The room this chip is currently travelling to — what a re-measured
         * geometry has to re-aim at. `motion.from` until the first hop
         * starts, which is where the snap above just put it.
         */
        let currentRoom: RoomId = motion.from;
        /**
         * Identifies the hop in flight. `step()` mints a new token; whichever
         * of `transitionend` or the fallback timer consumes it advances the
         * chain, and the other becomes a no-op (#596 item 2). `0` means no
         * hop is in flight.
         */
        let hopToken = 0;
        /**
         * Set once a fallback timer has had to advance a hop. From then on
         * the chain runs on timers alone: a `transitionend` arriving after
         * its own hop's fallback already fired is indistinguishable from the
         * CURRENT hop's, and honouring it advances two hops in one frame
         * (#596 item 2). Timers alone still complete the walk, 90ms per hop
         * slower — well inside the 3-second poll.
         */
        let timerOnly = false;

        /**
         * Re-aim at `currentRoom` under geometry measured now. Writes the
         * transform and nothing else: no `transition: none`, no duration
         * rewrite, so the transition already running simply re-targets and
         * the chip glides to the corrected position instead of snapping.
         */
        const reaim = () => {
          const point = pointFor(currentRoom, placement.slot);
          if (point === null) return;
          element.style.transform = `translate(${point.x}px, ${point.y}px)`;
        };
        walking.set(element, reaim);

        const finish = () => {
          if (finished) return;
          finished = true;
          hopToken = 0;
          if (fallback !== undefined) {
            clearTimeout(fallback);
            fallback = undefined;
          }
          walking.delete(element);
          element.classList.remove('chip-walking');
          element.style.transitionDuration = '';
          element.removeEventListener('transitionend', onTransitionEnd);
        };

        const step = () => {
          if (cancelled || finished) return;
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
          currentRoom = hop.room;
          applyTransform(element, point, true, hop.duration_ms);
          hopToken += 1;
          const token = hopToken;
          const timer = setTimeout(() => {
            // Stale: this hop's `transitionend` already advanced the chain.
            if (token !== hopToken) return;
            timerOnly = true;
            step();
          }, hop.duration_ms + TRANSITION_FALLBACK_SLACK_MS);
          fallback = timer;
          timers.add(timer);
        };

        function onTransitionEnd(event: TransitionEvent) {
          // `transitionend` bubbles, so any descendant that ever transitions
          // `transform` would otherwise advance the hop chain (#596 item 2).
          if (event.target !== element) return;
          // Only the transform transition advances the chain; a chip also
          // transitions opacity when it appears, and letting that event count
          // as a completed hop would run the walk at double speed.
          if (event.propertyName !== 'transform') return;
          // No hop in flight — the walk is over, or this is the tail of the
          // snap that placed the chip at its origin.
          if (hopToken === 0) return;
          if (timerOnly) return;
          // Consume the hop, which makes its fallback timer a no-op.
          hopToken += 1;
          if (fallback !== undefined) {
            clearTimeout(fallback);
            fallback = undefined;
          }
          step();
        }

        element.addEventListener('transitionend', onTransitionEnd);
        teardown.push(finish);
        step();
      }
    }

    /**
     * The floor size the current placement was measured against. `null` until
     * the observer's own first callback reports it: per spec `observe()`
     * ALWAYS delivers one initial observation — the initial `lastReportedSize`
     * is 0x0, so the first measurement always counts as a change — and that
     * delivery lands after layout and before paint. The floor has not moved
     * at that point; the placement pass a few lines up measured it. Treating
     * it as a resize is what let a fresh `observe()` on every poll cancel
     * every walk (#595).
     */
    let placedAgainst: { width: number; height: number } | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const box = entries[entries.length - 1]?.contentRect;
            const size =
              box === undefined
                ? { width: floor.clientWidth, height: floor.clientHeight }
                : { width: box.width, height: box.height };
            if (placedAgainst === null) {
              placedAgainst = size;
              return;
            }
            // `placedAgainst` is only advanced when a delivery actually
            // re-places, so drift is always measured against the size the
            // current placement was derived from and accumulates across
            // sub-epsilon deliveries until it crosses the threshold.
            if (
              Math.abs(size.width - placedAgainst.width) < RESIZE_EPSILON_PX &&
              Math.abs(size.height - placedAgainst.height) < RESIZE_EPSILON_PX
            ) {
              return;
            }
            placedAgainst = size;
            // A genuine container resize DOES have to re-derive geometry: the
            // rooms moved, so every chip's target moved with them, including
            // the ones mid-walk. `placeAll` re-aims those rather than snapping.
            placeAll();
          });
    observer?.observe(floor);

    // There is deliberately no `window` resize listener beside the observer.
    // Any window resize that moves the floor resizes it, so the observer
    // already covers that case with a guard the window event cannot share:
    // `placedAgainst` holds content-box dimensions, and what a window handler
    // could cheaply read (`clientWidth`) includes padding, so a size check
    // there would misfire rather than suppress. Unguarded it was worse — a
    // mobile URL-bar collapse fires `resize` with no geometry change at all
    // and force-reflowed every non-walking chip for nothing. Where
    // `ResizeObserver` is missing entirely, the next poll re-enters this
    // effect (`layout` is recomputed per snapshot) and re-places anyway.

    // A late webfont swap reflows the rooms after the first measurement, and
    // no resize event fires for it. Only subscribe when the fonts have NOT
    // finished loading: in the steady state this hook re-enters every 3
    // seconds `ready` is already resolved, so `.then()` is just a microtask
    // that re-places every chip before the next paint — for no reason, and
    // it cancelled the walk the same effect had just started (#595).
    const fonts = document.fonts;
    if (fonts !== undefined && fonts.status !== 'loaded') {
      void fonts.ready.then(() => placeAll());
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const timer of timers) clearTimeout(timer);
      // Motion rule 9: a new poll mid-walk wins. Outstanding hops are
      // cancelled here and the next effect's placement pass snaps every chip
      // to the observed state before any new walk starts.
      for (const undo of teardown) undo();
    };
  }, [layout, plan, reducedMotion, firstPaint, floorRef, roomRefs, chipRefs]);
}
