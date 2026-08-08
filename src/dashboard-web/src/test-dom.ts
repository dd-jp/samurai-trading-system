/**
 * The browser APIs `useWalkAnimation` depends on, stubbed for jsdom (issue
 * #595). Test-only — nothing the app renders imports this.
 *
 * ## Why this exists
 *
 * jsdom implements none of the geometry layer the walk animation is built on:
 *
 * | API                      | jsdom       |
 * | ------------------------ | ----------- |
 * | `document.fonts`         | `undefined` |
 * | `ResizeObserver`         | `undefined` |
 * | `window.matchMedia`      | `undefined` |
 * | `getBoundingClientRect`  | all zeros   |
 *
 * The first three mean the code paths that clobbered every walk in a real
 * browser (#595) were structurally unreachable from the test suite. The
 * fourth means *placement* was untestable too: with every rect zero,
 * `pointFor` returns the same `x` for every room, so a placement assertion
 * passes on slot pitch alone and cannot tell a chip in Risk from a chip in
 * the Lobby.
 *
 * ## What it models
 *
 * - **Rects** are derived from the real 4x2 room grid (`ROOM_ORDER`), keyed
 *   off the `data-room` attribute `RoomsGrid` already renders, with the floor
 *   at a deliberately non-zero origin so the `roomRect.left - floorRect.left`
 *   subtraction in `pointFor` is actually exercised.
 * - **`ResizeObserver.observe()` always delivers one initial callback** — per
 *   spec the initial `lastReportedSize` is 0x0, so the first observation
 *   always "changed". It is delivered in a microtask: after layout, before
 *   paint, which is the ordering that made #595 fatal.
 * - **`document.fonts.ready`** is a promise the test controls, so both the
 *   steady state (already resolved, `.then()` runs before the next paint) and
 *   a genuinely late webfont swap can be reproduced.
 * - **`matchMedia`** is live: `setReducedMotion` dispatches a `change` event,
 *   so `usePrefersReducedMotion` is exercised rather than defaulted.
 */

import { CHIP_INSET_X, CHIP_ROW_HEIGHT, CHIP_TOP_OFFSET } from './hooks/useWalkAnimation.ts';
import { ROOM_ORDER, type RoomId } from './lib/room-layout.ts';

/** Columns in the rooms grid — matches `GRID_COLUMNS` in `room-layout.ts`. */
const GRID_COLUMNS = 4;
/** Laid-out room box, in px. Distinct per axis so a row/column mix-up shows up. */
const ROOM_WIDTH = 200;
const ROOM_HEIGHT = 130;
const ROOM_GAP = 20;
/**
 * The floor's own offset in the viewport. Non-zero on purpose: `pointFor`
 * subtracts it from every room rect, and a floor at the origin would let a
 * missing subtraction pass.
 */
const FLOOR_LEFT = 37;
const FLOOR_TOP = 91;

interface Geometry {
  roomWidth: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  const box: Rect = {
    x: left,
    y: top,
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
  };
  return { ...box, toJSON: () => box } as DOMRect;
}

export interface DomHarness {
  /**
   * The point `useWalkAnimation` should place a chip at, computed from this
   * harness's geometry rather than from the hook's — an independent
   * derivation, so a test asserting on it is asserting on real room
   * placement.
   */
  pointFor(room: RoomId, slot: number): { x: number; y: number };
  /** Widen every room and deliver the resulting `ResizeObserver` callback. */
  resizeRoomsTo(roomWidth: number): void;
  /** Deliver a `ResizeObserver` callback reporting the CURRENT (unchanged) size. */
  notifyObservers(): void;
  /** Flip `prefers-reduced-motion` and fire `change` on every live query. */
  setReducedMotion(reduced: boolean): void;
  /** Resolve `document.fonts.ready`, as a late webfont swap does. */
  loadFonts(): void;
  restore(): void;
}

export interface DomHarnessOptions {
  /** `matchMedia('(prefers-reduced-motion: reduce)').matches` at install time. */
  reducedMotion?: boolean;
  /**
   * `'loaded'` (default) is the steady state a 3-second poll re-enters every
   * time: `document.fonts.ready` is already resolved, so `.then()` runs as a
   * microtask before the next paint. `'loading'` leaves it pending until
   * `loadFonts()`.
   */
  fonts?: 'loaded' | 'loading';
}

interface FakeEntry {
  target: Element;
  contentRect: DOMRect;
}

