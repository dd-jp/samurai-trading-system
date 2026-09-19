import type { RetryConfig, TokenBucket } from '../../../shared/index.js';
import {
  fetchWithTimeout,
  isFiniteNumber,
  truncateForError,
  withRetry,
} from '../../../shared/index.js';
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
const ALPACA_CRYPTO_API_VERSION = 'v1beta3';
const ALPACA_STOCKS_API_VERSION = 'v2';
export const ALPACA_BARS_TIMEOUT_MS = 10_000;
export const ALPACA_BARS_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};
const MAX_PAGES = 25;
const PAGE_SIZE = 1_000;
const BUFFER_MULTIPLIER = 8;
const RETRY_WIDEN_FACTOR = 4;
const RETRY_MIN_WINDOW_MS = 10 * 86_400_000;
const RETRY_MAX_ROWS = MAX_PAGES * PAGE_SIZE;

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

function requireResponseObject(body: unknown, context: string): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed response body (${context}): expected an object, got ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

function requireBarsArray(value: unknown, symbol: string, context: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed bars array for ${symbol} (${context}): expected an array, ` +
      `got ${truncateForError(JSON.stringify(value))}`,
  );
}

function toBarsPage(
  rawBars: unknown,
  symbol: string,
  nextPageTokenRaw: unknown,
): { bars: AlpacaBar[]; nextPageToken: string | undefined } {
  const bars: AlpacaBar[] = [];
  for (const raw of requireBarsArray(rawBars, symbol, 'getBars')) {
    bars.push(toAlpacaBar(validateRawAlpacaBar(raw, symbol, 'getBars')));
  }
  const nextPageToken = typeof nextPageTokenRaw === 'string' ? nextPageTokenRaw : undefined;
  return { bars, nextPageToken };
}

export function toAlpacaTimeframe(timeframe: string): string {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) {
    throw new Error(`AlpacaHttpDataClient: unsupported timeframe '${timeframe}'`);
  }
  const [, count, unit] = match;
  const unitName = unit === 'm' ? 'Min' : unit === 'h' ? 'Hour' : 'Day';
  return `${count}${unitName}`;
}

export function toAlpacaCryptoSymbol(symbol: string): string {
  return symbol.endsWith('-USD') ? `${symbol.slice(0, -'-USD'.length)}/USD` : symbol;
}

function lookupCryptoKey<T>(
  byKey: Record<string, T | undefined> | undefined,
  alpacaSymbol: string,
  originalSymbol: string,
): T | undefined {
  if (byKey === undefined) return undefined;
  if (byKey[alpacaSymbol] !== undefined) return byKey[alpacaSymbol];
  return byKey[originalSymbol];
}

export type AlpacaDataFeed = 'iex' | 'sip';

export const DEFAULT_ALPACA_DATA_FEED: AlpacaDataFeed = 'iex';

export const ALPACA_DATA_FEED_ENV_VAR = 'ALPACA_DATA_FEED';

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
  assetClass: 'crypto' | 'stocks';
  feed?: AlpacaDataFeed;
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  rateLimiter?: TokenBucket | undefined;
}

export class AlpacaHttpDataClient implements AlpacaMarketDataClient {
  private readonly assetClass: 'crypto' | 'stocks';
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

  private async fetchCryptoBarsPage(
    symbol: string,
    alpacaSymbol: string,
    params: URLSearchParams,
  ): Promise<{ bars: AlpacaBar[]; nextPageToken: string | undefined }> {
    params.set('symbols', alpacaSymbol);
    const body = requireResponseObject(
      await this.requestJson(
        `${this.baseUrl}/${ALPACA_CRYPTO_API_VERSION}/crypto/us/bars?${params.toString()}`,
        'getBars',
      ),
      'getBars',
    ) as CryptoBarsResponse;
    const rawBars = lookupCryptoKey(body.bars ?? undefined, alpacaSymbol, symbol);
    return toBarsPage(rawBars, symbol, body.next_page_token);
  }

  private async fetchStocksBarsPage(
    symbol: string,
    params: URLSearchParams,
  ): Promise<{ bars: AlpacaBar[]; nextPageToken: string | undefined }> {
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
    return toBarsPage(body.bars, symbol, body.next_page_token);
  }

  private async fetchRange(
    symbol: string,
    timeframe: string,
    asOf: Date,
    windowMs: number,
  ): Promise<AlpacaBar[]> {
    const alpacaTimeframe = toAlpacaTimeframe(timeframe);
    const start = new Date(asOf.getTime() - windowMs);
    const alpacaSymbol = this.assetClass === 'crypto' ? toAlpacaCryptoSymbol(symbol) : symbol;

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

      const page =
        this.assetClass === 'crypto'
          ? await this.fetchCryptoBarsPage(symbol, alpacaSymbol, params)
          : await this.fetchStocksBarsPage(symbol, params);
      out.push(...page.bars);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    return out;
  }

  async getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial: 'error' | 'allow' = 'error',
  ): Promise<AlpacaBar[]> {
    if (limit <= 0) return [];

    const timeframeMs = timeframeToMs(timeframe);
    const bufferMs = timeframeMs * limit * BUFFER_MULTIPLIER;
    const minBufferMs = isDailyTimeframe(timeframe) ? 4 * 86_400_000 : 0;
    const windowMs = Math.max(bufferMs, minBufferMs);

    const first = await this.fetchRange(symbol, timeframe, asOf, windowMs);
    if (first.length >= limit || partial === 'allow') return first.slice(-limit);

    const widenedMs = Math.min(
      Math.max(windowMs * RETRY_WIDEN_FACTOR, RETRY_MIN_WINDOW_MS),
      RETRY_MAX_ROWS * timeframeMs,
    );
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
