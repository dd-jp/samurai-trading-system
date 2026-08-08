/**
 * Control over the 3-second `/api/snapshot` poll, for the scenarios that are
 * about a SEQUENCE of polls rather than a single payload (#544).
 *
 * The bundle's poll interval is a constant (`POLL_INTERVAL_MS`) and `main.tsx`
 * mounts `<App/>` with no options, so a real browser test cannot shorten it —
 * every wait below is against the real 3-second clock, which is why those
 * assertions carry explicit timeouts.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import type { DashboardSnapshot } from '../../src/dashboard/types.ts';
import { expect } from './test.ts';

const SNAPSHOT_GLOB = '**/api/snapshot';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

/** The harness server's own payload — the base every transform starts from. */
export async function fetchSnapshot(request: APIRequestContext): Promise<DashboardSnapshot> {
  const response = await request.get('/api/snapshot');
  expect(response.status(), 'the fixture server must serve a snapshot').toBe(200);
  return (await response.json()) as DashboardSnapshot;
}

/**
 * Serve `payloads` in order, repeating the last one forever. Register from the
 * test body so this handler sits ABOVE the off-origin guard installed in
 * fixture setup.
 */
export async function serveSequence(
  page: Page,
  // Non-empty by type rather than by a runtime guard: "serve these in order"
  // has no meaning for an empty list, and the tuple makes the first element a
  // value the handler below can hold without a fallback that can never run.
  payloads: readonly [DashboardSnapshot, ...DashboardSnapshot[]],
): Promise<void> {
  let current: DashboardSnapshot = payloads[0];
  let served = 0;
  await page.route(SNAPSHOT_GLOB, async (route) => {
    const next = payloads[served];
    // Past the end of the list `current` keeps its last value — that IS the
    // "repeats the last one forever" rule, stated rather than indexed around.
    if (next !== undefined) current = next;
    served += 1;
    await route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(current) });
  });
}

/**
 * Serve `first` once, then fail every later poll — the staleness scenario.
 *
 * Failing rather than hanging on purpose: `useSnapshot` abandons a hung request
 * at the staleness horizon anyway, and a route handler that never settles
 * leaves requests outstanding at teardown. Either way the watchdog measures the
 * same thing — time since the last SUCCESSFUL poll.
 */
export async function serveThenFail(page: Page, first: DashboardSnapshot): Promise<void> {
  let served = 0;
  await page.route(SNAPSHOT_GLOB, async (route) => {
    served += 1;
    if (served === 1) {
      await route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(first) });
      return;
    }
    await route.abort('connectionfailed');
  });
}
