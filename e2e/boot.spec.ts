/**
 * Boot, placement, ledger, drawer and keyboard operation against the REAL
 * server (#544 scenarios 1, 2, 4-partial, 5, 8).
 *
 * Seam: no `page.route` for `/api/snapshot` at all. These tests read
 * `dist/server/apps/service-api/fixture-server.js` — production `createDashboardServer`,
 * production static handler, production `buildSnapshot`, production wire shape
 * — over an in-memory fixture store. That makes them the only tests here that
 * would catch a break in the server half of the dashboard.
 *
 * Assertions are on roles and accessible names wherever the scenario allows,
 * because #540 is reshaping this page's classes and spacing in parallel. Three
 * deliberate exceptions, all data attributes rather than styling hooks:
 * `[data-room]` for the lights-off room, which carries no accessible name at
 * all; and `[data-instrument]` plus `[data-trace-id]` for the keyboard walk,
 * which asks whether `document.activeElement` IS a given element — a question
 * only a selector can answer from inside the page. The ledger row is doubly
 * unnameable there: its accessible name states instrument, outcome, clock and
 * reason, never the `trace_id` that picks one row out of several.
 */
import { expect, test } from './support/test.ts';

/** The settled crypto lane — the first chip to appear, and the readiness signal. */
const BTC_CHIP = 'BTC-USD, crypto, go, in Execution';

/**
 * The fixture universe, as accessible names. Every cell state and outcome the
 * renderer can draw is here: a live lane, four settled ones across all four
 * outcomes, and an idle lane in the Lobby.
 */
const CHIPS = [
  BTC_CHIP,
  'ETH-USD, crypto, no-go, in Verdict',
  'AAPL, stocks, stopped, in Trader',
  'QQQ, stocks, idle, in Lobby',
  'SPY, stocks, in flight, in Debate',
  'TSLA, stocks, quorum skip, in Analysts',
];

/** Every panel the spec's information inventory requires on the page at boot. */
const REGIONS = [
  'Telemetry',
  'Pipeline rooms',
  'Verdict ledger',
  'Instrument detail',
  'Open positions',
  'Closed trades',
  'Metrics suite',
  'Analysts',
  'LLM spend',
  'Recent debates',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The first poll has landed once a chip exists; everything below reads the
  // same painted snapshot.
  await expect(page.getByRole('button', { name: BTC_CHIP })).toBeVisible();
});

test('boot: eight rooms, invalidation lights-off, every panel present', async ({ page }) => {
  const rooms = page.getByRole('region', { name: 'Pipeline rooms' });
  await expect(rooms.getByRole('heading', { level: 3 })).toHaveText([
    'Lobby',
    'Analysts',
    'Debate',
    'Trader',
    'Invalidation',
    'Risk',
    'Verdict',
    'Execution',
  ]);

  // Room 04 is drawn dark and says why, derived from the data rather than
  // hardcoded — no lane has an invalidation cell that was ever reached.
  await expect(rooms.locator('[data-room="invalidation"]')).toContainText(
    'specced and not built — devils-advocate-spec.md',
  );

  for (const region of REGIONS) {
    await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
  }

  // The strip resolved its mode from SAMURAI_MODE rather than defaulting.
  await expect(page.getByRole('region', { name: 'Telemetry' })).toContainText('PAPER');

  // Spend caveats: the two counts a summary is most likely to drop.
  const spend = page.getByRole('region', { name: 'LLM spend' });
  await expect(spend).toContainText('unpriced calls (all time)');
  await expect(spend).toContainText('carry no');

  // Positions and metrics carry real numbers, not empty states.
  await expect(page.getByRole('region', { name: 'Open positions' })).toContainText('BTC-USD');
  await expect(page.getByRole('region', { name: 'Metrics suite' })).toContainText('Sharpe');
});

test('chip placement: live, settled and idle chips stand in their own rooms', async ({ page }) => {
  for (const chip of CHIPS) {
    await expect(page.getByRole('button', { name: chip, exact: true })).toBeVisible();
  }
});

test('ledger: settled lanes seed rows, newest first, with the HITL badge', async ({ page }) => {
  const ledger = page.getByRole('region', { name: 'Verdict ledger' });
  const rows = ledger.getByRole('button');
  await expect(rows).toHaveCount(4);

  // Newest settle first: TSLA (47s), AAPL (84s), ETH (112s), BTC (170s).
  await expect(rows.nth(0)).toHaveAccessibleName(/^TSLA, quorum skip,/);
  await expect(rows.nth(1)).toHaveAccessibleName(/^AAPL, stopped,/);
  await expect(rows.nth(3)).toHaveAccessibleName(/^BTC-USD, go,/);

  // The verdict row for this trace carries `hitl_override`, so the badge and
  // the gate wording both reach the row.
  await expect(rows.nth(2)).toHaveAccessibleName(
    /^ETH-USD, no-go, human override, .*risk_correlation$/,
  );
  await expect(rows.nth(2)).toContainText('HITL');
});

test('drawer: a chip opens its stage strip and stances; an idle lane names its reason', async ({
  page,
}) => {
  const drawer = page.getByRole('region', { name: 'Instrument detail' });
  await expect(drawer).toContainText('no instrument selected');

  await page.getByRole('button', { name: BTC_CHIP }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('BTC-USD');
  // All seven stages, including the one that never ran.
  await expect(drawer.getByRole('row')).toHaveCount(8);
  await expect(drawer.getByRole('row').nth(4)).toContainText('not reached');
  await expect(drawer).toContainText('technical-analyst');
  await expect(drawer).toContainText('influence');

  await page.getByRole('button', { name: 'QQQ, stocks, idle, in Lobby' }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('QQQ');
  await expect(drawer).toContainText(
    'No trace in the last 15 minutes — this instrument is idle and stands in the Lobby.',
  );
});

test('a11y: chips and ledger rows are reachable by Tab and operated by Enter', async ({ page }) => {
  const drawer = page.getByRole('region', { name: 'Instrument detail' });

  await tabTo(page, '[data-instrument="SPY"]');
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('SPY');

  await tabTo(page, '[data-trace-id="trace-p-btc"]');
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('BTC-USD');
  await expect(drawer).toContainText('trace trace-p-btc');
});

/** Presses Tab until the focused element matches, so tab ORDER is what is asserted. */
async function tabTo(
  page: import('@playwright/test').Page,
  selector: string,
  maxPresses = 40,
): Promise<void> {
  for (let press = 0; press < maxPresses; press++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      (candidate) => document.activeElement?.matches(candidate) ?? false,
      selector,
    );
    if (focused) return;
  }
  throw new Error(`"${selector}" was not reachable within ${maxPresses} Tab presses`);
}
