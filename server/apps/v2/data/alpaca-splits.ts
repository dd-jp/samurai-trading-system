import type { EodhdSplit, SplitsRead, SplitsWindow } from './eodhd-client.js';
import { assertWindow } from './eodhd-client.js';
import { addDays } from './macro-calendar.js';

export const ALPACA_CORPORATE_ACTIONS_URL = 'https://data.alpaca.markets/v1/corporate-actions';
// The deprecated announcements endpoint capped a query at 90 days; v1's cap is unverified
const ALPACA_ACTIONS_MAX_DAYS = 90;
// start/end may filter on process_date rather than ex_date, so the query reaches back a week
const ALPACA_ACTIONS_LEAD_DAYS = 7;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AlpacaDataCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export class AlpacaSplitsError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface ActionPage {
  readonly splits: readonly EodhdSplit[];
  readonly next: string | undefined;
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) throw new AlpacaSplitsError('bad_body');
  return raw as Record<string, unknown>;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AlpacaSplitsError('bad_body');
  }
  return value;
}

function isoDate(value: unknown): string {
  try {
    assertWindow({ from: value as string, to: value as string });
  } catch {
    throw new AlpacaSplitsError('bad_body');
  }
  return value as string;
}

function parseAction(raw: unknown, symbol: string): EodhdSplit {
  const action = record(raw);
  if (action.symbol !== symbol) throw new AlpacaSplitsError('bad_body');
  return {
    date: isoDate(action.ex_date),
    ratio: positive(action.new_rate) / positive(action.old_rate),
  };
}

function actionList(raw: unknown): readonly unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AlpacaSplitsError('bad_body');
  return raw;
}

function nextToken(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new AlpacaSplitsError('bad_body');
  return raw;
}

export function parseActionPage(body: unknown, symbol: string): ActionPage {
  const page = record(body);
  const actions = record(page.corporate_actions ?? {});
  const raw = [...actionList(actions.forward_splits), ...actionList(actions.reverse_splits)];
  return {
    splits: raw.map((action) => parseAction(action, symbol)),
    next: nextToken(page.next_page_token),
  };
}

// one ex-date carrying two splits is unreadable, and one outside the window vouches for nothing
export function splitsWithin(splits: readonly EodhdSplit[], window: SplitsWindow): EodhdSplit[] {
  const sorted = [...splits].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map((split) => split.date)).size < sorted.length) {
    throw new AlpacaSplitsError('bad_body');
  }
  return sorted.filter((split) => split.date >= window.from && split.date <= window.to);
}

export function actionChunks(window: SplitsWindow): SplitsWindow[] {
  assertWindow(window);
  const chunks: SplitsWindow[] = [];
  let from = addDays(window.from, -ALPACA_ACTIONS_LEAD_DAYS);
  while (from <= window.to) {
    const end = addDays(from, ALPACA_ACTIONS_MAX_DAYS - 1);
    const to = end < window.to ? end : window.to;
    chunks.push({ from, to });
    from = addDays(to, 1);
  }
  return chunks;
}

export function actionsUrl(symbol: string, chunk: SplitsWindow, pageToken?: string): URL {
  const url = new URL(ALPACA_CORPORATE_ACTIONS_URL);
  url.searchParams.set('symbols', symbol);
  url.searchParams.set('types', 'forward_split,reverse_split');
  url.searchParams.set('start', chunk.from);
  url.searchParams.set('end', chunk.to);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (pageToken !== undefined) url.searchParams.set('page_token', pageToken);
  return url;
}

export class AlpacaSplitsClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(
    private readonly credentials: AlpacaDataCredentials,
    fetchImpl: typeof fetch = fetch,
    now: () => Date = () => new Date(),
  ) {
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async splits(symbol: string, window: SplitsWindow): Promise<SplitsRead> {
    const chunks = actionChunks(window);
    const asOf = this.#now().toISOString().slice(0, 10);
    const found: EodhdSplit[] = [];
    for (const chunk of chunks) found.push(...(await this.#chunk(symbol, chunk)));
    return { symbol, from: window.from, to: window.to, asOf, splits: splitsWithin(found, window) };
  }

  async #chunk(symbol: string, chunk: SplitsWindow): Promise<EodhdSplit[]> {
    const found: EodhdSplit[] = [];
    let token: string | undefined;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = parseActionPage(await this.#get(actionsUrl(symbol, chunk, token)), symbol);
      found.push(...page.splits);
      token = page.next;
      if (token === undefined) return found;
    }
    throw new AlpacaSplitsError('too_many_pages');
  }

  async #get(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: {
          'APCA-API-KEY-ID': this.credentials.apiKey,
          'APCA-API-SECRET-KEY': this.credentials.apiSecret,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AlpacaSplitsError(
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network',
      );
    }
    if (!response.ok) throw new AlpacaSplitsError(`http_${response.status}`);
    return response.json().catch(() => undefined);
  }
}
