import { expect, test } from './support/test.ts';
import { E2E_TOKEN } from './support/token.ts';

test('Evidence reads the fixture books risk-adjusted and names each owned panel', async ({
  page,
}) => {
  await page.goto(`/?token=${E2E_TOKEN}#evidence`);
  await expect(page.getByRole('link', { name: 'Evidence' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const performance = page.getByRole('region', { name: 'Sleeve vs benchmark' });
  await expect(performance.getByRole('row', { name: /^debate\/primary/ })).toBeVisible();
  await expect(performance).toContainText('↳ no-veto (shadow)');
  await expect(performance).toContainText('vs arm 2: Not yet fed: arm 2 (#1773).');
  await expect(page.getByRole('region', { name: 'Debate G1 progress' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live-vs-backtest band' })).toContainText(
    'Not yet fed: Step 1b (#1785).',
  );
  await expect(page.getByRole('region', { name: 'Gate statistics' })).toContainText('Not yet fed');
  await expect(page.getByRole('region', { name: 'Loss budget' })).toHaveCount(0);
});

test('Records searches the journal and shows the owned panels', async ({ page }) => {
  await page.goto(`/?token=${E2E_TOKEN}#records`);
  const journal = page.getByRole('region', { name: 'Decision journal' });
  const day = journal.getByRole('article', { name: 'Cycle 2026-10-05' });
  await expect(day).toContainText('AAPL long, debate/primary: entered long');

  await journal.getByLabel('Outcome').selectOption('vetoed');
  await journal.getByRole('button', { name: 'Search' }).click();
  await expect(journal).toContainText('No cycle days match.');

  await journal.getByLabel('Outcome').selectOption('');
  await journal.getByLabel('Instrument').fill('aapl');
  await journal.getByRole('button', { name: 'Search' }).click();
  await expect(day).toBeVisible();

  await expect(page.getByRole('region', { name: 'Research loop' })).toContainText(
    'Proposals: Not yet fed: G11 not ruled (#1717).',
  );
  await expect(page.getByRole('region', { name: 'LLM spend' })).toContainText('of $30.00');
  await expect(page.getByRole('region', { name: 'Reconcile diffs' })).toContainText(
    /2026-10-05\s*alpaca broker\s*debate\/primary\s*clean/,
  );
  await expect(page.getByRole('region', { name: 'Tax export' })).toContainText(
    'Not yet fed: Step 4 (#1947).',
  );
});
