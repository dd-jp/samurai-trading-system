/**
 * Polygon free-tier aggregates — the EQUITIES FALLBACK for the #512
 * warm-start backfill script (#496), and ONLY that. Not a `DataSource` port
 * implementation (`../market-data-service/sources/`); the live composition
 * root (`server/apps/orchestrator/production.ts`) never imports this module — see
 * `backfill-market-data.ts`'s module doc for the composition-root trace and
 * the residual gap this leaves on the live equities leg.
 *
 * ADR-0001 / `docs/research/free-ohlcv-fallback-sources-2026-08-06.md` name
 * Polygon free tier as the equities fallback:
 *
 *   GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
 *       ?adjusted=false&sort=asc
 *
 * Free tier is a 2-year rolling window at 5 calls/min (PROBED, research
 * doc), which physically cannot serve a cold multi-year backfill — it is
 * usable ONLY in the increment-only role, which is exactly what this script
 * plays (`WARM_START_WINDOWS` is `1h`/20 and `1d`/30, days not years).
 * `resolvePolygonPacing()` (already script-only — see `venue-pacing.ts`)
 * paces this client the same way it paces `HttpPolygonClient`.
 *
 * **`adjusted=false`, not `HttpPolygonClient`'s `adjusted=true`, and a
 * SEPARATE client rather than a parameter on that one.** The research doc's
 * load-bearing measurement is that Alpaca (`adjustment=raw`) and Polygon
 * (`adjusted=false`) closes agree EXACTLY on every shared bar; mixing an
 * *adjusted* Polygon series into a raw Alpaca column would put two
 * incompatible price conventions in `bars.close`. `HttpPolygonClient`'s own
 * `adjusted=true` is load-bearing for Stage 2's backtests
 * (`stage2-historical-store.ts`) — flipping it, or threading a
 * caller-supplied flag through that class, risks silently restating every
 * Stage 2 price series for an unrelated caller. A second, narrower client
 * costs nothing and cannot regress the first.
 *
 * ⚠️ Volume does NOT agree between the two: Polygon reports up to ~8% less
 * than Alpaca on SPY (research doc, "PROBED directly"). That shifts
 * `getADV()`'s denominator by up to ~8% while a Polygon-sourced bar sits in
 * the window — tolerable during a stall, which is why every bar this client
 * returns is stamped `source: 'polygon'` (the `bars.source` column,
 * `0001_init.sql`, present since the schema's first migration) so it can be
 * told apart from an Alpaca-sourced bar and re-derived from the primary
 * later.
 */

import { fetchWithTimeout, type TokenBucket, truncateForError } from '../../../shared/index.js';
import type { Bar } from '../index.js';
import { closeTimeOf, isDailyTimeframe, timeframeToMs } from '../index.js';

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Comfortably above anything this client's small `limit`s (20/30) could return in one page. */
const PAGE_LIMIT = 50_000;
/** Headroom over the requested `limit`, same posture as `CoinbaseCandlesClient` — a short read is returned as-is, not retried. */
const REQUEST_BUFFER_MULTIPLIER = 2;
/**
 * Small-`limit` DAILY requests still need a few calendar days of headroom to
 * cross a weekend; gated to `isDailyTimeframe` — same split
 * `AlpacaHttpDataClient.getBars` uses for its own `minBufferMs` — so an
 * intraday (`1h`) request isn't forced to search 4 days it does not need.
 */
const MIN_DAILY_BUFFER_MS = 4 * 86_400_000;

interface RawPolygonAggregate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface PolygonAggregatesResponse {
  results?: unknown;
}

/** `typeof x === 'number'` narrowed further to exclude `NaN`/`Infinity` — a vendor can send either on the wire. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Same shape guard as `HttpPolygonClient`'s `validateRawPolygonAggregate` (issue #509 precedent) — no unvalidated field rides into a `Bar`. */
function validateRawPolygonAggregate(raw: unknown, symbol: string): RawPolygonAggregate {
  if (typeof raw === 'object' && raw !== null) {
    const { t, o, h, l, c, v } = raw as Record<string, unknown>;
    if (
      isFiniteNumber(t) &&
      isFiniteNumber(o) &&
      isFiniteNumber(h) &&
      isFiniteNumber(l) &&
      isFiniteNumber(c) &&
      isFiniteNumber(v)
    ) {
      return { t, o, h, l, c, v };
    }
  }
  throw new Error(
    `PolygonBarsClient: malformed aggregate for ${symbol}: ${truncateForError(JSON.stringify(raw))}`,
  );
}

