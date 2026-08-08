/**
 * The replay walk (#544 scenarios 3 and 7) — the reason this suite exists.
 *
 * #595 shipped a dashboard whose chips TELEPORTED: a `ResizeObserver` first
 * delivery and a resolved `document.fonts.ready` both re-placed every chip
 * before the next paint, which cancelled the transition the walk had just
 * started. Every unit test passed, because jsdom has neither API.
 *
 * So this file does not assert that the chip ends up in the right room — a
 * teleport does that too — and it does not rest on the `chip-walking` class,
 * which the broken build still carried after its transition was cancelled. It
 * samples the chip's position every 20ms and asserts it STOOD at each recorded
 * room on the way: many distinct positions, a landing at trader, risk and
 * verdict, and never a landing at invalidation, whose row was never recorded.
 *
 * Seam: `page.route` over the harness server's own payload, because the
 * scenario is a sequence — poll 1 in flight at Debate, poll 2 settled at
 * Execution on the SAME trace.
 */
import {
  anchorFor,
  distinctPositions,
  installChipSampler,
  readChipSamples,
  readRoomBoxes,
  roomAt,
  touched,
} from './support/motion.ts';
import { fetchSnapshot, serveSequence } from './support/poll.ts';
import { laneOf, SKIPPED_ROOM, settleAtExecution, WALKED_ROOMS } from './support/snapshot.ts';
import { expect, test } from './support/test.ts';

const WALKER = 'SPY';
const LIVE_CHIP = 'SPY, stocks, in flight, in Debate';
const SETTLED_CHIP = 'SPY, stocks, go, in Execution';

/** The walk is 4 hops x 300ms; this leaves the sampler room either side of it. */
const WALK_OBSERVATION_MS = 2_500;

/**
 * Drives one snapshot-to-snapshot transition and returns everything the
 * assertions need: the sampled path, the room boxes and the resting sample.
 */
async function observeTransition(page: import('@playwright/test').Page) {
  await expect(page.getByRole('button', { name: LIVE_CHIP })).toBeVisible();
  // The accessible name flips the instant the second snapshot renders — which
  // is when the walk STARTS, not when it ends.
  await expect(page.getByRole('button', { name: SETTLED_CHIP })).toBeVisible({ timeout: 15_000 });
  // A fixed wait, deliberately: the thing under test is a time-boxed
  // animation, and there is no event that means "the replay is over".
  await page.waitForTimeout(WALK_OBSERVATION_MS);

  const samples = await readChipSamples(page);
  const boxes = await readRoomBoxes(page);
  const resting = samples[samples.length - 1];
  expect(resting, 'the sampler recorded nothing').toBeDefined();
  return { samples, boxes, resting: resting as NonNullable<typeof resting> };
}

test('replay walk: the chip walks its recorded rooms and never enters the skipped one', async ({
  page,
  request,
}) => {
  const base = await fetchSnapshot(request);
  const settled = settleAtExecution(base, WALKER);
  expect(laneOf(settled, WALKER).trace_id).toBe(laneOf(base, WALKER).trace_id);

  await installChipSampler(page, WALKER);
  await serveSequence(page, [base, settled]);
  await page.goto('/');

  const { samples, boxes, resting } = await observeTransition(page);

  expect(roomAt(boxes, resting), 'the chip finished in Execution').toBe('execution');

  // THE teleport check. A transitioned walk leaves one position per sampled
  // frame; a cancelled transition leaves the origin and the destination.
  expect(
    distinctPositions(samples),
    'the chip must occupy many intermediate positions — a teleport occupies two',
  ).toBeGreaterThan(10);

  // It stood at every room whose transition was recorded.
  const anchor = (room: string) => anchorFor(boxes, room, resting, 'execution');
  for (const room of WALKED_ROOMS) {
    expect(touched(samples, anchor(room)), `the chip never stood in ${room}`).toBe(true);
  }

  // Motion rule 6: no recorded transition exists for the invalidation stage,
  // so the chip hops over room 04 rather than through it.
  expect(touched(samples, anchor(SKIPPED_ROOM)), 'the chip entered the skipped room').toBe(false);

  // Secondary, and only ever secondary: the pre-#605 build kept this class on
  // a chip whose transition had already been cancelled.
  expect(samples.some((sample) => sample.walking)).toBe(true);
  expect(samples[samples.length - 1]?.walking).toBe(false);
});

test.describe('reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('snaps to the destination with a settle ring and no walk', async ({ page, request }) => {
    const base = await fetchSnapshot(request);
    const settled = settleAtExecution(base, WALKER);

    await installChipSampler(page, WALKER);
    await serveSequence(page, [base, settled]);
    await page.goto('/');

    const { samples, boxes, resting } = await observeTransition(page);

    expect(roomAt(boxes, resting)).toBe('execution');
    expect(
      samples.some((sample) => sample.walking),
      'nothing may walk under rule 5',
    ).toBe(false);
    // Motion rule 5's other half: what moved still says so, statically.
    expect(
      samples.some((sample) => sample.settled),
      'the settle ring must appear',
    ).toBe(true);
    // Exactly two positions — the origin room and the destination room, with
    // nothing in between. A snap writes `transition: none` and forces a reflow
    // before restoring it, so there is no interpolated frame for the sampler to
    // catch: measured over ~295 samples, every one of them sat on one of the
    // two room anchors. Anything above two is a chip that moved.
    expect(distinctPositions(samples)).toBeLessThanOrEqual(2);

    const anchor = (room: string) => anchorFor(boxes, room, resting, 'execution');
    for (const room of WALKED_ROOMS.filter((walked) => walked !== 'execution')) {
      expect(
        touched(samples, anchor(room)),
        `the chip travelled through ${room} under reduced motion`,
      ).toBe(false);
    }
  });
});
