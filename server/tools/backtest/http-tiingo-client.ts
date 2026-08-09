/**
 * Tiingo historical-aggregates client (review 2026-08-06 A2).
 *
 * The Polygon key is deliberately on the free tier (2-year depth), and the
 * 5-year history Stage 2's MinBTL gate needs is a ONE-TIME fetch into the
 * persistent scratch store — Tiingo's free tier serves decades of EOD data,
 * so the depth entitlement is free here rather than a $29-49/mo Polygon SKU.
 *
 * Implements the `PolygonClient` port (`fetchAggregates`) so
 * `Stage2HistoricalStore` consumes it unchanged — the port's name is
 * vendor-stained but its shape ("daily aggregates for a symbol over a
 * window") is not, and both vendors satisfy it.
 *
 * **Endpoints.** Equities: `GET /tiingo/daily/{ticker}/prices` with
 * `startDate`/`endDate`, using the split/dividend-ADJUSTED fields
 * (`adjOpen`..`adjVolume`) to match Polygon's `adjusted=true` bars already
 * in the store. Crypto: `GET /tiingo/crypto/prices?tickers={t}` with
 * `resampleFreq=1day` — raw fields; crypto has no corporate actions.
 *
 * **Auth.** `Authorization: Token ${TIINGO_API_KEY}` header — same
 * keep-the-key-out-of-URLs posture as `HttpPolygonClient`.
 *
 * **Pacing.** Free tier allows ~50 requests/hour; one request covers a
 * symbol's whole window (no pagination at daily scale), so the 6-symbol
 * universe is 6 requests. 2s spacing is politeness, not budget math.
 */

import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_BASE_URL = 'https://api.tiingo.com';
const MIN_REQUEST_SPACING_MS = 2_000;

/** Equities response row — adjusted fields carry the split/dividend-corrected series. */
interface TiingoDailyRow {
  date: string;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
}

/** Crypto response: one entry per requested ticker, bars under `priceData`. */
interface TiingoCryptoEntry {
  ticker: string;
  priceData: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
}

/** `BTC-USD` -> `btcusd`, Tiingo's crypto ticker format. Equities pass through unchanged. */
export function toTiingoCryptoTicker(symbol: string): string {
  return symbol.replace('-', '').toLowerCase();
}

/** `YYYY-MM-DD`, per Tiingo's `startDate`/`endDate` query format. */
function toTiingoDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

export interface HttpTiingoClientOptions {
  /** Defaults to `process.env.TIINGO_API_KEY`. Never logged or thrown into an error message. */
  apiKey?: string;
  baseUrl?: string;
  /** Injectable for tests — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Milliseconds between requests. Defaults to polite spacing; tests pass 0. */
  minRequestSpacingMs?: number;
}

/** Real HTTP Tiingo client behind the `PolygonClient` aggregates port. */
export class HttpTiingoClient implements PolygonClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minRequestSpacingMs: number;
  private lastRequestAt = 0;

  constructor(options: HttpTiingoClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TIINGO_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        'HttpTiingoClient: TIINGO_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiKey } explicitly.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minRequestSpacingMs = options.minRequestSpacingMs ?? MIN_REQUEST_SPACING_MS;
  }

  async fetchAggregates(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    await this.paceRequest();
    return symbol.endsWith('-USD')
      ? this.fetchCrypto(symbol, window)
      : this.fetchEquity(symbol, window);
  }

  private async fetchEquity(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    const url =
      `${this.baseUrl}/tiingo/daily/${encodeURIComponent(symbol)}/prices` +
      `?startDate=${toTiingoDate(window.start)}&endDate=${toTiingoDate(window.end)}`;
    const rows = (await this.getJson(url, symbol)) as TiingoDailyRow[];
    return rows.map((row) => ({
      t: Date.parse(row.date),
      o: row.adjOpen,
      h: row.adjHigh,
      l: row.adjLow,
      c: row.adjClose,
      v: row.adjVolume,
    }));
  }

  private async fetchCrypto(symbol: string, window: DateRange): Promise<PolygonAggregate[]> {
    const ticker = toTiingoCryptoTicker(symbol);
    const url =
      `${this.baseUrl}/tiingo/crypto/prices?tickers=${encodeURIComponent(ticker)}` +
      `&startDate=${toTiingoDate(window.start)}&endDate=${toTiingoDate(window.end)}` +
      `&resampleFreq=1day`;
    const entries = (await this.getJson(url, symbol)) as TiingoCryptoEntry[];
    const bars = entries[0]?.priceData ?? [];
    return bars.map((bar) => ({
      t: Date.parse(bar.date),
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
    }));
  }

  private async getJson(url: string, symbol: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(
        `HttpTiingoClient: Tiingo returned HTTP ${response.status} ${response.statusText} ` +
          `for ${symbol}.`,
      );
    }
    return response.json();
  }

  /** Sleeps out the remainder of the spacing window since the last request. */
  private async paceRequest(): Promise<void> {
    const wait = this.lastRequestAt + this.minRequestSpacingMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }
}
