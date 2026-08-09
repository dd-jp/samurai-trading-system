/**
 * A `PolygonClient` served by the FREE stack instead of Polygon.
 *
 * Why this exists: `HttpPolygonClient` is the only aggregates source Stage 2
 * has ever had, and the Polygon plan serves **two years** against a five-year
 * request. Every Stage 2 verdict to date was therefore computed on ~500 stock
 * bars, and `archive/2026-08-06-stage2-verdict-post-405.md` named sample length as
 * "the one lever that would change this", assuming deeper history had to be
 * bought. It does not: measured 2026-08-07, Alpaca serves SPY daily from
 * **2016-01-04** and Coinbase serves BTC-USD daily from **2015-07-20**, both
 * on keys already held, at £0. See `docs/research/11-trend-signal-measurement.md`
 * for the measurement that used this data directly.
 *
 * ADR-0001 (#494/#499) already designates this stack as primary — Alpaca for
 * equities, Coinbase/Bitstamp for crypto, Polygon free as fallback only — and
 * `#514`'s roadmap records that "Stage 2 still runs one `HttpPolygonClient`,
 * the source ADR-0001 demoted to fallback-only". This closes that gap for the
 * Stage 2 path specifically.
 *
 * **Why not reuse
 * `providers/market-data-service/sources/coinbase-candles-client.ts` or
 * `AlpacaHttpDataClient`.** Both are `(symbol, timeframe, asOf, limit)`-shaped
 * — they answer "the last N bars as of a moment", which is what the live and
 * backfill paths need. The `PolygonClient` seam is window-shaped
 * (`fetchAggregates(symbol, window)`), which is what a replay needs. Adapting
 * either would mean converting a window to a limit and back, and
 * `CoinbaseCandlesClient` additionally has no pagination at all (a single
 * 300-candle request), so a ten-year window could not be expressed through it.
 * The duplication here is the HTTP call shape only; the pacing, validation and
 * error conventions follow `HttpPolygonClient`.
 */

import { TokenBucket } from '../../shared/index.js';
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_ALPACA_BASE_URL = 'https://data.alpaca.markets';
const DEFAULT_COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';

/** Alpaca's documented per-request ceiling for bars. */
const ALPACA_PAGE_LIMIT = 10_000;

/**
 * Coinbase serves at most 300 candles per request and, unlike Alpaca, offers
 * no continuation token — the only way forward is to walk the window in
 * chunks. 290 leaves headroom so a chunk that happens to contain an extra
 * boundary candle is not silently truncated to exactly 300.
 */
const COINBASE_MAX_CANDLES_PER_REQUEST = 300;
const COINBASE_CHUNK_DAYS = 290;

const DAY_MS = 86_400_000;

/**
 * Guards a malformed/cyclical `next_page_token` or a non-advancing chunk walk
 * from spinning forever. Ten years of daily bars is ~37 Coinbase chunks and a
 * single Alpaca page, so this is far above any legitimate run.
 */
const MAX_PAGES = 200;

/** Conservative shared pacing: Alpaca free allows 200 req/min, Coinbase ~10 req/s. */
const DEFAULT_PACING = { capacity: 5, refillPerSecond: 3 } as const;

function truncateForError(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

/**
 * The repo's crypto convention, matching `toPolygonTicker`'s `<BASE>-USD` rule
 * in `http-polygon-client.ts`. Kept as a predicate rather than importing
 * `CRYPTO_SYMBOLS` from `scripts/run-stage2.ts`, which imports this module.
 */
export function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith('-USD');
}

function requireFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Coinbase candle tuple order is `[time, low, high, open, close, volume]`. */
function validateCoinbaseCandle(raw: unknown, symbol: string): PolygonAggregate {
  const bad = (): never => {
    throw new Error(
      `FreeStackAggregatesClient: malformed candle for ${symbol}: ` +
        truncateForError(JSON.stringify(raw)),
    );
  };
  if (!Array.isArray(raw) || raw.length < 6) return bad();
  const [time, low, high, open, close, volume] = raw as unknown[];
  const t = requireFiniteNumber(time);
  const l = requireFiniteNumber(low);
  const h = requireFiniteNumber(high);
  const o = requireFiniteNumber(open);
  const c = requireFiniteNumber(close);
  const v = requireFiniteNumber(volume);
  if (t === undefined || l === undefined || h === undefined) return bad();
  if (o === undefined || c === undefined || v === undefined) return bad();
  return { t: t * 1000, o, h, l, c, v };
}

