/**
 * What the page does ACROSS polls (#544 scenarios 4 and 6): a lane settling
 * between two snapshots, and the poll failing outright.
 *
 * Seam: `page.route` over the harness server's own payload. Both scenarios are
 * about a sequence — one poll's page state compared against the next — which a
 * static fixture store cannot express.
 *
 * Every wait here is against the bundle's real 3-second poll clock
 * (`POLL_INTERVAL_MS`, not overridable from outside `<App/>`), so the timeouts
 * are explicit rather than left to the 5-second default.
 */
import { fetchSnapshot, serveSequence, serveThenFail } from './support/poll.ts';
import { laneOf, settleAtExecution, withVerdict } from './support/snapshot.ts';
import { expect, test } from './support/test.ts';

/** Two poll intervals plus the tick that evaluates the watchdog. */
const STALE_TIMEOUT_MS = 20_000;
/** Long enough for two further polls of the unchanged payload. */
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
  // Seeded from the first paint: the four lanes that were already settled.
  await expect(rows).toHaveCount(4);

  // The settle is OBSERVED, so it earns a stamped row of its own.
  await expect(rows).toHaveCount(5, { timeout: 15_000 });
  const spyRow = verdicts.getByRole('button', { name: /^SPY, go, human override, / });
  await expect(spyRow).toBeVisible();
  await expect(spyRow, 'the HITL badge travels with the verdict row').toContainText('HITL');

  // Re-polling the same payload must not stamp it again.
  await page.waitForTimeout(REPOLL_MS);
  await expect(rows).toHaveCount(5);

  // A row opens Live on the trace stamped on it.
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
  // The state is announced, not merely coloured.
  await expect(page.getByRole('status')).toContainText('stale — last update');
  await expect(rail).toContainText('STALE');

  // A stale page keeps the numbers it last had; blanking them would read as
  // zero on a live-money surface.
  await expect(page.getByRole('region', { name: 'Open risk' })).toContainText('BTC-USD');
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(
    page.getByRole('button', { name: 'BTC-USD, crypto, go, at Execution' }),
  ).toBeVisible();
});
