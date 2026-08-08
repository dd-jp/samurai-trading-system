/**
 * Motion sampling — how this suite tells a chip that WALKED from a chip that
 * ARRIVED (#544, and the reason the ticket exists: #595).
 *
 * Asserting the final room proves nothing; a teleport lands there too. Nor is
 * the `chip-walking` class enough on its own — the pre-#605 bug cancelled the
 * transition without removing the class, so a teleporting build still carried
 * it. The only honest discriminator is the chip's POSITION over time, so a
 * sampler is installed before the page loads and reads the element's box every
 * few milliseconds: a walk leaves dozens of distinct positions across four
 * rooms, a teleport leaves two.
 *
 * Room membership is resolved from `[data-room]` boxes measured in the page at
 * assertion time rather than from grid arithmetic, so the assertions survive
 * the spacing and layout changes #540 owns.
 */
import type { Page } from '@playwright/test';

export interface ChipSample {
  /** Milliseconds since the sampler started. */
  t: number;
  /** A point just inside the chip's top-left corner, in viewport coordinates. */
  x: number;
  y: number;
  walking: boolean;
  settled: boolean;
}

export interface RoomBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Sampling period. 20ms against a 300ms hop is ~15 samples per room-to-room leg. */
const SAMPLE_INTERVAL_MS = 20;

/**
 * Start recording one chip's position. Installed via `addInitScript` so it is
 * running before the first paint — a sampler started after `goto` races the
 * poll it is supposed to observe.
 */
export async function installChipSampler(page: Page, instrument: string): Promise<void> {
  await page.addInitScript(
    ({ instrument, intervalMs }: { instrument: string; intervalMs: number }) => {
      const samples: ChipSample[] = [];
      (window as unknown as { __chipSamples: ChipSample[] }).__chipSamples = samples;
      const started = Date.now();
      setInterval(() => {
        const element = document.querySelector(`[data-instrument="${instrument}"]`);
        if (element === null) return;
        const box = element.getBoundingClientRect();
        samples.push({
          t: Date.now() - started,
          // Inset from the corner so the probe point sits inside the room the
          // chip is standing in rather than on its boundary.
          x: box.left + 4,
          y: box.top + 4,
          walking: element.classList.contains('chip-walking'),
          settled: element.classList.contains('chip-settled'),
        });
      }, intervalMs);
    },
    { instrument, intervalMs: SAMPLE_INTERVAL_MS },
  );
}

export function readChipSamples(page: Page): Promise<ChipSample[]> {
  return page.evaluate(
    () => (window as unknown as { __chipSamples?: ChipSample[] }).__chipSamples ?? [],
  );
}

/** Every room's box, measured now, keyed by `data-room`. */
export function readRoomBoxes(page: Page): Promise<Record<string, RoomBox>> {
  return page.evaluate(() => {
    const boxes: Record<string, RoomBox> = {};
    for (const element of document.querySelectorAll('[data-room]')) {
      const room = element.getAttribute('data-room');
      if (room === null) continue;
      const box = element.getBoundingClientRect();
      boxes[room] = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }
    return boxes;
  });
}

/** The room whose box contains this sample, or `null` while the chip is between rooms. */
export function roomAt(boxes: Record<string, RoomBox>, sample: ChipSample): string | null {
  for (const [room, box] of Object.entries(boxes)) {
    if (
      sample.x >= box.left &&
      sample.x <= box.right &&
      sample.y >= box.top &&
      sample.y <= box.bottom
    ) {
      return room;
    }
  }
  return null;
}

/** How many distinct whole-pixel positions the chip occupied. A teleport gives 2. */
export function distinctPositions(samples: readonly ChipSample[]): number {
  return new Set(samples.map((sample) => `${Math.round(sample.x)},${Math.round(sample.y)}`)).size;
}

/**
 * How close a sample must come to a room's landing point to count as having
 * stood there.
 *
 * Comfortably larger than one sampling interval's worth of travel at the tail
 * of a hop (the transform eases out, so the last 20ms cover a few pixels) and
 * far smaller than the distance between two rooms, so it can neither miss a
 * genuine landing nor be satisfied by a chip merely passing overhead.
 */
export const ANCHOR_TOLERANCE_PX = 24;

export interface Point {
  x: number;
  y: number;
}

/**
 * Where the chip's probe point sits when it stands in `room`, derived from
 * where it came to rest rather than from the app's layout constants.
 *
 * Every hop of one walk is positioned with the SAME slot within its room (the
 * chip's slot in its destination), so the offset inside a room is constant
 * across the walk and one observed resting position fixes all of them. Doing
 * it this way keeps the assertions independent of the chip insets and room
 * padding that #540 owns.
 */
export function anchorFor(
  boxes: Record<string, RoomBox>,
  room: string,
  resting: ChipSample,
  restingRoom: string,
): Point {
  const from = boxes[restingRoom];
  const to = boxes[room];
  if (from === undefined || to === undefined) throw new Error(`no box for room "${room}"`);
  return { x: resting.x + to.left - from.left, y: resting.y + to.top - from.top };
}

/** Did the chip ever stand at this point? */
export function touched(
  samples: readonly ChipSample[],
  point: Point,
  tolerance = ANCHOR_TOLERANCE_PX,
): boolean {
  return samples.some((sample) => Math.hypot(sample.x - point.x, sample.y - point.y) <= tolerance);
}
