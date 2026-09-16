/**
 * Real HTTP `AlpacaMarketDataClient`. No paper/live guard here (unlike the broker client) —
 * one host serves both. Crypto and equities are a path-root split on non-interchangeable API
 * versions; a client instance is scoped to one asset class at construction.
 */

import type { RetryConfig, TokenBucket } from '../../../shared/index.js';
import { fetchWithTimeout, truncateForError, withRetry } from '../../../shared/index.js';
import { isDailyTimeframe, timeframeToMs } from '../timeframe.js';
import {
  AlpacaDataProviderError,
  AlpacaDataUnderfetchError,
  classifyAlpacaDataNetworkError,
  classifyAlpacaDataResponse,
  isRetryableAlpacaDataError,
} from './alpaca-data-errors.js';
import type { AlpacaBar, AlpacaMarketDataClient, AlpacaQuote } from './alpaca-source.js';

const DEFAULT_BASE_URL = 'https://data.alpaca.markets';
/** Crypto is NOT on `/v2` (verified live: `/v2/crypto/us/bars` 404s, `/v1beta3/crypto/us/bars` 200s) */
const ALPACA_CRYPTO_API_VERSION = 'v1beta3';
const ALPACA_STOCKS_API_VERSION = 'v2';
/** Exported so `deriveAnalystTimeoutMs`'s fetch-bound floor is computed from these actual constants rather than a re-guessed literal */
export const ALPACA_BARS_TIMEOUT_MS = 10_000;
/** Same sizing as the broker client — one Alpaca key's ~200 req/min budget is shared across both APIs */
export const ALPACA_BARS_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};
/** Guards against a malformed/cyclical `next_page_token` spinning forever — mirrors `HttpPolygonClient`'s `MAX_PAGES` */
const MAX_PAGES = 25;
/** Rows requested per page — well under Alpaca's own page-size cap, unrelated to the caller's `limit` */
const PAGE_SIZE = 1_000;
/** How many `timeframe`-widths back of `asOf` to search for `limit` bars. An optimization, not a guarantee — the in-session count is guaranteed one layer up. */
const BUFFER_MULTIPLIER = 8;
/** Widening factor for the one retry a short first read earns — a sparse symbol (halt, fresh listing) can break `BUFFER_MULTIPLIER`'s assumption */
const RETRY_WIDEN_FACTOR = 4;
/** Calendar-time floor for that retry: a purely multiplicative widen at small `limit`s can still land entirely inside a weekend. Ten days clears any US equity weekend plus an adjacent holiday. */
const RETRY_MIN_WINDOW_MS = 10 * 86_400_000;
/** Hard ceiling on the retry's page walk, in rows so it holds across timeframes — bounds a widened crawl against a rate-limit budget shared with live order placement */
const RETRY_MAX_ROWS = MAX_PAGES * PAGE_SIZE;

/** Alpaca's raw per-bar shape on the wire — a superset of `AlpacaBar` (also carries `n`, `vw`) */
interface RawAlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface RawAlpacaQuote {
  t: string;
  ap: number;
  bp: number;
}

interface StocksBarsResponse {
  bars?: RawAlpacaBar[] | null;
  next_page_token?: string | null;
}

interface CryptoBarsResponse {
  bars?: Record<string, RawAlpacaBar[] | undefined>;
  next_page_token?: string | null;
}

interface StocksLatestQuoteResponse {
  quote?: RawAlpacaQuote;
}

interface CryptoLatestQuoteResponse {
  quotes?: Record<string, RawAlpacaQuote | undefined>;
}

function toAlpacaBar(raw: RawAlpacaBar): AlpacaBar {
  return { t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: raw.v };
}

