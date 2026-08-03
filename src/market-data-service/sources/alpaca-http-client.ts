/**
 * Real market-data `AlpacaClient` (ticket #273) — see
 * docs/specs/transport-layer-spec.md ("Module: AlpacaClient (market
 * data)"), Wayfinder map "Live Transport Layer" #259 (closed), decision
 * #260, and docs/research/alpaca-rest-api-surface-2026-07-29.md.
 *
 * Implements `alpaca-source.ts`'s `AlpacaClient` (`getBars`/
 * `getLatestQuote`) against Alpaca's Market Data API v2. No interface
 * change — this module only supplies the real HTTP implementation
 * `AlpacaDataSource` is already injected against.
 *
 * **Crypto/equity is a path-root split, not a query parameter** (spec):
 *   - equities: `GET /v2/stocks/{symbol}/bars`, `GET /v2/stocks/{symbol}/quotes/latest`
 *   - crypto:   `GET /v2/crypto/us/bars`,        `GET /v2/crypto/us/latest/quotes`
 * (`symbols=` query param for the multi-symbol crypto endpoints, `symbol`
 * embedded in the path for the single-symbol equity endpoints.)
 *
 * The neither-broker-nor-data-source-currently-passes-`asset_class`-to-the-
 * client shape (`AlpacaClient.getBars`/`getLatestQuote` take no asset-class
 * argument — see alpaca-source.ts) means the routing choice has to be made
 * at construction time: one `AlpacaHttpDataClient` instance is scoped to one
 * asset class via `AlpacaHttpDataClientOptions.assetClass`, and
 * composition code is expected to construct one client per `AlpacaDataSource`
 * (which is itself already one-per-asset-class, see `AlpacaSourceOptions.asset_class`).
 *
 * **Crypto symbol format — UNVERIFIED.** This repo's universe uses
 * `BTC-USD`; Alpaca's crypto endpoints are believed (public docs, not
 * confirmed against a live account) to use a slash (`BTC/USD`). `toAlpacaCryptoSymbol`
 * does that translation for the request, and the response-key lookup falls
 * back to the raw untranslated symbol, then to whatever single key the
 * `bars`/`quotes` object actually carries, so a wrong guess about the exact
 * separator degrades to "still works" rather than "silently returns empty" —
 * but the format itself needs confirming against a real paper account before
 * this is trusted (see this ticket's PR description).
 *
 * **Timeframe translation.** This codebase's canonical timeframe strings are
 * `'1m' | '5m' | '1h' | '1d'` (`timeframe.ts`'s `timeframeToMs`/
 * `isDailyTimeframe`) — NOT Alpaca's own `1Min`/`1Hour`/`1Day` query-param
 * vocabulary the #260 research note assumed would pass through opaquely.
 * `toAlpacaTimeframe` below does that translation; getting it wrong would
 * have silently 422'd every bars request rather than returning wrong data,
 * so this is at least a loud failure if the mapping is ever incomplete.
 *
 * **`getBars` date range, ordering, and pagination.** Alpaca's bars
 * endpoints return ascending-order rows within `[start, end]`; given only an
 * `end` + a `limit` cap (no `start`), Alpaca returns the *oldest* rows at or
 * before `end`, not the most recent `limit` — the opposite of what
 * `AlpacaDataSource.fetchRawCandles`/`completedBars`'s `slice(-lookback)`
 * need. So `start` is derived here from `asOf - timeframe*limit*bufferMultiplier`
 * (a generous multiplier — see `BUFFER_MULTIPLIER` — covering weekends/
 * holidays for daily bars and session-hours-vs-24h for intraday equity
 * bars), `sort=asc` is passed explicitly, every page in range is followed
 * (bounded by `MAX_PAGES`, same defensive shape as `HttpPolygonClient`'s
 * `next_url` loop, #266), and the final ascending array is trimmed to the
 * most recent `limit` rows via `.slice(-limit)`.
 *
 * **Auth.** `APCA-API-KEY-ID`/`APCA-API-SECRET-KEY` headers, defaulting to
 * `ALPACA_API_KEY`/`ALPACA_API_SECRET` — same env vars and header names as
 * the broker client (execution/adapters/alpaca-http-client.ts), per public
 * docs' one-key-pair-covers-both-APIs claim (unconfirmed against a live
 * account — see this ticket's PR description).
 *
 * Uses `fetchWithTimeout`/`withRetry` (issue #271, shared/http/), retry
 * config sized the same as the broker client (Alpaca's ~200 req/min is a
 * per-key limit shared across both APIs, not a separate budget per client).
 */

