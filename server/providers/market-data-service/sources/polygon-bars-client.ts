/**
 * Polygon free-tier aggregates — the EQUITIES FALLBACK for the #512
 * warm-start backfill script (#496) and, since #562, for the LIVE
 * orchestrator's equities leg as well. Still not a `DataSource` port
 * implementation: it serves BARS only, and the live path wraps it as the
 * fallback `BarFetcher` inside `FailoverDataSource`
 * (`./failover-data-source.ts`), built by `buildFailoverDataSource`
 * (`server/apps/orchestrator/production/data-failover.ts`) and injected at
 * `production.ts`'s `config.dataSource` seam. Marks and quotes are NOT
 * failed over to this client — see `failover-data-source.ts`'s module doc
 * for why a delayed aggregate feed must not price an open position.
 *
 * ADR-0001 / `docs/research/31-free-ohlcv-evidence.md` name
 * Polygon free tier as the equities fallback:
 *
 *   GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
 *       ?adjusted=false&sort=asc
 *
 * Free tier is a 2-year rolling window at 5 calls/min (PROBED, research
 * doc), which physically cannot serve a cold multi-year backfill — it is
 * usable ONLY in the increment-only role, which is exactly what this script
 * plays (`WARM_START_WINDOWS` is `1h`/57 and `1d`/30, days not years).
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
import {
  fetchWithTimeout,
  type RetryConfig,
  type TokenBucket,
  truncateForError,
  withRetry,
} from '../../../shared/index.js';
import type { Bar } from '../index.js';
import { closeTimeOf, isDailyTimeframe, timeframeToMs } from '../index.js';
import {
  classifyPolygonBarsNetworkError,
  classifyPolygonBarsResponse,
  isRetryablePolygonBarsError,
} from './polygon-bars-errors.js';

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * One retry, not the other three transport clients' three attempts (#1238).
 * Each attempt re-acquires from the shared account-wide `TokenBucket`
 * (`capacity: 1, refillPerSecond: 1/13` — `venue-pacing.ts`'s
 * `DEFAULT_POLYGON_PACING`), so the bucket's own ~13s refill wait already
 * dominates the gap between attempts; a second retry would roughly double
 * the worst-case fallback latency for a shrinking chance of a third bad
 * response resolving. Sized against the 5-10 name watchlist
 * (`universe-selector-spec.md`) all failing over at once: 2 attempts x 10
 * names is 20 bucket acquisitions, ~4 minutes worst case, comfortably inside
 * the 15-minute tick cadence — but that arithmetic assumes each failed
 * attempt is dominated by the bucket's refill wait, not by `timeoutMs`
 * itself; it holds only while `DEFAULT_TIMEOUT_MS` stays under the bucket's
 * ~13s refill, so a future timeout increase past that point should re-check
 * this budget.
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 };
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
  /** Defaults to `DEFAULT_RETRY_CONFIG` — see its doc comment for why this client retries less than the other transport clients. */
  retry?: RetryConfig;
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
  private readonly retry: RetryConfig;

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
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
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

    const context = `${symbol} ${timeframe} bars`;

    // The rate limiter is acquired INSIDE the retried closure, not once
    // before it (#391 precedent, `AlpacaHttpDataClient.requestJson`): a
    // retried attempt is a second request against the same account-wide
    // budget, and pacing only the first attempt would let a retry burst
    // through the bucket.
    const response = await withRetry(
      async () => {
        await this.rateLimiter?.acquireBackground();
        let attempt: Response;
        try {
          attempt = await fetchWithTimeout(
            url,
            { headers: { Authorization: `Bearer ${this.apiKey}` } },
            this.timeoutMs,
          );
        } catch (cause) {
          throw classifyPolygonBarsNetworkError(cause, context);
        }
        if (!attempt.ok) {
          throw classifyPolygonBarsResponse(attempt, context);
        }
        return attempt;
      },
      this.retry,
      isRetryablePolygonBarsError,
    );

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