/** `typeof x === 'number'` narrowed further to exclude `NaN`/`Infinity` — a vendor can send either on the wire */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validates and narrows one wire bar before it reaches `toAlpacaBar` — a non-finite OHLCV field would otherwise flow silently into an indicator, then a stop distance */
function validateRawAlpacaBar(raw: unknown, symbol: string, context: string): RawAlpacaBar {
  if (typeof raw === 'object' && raw !== null) {
    const { t, o, h, l, c, v } = raw as Record<string, unknown>;
    if (
      typeof t === 'string' &&
      isFiniteNumber(o) &&
      isFiniteNumber(h) &&
      isFiniteNumber(l) &&
      isFiniteNumber(c) &&
      isFiniteNumber(v)
    ) {
      return { t, o, h, l, c, v };
    }
  }
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed bar for ${symbol} (${context}): ${truncateForError(
      JSON.stringify(raw),
    )}`,
  );
}

/** Same shape guard as `validateRawAlpacaBar`, for the single-quote payload `getLatestQuote` reads */
function validateRawAlpacaQuote(raw: unknown, symbol: string, context: string): RawAlpacaQuote {
  if (typeof raw === 'object' && raw !== null) {
    const { t, ap, bp } = raw as Record<string, unknown>;
    if (typeof t === 'string' && isFiniteNumber(ap) && isFiniteNumber(bp)) {
      return { t, ap, bp };
    }
  }
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed quote for ${symbol} (${context}): ${truncateForError(
      JSON.stringify(raw),
    )}`,
  );
}

/** Guards the top-level envelope before any field is read off it — a `null`/non-object body would otherwise throw an unclassified `TypeError` */
function requireResponseObject(body: unknown, context: string): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed response body (${context}): expected an object, got ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

/** `undefined`/`null` degrade to "no bars"; any other non-array shape is a vendor error, not a silently-empty page */
function requireBarsArray(value: unknown, symbol: string, context: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed bars array for ${symbol} (${context}): expected an array, ` +
      `got ${truncateForError(JSON.stringify(value))}`,
  );
}

/** `'1m'` -> `'1Min'`, `'5m'` -> `'5Min'`, `'1h'` -> `'1Hour'`, `'1d'` -> `'1Day'` (Alpaca's own vocabulary) */
export function toAlpacaTimeframe(timeframe: string): string {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`AlpacaHttpDataClient: unsupported timeframe '${timeframe}'`);
  }
  const [, count, unit] = match;
  const unitName = unit === 'm' ? 'Min' : unit === 'h' ? 'Hour' : 'Day';
  return `${count}${unitName}`;
}

/** `'BTC-USD'` -> `'BTC/USD'` — Alpaca's crypto wire format, verified live. Any `-USD`-suffixed universe symbol maps; anything else passes through unchanged. */
export function toAlpacaCryptoSymbol(symbol: string): string {
  return symbol.endsWith('-USD') ? `${symbol.slice(0, -'-USD'.length)}/USD` : symbol;
}

/** Matches by name only — it will not guess: a single-key fallback used to hand back a DIFFERENT instrument's bars under the requested name */
function lookupCryptoKey<T>(
  byKey: Record<string, T | undefined> | undefined,
  alpacaSymbol: string,
  originalSymbol: string,
): T | undefined {
  if (byKey === undefined) return undefined;
  if (byKey[alpacaSymbol] !== undefined) return byKey[alpacaSymbol];
  return byKey[originalSymbol];
}

/**
 * Equity feed only. Defaults to `iex` deliberately: Alpaca's own default (SIP) 403s a Basic
 * subscription for data under 15 minutes old, and `asOf` is always `clock.now()`.
 */
export type AlpacaDataFeed = 'iex' | 'sip';

/** Default equity feed — see `AlpacaDataFeed` for why it is not Alpaca's own default */
export const DEFAULT_ALPACA_DATA_FEED: AlpacaDataFeed = 'iex';

/** The operator's override. Read once, at construction. */
export const ALPACA_DATA_FEED_ENV_VAR = 'ALPACA_DATA_FEED';

/** Unrecognised values are refused rather than passed to the wire — a typo'd value would otherwise read as a data outage on every equity tick */
export function resolveAlpacaDataFeed(raw: string | undefined): AlpacaDataFeed {
  const value = (raw ?? '').trim();
  if (value.length === 0) return DEFAULT_ALPACA_DATA_FEED;
  if (value === 'iex' || value === 'sip') return value;
  throw new Error(
    `AlpacaHttpDataClient: ${ALPACA_DATA_FEED_ENV_VAR} must be 'iex' or 'sip' (got '${value}'). ` +
      "Leave it unset for 'iex', which is what a Basic Alpaca subscription can read in real " +
      "time; 'sip' requires a paid data subscription and 403s on recent data without one.",
  );
}

export interface AlpacaHttpDataClientOptions {
  /** Routes requests through the `/v2/stocks/...` or `/v1beta3/crypto/us/...` path root */
  assetClass: 'crypto' | 'stocks';
  /**
   * Equity feed. Defaults to `ALPACA_DATA_FEED`, then to
   * `DEFAULT_ALPACA_DATA_FEED` — see `AlpacaDataFeed` for why that is `iex`.
   * Ignored for crypto.
   */
  feed?: AlpacaDataFeed;
  /** Defaults to `process.env.ALPACA_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `process.env.ALPACA_API_SECRET`. Never logged or thrown into an error message. */
  apiSecret?: string;
  /** Defaults to `https://data.alpaca.markets` — one host serves both paper and live accounts */
  baseUrl?: string;
  /** Per-attempt network timeout passed to `fetchWithTimeout` */
  timeoutMs?: number;
  retry?: RetryConfig;
  /**
   * Outbound pacing, SHARED with the broker adapter — Alpaca's 200 req/min is
   * per ACCOUNT. Calls here take `acquireBackground()`, so a bar burst can
   * never park an order behind the refill. Optional: unset means unpaced,
   * which every existing unit test wants; the composition root always supplies it.
   */
  rateLimiter?: TokenBucket | undefined;
}

