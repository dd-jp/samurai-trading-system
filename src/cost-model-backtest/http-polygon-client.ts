/**
 * Real `PolygonClient` (ticket #266) — see
 * docs/specs/stage2-validation-execution-spec.md ("Module: Historical Data
 * Ingestion") and docs/research/polygon-aggregates-api-2026-07-31.md (ticket
 * #263's primary-source research this implementation follows directly).
 *
 * Implements `PolygonClient.fetchAggregates` (stage2-historical-store.ts)
 * against Polygon/Massive's `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}`
 * endpoint. `Stage2HistoricalStore` already treats the client as an injected
 * seam (constructor-injected `PolygonClient`) — this module just supplies the
 * real implementation; nothing about the store changes.
 *
 * **Base URL.** `api.polygon.io` (the legacy, still-documented-as-supported
 * host) rather than `api.massive.com` — matches this repo's existing
 * `PolygonClient` naming and needs no rebrand-driven rename; the research doc
 * flags this as a one-constant swap if that ever changes.
 *
 * **Auth.** `Authorization: Bearer ${POLYGON_API_KEY}` header, per the
 * research doc's recommendation (current official guidance, and keeps the
 * key out of URLs/logs/proxies) — reused verbatim on every `next_url` page
 * request rather than re-derived, since the docs did not confirm whether
 * `next_url` embeds or requires the key itself.
 *
 * **Ticker mapping.** Equities pass through unchanged (`SPY` -> `SPY`);
 * crypto's `<BASE>-USD` universe symbols become Polygon's `X:<BASE>USD`
 * (`BTC-USD` -> `X:BTCUSD`).
 *
 * **Pagination.** Follows `.next_url` in a loop, capped at `MAX_PAGES` so a
 * malformed or cyclical `next_url` cannot spin forever and burn the rate
 * limit — the research doc's explicit caution, even though pagination is not
 * expected to trigger at this universe's daily-bar scale (~1300 rows for a
 * 5-year window, well under the 5000-row default page size).
 */

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const MAX_PAGES = 25;
const PAGE_LIMIT = 50_000;

import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

/** Polygon's raw per-bar shape — a superset of `PolygonAggregate` (also carries `vw`, `n`). */
interface RawPolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface PolygonAggregatesResponse {
  results?: RawPolygonAggregate[];
  next_url?: string;
}

/** Maps this repo's universe symbols to Polygon ticker strings — crypto gets the `X:` prefix. */
export function toPolygonTicker(symbol: string): string {
  return symbol.endsWith('-USD') ? `X:${symbol.slice(0, -'-USD'.length)}USD` : symbol;
}

/** `YYYY-MM-DD`, per Polygon's `from`/`to` path-param format. */
function toPolygonDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

/**
 * Free-tier pacing (review 2026-08-06 A1): Polygon's free tier allows 5
 * calls/min and this key is deliberately on it (the paid depth entitlement
 * was never in effect — see docs/reviews/codebase-review-2026-08-06.md).
 * 13s spacing sits under the ceiling rather than at it, the same posture
 * DEFAULT_VENUE_PACING takes for Alpaca.
 */
const MIN_REQUEST_SPACING_MS = 13_000;

export interface HttpPolygonClientOptions {
  /** Defaults to `process.env.POLYGON_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `https://api.polygon.io`. See module doc on the Massive.com rebrand. */
  baseUrl?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Milliseconds between requests. Defaults to free-tier spacing; tests pass 0. */
  minRequestSpacingMs?: number;
}

/** Real HTTP `PolygonClient` against Polygon/Massive's aggregates endpoint. */
export class HttpPolygonClient implements PolygonClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minRequestSpacingMs: number;
  private lastRequestAt = 0;

  constructor(options: HttpPolygonClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.POLYGON_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'HttpPolygonClient: POLYGON_API_KEY is not set. Provide it via the environment ' +
          '(.env.local, already provisioned) or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minRequestSpacingMs = options.minRequestSpacingMs ?? MIN_REQUEST_SPACING_MS;
  }

  /** Sleeps out the remainder of the spacing window since the last request. */
  private async paceRequest(): Promise<void> {
    const wait = this.lastRequestAt + this.minRequestSpacingMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }

  async fetchAggregates(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    const ticker = toPolygonTicker(symbol);
    const from = toPolygonDate(window.start);
    const to = toPolygonDate(window.end);

    let url: string | undefined =
      `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}` +
      `?adjusted=true&sort=asc&limit=${PAGE_LIMIT}`;

    const out: PolygonAggregate[] = [];
    let pages = 0;

    while (url !== undefined) {
      pages++;
      if (pages > MAX_PAGES) {
        throw new Error(
          `HttpPolygonClient.fetchAggregates: exceeded ${MAX_PAGES} pages for ${symbol} ` +
            `(ticker ${ticker}) — refusing to follow next_url further (malformed/cyclical ` +
            'pagination guard).',
        );
      }

      await this.paceRequest();
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!response.ok) {
        throw new Error(
          `HttpPolygonClient.fetchAggregates: Polygon returned HTTP ${response.status} ` +
            `${response.statusText} for ${symbol} (ticker ${ticker}).`,
        );
      }

      const body = (await response.json()) as PolygonAggregatesResponse;
      const results = body.results ?? [];
      for (const bar of results) {
        out.push({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
      }

      if (body.next_url === undefined) break;
      url = body.next_url;
    }

    return out;
  }
}
