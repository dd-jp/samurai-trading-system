
import { TokenBucket } from '../../../shared/index.js';

const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';

const REQUEST_TIMEOUT_MS = 20_000;

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const DEFAULT_PACING = { capacity: 20, refillPerSecond: 5 } as const;

export interface PolymarketMarket {
  slug: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  tokenIds: string[];
  bestBid: number | undefined;
  bestAsk: number | undefined;
  spread: number | undefined;
  volume24hr: number | undefined;
  liquidity: number | undefined;
  updatedAt: Date | undefined;
  closed: boolean;
  payload: string;
}

export interface PolymarketPricePoint {
  at: Date;
  probability: number;
}

export interface PolymarketClientOptions {
  gammaBaseUrl?: string | undefined;
  clobBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
}

function requestInit(): RequestInit {
  return { redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function decodeJsonArray(raw: unknown, field: string, slug: string): string[] {
  if (Array.isArray(raw)) return raw.map((entry) => String(entry));
  if (typeof raw !== 'string') {
    throw new Error(`polymarket: market '${slug}' has no ${field}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`polymarket: market '${slug}' has a non-array ${field}`);
  }
  return parsed.map((entry) => String(entry));
}

function optionalNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class PolymarketClient {
  private readonly gammaBaseUrl: string;
  private readonly clobBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;

  constructor(options: PolymarketClientOptions = {}) {
    this.gammaBaseUrl = options.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
    this.clobBaseUrl = options.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(DEFAULT_PACING);
  }

  async fetchEventMarket(
    eventSlug: string,
    marketSlug: string,
  ): Promise<PolymarketMarket | undefined> {
    const url = `${this.gammaBaseUrl}/events?slug=${encodeURIComponent(eventSlug)}`;
    const body = await this.getJson(url);
    if (!Array.isArray(body) || body.length === 0) return undefined;

    const event = body[0] as { markets?: unknown };
    const markets = Array.isArray(event.markets) ? event.markets : [];
    const raw = markets.find((market) => (market as { slug?: unknown }).slug === marketSlug) as
      | Record<string, unknown>
      | undefined;
    if (raw === undefined) return undefined;

    const outcomes = decodeJsonArray(raw.outcomes, 'outcomes', marketSlug);
    const prices = decodeJsonArray(raw.outcomePrices, 'outcomePrices', marketSlug).map(Number);
    const tokenIds = decodeJsonArray(raw.clobTokenIds, 'clobTokenIds', marketSlug);
    if (outcomes.length !== prices.length || outcomes.length !== tokenIds.length) {
      throw new Error(
        `polymarket: market '${marketSlug}' has ${outcomes.length} outcomes but ` +
          `${prices.length} prices and ${tokenIds.length} token ids`,
      );
    }
    if (prices.some((price) => !Number.isFinite(price))) {
      throw new Error(`polymarket: market '${marketSlug}' has an unparseable outcome price`);
    }

    return {
      slug: marketSlug,
      question: typeof raw.question === 'string' ? raw.question : marketSlug,
      outcomes,
      outcomePrices: prices,
      tokenIds,
      bestBid: optionalNumber(raw.bestBid),
      bestAsk: optionalNumber(raw.bestAsk),
      spread: optionalNumber(raw.spread),
      volume24hr: optionalNumber(raw.volume24hr),
      liquidity: optionalNumber(raw.liquidityNum) ?? optionalNumber(raw.liquidity),
      updatedAt: optionalDate(raw.updatedAt),
      closed: raw.closed === true,
      payload: JSON.stringify(raw),
    };
  }

  async fetchPriceHistory(tokenId: string): Promise<PolymarketPricePoint[]> {
    const url =
      `${this.clobBaseUrl}/prices-history?market=${encodeURIComponent(tokenId)}` +
      '&interval=1d&fidelity=60';
    const body = await this.getJson(url);
    const history = (body as { history?: unknown }).history;
    if (!Array.isArray(history)) return [];
    return history
      .map((point) => {
        const record = point as { t?: unknown; p?: unknown };
        const seconds = optionalNumber(record.t);
        const probability = optionalNumber(record.p);
        if (seconds === undefined || probability === undefined) return undefined;
        return { at: new Date(seconds * 1000), probability };
      })
      .filter((point): point is PolymarketPricePoint => point !== undefined);
  }

  private async getJson(url: string): Promise<unknown> {
    await this.rateLimiter.acquire();
    const response = await this.fetchImpl(url, requestInit());
    if (!response.ok) {
      throw new Error(`polymarket: ${url} returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`polymarket: ${url} declared ${declared} bytes`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`polymarket: ${url} returned ${text.length} bytes`);
    }
    return JSON.parse(text);
  }
}
