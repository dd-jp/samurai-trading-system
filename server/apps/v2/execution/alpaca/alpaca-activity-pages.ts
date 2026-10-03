import { ALPACA_ACTIVITY_PAGE_SIZE } from './alpaca-http-client.js';

export const ALPACA_ACTIVITY_MAX_PAGES = 20;

export async function readActivityPages<T extends { readonly id: string }>(
  list: (after: string, pageToken?: string) => Promise<T[]>,
  sinceDate: string,
  label: string,
): Promise<T[]> {
  const activities: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < ALPACA_ACTIVITY_MAX_PAGES; page += 1) {
    const rows = await list(sinceDate, pageToken);
    activities.push(...rows);
    if (rows.length < ALPACA_ACTIVITY_PAGE_SIZE) return activities;
    pageToken = (rows.at(-1) as T).id;
  }
  throw new Error(
    `Alpaca ${label} activities since ${sinceDate} run past ${ALPACA_ACTIVITY_MAX_PAGES} pages`,
  );
}