/** `'1h'` -> `{multiplier: 1, timespan: 'hour'}`, `'1d'` -> `{multiplier: 1, timespan: 'day'}` — Polygon's `/range/{multiplier}/{timespan}/...` vocabulary. */
export function toPolygonRange(timeframe: string): { multiplier: number; timespan: string } {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`PolygonBarsClient: unsupported timeframe '${timeframe}'`);
  }
  const [, countText, unit] = match;
  const timespan = unit === 'm' ? 'minute' : unit === 'h' ? 'hour' : 'day';
  // biome-ignore lint/style/noNonNullAssertion: countText is constrained to \d+ by the regex.
  return { multiplier: Number(countText!), timespan };
}

/** `YYYY-MM-DD`, per Polygon's `from`/`to` path-param format (matches `HttpPolygonClient`'s `toPolygonDate`). */
function toPolygonDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

export interface PolygonBarsClientOptions {
  /** Defaults to `process.env.POLYGON_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `https://api.polygon.io`. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Paced via `resolvePolygonPacing()` at the call site — never a bespoke sleep, same as `HttpPolygonClient`. */
  rateLimiter?: TokenBucket | undefined;
}

/**
 * Fetches the most recent `limit` COMPLETE bars at or before `asOf`,
 * ascending by `close_time` — the same contract `CoinbaseCandlesClient`/
 * `AlpacaHttpDataClient.getBars` share. A short read (fewer than `limit`
 * rows after filtering) is returned as-is rather than retried; the
 * backfill script's own coverage report is what surfaces that.
 */
export class PolygonBarsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: TokenBucket | undefined;

  constructor(options: PolygonBarsClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.POLYGON_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'PolygonBarsClient: POLYGON_API_KEY is not set. Provide it via the environment ' +
          '(.env.local, already provisioned) or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimiter = options.rateLimiter;
  }

  async getBars(symbol: string, timeframe: string, asOf: Date, limit: number): Promise<Bar[]> {
    if (limit <= 0) return [];

    const { multiplier, timespan } = toPolygonRange(timeframe);
    const requestCount = limit * REQUEST_BUFFER_MULTIPLIER;
    const minBufferMs = isDailyTimeframe(timeframe) ? MIN_DAILY_BUFFER_MS : 0;
    const bufferMs = Math.max(timeframeToMs(timeframe) * requestCount, minBufferMs);
    const from = new Date(asOf.getTime() - bufferMs);

    const params = new URLSearchParams({
      adjusted: 'false',
      sort: 'asc',
      limit: String(PAGE_LIMIT),
    });
    const url =
      `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/` +
      `${toPolygonDate(from)}/${toPolygonDate(asOf)}?${params.toString()}`;

    await this.rateLimiter?.acquireBackground();

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
        this.timeoutMs,
      );
    } catch (cause) {
      throw new Error(`PolygonBarsClient: network error fetching ${symbol} ${timeframe} bars.`, {
        cause,
      });
    }

    if (!response.ok) {
      throw new Error(
        `PolygonBarsClient: ${symbol} ${timeframe} bars request failed with HTTP ${response.status}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      throw new Error(
        `PolygonBarsClient: response body for ${symbol} ${timeframe} could not be parsed as JSON.`,
        { cause },
      );
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `PolygonBarsClient: malformed response for ${symbol} ${timeframe} — expected an object, ` +
          `got ${truncateForError(JSON.stringify(parsed))}`,
      );
    }
    const body = parsed as PolygonAggregatesResponse;
    if (body.results !== undefined && !Array.isArray(body.results)) {
      throw new Error(
        `PolygonBarsClient: malformed 'results' for ${symbol} ${timeframe} — expected an array.`,
      );
    }
    const rawResults: unknown[] = Array.isArray(body.results) ? body.results : [];

    const bars: Bar[] = rawResults
      .map((raw) => validateRawPolygonAggregate(raw, symbol))
      .map((agg): Bar => {
        const open_time = new Date(agg.t);
        return {
          instrument: symbol,
          timeframe,
          open_time,
          close_time: closeTimeOf(open_time, timeframe),
          open: agg.o,
          high: agg.h,
          low: agg.l,
          close: agg.c,
          volume: agg.v,
          source: 'polygon',
        };
      })
      .filter((bar) => bar.close_time.getTime() <= asOf.getTime())
      .sort((a, b) => a.close_time.getTime() - b.close_time.getTime());

    return bars.slice(-limit);
  }
}
