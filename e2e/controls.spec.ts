import type { Locator, Page } from '@playwright/test';
import { CONTROLS_SERVER, fixtureUrl, LOSS_BUDGET_SERVER } from './support/servers.ts';
import { expect, test } from './support/test.ts';
import { E2E_TOKEN } from './support/token.ts';

const CONTROL_INTERVAL_WAIT_MS = 15_000;

async function openControls(page: Page): Promise<Locator> {
  await page.goto(`/?token=${E2E_TOKEN}`);
  return page.getByRole('region', { name: 'Halt and pause' });
}

async function send(panel: Locator, button: string, reason: string, recorded: RegExp) {
  await panel.getByLabel('Reason').fill(reason);
  await expect(async () => {
    await panel.getByRole('button', { name: button }).click();
    await expect(panel.getByRole('status')).toHaveText(recorded, { timeout: 1_000 });
  }).toPass({ timeout: CONTROL_INTERVAL_WAIT_MS, intervals: [1_000] });
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
    await expect(panel.getByRole('status')).toHaveText(
      /^One control per 10 seconds: try again in \d+ s\.$/,
    );
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
    await expect(page.getByRole('banner')).toContainText('HALTED');
    expect(await history(panel)).toEqual(['resume', 'halt']);
  });
});
