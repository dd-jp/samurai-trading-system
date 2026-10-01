import { expect, test } from './support/test.ts';
import { E2E_TOKEN } from './support/token.ts';

test('boot: the token leaves the URL, the strip reads the fixture, Today shows its panels', async ({
  page,
}) => {
  await page.goto(`/?token=${E2E_TOKEN}`);
  const strip = page.getByRole('banner');
  await expect(strip).toContainText('PAPER');
  await expect(strip).toContainText('Last cycle 2026-10-05');
  await expect(strip).toContainText('Next due 2026-10-06 (estimate)');
  await expect(strip).toContainText('Ping success 2026-10-05 21:41Z');
  await expect(strip).toContainText('RUNNING');
  await expect(page).toHaveURL(/\/$/);

  const budget = page.getByRole('region', { name: 'Loss budget' });
  await expect(budget.getByRole('list', { name: 'Size steps' })).toContainText(
    '−£500.00: ½ size−£1,000.00: ¼ size−£1,500.00: halt',
  );
  await expect(budget).toContainText('debate/primary');
  await expect(budget).toContainText('no-veto (shadow)');

  const positions = page.getByRole('region', { name: 'Positions and cash' });
  await expect(positions).toContainText('AAPL');
  await expect(positions).toContainText('unavailable');

  await expect(page.getByRole('region', { name: "Today's decisions" })).toContainText(
    'entered long',
  );
});

test('the token survives a reload from session storage', async ({ page }) => {
  await page.goto(`/?token=${E2E_TOKEN}`);
  await expect(page.getByRole('banner')).toContainText('RUNNING');
  await page.reload();
  await expect(page.getByRole('banner')).toContainText('RUNNING');
});

test('without a token the page says so and shows no data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('token is missing or wrong');
  await expect(page.getByRole('region', { name: 'Loss budget' })).toHaveCount(0);
});
