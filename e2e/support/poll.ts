import type { APIRequestContext, Page } from '@playwright/test';
import type { DashboardSnapshot } from '../../contracts/index.ts';
import { expect } from './test.ts';

const SNAPSHOT_GLOB = '**/api/snapshot';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

export async function fetchSnapshot(request: APIRequestContext): Promise<DashboardSnapshot> {
  const response = await request.get('/api/snapshot');
  expect(response.status(), 'the fixture server must serve a snapshot').toBe(200);
  return (await response.json()) as DashboardSnapshot;
}

export async function serveSequence(
  page: Page,
  payloads: readonly [DashboardSnapshot, ...DashboardSnapshot[]],
): Promise<void> {
  let current: DashboardSnapshot = payloads[0];
  let served = 0;
  await page.route(SNAPSHOT_GLOB, async (route) => {
    const next = payloads[served];
    if (next !== undefined) current = next;
    served += 1;
    await route.fulfill({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(current) });
  });
}

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
