
import type { PolygonAggregate, PolygonClient } from './stage2-historical-store.js';
import type { DateRange } from './universe.js';

const DEFAULT_BASE_URL = 'https://api.tiingo.com';
const MIN_REQUEST_SPACING_MS = 2_000;

interface TiingoDailyRow {
  date: string;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
}

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

export function toTiingoCryptoTicker(symbol: string): string {
  return symbol.replace('-', '').toLowerCase();
}

function toTiingoDate(date: Date): string {
  return date.toISOString().split('T')[0] as string;
}

export interface HttpTiingoClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  minRequestSpacingMs?: number;
}

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

  async fetchAggregates(
    symbol: string,
    window: DateRange,
    timeframe: string,
  ): Promise<PolygonAggregate[]> {
    if (timeframe !== '1d') {
      throw new Error(
        `HttpTiingoClient.fetchAggregates: this client serves '1d' only; got '${timeframe}'.`,
      );
    }
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

  private async paceRequest(): Promise<void> {
    const wait = this.lastRequestAt + this.minRequestSpacingMs - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }
}
