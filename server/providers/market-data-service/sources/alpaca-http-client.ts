/**
 * Real market-data `AlpacaMarketDataClient` (ticket #273) — see
 * docs/specs/transport-layer-spec.md ("Module: AlpacaMarketDataClient (market
 * data)"), Wayfinder map "Live Transport Layer" #259 (closed), decision
 * #260, and docs/research/32-vendor-api-reference.md.
 *
 * Implements `alpaca-source.ts`'s `AlpacaMarketDataClient` (`getBars`/
 * `getLatestQuote`) against Alpaca's Market Data API v2. No interface
 * change — this module only supplies the real HTTP implementation
 * `AlpacaDataSource` is already injected against.
 *
 * **No paper/live environment guard here, deliberately (#293).** The broker
 * client (execution/adapters/alpaca-http-client.ts) carries an `environment`
 * option because its two hosts spend different money. Market data has one
 * host — `https://data.alpaca.markets` serves paper and live accounts
 * alike — so there is no environment to get wrong and nothing an operator
 * could point this client at that would place an order. The asset-class split
 * below is this client's only construction-time routing decision. Do not add a
 * parallel `environment` option here for symmetry's sake: an option with no
 * failure mode behind it teaches readers that the broker client's option is
 * also ceremonial.
 *
 * **Crypto/equity is a path-root split, not a query parameter** (spec) — and
 * the two roots are on DIFFERENT API VERSIONS (issue #358):
 *   - equities: `GET /v2/stocks/{symbol}/bars`, `GET /v2/stocks/{symbol}/quotes/latest`
 *   - crypto:   `GET /v1beta3/crypto/us/bars`,  `GET /v1beta3/crypto/us/latest/quotes`
 * (`symbols=` query param for the multi-symbol crypto endpoints, `symbol`
 * embedded in the path for the single-symbol equity endpoints.)
 *
 * The crypto root shipped as `/v2/crypto/us/...` — a guess from the #260
 * research note, and wrong. `/v2` 404s for crypto; `/v1beta3` is the live root.
 * Because `MarketDataServiceImpl.getBars` fetches before it appends, the 404
 * threw away every bar before anything was written, the mandatory technical
 * analyst failed, and the tick surfaced as a quiet `analysts: quorum_skip` —
 * a hard outage wearing the costume of a considered no-trade. Nothing in a
 * unit test could catch it, so `ALPACA_CRYPTO_API_VERSION` /
 * `ALPACA_STOCKS_API_VERSION` below are pinned by name in
 * `alpaca-http-client.test.ts` ("API version segment (issue #358)") against the
 * live status codes recorded there.
 *
 * The neither-broker-nor-data-source-currently-passes-`asset_class`-to-the-
 * client shape (`AlpacaMarketDataClient.getBars`/`getLatestQuote` take no asset-class
 * argument — see alpaca-source.ts) means the routing choice has to be made
 * at construction time: one `AlpacaHttpDataClient` instance is scoped to one
 * asset class via `AlpacaHttpDataClientOptions.assetClass`, and
 * composition code is expected to construct one client per `AlpacaDataSource`
 * (which is itself already one-per-asset-class, see `AlpacaSourceOptions.asset_class`).
 *
 * **Crypto symbol format — VERIFIED (2026-08-05, issue #358).** This repo's
 * universe uses `BTC-USD`; Alpaca's crypto endpoints use a slash (`BTC/USD`),
 * and `toAlpacaCryptoSymbol` does that translation. Confirmed against a live
 * paper account: `symbols=BTC/USD` returns `200` with the response keyed by
 * exactly the string sent, and any other separator is rejected outright —
 * `symbols=BTC-USD` is a `400` carrying
 * `{"message":"invalid symbol: BTC-USD does not match ^[A-Z]+x?/[A-Z]+$"}`.
 * That regex is the whole story: the wire format is not a guess any more.
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
/**
 * Alpaca versions its two data roots independently, and crypto is NOT on `/v2`
 * (issue #358). Verified against the live API with paper credentials on
 * 2026-08-05 — the `404`s are the reason these are named constants rather than
 * inline path literals, and the reason the test file asserts on the segment:
 *
 *   GET /v2/crypto/us/bars                -> 404
 *   GET /v1beta3/crypto/us/bars           -> 200
 *   GET /v2/crypto/us/latest/quotes       -> 404
 *   GET /v1beta3/crypto/us/latest/quotes  -> 200
 *   GET /v2/stocks/{symbol}/bars          -> 200
 *   GET /v2/stocks/{symbol}/quotes/latest -> 200
 *
 * Re-verify against a live account before changing either — the whole point of
 * this ticket is that the docs were not sufficient evidence.
 */