export function installDomHarness(options: DomHarnessOptions = {}): DomHarness {
  const geometry: Geometry = { roomWidth: ROOM_WIDTH };
  const roomIndexById = new Map<RoomId, number>(ROOM_ORDER.map((room, i) => [room, i]));

  const pitch = () => geometry.roomWidth + ROOM_GAP;
  const floorWidth = () => GRID_COLUMNS * pitch() - ROOM_GAP;
  const floorHeight = () => 2 * (ROOM_HEIGHT + ROOM_GAP) - ROOM_GAP;

  const roomRect = (index: number): DOMRect =>
    rect(
      FLOOR_LEFT + (index % GRID_COLUMNS) * pitch(),
      FLOOR_TOP + Math.floor(index / GRID_COLUMNS) * (ROOM_HEIGHT + ROOM_GAP),
      geometry.roomWidth,
      ROOM_HEIGHT,
    );
  const floorRect = (): DOMRect => rect(FLOOR_LEFT, FLOOR_TOP, floorWidth(), floorHeight());

  // --- rects -------------------------------------------------------------
  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function harnessRect(this: Element): DOMRect {
    const room = this.getAttribute('data-room');
    if (room !== null) {
      const index = roomIndexById.get(room as RoomId);
      if (index !== undefined) return roomRect(index);
    }
    if (this.classList.contains('rooms-floor')) return floorRect();
    return originalRect.call(this);
  };

  // --- ResizeObserver ----------------------------------------------------
  const observers = new Set<FakeResizeObserver>();

  class FakeResizeObserver {
    private readonly callback: (entries: FakeEntry[], observer: FakeResizeObserver) => void;
    private readonly targets = new Set<Element>();

    constructor(callback: (entries: FakeEntry[], observer: FakeResizeObserver) => void) {
      this.callback = callback;
      observers.add(this);
    }

    observe(target: Element): void {
      this.targets.add(target);
      // Spec: `observe()` queues an initial observation, because the initial
      // `lastReportedSize` is 0x0 and therefore always "changed". It is
      // delivered during the rendering steps — after layout, before paint.
      queueMicrotask(() => {
        if (!this.targets.has(target)) return;
        this.deliver([target]);
      });
    }

    unobserve(target: Element): void {
      this.targets.delete(target);
    }

    disconnect(): void {
      this.targets.clear();
      observers.delete(this);
    }

    deliver(targets?: readonly Element[]): void {
      const observed = targets ?? [...this.targets];
      const entries = observed.map((target) => ({
        target,
        contentRect: target.getBoundingClientRect(),
      }));
      if (entries.length > 0) this.callback(entries, this);
    }
  }

  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });

  const deliverToAll = () => {
    for (const observer of [...observers]) observer.deliver();
  };

  // --- document.fonts ----------------------------------------------------
  let resolveFonts: () => void = () => {};
  const readyPromise =
    options.fonts === 'loading'
      ? new Promise<void>((resolve) => {
          resolveFonts = resolve;
        })
      : Promise.resolve();
  const fontsStub = {
    status: options.fonts === 'loading' ? 'loading' : 'loaded',
    ready: readyPromise,
  };
  const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: fontsStub as unknown as FontFaceSet,
  });

  // --- matchMedia --------------------------------------------------------
  const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';
  let reduced = options.reducedMotion === true;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const isReduceQuery = query === REDUCE_QUERY;
      const list = {
        get matches() {
          return isReduceQuery && reduced;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          if (isReduceQuery) listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          listeners.delete(listener);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
      return list as unknown as MediaQueryList;
    },
  });

  return {
    pointFor(room, slot) {
      const index = roomIndexById.get(room);
      if (index === undefined) throw new Error(`unknown room: ${room}`);
      const box = roomRect(index);
      const floor = floorRect();
      return {
        x: box.left - floor.left + CHIP_INSET_X,
        y: box.top - floor.top + CHIP_TOP_OFFSET + slot * CHIP_ROW_HEIGHT,
      };
    },
    resizeRoomsTo(roomWidth) {
      geometry.roomWidth = roomWidth;
      deliverToAll();
    },
    notifyObservers: deliverToAll,
    setReducedMotion(next) {
      reduced = next;
      for (const listener of [...listeners]) {
        listener({ matches: next, media: REDUCE_QUERY } as MediaQueryListEvent);
      }
    },
    loadFonts() {
      fontsStub.status = 'loaded';
      resolveFonts();
    },
    restore() {
      Element.prototype.getBoundingClientRect = originalRect;
      observers.clear();
      if (originalResizeObserver === undefined) {
        Reflect.deleteProperty(globalThis, 'ResizeObserver');
      } else {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver);
      }
      if (originalFonts === undefined) Reflect.deleteProperty(document, 'fonts');
      else Object.defineProperty(document, 'fonts', originalFonts);
      if (originalMatchMedia === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    },
  };
}

/**
 * The `style` attribute after every mutation, in order — the recording that
 * proved #595. A `MutationObserver` reports the value BEFORE each mutation,
 * so the sequence of resulting states is `oldValue[1..n]` followed by the
 * attribute's current value.
 *
 * Writes that set a property to the value it already holds produce no
 * mutation record (verified against this jsdom), which is the correct
 * granularity here: what matters is the state the element was left in after
 * each step, not how many assignments produced it.
 */
export interface AttributeLog {
  /** Every state the attribute has held, oldest first. */
  states(): string[];
  stop(): void;
}

export function recordAttribute(element: Element, attribute: string): AttributeLog {
  const olds: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) olds.push(record.oldValue ?? '');
  });
  observer.observe(element, {
    attributes: true,
    attributeFilter: [attribute],
    attributeOldValue: true,
  });
  return {
    states() {
      for (const record of observer.takeRecords()) olds.push(record.oldValue ?? '');
      // `olds[0]` is the state before the first mutation; every later entry is
      // the state the previous mutation produced, and the live attribute is
      // the state the last one produced.
      return [...olds.slice(1), element.getAttribute(attribute) ?? ''];
    },
    stop() {
      observer.disconnect();
    },
  };
}

export function recordStyle(element: Element): AttributeLog {
  return recordAttribute(element, 'style');
}

/** `translate(Xpx, Ypx)` from a recorded style state, or `null` if it carries none. */
export function transformOf(state: string): { x: number; y: number } | null {
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(state);
  if (match === null) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** True when this state has transitions switched off — the teleport signature. */
export function isSnapped(state: string): boolean {
  return /(?:^|;)\s*transition:\s*none/.test(state);
}

/** True when this state carries a per-hop duration — the walk signature. */
export function isAnimated(state: string): boolean {
  return /transition-duration:\s*\d/.test(state);
}