interface AlpacaRawBar {
  t?: unknown;
  o?: unknown;
  h?: unknown;
  l?: unknown;
  c?: unknown;
  v?: unknown;
}

function validateAlpacaBar(raw: unknown, symbol: string): PolygonAggregate {
  const bad = (): never => {
    throw new Error(
      `FreeStackAggregatesClient: malformed bar for ${symbol}: ` +
        truncateForError(JSON.stringify(raw)),
    );
  };
  if (typeof raw !== 'object' || raw === null) return bad();
  const bar = raw as AlpacaRawBar;
  const t = typeof bar.t === 'string' ? Date.parse(bar.t) : undefined;
  const o = requireFiniteNumber(bar.o);
  const h = requireFiniteNumber(bar.h);
  const l = requireFiniteNumber(bar.l);
  const c = requireFiniteNumber(bar.c);
  const v = requireFiniteNumber(bar.v);
  if (t === undefined || Number.isNaN(t)) return bad();
  if (o === undefined || h === undefined || l === undefined) return bad();
  if (c === undefined || v === undefined) return bad();
  return { t, o, h, l, c, v };
}

export interface FreeStackAggregatesClientOptions {
  /**
   * Defaults to `process.env.ALPACA_API_KEY`. Never logged or thrown into an
   * error message. Explicitly `| undefined` so a caller can forward an
   * environment lookup straight through under `exactOptionalPropertyTypes`
   * without a conditional spread at every call site.
   */
  alpacaKeyId?: string | undefined;
  /** Defaults to `process.env.ALPACA_API_SECRET`. Never logged or thrown into an error message. */
  alpacaSecretKey?: string | undefined;
  alpacaBaseUrl?: string | undefined;
  coinbaseBaseUrl?: string | undefined;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Proactive outbound pacing, shared across both venues. */
  rateLimiter?: TokenBucket;
}

/** A `PolygonClient` backed by Alpaca (equities) and Coinbase (crypto). */
export class FreeStackAggregatesClient implements PolygonClient {
  private readonly alpacaKeyId: string;
  private readonly alpacaSecretKey: string;
  private readonly alpacaBaseUrl: string;
  private readonly coinbaseBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;

  constructor(options: FreeStackAggregatesClientOptions = {}) {
    const keyId = options.alpacaKeyId ?? process.env.ALPACA_API_KEY;
    const secretKey = options.alpacaSecretKey ?? process.env.ALPACA_API_SECRET;
    // Checked in the constructor rather than lazily at the first equity
    // request: Stage 2 always ingests the whole MVP universe, so a run that
    // reaches the crypto leg with no equity credentials would fail partway
    // through an ingest loop that has already spent minutes on Coinbase.
    if (keyId === undefined || keyId.length === 0) {
      throw new Error(
        'FreeStackAggregatesClient: ALPACA_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { alpacaKeyId } explicitly.',
      );
    }
    if (secretKey === undefined || secretKey.length === 0) {
      throw new Error(
        'FreeStackAggregatesClient: ALPACA_API_SECRET is not set. Provide it via the ' +
          'environment (.env.local) or pass { alpacaSecretKey } explicitly.',
      );
    }
    this.alpacaKeyId = keyId;
    this.alpacaSecretKey = secretKey;
    this.alpacaBaseUrl = options.alpacaBaseUrl ?? DEFAULT_ALPACA_BASE_URL;
    this.coinbaseBaseUrl = options.coinbaseBaseUrl ?? DEFAULT_COINBASE_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(DEFAULT_PACING);
  }

  async fetchAggregates(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    return isCryptoSymbol(symbol)
      ? this.fetchCoinbase(symbol, window)
      : this.fetchAlpaca(symbol, window);
  }