const ALPACA_CRYPTO_API_VERSION = 'v1beta3';
const ALPACA_STOCKS_API_VERSION = 'v2';
/**
 * Exported (#1542) so `deriveAnalystTimeoutMs`'s fetch-bound floor is computed
 * from these actual bars-fetch constants rather than a re-guessed literal.
 * Named distinctly from the identically-shaped pair in
 * `pipeline/execution/adapters/{alpaca,saxo}-http-client.ts` — those are separate
 * private copies of the same `withRetry` convention (transport-layer-spec.md),
 * not this module's constants under another name, so a bare `DEFAULT_*` name
 * would have been a collision waiting to happen in any shared barrel.
 */
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
/**
 * How many `timeframe`-widths back of `asOf` to search for `limit` bars.
 * Generous on purpose: daily bars only land ~5/7 days (weekends) and lose
 * more to holidays; intraday equity bars only land within the trading
 * session (a fraction of the 24h day); crypto bars are 24/7 so the buffer is
 * pure headroom there. Getting this too small silently returns fewer than
 * `limit` bars instead of a loud failure, so it errs wide.
 *
 * **This is an optimization, not the guarantee (issue #386).** Raising it was
 * the candidate fix for #386 and was REJECTED: no value of it can be a
 * guarantee, because it is sized in calendar time against a session density it
 * cannot see, and any value that covered hourly equity bars would over-fetch
 * for crypto and daily ones while still being a calibration that happens to
 * work for one feed and one timeframe. The COMPLETED, IN-SESSION count is
 * guaranteed one layer up instead — see `NormalizingDataSource.fetchBars` for
 * the full account. What this multiplier still buys is requests: the wider it
 * is, the more often that layer is satisfied on its first attempt. Getting it
 * wrong now costs a round trip, not a wrong number.
 */
const BUFFER_MULTIPLIER = 8;
/**
 * Widening factor for the one retry a short first read earns (issue #292).
 * BUFFER_MULTIPLIER's headroom assumes a roughly-continuous trading calendar;
 * an extremely sparse symbol (a multi-week halt, a fresh listing) breaks that
 * assumption and the first window comes back short.
 */
const RETRY_WIDEN_FACTOR = 4;
/**
 * Calendar-time floor for that retry, because a purely multiplicative widen
 * cannot escape a weekend at small `limit`s: `1h`/`limit=1` searches 8 hours,
 * and 8x4 = 32 hours still lands entirely inside a Saturday. Ten days clears
 * any US equity weekend plus an adjacent holiday, which is the difference
 * between "our window was too narrow" (fixable, and this fixes it) and "the
 * symbol genuinely has no bars there" (not fixable — that throws).
 */
const RETRY_MIN_WINDOW_MS = 10 * 86_400_000;
/**
 * Hard ceiling on the retry's page walk, expressed in rows so it holds across
 * timeframes. Without it a large `limit` turns the widened window into a very
 * long paginated crawl (`1m`/`limit=5_000` widens to ~111 days ≈ 160k rows ≈
 * 160 sequential requests) against a ~200 req/min budget shared with the broker
 * API — one failing `getBars` could starve live order placement. A request that
 * already came back short from its own generous window is not going to be
 * rescued by widening anyway, so when the ceiling leaves no room to widen, the
 * retry is skipped and the throw happens immediately.
 */
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

/**
 * Validates and narrows one wire bar before it ever reaches `toAlpacaBar`
 * (issue #509). Prices and volume computed from a non-finite OHLCV field
 * flow silently into an indicator, then a stop distance — there was
 * previously no `Number.isFinite` anywhere in this file. A response body
 * that parses as JSON but has the wrong shape (a missing field, a string
 * where Alpaca's docs promise a number) throws a classified
 * `AlpacaDataProviderError` here instead of an unguarded `undefined`/string
 * riding along as if it were a valid `number`.
 */
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

/**
 * Guards the top-level envelope before any field is read off it — a `null`
 * or non-object body would otherwise throw an unclassified `TypeError` the
 * instant `.bars`/`.quote` is read, rather than the classified
 * `AlpacaDataProviderError` every other failure on this path produces
 */
function requireResponseObject(body: unknown, context: string): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  throw new AlpacaDataProviderError(
    `AlpacaHttpDataClient: malformed response body (${context}): expected an object, got ${truncateForError(
      JSON.stringify(body),
    )}`,
  );
}

/**
 * Validates a raw bars array is actually an array before iterating it —
 * `undefined`/`null` degrade to "no bars" (the existing contract), but any
 * other non-array shape (an object, a string) is a vendor error, not a
 * silently-empty page
 */
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

