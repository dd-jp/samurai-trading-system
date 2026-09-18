import { fetchSnapshot, serveSequence, serveThenFail } from './support/poll.ts';
import { laneOf, settleAtExecution, withVerdict } from './support/snapshot.ts';
import { expect, test } from './support/test.ts';

const STALE_TIMEOUT_MS = 20_000;
const REPOLL_MS = 7_000;

test('verdicts: a settle between polls appends one row, deduped, and opens its own trace', async ({
  page,
  request,
}) => {
  const base = await fetchSnapshot(request);
  const traceId = laneOf(base, 'SPY').trace_id;
  expect(traceId, 'the in-flight fixture lane must carry a trace').not.toBeNull();

  const settled = withVerdict(settleAtExecution(base, 'SPY'), {
    trace_id: traceId ?? '',
    instrument: 'SPY',
    status: 'go',
    reason: 'approved',
    hitl_override: true,
    timestamp: base.as_of,
  });

  await serveSequence(page, [base, settled]);
  await page.goto('/');

  const verdicts = page.getByRole('region', { name: 'Verdicts this session' });
  const rows = verdicts.getByRole('button');
  await expect(rows).toHaveCount(4);

  await expect(rows).toHaveCount(5, { timeout: 15_000 });
  const spyRow = verdicts.getByRole('button', { name: /^SPY, go, human override, / });
  await expect(spyRow).toBeVisible();
  await expect(spyRow, 'the HITL badge travels with the verdict row').toContainText('HITL');

  await page.waitForTimeout(REPOLL_MS);
  await expect(rows).toHaveCount(5);

  await spyRow.click();
  await expect(page).toHaveURL(/#live$/);
  const drawer = page.getByRole('complementary', { name: 'Trace detail' });
  await expect(drawer.getByRole('heading', { level: 2 })).toHaveText('SPY');
  await expect(drawer).toContainText(traceId ?? '');
  await expect(drawer).toContainText('human override');
});

test('staleness: two missed polls mark the page stale and keep its last numbers', async ({
  page,
  request,
}) => {
  const base = await fetchSnapshot(request);
  await serveThenFail(page, base);
  await page.goto('/');

  const rail = page.getByRole('complementary', { name: 'Rail' });
  await expect(rail).toHaveAttribute('data-stale', 'false');

  await expect(rail).toHaveAttribute('data-stale', 'true', { timeout: STALE_TIMEOUT_MS });
  await expect(page.getByRole('status')).toContainText('stale — last update');
  await expect(rail).toContainText('STALE');

  await expect(page.getByRole('region', { name: 'Open risk' })).toContainText('BTC-USD');
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(
    page.getByRole('button', { name: 'BTC-USD, crypto, go, at Execution' }),
  ).toBeVisible();
});
