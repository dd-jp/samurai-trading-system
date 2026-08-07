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

import { resolvePolygonPacing, TokenBucket } from '../shared/index.js';
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const MAX_PAGES = 25;
const PAGE_LIMIT = 50_000;

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

export interface HttpPolygonClientOptions {
  /** Defaults to `process.env.POLYGON_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `https://api.polygon.io`. See module doc on the Massive.com rebrand. */
  baseUrl?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Proactive outbound pacing against the free tier's 5 calls/min (ticket
   * #510). Defaults to `resolvePolygonPacing()` — see
   * `shared/http/venue-pacing.ts` for the provenance of the pacing figure
   * and how to override it (`SAMURAI_PACING_POLYGON_*`) if this key is ever
   * upgraded off the free tier. Tests inject a bucket sized to never wait
   * (see `http-polygon-client.test.ts`).
   *
   * This replaces the bare `MIN_REQUEST_SPACING_MS` constant this client
   * carried before #510 — that value was invisible to `venue-pacing.ts`'s
   * env-override and ceiling-validation machinery every other venue gets,
   * so a re-tier could only be applied by editing this file. It is not
   * optional at the call site (`fetchAggregates` always awaits it), and
   * unlike `AlpacaHttpDataClient`'s injected-only `rateLimiter` — safe to
   * omit there because `production.ts` is a real composition root that
   * always constructs and injects one — this constructor's own default is
   * not a rarely-exercised fallback. `HttpPolygonClient` is constructed
   * directly by several standalone scripts (`run-stage2.ts`,
   * `run-stage2-cost-decomposition.ts`, `run-spread-calibration.ts`), none
   * of which pass a `rateLimiter`; there is no shared composition root that
   * could inject one instead. So this default IS the only pacing path any
   * of them ever take.
   *
   * **`resolvePolygonPacing()`, not `resolveVenuePacing().polygon` (review
   * feedback on PR #520, reversing an earlier version of this PR).**
   * Polygon pacing briefly lived inside `VENUE_KEYS`/`resolveVenuePacing()`
   * alongside the three broker venues, wrapped here with extra error
   * context because that coupling meant a malformed
   * `SAMURAI_PACING_ALPACA_*`/`IBKR_*` override — venues this client never
   * touches — would throw while constructing a Polygon-only backfill
   * client. That fixed the direction of the coupling this client could see,
   * but left the more dangerous direction open: `production.ts`, the LIVE
   * composition root, would ALSO now validate `SAMURAI_PACING_POLYGON_*` and
   * build a bucket for a venue it never calls — a typo in a backfill-only
   * env var failing orchestrator boot during the unattended soak (#238),
   * with nobody watching. `resolvePolygonPacing()` reads and validates only
   * `SAMURAI_PACING_POLYGON_*` (see its doc in `venue-pacing.ts`), so
   * neither direction of the coupling exists any more, and the error-context
   * wrapper this option's doc used to describe was removed as dead weight —
   * a malformed `SAMURAI_PACING_POLYGON_*` still throws loudly and still
   * names the variable (`readPositive`'s own message), it just no longer
   * needs a wrapper to explain an unrelated venue's failure.
   */
  rateLimiter?: TokenBucket;
}

/** Real HTTP `PolygonClient` against Polygon/Massive's aggregates endpoint. */
export class HttpPolygonClient implements PolygonClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;

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
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(resolvePolygonPacing());
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

      // Proactive floor (#510): stop issuing the call that would earn a 429
      // in the first place, rather than only reacting after the venue
      // rejects it. A 429 that does slip through (e.g. another process
      // sharing this key) still surfaces below via the generic `!response.ok`
      // throw — this bucket is a floor, not a replacement for reacting to
      // whatever the venue actually says.
      await this.rateLimiter.acquire();
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