/** Real HTTP market-data `AlpacaMarketDataClient` against Alpaca's Market Data API v2 */
export class AlpacaHttpDataClient implements AlpacaMarketDataClient {
  private readonly assetClass: 'crypto' | 'stocks';
  /** Resolved for a STOCKS client only, `undefined` for crypto — see the constructor for why an unused env var must not fail a boot */
  private readonly feed: AlpacaDataFeed | undefined;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;
  private readonly rateLimiter: TokenBucket | undefined;

  constructor(options: AlpacaHttpDataClientOptions) {
    const apiKey = options.apiKey ?? process.env.ALPACA_API_KEY;
    const apiSecret = options.apiSecret ?? process.env.ALPACA_API_SECRET;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'AlpacaHttpDataClient: ALPACA_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiKey } explicitly.',
      );
    }
    if (apiSecret === undefined || apiSecret.length === 0) {
      throw new Error(
        'AlpacaHttpDataClient: ALPACA_API_SECRET is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiSecret } explicitly.',
      );
    }
    this.assetClass = options.assetClass;
    // Resolved at construction (fail at wiring time, not mid-run) and for STOCKS ONLY — a crypto
    // client never sends `feed`, so reading the env var there would let a typo kill it over an unused value
    this.feed =
      options.assetClass === 'stocks'
        ? (options.feed ?? resolveAlpacaDataFeed(process.env[ALPACA_DATA_FEED_ENV_VAR]))
        : undefined;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? ALPACA_BARS_TIMEOUT_MS;
    this.retry = options.retry ?? ALPACA_BARS_RETRY_CONFIG;
    this.rateLimiter = options.rateLimiter;
  }

  /** The feed to send on an equity request. The fallback is deliberately a VALUE, not an omission — dropping it is what produces the 403 `AlpacaDataFeed` exists to prevent. */
  private get equityFeed(): AlpacaDataFeed {
    return this.feed ?? DEFAULT_ALPACA_DATA_FEED;
  }

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.apiKey,
      'APCA-API-SECRET-KEY': this.apiSecret,
    };
  }

  private async requestJson(url: string, context: string): Promise<unknown> {
    return withRetry(
      async () => {
        // Inside the retry body, not outside: a retried attempt is a second request against the same
        // per-account budget. `acquireBackground` yields to the order path so a bar sweep cannot delay a protective leg.
        await this.rateLimiter?.acquireBackground();

        let response: Response;
        try {
          response = await fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
        } catch (cause) {
          throw classifyAlpacaDataNetworkError(cause, context);
        }

        if (!response.ok) {
          throw await classifyAlpacaDataResponse(response, context);
        }

        try {
          return await response.json();
        } catch (cause) {
          throw new AlpacaDataProviderError(
            `Alpaca API error: response body could not be parsed as JSON (${context}): ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      },
      this.retry,
      isRetryableAlpacaDataError,
    );
  }

  /** Ascending bars in `[asOf - windowMs, asOf]`, every page followed. Trimming to a caller's `limit` and deciding what a short range means are `getBars`'s job, not this one's. */
  private async fetchRange(
    symbol: string,
    timeframe: string,
    asOf: Date,
    windowMs: number,
  ): Promise<AlpacaBar[]> {
    const alpacaTimeframe = toAlpacaTimeframe(timeframe);
    const start = new Date(asOf.getTime() - windowMs);
    const alpacaSymbol = this.assetClass === 'crypto' ? toAlpacaCryptoSymbol(symbol) : symbol;

    // Scale the page cap with the window actually searched, not a fixed constant, so a large
    // legitimate request can't trip the malformed/cyclical-token guard; +2 pages absorbs boundary rounding
    const maxPages = Math.max(
      MAX_PAGES,
      Math.ceil(windowMs / timeframeToMs(timeframe) / PAGE_SIZE) + 2,
    );

    const out: AlpacaBar[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    do {
      pages++;
      if (pages > maxPages) {
        throw new AlpacaDataProviderError(
          `AlpacaHttpDataClient.getBars: exceeded ${maxPages} pages for ${symbol} — refusing to ` +
            'follow next_page_token further (malformed/cyclical pagination guard).',
        );
      }

      const params = new URLSearchParams({
        timeframe: alpacaTimeframe,
        start: start.toISOString(),
        end: asOf.toISOString(),
        sort: 'asc',
        limit: String(PAGE_SIZE),
      });
      if (pageToken !== undefined) params.set('page_token', pageToken);

      if (this.assetClass === 'crypto') {
        params.set('symbols', alpacaSymbol);
        const body = requireResponseObject(
          await this.requestJson(
            `${this.baseUrl}/${ALPACA_CRYPTO_API_VERSION}/crypto/us/bars?${params.toString()}`,
            'getBars',
          ),
          'getBars',
        ) as CryptoBarsResponse;
        // `?? undefined` folds an explicit `bars: null` into the "no key" branch `lookupCryptoKey` already handles.
        const rawBars = lookupCryptoKey(body.bars ?? undefined, alpacaSymbol, symbol);
        for (const raw of requireBarsArray(rawBars, symbol, 'getBars')) {
          out.push(toAlpacaBar(validateRawAlpacaBar(raw, symbol, 'getBars')));
        }
        // A wrong-typed `next_page_token` degrades to "no more pages" — caught by the existing widen-and-retry sparse-data path
        pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
      } else {
        // Stocks only — without this every equity bars request 403s, since `end` is always `clock.now()`. See `AlpacaDataFeed`.
        params.set('feed', this.equityFeed);
        const body = requireResponseObject(
          await this.requestJson(
            `${this.baseUrl}/${ALPACA_STOCKS_API_VERSION}/stocks/${encodeURIComponent(
              symbol,
            )}/bars?${params.toString()}`,
            'getBars',
          ),
          'getBars',
        ) as StocksBarsResponse;
        for (const raw of requireBarsArray(body.bars, symbol, 'getBars')) {
          out.push(toAlpacaBar(validateRawAlpacaBar(raw, symbol, 'getBars')));
        }
        pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
      }
    } while (pageToken !== undefined);

    return out;
  }

  /**
   * The most recent `limit` bars at or before `asOf`. Short reads fail loudly
   * rather than silently serving `computeIndicator` too few bars: exactly one
   * retry over a wider window (`RETRY_WIDEN_FACTOR`, floored at
   * `RETRY_MIN_WINDOW_MS`, bounded by `RETRY_MAX_ROWS`) separates a merely-too-
   * narrow buffer from a genuinely sparse symbol. `partial: 'allow'` opts out
   * (and skips the retry) for a caller that can reason about a short window.
   */
  async getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial: 'error' | 'allow' = 'error',
  ): Promise<AlpacaBar[]> {
    // `slice(-0)` is `slice(0)` — the whole array, not none of it — so this is guarded explicitly
    if (limit <= 0) return [];

    const timeframeMs = timeframeToMs(timeframe);
    const bufferMs = timeframeMs * limit * BUFFER_MULTIPLIER;
    // Small-`limit` daily requests still need a few calendar days of headroom to cross a weekend
    const minBufferMs = isDailyTimeframe(timeframe) ? 4 * 86_400_000 : 0;
    const windowMs = Math.max(bufferMs, minBufferMs);

    const first = await this.fetchRange(symbol, timeframe, asOf, windowMs);
    if (first.length >= limit || partial === 'allow') return first.slice(-limit);

    const widenedMs = Math.min(
      Math.max(windowMs * RETRY_WIDEN_FACTOR, RETRY_MIN_WINDOW_MS),
      RETRY_MAX_ROWS * timeframeMs,
    );
    // No room left under the ceiling — don't spend a second full page walk re-reading a subset of the first attempt
    const searched =
      widenedMs > windowMs ? await this.fetchRange(symbol, timeframe, asOf, widenedMs) : first;
    if (searched.length >= limit) return searched.slice(-limit);

    throw new AlpacaDataUnderfetchError({
      symbol,
      timeframe,
      requested: limit,
      received: searched.length,
      searchedFrom: new Date(asOf.getTime() - Math.max(windowMs, widenedMs)).toISOString(),
      searchedTo: asOf.toISOString(),
    });
  }

  async getLatestQuote(symbol: string): Promise<AlpacaQuote> {
    if (this.assetClass === 'crypto') {
      const alpacaSymbol = toAlpacaCryptoSymbol(symbol);
      const params = new URLSearchParams({ symbols: alpacaSymbol });
      const body = requireResponseObject(
        await this.requestJson(
          `${this.baseUrl}/${ALPACA_CRYPTO_API_VERSION}/crypto/us/latest/quotes?${params.toString()}`,
          'getLatestQuote',
        ),
        'getLatestQuote',
      ) as CryptoLatestQuoteResponse;
      const quote = lookupCryptoKey(body.quotes ?? undefined, alpacaSymbol, symbol);
      if (quote === undefined) {
        throw new AlpacaDataProviderError(
          `AlpacaHttpDataClient.getLatestQuote: no quote for ${symbol} in crypto response`,
        );
      }
      const validated = validateRawAlpacaQuote(quote, symbol, 'getLatestQuote');
      return { t: validated.t, ap: validated.ap, bp: validated.bp };
    }

    // Passed explicitly: the mark and the bars an indicator is computed from must come from the same tape
    const quoteParams = new URLSearchParams({ feed: this.equityFeed });
    const body = requireResponseObject(
      await this.requestJson(
        `${this.baseUrl}/${ALPACA_STOCKS_API_VERSION}/stocks/${encodeURIComponent(
          symbol,
        )}/quotes/latest?${quoteParams.toString()}`,
        'getLatestQuote',
      ),
      'getLatestQuote',
    ) as StocksLatestQuoteResponse;
    if (body.quote === undefined) {
      throw new AlpacaDataProviderError(
        `AlpacaHttpDataClient.getLatestQuote: no quote for ${symbol} in stocks response`,
      );
    }
    const validated = validateRawAlpacaQuote(body.quote, symbol, 'getLatestQuote');
    return { t: validated.t, ap: validated.ap, bp: validated.bp };
  }
}
