
import { timeframeToMs, toAlpacaTimeframe } from '../../providers/market-data-service/index.js';
import { TokenBucket } from '../../shared/index.js';
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_ALPACA_BASE_URL = 'https://data.alpaca.markets';
const DEFAULT_COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';

const ALPACA_PAGE_LIMIT = 10_000;

const COINBASE_MAX_CANDLES_PER_REQUEST = 300;
const COINBASE_CHUNK_DAYS = 290;

const DAY_MS = 86_400_000;

const MIN_MAX_PAGES = 200;

const PAGE_GUARD_HEADROOM = 4;

export function maxAlpacaPagesFor(window: DateRange, timeframe: string): number {
  const spanMs = Math.max(0, window.end.getTime() - window.start.getTime());
  const expectedBars = spanMs / timeframeToMs(timeframe);
  const expectedPages = Math.ceil(expectedBars / ALPACA_PAGE_LIMIT);
  return Math.max(MIN_MAX_PAGES, expectedPages * PAGE_GUARD_HEADROOM);
}

const DEFAULT_PACING = { capacity: 5, refillPerSecond: 3 } as const;

function truncateForError(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export function isCryptoSymbol(symbol: string): boolean {
  return symbol.endsWith('-USD');
}

function requireFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

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
  alpacaKeyId?: string | undefined;
  alpacaSecretKey?: string | undefined;
  alpacaBaseUrl?: string | undefined;
  coinbaseBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
}

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

  async fetchAggregates(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]> {
    return isCryptoSymbol(symbol)
      ? this.fetchCoinbase(symbol, window, timeframe)
      : this.fetchAlpaca(symbol, window, timeframe);
  }

  private async fetchCoinbaseChunk(
    symbol: string,
    cursor: number,
    chunkEnd: number,
  ): Promise<unknown[]> {
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
    return parsed;
  }

  private async fetchCoinbase(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]> {
    if (timeframe !== '1d') {
      throw new Error(
        `FreeStackAggregatesClient: crypto (${symbol}) is served at '1d' only; got ` +
          `'${timeframe}'. Crypto left Samurai's scope on 2026-08-16 (ADR-0015 amendment), so ` +
          'the intraday work of #664 deliberately does not extend the Coinbase leg.',
      );
    }
    const byTime = new Map<number, PolygonAggregate>();
    let cursor = window.start.getTime();
    const endMs = window.end.getTime();
    let pages = 0;

    while (cursor <= endMs) {
      pages++;
      if (pages > MIN_MAX_PAGES) {
        throw new Error(
          `FreeStackAggregatesClient: exceeded ${MIN_MAX_PAGES} Coinbase chunks for ${symbol} — ` +
            'refusing to walk further (non-advancing chunk guard).',
        );
      }
      const chunkEnd = Math.min(cursor + COINBASE_CHUNK_DAYS * DAY_MS, endMs);
      const parsed = await this.fetchCoinbaseChunk(symbol, cursor, chunkEnd);
      for (const raw of parsed) {
        const bar = validateCoinbaseCandle(raw, symbol);
        byTime.set(bar.t, bar);
      }

      if (chunkEnd >= endMs) break;
      cursor = chunkEnd;
    }

    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  private async fetchAlpacaPage(
    symbol: string,
    alpacaTimeframe: string,
    window: DateRange,
    pageToken: string | undefined,
  ): Promise<{ bars: unknown[]; next_page_token: string | undefined }> {
    const params = new URLSearchParams({
      symbols: symbol,
      timeframe: alpacaTimeframe,
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
    const next_page_token =
      typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
    return { bars: bars ?? [], next_page_token };
  }

  private async fetchAlpaca(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]> {
    const alpacaTimeframe = toAlpacaTimeframe(timeframe);
    const maxPages = maxAlpacaPagesFor(window, timeframe);
    const byTime = new Map<number, PolygonAggregate>();
    let pageToken: string | undefined;
    let pages = 0;

    do {
      pages++;
      if (pages > maxPages) {
        throw new Error(
          `FreeStackAggregatesClient: exceeded ${maxPages} Alpaca pages for ${symbol} at ` +
            `${timeframe} — ` +
            'refusing to follow next_page_token further (malformed/cyclical pagination guard).',
        );
      }
      const page = await this.fetchAlpacaPage(symbol, alpacaTimeframe, window, pageToken);
      for (const raw of page.bars) {
        const bar = validateAlpacaBar(raw, symbol);
        byTime.set(bar.t, bar);
      }
      pageToken = page.next_page_token;
    } while (pageToken !== undefined);

    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }
}