import type { RetryConfig } from '../../shared/index.js';
import { fetchWithTimeout, withRetry } from '../../shared/index.js';
import { isDailyTimeframe, timeframeToMs } from '../timeframe.js';
import {
  AlpacaDataProviderError,
  classifyAlpacaDataNetworkError,
  classifyAlpacaDataResponse,
  isRetryableAlpacaDataError,
} from './alpaca-data-errors.js';
import type { AlpacaBar, AlpacaClient, AlpacaQuote } from './alpaca-source.js';

const DEFAULT_BASE_URL = 'https://data.alpaca.markets';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Same sizing as the broker client — one Alpaca key's ~200 req/min budget is shared across both APIs. */
const DEFAULT_RETRY_CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
/** Guards against a malformed/cyclical `next_page_token` spinning forever — mirrors `HttpPolygonClient`'s `MAX_PAGES`. */
const MAX_PAGES = 25;
/** Rows requested per page — well under Alpaca's own page-size cap, unrelated to the caller's `limit`. */
const PAGE_SIZE = 1_000;
/**
 * How many `timeframe`-widths back of `asOf` to search for `limit` bars.
 * Generous on purpose: daily bars only land ~5/7 days (weekends) and lose
 * more to holidays; intraday equity bars only land within the trading
 * session (a fraction of the 24h day); crypto bars are 24/7 so the buffer is
 * pure headroom there. Getting this too small silently returns fewer than
 * `limit` bars instead of a loud failure, so it errs wide.
 */
const BUFFER_MULTIPLIER = 8;

/** Alpaca's raw per-bar shape on the wire — a superset of `AlpacaBar` (also carries `n`, `vw`). */
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

/** `'1m'` -> `'1Min'`, `'5m'` -> `'5Min'`, `'1h'` -> `'1Hour'`, `'1d'` -> `'1Day'` (Alpaca's own vocabulary). */
export function toAlpacaTimeframe(timeframe: string): string {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`AlpacaHttpDataClient: unsupported timeframe '${timeframe}'`);
  }
  const [, count, unit] = match;
  const unitName = unit === 'm' ? 'Min' : unit === 'h' ? 'Hour' : 'Day';
  return `${count}${unitName}`;
}

/**
 * `'BTC-USD'` -> `'BTC/USD'` — believed (unverified, see module doc comment)
 * Alpaca crypto wire format. Any `-USD`-suffixed universe symbol maps;
 * anything else passes through unchanged.
 */
export function toAlpacaCryptoSymbol(symbol: string): string {
  return symbol.endsWith('-USD') ? `${symbol.slice(0, -'-USD'.length)}/USD` : symbol;
}

/**
 * Looks up a keyed crypto response object first by the translated Alpaca
 * symbol, falling back to the original untranslated symbol, and finally to
 * the response's only key (if it has exactly one) — so an unverified
 * separator guess degrades to "still works for a single-symbol request"
 * rather than silently returning nothing.
 */
function lookupCryptoKey<T>(
  byKey: Record<string, T | undefined> | undefined,
  alpacaSymbol: string,
  originalSymbol: string,
): T | undefined {
  if (byKey === undefined) return undefined;
  if (byKey[alpacaSymbol] !== undefined) return byKey[alpacaSymbol];
  if (byKey[originalSymbol] !== undefined) return byKey[originalSymbol];
  const keys = Object.keys(byKey);
  return keys.length === 1 ? byKey[keys[0] as string] : undefined;
}