  /**
   * Walks the window forward in ≤290-day chunks. Bars are collected into a
   * map keyed by open time so an overlapping chunk boundary yields one bar,
   * not two — Coinbase's `start`/`end` are inclusive at both ends.
   */
  private async fetchCoinbase(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    const byTime = new Map<number, PolygonAggregate>();
    let cursor = window.start.getTime();
    const endMs = window.end.getTime();
    let pages = 0;

    while (cursor <= endMs) {
      pages++;
      if (pages > MAX_PAGES) {
        throw new Error(
          `FreeStackAggregatesClient: exceeded ${MAX_PAGES} Coinbase chunks for ${symbol} — ` +
            'refusing to walk further (non-advancing chunk guard).',
        );
      }
      const chunkEnd = Math.min(cursor + COINBASE_CHUNK_DAYS * DAY_MS, endMs);
      const url =
        `${this.coinbaseBaseUrl}/products/${encodeURIComponent(symbol)}/candles` +
        `?granularity=86400&start=${new Date(cursor).toISOString()}` +
        `&end=${new Date(chunkEnd).toISOString()}`;

      await this.rateLimiter.acquire();
      const response = await this.fetchImpl(url, {
        headers: { 'User-Agent': 'samurai-stage2' },
      });
      if (!response.ok) {
        throw new Error(
          `FreeStackAggregatesClient: Coinbase returned HTTP ${response.status} ` +
            `${response.statusText} for ${symbol}.`,
        );
      }
      const parsed: unknown = await response.json();
      if (!Array.isArray(parsed)) {
        throw new Error(
          `FreeStackAggregatesClient: malformed Coinbase response for ${symbol}: expected an ` +
            `array, got ${truncateForError(JSON.stringify(parsed))}`,
        );
      }
      if (parsed.length > COINBASE_MAX_CANDLES_PER_REQUEST) {
        throw new Error(
          `FreeStackAggregatesClient: Coinbase returned ${parsed.length} candles for ${symbol}, ` +
            `above its documented ${COINBASE_MAX_CANDLES_PER_REQUEST} cap — the chunk walk ` +
            'assumes that cap, so this response cannot be trusted to be complete.',
        );
      }
      for (const raw of parsed) {
        const bar = validateCoinbaseCandle(raw, symbol);
        byTime.set(bar.t, bar);
      }

      if (chunkEnd >= endMs) break;
      cursor = chunkEnd;
    }

    // NOT redundant despite the forward chunk walk (raised in review on
    // #598): Coinbase returns each chunk NEWEST-FIRST, so `Map` insertion
    // order is descending within a chunk. Deleting this sort returns
    // [300, 200, 100] for the first test's fixture — verified by mutation.
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  private async fetchAlpaca(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    // Keyed by open time for the same reason as the Coinbase leg: Alpaca
    // documents non-overlapping pages, but a bar silently counted twice would
    // skew every downstream metric rather than failing loudly, and the store
    // has no duplicate check of its own (PRIMARY KEY dedups on write, which is
    // after the series has already been returned). Review finding on PR #598.
    const byTime = new Map<number, PolygonAggregate>();
    let pageToken: string | undefined;
    let pages = 0;

    do {
      pages++;
      if (pages > MAX_PAGES) {
        throw new Error(
          `FreeStackAggregatesClient: exceeded ${MAX_PAGES} Alpaca pages for ${symbol} — ` +
            'refusing to follow next_page_token further (malformed/cyclical pagination guard).',
        );
      }
      const params = new URLSearchParams({
        symbols: symbol,
        timeframe: '1Day',
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        limit: String(ALPACA_PAGE_LIMIT),
        sort: 'asc',
      });
      if (pageToken !== undefined) params.set('page_token', pageToken);

      await this.rateLimiter.acquire();
      const response = await this.fetchImpl(`${this.alpacaBaseUrl}/v2/stocks/bars?${params}`, {
        headers: {
          'APCA-API-KEY-ID': this.alpacaKeyId,
          'APCA-API-SECRET-KEY': this.alpacaSecretKey,
        },
      });
      if (!response.ok) {
        throw new Error(
          `FreeStackAggregatesClient: Alpaca returned HTTP ${response.status} ` +
            `${response.statusText} for ${symbol}.`,
        );
      }
      const parsed: unknown = await response.json();
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(
          `FreeStackAggregatesClient: malformed Alpaca response for ${symbol}: expected an ` +
            `object, got ${truncateForError(JSON.stringify(parsed))}`,
        );
      }
      const body = parsed as { bars?: Record<string, unknown>; next_page_token?: unknown };
      const bars = body.bars?.[symbol];
      if (bars !== undefined && !Array.isArray(bars)) {
        throw new Error(
          `FreeStackAggregatesClient: malformed 'bars.${symbol}' from Alpaca: expected an array`,
        );
      }
      for (const raw of bars ?? []) {
        const bar = validateAlpacaBar(raw, symbol);
        byTime.set(bar.t, bar);
      }

      // A wrong-typed token degrades to "no more pages" rather than throwing,
      // matching `HttpPolygonClient`: Stage 2 is offline tooling, and an early
      // stop shows up as a short series in the printed bar count rather than
      // silently corrupting one.
      pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
    } while (pageToken !== undefined);

    // Sorted for the same reason as the Coinbase leg: `sort=asc` is a request
    // parameter, not a guarantee this client verifies, and the store's
    // contract is ascending.
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }
}
