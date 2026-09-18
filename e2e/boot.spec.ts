import { expect, test } from './support/test.ts';

const BTC_LANE = 'BTC-USD, crypto, go, at Execution';

const LANES = [
  BTC_LANE,
  'ETH-USD, crypto, no-go, at Verdict',
  'AAPL, stocks, stopped, at Trader',
  'QQQ, stocks, idle, no trace in the window',
  'SPY, stocks, in flight, at Debate',
  'TSLA, stocks, quorum skip, at Analysts',
];

const GLANCE_REGIONS = ['P&L', 'Open risk', 'Verdicts this session'];
const LIVE_REGIONS = ['Lanes'];
const REVIEW_REGIONS = [
  'Metrics suite',
  'Arm comparison',
  'Outside benchmarks',
  'Analysts',
  'Closed trades',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('complementary', { name: 'Rail' })).toContainText('ALIVE');
});

test('boot: the rail reads the mode, providers and budgets; Glance is the first tab', async ({
  page,
}) => {
  const rail = page.getByRole('complementary', { name: 'Rail' });
  await expect(rail.getByRole('tab')).toHaveText(['Glance', 'Live', 'Review']);
  await expect(rail.getByRole('tab', { name: 'Glance' })).toHaveAttribute('aria-selected', 'true');

  await expect(rail).toContainText('PAPER');
  await expect(rail).toContainText('Alpaca');
  await expect(rail).toContainText('Polygon');
  await expect(rail.getByRole('img', { name: /LLM budget used/ })).toBeVisible();
  await expect(rail.getByRole('img', { name: /max drawdown/ })).toBeVisible();

  for (const region of GLANCE_REGIONS) {
    await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Open risk' })).toContainText('BTC-USD');
});

test('tabs: Live and Review each carry their regions, and the hash follows the tab', async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page).toHaveURL(/#live$/);
  for (const region of LIVE_REGIONS) {
    await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('complementary', { name: 'Trace detail' })).toBeVisible();

  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page).toHaveURL(/#review$/);
  for (const region of REVIEW_REGIONS) {
    await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('complementary', { name: 'Trade detail' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Metrics suite' })).toContainText('Sharpe');
  await expect(page.getByRole('region', { name: 'Closed trades' })).toContainText('SPY');
});

test('lanes: every outcome is named in words, with the stage it reached', async ({ page }) => {
  await page.getByRole('tab', { name: 'Live' }).click();
  for (const lane of LANES) {
    await expect(page.getByRole('button', { name: lane, exact: true })).toBeVisible();
  }
});

test('verdicts: settled lanes seed rows, newest first, with the HITL badge', async ({ page }) => {
  const verdicts = page.getByRole('region', { name: 'Verdicts this session' });
  const rows = verdicts.getByRole('button');
  await expect(rows).toHaveCount(4);

  await expect(rows.nth(0)).toHaveAccessibleName(/^TSLA, quorum skip/);
  await expect(rows.nth(1)).toHaveAccessibleName(/^AAPL, stopped/);
  await expect(rows.nth(3)).toHaveAccessibleName(/^BTC-USD, go/);

  await expect(rows.nth(2)).toHaveAccessibleName(
    /^ETH-USD, no-go, human override, risk_correlation$/,
  );
  await expect(rows.nth(2)).toContainText('HITL');
});

test('drawer: a verdict row jumps to Live with its trace; a lane opens its timeline and debate', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^BTC-USD, go/ }).click();
  await expect(page).toHaveURL(/#live$/);
  const drawer = page.getByRole('complementary', { name: 'Trace detail' });
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('BTC-USD');
  await expect(drawer).toContainText('trace-p-btc');
  await expect(
    drawer.getByRole('list', { name: 'Stage timeline' }).getByRole('listitem'),
  ).toHaveCount(6);
  await expect(drawer).not.toContainText('not reached');
  await expect(drawer).toContainText('technical-analyst');
  await expect(drawer).toContainText('influence');
  await expect(drawer).toContainText('long 0.3 @ 66,100.00');
  await expect(drawer).toContainText('No fill recorded against this order key');

  await page.getByRole('button', { name: 'QQQ, stocks, idle, no trace in the window' }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('QQQ');
  await expect(drawer).toContainText('idle — no trace in the last 15 minutes');
});

test('review: a closed trade opens its P&L breakdown and fills', async ({ page }) => {
  await page.getByRole('tab', { name: 'Review' }).click();
  const drawer = page.getByRole('complementary', { name: 'Trade detail' });
  await expect(drawer).toContainText('No trade selected');

  await page.getByRole('button', { name: /^QQQ, .*, stop hit/ }).click();
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('QQQ');
  await expect(drawer).toContainText('Gross');
  await expect(drawer).toContainText('Fees');
  await expect(drawer.getByRole('list', { name: 'Fills' }).getByRole('listitem')).toHaveCount(2);
});

test('a11y: tabs, lanes, verdict rows and trade rows are reachable by Tab and operated by Enter', async ({
  page,
}) => {
  await tabTo(page, '[role="tab"][id="tab-live"]');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Lanes' })).toBeVisible();

  const drawer = page.getByRole('complementary', { name: 'Trace detail' });
  await tabTo(page, '[data-instrument="SPY"]');
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('SPY');

  await tabTo(page, '[role="tab"][id="tab-glance"]');
  await page.keyboard.press('Enter');
  await tabTo(page, '[data-trace-id="trace-p-btc"]');
  await page.keyboard.press('Enter');
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('BTC-USD');
  await expect(drawer).toContainText('trace-p-btc');

  await tabTo(page, '[role="tab"][id="tab-review"]');
  await page.keyboard.press('Enter');
  const tradeDrawer = page.getByRole('complementary', { name: 'Trade detail' });
  await tabTo(page, '.trade-row');
  await page.keyboard.press('Enter');
  await expect(tradeDrawer.getByRole('heading', { level: 2 })).toHaveText(/SPY|QQQ/);
});

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
