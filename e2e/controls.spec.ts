import type { Locator, Page } from '@playwright/test';
import { CONTROLS_SERVER, fixtureUrl, LOSS_BUDGET_SERVER } from './support/servers.ts';
import { expect, test } from './support/test.ts';
import { E2E_TOKEN } from './support/token.ts';

const TOO_SOON = /^One control per 10 seconds: try again in (\d+) s\.$/;
const RETRY_MARGIN_MS = 500;

async function openControls(page: Page): Promise<Locator> {
  await page.goto(`/?token=${E2E_TOKEN}`);
  return page.getByRole('region', { name: 'Halt and pause' });
}

async function retryAfterSeconds(status: Locator): Promise<number> {
  await expect(status).toHaveText(TOO_SOON);
  return Number(TOO_SOON.exec((await status.textContent()) ?? '')?.[1]);
}

async function send(panel: Locator, button: string, reason: string, recorded: RegExp) {
  const status = panel.getByRole('status');
  await panel.getByLabel('Reason').fill(reason);
  await panel.getByRole('button', { name: button }).click();
  await expect(status).toHaveText(new RegExp(`${recorded.source}|${TOO_SOON.source}`));
  if (TOO_SOON.test((await status.textContent()) ?? '')) {
    const seconds = await retryAfterSeconds(status);
    await panel.page().waitForTimeout(seconds * 1_000 + RETRY_MARGIN_MS);
    await panel.getByRole('button', { name: button }).click();
  }
  await expect(status).toHaveText(recorded);
}

async function history(panel: Locator): Promise<string[]> {
  await panel.getByText(/^Control history/).click();
  return panel
    .getByRole('row')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('th')?.textContent ?? ''));
}

test.describe('pause, halt and resume from the UI', () => {
  test.use({ baseURL: fixtureUrl(CONTROLS_SERVER) });

  test('each control updates the state and the history, one per 10 seconds', async ({ page }) => {
    const panel = await openControls(page);
    const state = panel.locator('.state');
    await expect(state).toContainText('State: RUNNING');
    await expect(panel.getByRole('button', { name: 'Resume' })).toHaveCount(0);

    await send(panel, 'Pause entries', 'e2e pause', /^Recorded: pause #1\./);
    await expect(state).toContainText('State: PAUSED');
    await expect(state).toContainText('from dashboard 127.0.0.1: e2e pause');
    await expect(page.getByRole('banner')).toContainText('PAUSED');

    await panel.getByLabel('Reason').fill('e2e halt');
    await panel.getByRole('button', { name: 'Halt: flat at next fill' }).click();
    expect(await retryAfterSeconds(panel.getByRole('status'))).toBeGreaterThanOrEqual(8);
    await expect(state).toContainText('State: PAUSED');

    await send(panel, 'Halt: flat at next fill', 'e2e halt', /^Recorded: halt #2\./);
    await expect(state).toContainText('State: HALTED (manual)');
    await expect(state).toContainText('e2e halt');

    await send(panel, 'Resume', 'e2e resume', /^Recorded: resume #3\./);
    await expect(state).toHaveText('State: RUNNING');
    await expect(panel.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    expect(await history(panel)).toEqual(['resume', 'halt', 'pause']);
  });
});

test.describe('resume after a loss-budget halt', () => {
  test.use({ baseURL: fixtureUrl(LOSS_BUDGET_SERVER) });

  test('leaves the book halted and says so', async ({ page }) => {
    const panel = await openControls(page);
    const state = panel.locator('.state');
    const note = panel.getByRole('note');
    await expect(state).toHaveText('State: HALTED (loss budget)');
    await expect(note).toHaveText(
      'The loss budget has halted debate/primary. Resume does not lift it.',
    );
    await expect(panel.getByRole('button', { name: 'Resume' })).toHaveCount(0);

    await send(panel, 'Halt: flat at next fill', 'e2e halt', /^Recorded: halt #1\./);
    await expect(state).toContainText('State: HALTED (loss budget)');
    await send(panel, 'Resume', 'e2e resume', /^Recorded: resume #2\./);

    await expect(state).toHaveText('State: HALTED (loss budget)');
    await expect(note).toBeVisible();
    expect(await history(panel)).toEqual(['resume', 'halt']);
  });
});
