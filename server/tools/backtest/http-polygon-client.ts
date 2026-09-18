
import { resolvePolygonPacing, TokenBucket, truncateForError } from '../../shared/index.js';
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_BASE_URL = 'https://api.polygon.io';
const MAX_PAGES = 25;
const PAGE_LIMIT = 50_000;

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

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
    `HttpPolygonClient.fetchAggregates: malformed aggregate for ${symbol}: ${truncateForError(
      JSON.stringify(raw),
    )}`,
  );
}

export function toPolygonTicker(symbol: string): string {
  return symbol.endsWith('-USD') ? `X:${symbol.slice(0, -'-USD'.length)}USD` : symbol;
}

function toPolygonDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

export interface HttpPolygonClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
}

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

  private async fetchPage(
    url: string,
    symbol: string,
    ticker: string,
  ): Promise<{ rows: PolygonAggregate[]; next_url: string | undefined }> {
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

    const parsed: unknown = await response.json();
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `HttpPolygonClient.fetchAggregates: malformed response body for ${symbol}: expected an ` +
          `object, got ${truncateForError(JSON.stringify(parsed))}`,
      );
    }
    const body = parsed as PolygonAggregatesResponse;
    if (body.results !== undefined && !Array.isArray(body.results)) {
      throw new Error(
        `HttpPolygonClient.fetchAggregates: malformed 'results' for ${symbol}: expected an array`,
      );
    }
    const rows = (body.results ?? []).map((bar) => validateRawPolygonAggregate(bar, symbol));

    const next_url = typeof body.next_url === 'string' ? body.next_url : undefined;
    return { rows, next_url };
  }

  async fetchAggregates(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]> {
    if (timeframe !== '1d') {
      throw new Error(
        `HttpPolygonClient.fetchAggregates: this client serves '1d' only; got '${timeframe}'. ` +
          'The Polygon key here is free-tier (2-year window, 5 req/min) and is fallback-only ' +
          'per stage2-source.ts — run intraday backfill through FreeStackAggregatesClient ' +
          '(Alpaca) instead.',
      );
    }
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

      const page = await this.fetchPage(url, symbol, ticker);
      out.push(...page.rows);
      if (page.next_url === undefined) break;
      url = page.next_url;
    }

    return out;
  }
}