export interface AlpacaHttpDataClientOptions {
  /** Routes requests through the `/v2/stocks/...` or `/v2/crypto/us/...` path root. */
  assetClass: 'crypto' | 'stocks';
  /** Defaults to `process.env.ALPACA_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  /** Defaults to `process.env.ALPACA_API_SECRET`. Never logged or thrown into an error message. */
  apiSecret?: string;
  /** Defaults to `https://data.alpaca.markets` — one host serves both paper and live accounts. */
  baseUrl?: string;
  /** Per-attempt network timeout passed to `fetchWithTimeout`. */
  timeoutMs?: number;
  retry?: RetryConfig;
}

/** Real HTTP market-data `AlpacaClient` against Alpaca's Market Data API v2. */
export class AlpacaHttpDataClient implements AlpacaClient {
  private readonly assetClass: 'crypto' | 'stocks';
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryConfig;

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
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? DEFAULT_RETRY_CONFIG;
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

  async getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
  ): Promise<AlpacaBar[]> {
    const alpacaTimeframe = toAlpacaTimeframe(timeframe);
    const bufferMs = timeframeToMs(timeframe) * limit * BUFFER_MULTIPLIER;
    // Small-`limit` daily requests still need at least a few calendar days of
    // headroom to cross a weekend; the multiplier alone can underflow at limit=1.
    const minBufferMs = isDailyTimeframe(timeframe) ? 4 * 86_400_000 : 0;
    const start = new Date(asOf.getTime() - Math.max(bufferMs, minBufferMs));
    const alpacaSymbol = this.assetClass === 'crypto' ? toAlpacaCryptoSymbol(symbol) : symbol;

    // `bufferMs`'s calendar-time window can, for large `limit`, hold many more
    // rows than `limit` itself (worst case ~`BUFFER_MULTIPLIER`x, at density 1
    // for 24/7 crypto) — a fixed page cap sized for typical small lookbacks
    // would then trip on a legitimate large request before a malformed/cyclical
    // token ever could. Scale the cap with the request instead; +2 pages of
    // slack absorbs boundary rounding without weakening the loop guard itself.
    const maxPages = Math.max(MAX_PAGES, Math.ceil((limit * BUFFER_MULTIPLIER) / PAGE_SIZE) + 2);

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
        const body = (await this.requestJson(
          `${this.baseUrl}/v2/crypto/us/bars?${params.toString()}`,
          'getBars',
        )) as CryptoBarsResponse;
        for (const raw of lookupCryptoKey(body.bars, alpacaSymbol, symbol) ?? []) {
          out.push(toAlpacaBar(raw));
        }
        pageToken = body.next_page_token ?? undefined;
      } else {
        const body = (await this.requestJson(
          `${this.baseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`,
          'getBars',
        )) as StocksBarsResponse;
        for (const raw of body.bars ?? []) out.push(toAlpacaBar(raw));
        pageToken = body.next_page_token ?? undefined;
      }
    } while (pageToken !== undefined);

    return out.slice(-limit);
  }

  async getLatestQuote(symbol: string): Promise<AlpacaQuote> {
    if (this.assetClass === 'crypto') {
      const alpacaSymbol = toAlpacaCryptoSymbol(symbol);
      const params = new URLSearchParams({ symbols: alpacaSymbol });
      const body = (await this.requestJson(
        `${this.baseUrl}/v2/crypto/us/latest/quotes?${params.toString()}`,
        'getLatestQuote',
      )) as CryptoLatestQuoteResponse;
      const quote = lookupCryptoKey(body.quotes, alpacaSymbol, symbol);
      if (quote === undefined) {
        throw new AlpacaDataProviderError(
          `AlpacaHttpDataClient.getLatestQuote: no quote for ${symbol} in crypto response`,
        );
      }
      return { t: quote.t, ap: quote.ap, bp: quote.bp };
    }

    const body = (await this.requestJson(
      `${this.baseUrl}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      'getLatestQuote',
    )) as StocksLatestQuoteResponse;
    if (body.quote === undefined) {
      throw new AlpacaDataProviderError(
        `AlpacaHttpDataClient.getLatestQuote: no quote for ${symbol} in stocks response`,
      );
    }
    return { t: body.quote.t, ap: body.quote.ap, bp: body.quote.bp };
  }
}
