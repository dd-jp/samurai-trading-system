import { delay, isString, jsonOrTextResult, readOhlcvBar } from '../../shared/index.js';

export const ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';
const ALPACA_REQUESTS_PER_MINUTE = 200;
const PAGE_LIMIT = 10_000;
const RATE_LIMIT_BACKOFF_MS = 20_000;
const MAX_ATTEMPTS = 5;

export interface AlpacaCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface RawDailyBar {
  readonly t: string;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

export type Adjustment = 'all' | 'raw';

export interface BarsRequest {
  readonly symbol: string;
  readonly start: string;
  readonly end: string;
  readonly adjustment: Adjustment;
}

export type Fetcher = (url: string, headers: Record<string, string>) => Promise<FetchResult>;

export interface FetchResult {
  readonly status: number;
  readonly body: unknown;
}

export type Sleeper = (ms: number) => Promise<void>;

export function credentialsFromEnv(env: NodeJS.ProcessEnv): AlpacaCredentials {
  const apiKey = env.ALPACA_API_KEY;
  const apiSecret = env.ALPACA_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('ALPACA_API_KEY and ALPACA_API_SECRET must be set (use --env-file).');
  }
  return { apiKey, apiSecret };
}

export function authHeaders(credentials: AlpacaCredentials): Record<string, string> {
  return {
    'APCA-API-KEY-ID': credentials.apiKey,
    'APCA-API-SECRET-KEY': credentials.apiSecret,
    accept: 'application/json',
  };
}

export function endOfDayUtc(date: string): string {
  return `${date}T23:59:59Z`;
}

// The free data plan answers 403 "subscription does not permit querying recent SIP data"
// to any SIP request whose end falls inside the last 15 minutes (measured 2026-09-30)
const SIP_RECENT_EMBARGO_MS = 16 * 60_000;

export function sipEnd(date: string, nowMs: number): string {
  const embargoed = new Date(nowMs - SIP_RECENT_EMBARGO_MS).toISOString().slice(0, 19);
  const endOfDay = endOfDayUtc(date).slice(0, 19);
  return `${embargoed < endOfDay ? embargoed : endOfDay}Z`;
}

export function barsUrl(
  request: BarsRequest,
  pageToken: string | undefined,
  nowMs: number = Date.now(),
): string {
  const params = new URLSearchParams({
    symbols: request.symbol,
    timeframe: '1Day',
    start: request.start,
    end: sipEnd(request.end, nowMs),
    limit: String(PAGE_LIMIT),
    adjustment: request.adjustment,
    feed: 'sip',
    sort: 'asc',
  });
  if (pageToken !== undefined) params.set('page_token', pageToken);
  return `${ALPACA_DATA_BASE_URL}/v2/stocks/bars?${params.toString()}`;
}

export function parseBarsPage(
  body: unknown,
  symbol: string,
): { bars: RawDailyBar[]; nextPageToken: string | undefined } {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`Alpaca bars: non-object body for ${symbol}`);
  }
  const record = body as Record<string, unknown>;
  const bySymbol = record.bars;
  const raw =
    typeof bySymbol === 'object' && bySymbol !== null
      ? (bySymbol as Record<string, unknown>)[symbol]
      : undefined;
  const bars = raw === undefined || raw === null ? [] : parseBarArray(raw, symbol);
  const token = record.next_page_token;
  return { bars, nextPageToken: typeof token === 'string' ? token : undefined };
}

function parseBarArray(raw: unknown, symbol: string): RawDailyBar[] {
  if (!Array.isArray(raw)) throw new Error(`Alpaca bars: bars[${symbol}] is not an array`);
  return raw.map((item) => parseBar(item, symbol));
}

function parseBar(item: unknown, symbol: string): RawDailyBar {
  const bar = readOhlcvBar(item, isString);
  if (bar !== undefined) return bar;
  throw new Error(`Alpaca bars: malformed bar for ${symbol}: ${JSON.stringify(item)}`);
}

export class AlpacaBarsApi {
  private readonly headers: Record<string, string>;
  private lastRequestAt = 0;

  constructor(
    credentials: AlpacaCredentials,
    private readonly fetcher: Fetcher = jsonFetcher,
    private readonly sleep: Sleeper = delay,
    private readonly minIntervalMs = Math.ceil(60_000 / ALPACA_REQUESTS_PER_MINUTE),
    private readonly now: () => number = Date.now,
  ) {
    this.headers = authHeaders(credentials);
  }

  async dailyBars(request: BarsRequest): Promise<RawDailyBar[]> {
    const bars: RawDailyBar[] = [];
    let pageToken: string | undefined;
    do {
      const page = parseBarsPage(
        await this.getWithRetry(barsUrl(request, pageToken, this.now())),
        request.symbol,
      );
      bars.push(...page.bars);
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return bars;
  }

  async getWithRetry(url: string): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.pace();
      const result = await this.fetcher(url, this.headers);
      if (result.status === 200) return result.body;
      if (result.status === 429) {
        await this.sleep(RATE_LIMIT_BACKOFF_MS);
        continue;
      }
      throw new Error(`Alpaca ${result.status} for ${url}: ${JSON.stringify(result.body)}`);
    }
    throw new Error(`Alpaca: rate-limited ${MAX_ATTEMPTS} times for ${url}`);
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

async function jsonFetcher(url: string, headers: Record<string, string>): Promise<FetchResult> {
  return jsonOrTextResult(await fetch(url, { headers }));
}