/**
 * `'BTC-USD'` -> `'BTC/USD'` — believed (unverified, see module doc comment)
 * Alpaca crypto wire format. Any `-USD`-suffixed universe symbol maps;
 * anything else passes through unchanged.
 */
export function toAlpacaCryptoSymbol(symbol: string): string {
  return symbol.endsWith('-USD') ? `${symbol.slice(0, -'-USD'.length)}/USD` : symbol;
}

/**
 * Looks up a keyed crypto response object by the translated Alpaca symbol,
 * falling back to the original untranslated symbol. **Matches by name only —
 * it will not guess** (issue #358 item 3).
 *
 * There used to be a third fallback: "if the response has exactly one key, use
 * whatever it is, whatever it is called." It was written to make the then-
 * unverified `BTC/USD` separator guess degrade gracefully instead of silently
 * returning nothing. Live verification retired that argument on both ends:
 *
 *  - It could never have fired for the case it was written for. A wrong
 *    separator is a hard `400` (`invalid symbol: BTC-USD does not match
 *    ^[A-Z]+x?/[A-Z]+$`), so there is no body to fall back inside of. And on a
 *    correct request Alpaca echoes the key back verbatim, so the first lookup
 *    always hits — the legitimate single-symbol case never needed it.
 *  - What it could do is hand back a DIFFERENT instrument's bars under the
 *    requested instrument's name. Every request this client makes is
 *    single-symbol, so `keys.length === 1` is true on essentially every
 *    response: the guard was never a guard. Prices flow from here into
 *    indicators, stops, and position sizing; serving ETH's prices as BTC's is
 *    strictly worse than serving none, because none is loud (a missing key
 *    becomes `AlpacaDataUnderfetchError` in `getBars`, a thrown
 *    `AlpacaDataProviderError` in `getLatestQuote`) and wrong is not.
 *
 * That is the general rule this ticket exists to enforce: an unverified guess
 * must fail loudly, never degrade into something indistinguishable from a
 * considered decision.
 */
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
 * Equity market-data feed. **Stocks only** — Alpaca's crypto endpoints take no
 * `feed` parameter, and passing one there is meaningless.
 *
 * `iex` by default, and that default is load-bearing rather than cautious
 * (#381). Verified against the live API on 2026-08-05, read-only:
 *
 * ```
 * end=now   feed=default  403  subscription does not permit querying recent SIP data
 * end=T-14m feed=default  403  subscription does not permit querying recent SIP data
 * end=T-16m feed=default  200
 * end=now   feed=iex      200
 * ```
 *
 * Alpaca's default equity feed is SIP, and a Basic (free) subscription — which
 * is what an Alpaca paper account has — is refused SIP data from the last 15
 * minutes. `MarketDataServiceImpl.getBars` always passes `asOf = clock.now()`,
 * so **every** equity bars request in the pipeline lands inside that window:
 * the trader's ATR(14) on `atr_timeframe`, the correlation window, the ADV
 * window. On the default feed the widened universe would 403 on all four
 * equities on every tick — a failure that looks like four instruments quietly
 * finding no setup, which is the #358 shape exactly.
 *
 * `iex` is served in real time to the same subscription and needs no clock
 * games (the alternative — backdating `end` by 15 minutes — would silently
 * make every equity decision act on stale bars while reporting them as
 * current). An operator holding a SIP subscription sets `ALPACA_DATA_FEED=sip`;
 * the default has to be the one that works on the account the project has.
 *
 * The cost is real and is not hidden: IEX is a single venue with a small share
 * of consolidated volume, so equity bar volumes are a fraction of the true tape
 * and the ADV-derived market-impact term reads low. That is a calibration
 * caveat for the soak, not a correctness bug — and it is strictly better than
 * no equity bars at all.
 */
export type AlpacaDataFeed = 'iex' | 'sip';

/** Default equity feed — see `AlpacaDataFeed` for why it is not Alpaca's own default */
export const DEFAULT_ALPACA_DATA_FEED: AlpacaDataFeed = 'iex';

/** The operator's override. Read once, at construction. */
export const ALPACA_DATA_FEED_ENV_VAR = 'ALPACA_DATA_FEED';

/**
 * Unrecognised values are refused rather than passed to the wire: a typo'd
 * `ALPACA_DATA_FEED=sipp` would otherwise be forwarded, rejected by Alpaca as
 * a query error, and read as a data outage on every equity tick
 */
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
   * Outbound pacing, SHARED with the broker adapter (#391).
   *
   * Alpaca's 200 req/min is per ACCOUNT, so this client and
   * `AlpacaBrokerAdapter` spend one budget. Before #391 only the broker was
   * paced and this client could exceed the headroom reserved for it freely —
   * with six instruments (#381) and #386's bounded widen-and-retry, a single
   * cold sweep is a burst that earns the 429 for the ORDER path.
   *
   * Calls made here take `acquireBackground()`, so a bar burst can never park
   * an order behind the refill (`TokenBucket.reserveForPriority`).
   *
   * Optional: left unset, the client is unpaced, which is what every existing
   * unit test wants. The composition root always supplies it — see
   * `buildAlpacaDataSource`.
   */
  rateLimiter?: TokenBucket | undefined;
}

/** Real HTTP market-data `AlpacaMarketDataClient` against Alpaca's Market Data API v2 */
export class AlpacaHttpDataClient implements AlpacaMarketDataClient {
  private readonly assetClass: 'crypto' | 'stocks';
  /**
   * Resolved for a STOCKS client only, and `undefined` for crypto — see the
   * constructor for why an unused env var must not be able to fail a boot
   */
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
    // Resolved at construction, not per request: an unrecognised value must
    // fail at wiring time rather than on the first equity tick, and a mid-run
    // environment edit must not change the tape underneath a running process
    //
    // Resolved for STOCKS ONLY, which keeps the field honest against its own
    // "Ignored for crypto" contract. A crypto client never sends `feed` — the
    // crypto endpoints take no such parameter — so reading the variable here
    // would let a typo'd `ALPACA_DATA_FEED` kill a crypto-only process over a
    // value it would never use
    //
    // This does NOT weaken the fail-fast posture, because the failure moves to
    // the client that would actually use the value rather than disappearing:
    // `resolveAlpacaDataFeed` accepts only `iex`/`sip`, so a malformed value
    // can never become a *wrong feed* — it can only throw. The day equities
    // enter the universe, `buildAlpacaDataSource` constructs a stocks client
    // (both of them, for a mixed universe) and that constructor throws at boot,
    // naming the variable. The window in which a typo goes unnoticed is exactly
    // the window in which it is inert
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

  /**
   * The feed to send on an equity request. Non-null by construction on every
   * path that calls this — the constructor resolves it whenever
   * `assetClass === 'stocks'`, and only the stocks branches read it.
   *
   * The fallback is deliberately a VALUE and not an omission: dropping the
   * parameter is what produces the 403 this option exists to prevent
   * (`AlpacaDataFeed`), so a future refactor that reached here from an
   * unexpected path should still send a working feed rather than silently
   * restore the outage.
   */
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
        // INSIDE the retry body, not outside it (#391): a retried attempt is a
        // second request against the same per-account budget, and pacing only
        // the first attempt would let a degraded venue — the exact moment
        // #386's widen-and-retry also fires — burst through the bucket
        //
        // `acquireBackground` yields to the order path: market data waits for
        // the reserve to be re-minted on top of its own token, so a bar sweep
        // can be late but cannot delay a protective leg
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
    // `?? undefined` folds an explicit `bars: null` into the same
    // "no key" branch `lookupCryptoKey` already handles — it only guards
    // `undefined`, and a malformed body sending `null` would otherwise
    // throw an unclassified TypeError reading `byKey[alpacaSymbol]`
    const rawBars = lookupCryptoKey(body.bars ?? undefined, alpacaSymbol, symbol);
    const bars: AlpacaBar[] = [];
    for (const raw of requireBarsArray(rawBars, symbol, 'getBars')) {
      bars.push(toAlpacaBar(validateRawAlpacaBar(raw, symbol, 'getBars')));
    }
    // A wrong-typed `next_page_token` degrades to "no more pages" rather
    // than throwing: an early stop here is exactly the short-read case
    // `getBars`'s widen-and-retry (RETRY_WIDEN_FACTOR) already exists to
    // recover, so it is caught by the existing sparse-data path instead
    // of a second bespoke guard
    const nextPageToken =
      typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
    return { bars, nextPageToken };
  }

  private async fetchStocksBarsPage(
    symbol: string,
    params: URLSearchParams,
  ): Promise<{ bars: AlpacaBar[]; nextPageToken: string | undefined }> {
    // Stocks only — Alpaca's crypto endpoints take no `feed`. Without this
    // every equity bars request 403s, because `end` is always `clock.now()`
    // and a Basic subscription cannot read SIP data under 15 minutes old
    // See `AlpacaDataFeed` for the live status codes
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
    const bars: AlpacaBar[] = [];
    for (const raw of requireBarsArray(body.bars, symbol, 'getBars')) {
      bars.push(toAlpacaBar(validateRawAlpacaBar(raw, symbol, 'getBars')));
    }
    const nextPageToken =
      typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
    return { bars, nextPageToken };
  }

  /**
   * Ascending bars in `[asOf - windowMs, asOf]`, every page followed.
   * Returns everything the range holds — trimming to a caller's `limit` and
   * deciding what a short range means are `getBars`'s job, not this one's.
   */
  private async fetchRange(
    symbol: string,
    timeframe: string,
    asOf: Date,
    windowMs: number,
  ): Promise<AlpacaBar[]> {
    const alpacaTimeframe = toAlpacaTimeframe(timeframe);
    const start = new Date(asOf.getTime() - windowMs);
    const alpacaSymbol = this.assetClass === 'crypto' ? toAlpacaCryptoSymbol(symbol) : symbol;

    // The calendar-time window can, for large `limit`, hold many more rows than
    // `limit` itself (worst case ~`BUFFER_MULTIPLIER`x, at density 1 for 24/7
    // crypto) — a fixed page cap sized for typical small lookbacks would then
    // trip on a legitimate large request before a malformed/cyclical token ever
    // could. Scale the cap with the window actually being searched instead (so
    // a widened retry gets a widened cap, not the first attempt's); +2 pages of
    // slack absorbs boundary rounding without weakening the loop guard itself
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

  /**
   * The most recent `limit` bars at or before `asOf`.
   *
   * **Short reads fail loudly (issue #292).** `BUFFER_MULTIPLIER`'s window is
   * sized against a roughly-continuous trading calendar; a sparse symbol (a
   * multi-week halt, a fresh listing, a thinly-quoted ticker) breaks that and
   * the range comes back with fewer than `limit` bars. Returning that quietly
   * is the failure this repo keeps getting bitten by: `computeIndicator` has
   * no minimum-length guard, so an SMA/RSI/ATR over 3 bars is served as one
   * over `limit` bars, and a mispriced stop follows from it.
   *
   * The fixable case is separated from the unsatisfiable one by RETRYING
   * ONCE over a wider window (`RETRY_WIDEN_FACTOR`, floored at
   * `RETRY_MIN_WINDOW_MS` so the retry can actually clear a weekend) rather
   * than by guessing from the response: "our buffer was too narrow" then
   * resolves itself, and only a genuinely-sparse symbol reaches the throw.
   * Exactly one retry, and only within `RETRY_MAX_ROWS` — a widening loop (or
   * an unbounded single widen at large `limit`) against a symbol with no
   * history would walk back years of pages for nothing, on a rate-limit budget
   * shared with live order placement.
   *
   * `partial: 'allow'` opts out for a caller that can reason about a short
   * window (the Risk Manager's correlation estimate, whose `min_bars` check
   * already omits an under-covered pair); it skips the retry too, so an
   * opted-in caller costs exactly one request, as before. `asOf` is never
   * widened — only `start` moves, so point-in-time discipline is untouched.
   */
  async getBars(
    symbol: string,
    timeframe: string,
    asOf: Date,
    limit: number,
    partial: 'error' | 'allow' = 'error',
  ): Promise<AlpacaBar[]> {
    // `slice(-0)` is `slice(0)` — the WHOLE array, not none of it. Guarded
    // rather than relied upon: a `lookback: 0` window is operator config away
    if (limit <= 0) return [];

    const timeframeMs = timeframeToMs(timeframe);
    const bufferMs = timeframeMs * limit * BUFFER_MULTIPLIER;
    // Small-`limit` daily requests still need at least a few calendar days of
    // headroom to cross a weekend; the multiplier alone can underflow at limit=1
    const minBufferMs = isDailyTimeframe(timeframe) ? 4 * 86_400_000 : 0;
    const windowMs = Math.max(bufferMs, minBufferMs);

    const first = await this.fetchRange(symbol, timeframe, asOf, windowMs);
    if (first.length >= limit || partial === 'allow') return first.slice(-limit);

    const widenedMs = Math.min(
      Math.max(windowMs * RETRY_WIDEN_FACTOR, RETRY_MIN_WINDOW_MS),
      RETRY_MAX_ROWS * timeframeMs,
    );
    // No room left under the ceiling — don't spend a second full page walk to
    // re-read a subset of what the first attempt already searched
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

    // Passed explicitly even though this endpoint already defaults to IEX for a
    // Basic subscription: the mark and the bars an indicator is computed from
    // must come from the same tape, or an ATR-derived stop is priced against a
    // venue the mark never saw
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
