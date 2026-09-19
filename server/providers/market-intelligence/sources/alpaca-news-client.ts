import { TokenBucket } from '../../../shared/index.js';

const DEFAULT_BASE_URL = 'https://data.alpaca.markets';

const PAGE_LIMIT = 50;

const MAX_PAGES = 40;

const DEFAULT_PACING = { capacity: 5, refillPerSecond: 2 } as const;

export interface AlpacaNewsArticle {
  id: string;
  headline: string;
  summary: string;
  symbols: string[];
  source: string;
  url: string;
  created_at: Date;
  updated_at: Date;
  payload: string;
}

export interface AlpacaNewsClientOptions {
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  rateLimiter?: TokenBucket;
}

function truncateForError(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

interface RawArticle {
  id?: unknown;
  headline?: unknown;
  summary?: unknown;
  symbols?: unknown;
  source?: unknown;
  url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function parsedTimestampOrNaN(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function articleSymbols(article: RawArticle): string[] {
  return Array.isArray(article.symbols)
    ? article.symbols.filter((symbol): symbol is string => typeof symbol === 'string')
    : [];
}

function validateArticle(raw: unknown): AlpacaNewsArticle {
  const bad = (): never => {
    throw new Error(
      `AlpacaNewsClient: malformed article: ${truncateForError(JSON.stringify(raw))}`,
    );
  };
  if (typeof raw !== 'object' || raw === null) return bad();
  const article = raw as RawArticle;

  const id = typeof article.id === 'number' || typeof article.id === 'string' ? article.id : bad();
  const headline = typeof article.headline === 'string' ? article.headline : bad();
  const created = parsedTimestampOrNaN(article.created_at);
  if (Number.isNaN(created)) return bad();
  const updatedRaw = parsedTimestampOrNaN(article.updated_at);
  const updated = Number.isNaN(updatedRaw) ? created : updatedRaw;

  return {
    id: String(id),
    headline,
    summary: typeof article.summary === 'string' ? article.summary : '',
    symbols: articleSymbols(article),
    source: typeof article.source === 'string' ? article.source : 'alpaca',
    url: typeof article.url === 'string' ? article.url : '',
    created_at: new Date(created),
    updated_at: new Date(updated),
    payload: JSON.stringify(raw),
  };
}

export class AlpacaNewsClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: TokenBucket;

  constructor(options: AlpacaNewsClientOptions = {}) {
    const key = options.apiKey ?? process.env.ALPACA_API_KEY;
    const secret = options.apiSecret ?? process.env.ALPACA_API_SECRET;
    if (key === undefined || key.length === 0) {
      throw new Error(
        'AlpacaNewsClient: ALPACA_API_KEY is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiKey } explicitly.',
      );
    }
    if (secret === undefined || secret.length === 0) {
      throw new Error(
        'AlpacaNewsClient: ALPACA_API_SECRET is not set. Provide it via the environment ' +
          '(.env.local) or pass { apiSecret } explicitly.',
      );
    }
    this.apiKey = key;
    this.apiSecret = secret;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new TokenBucket(DEFAULT_PACING);
  }

  async #fetchNewsPage(
    symbols: readonly string[],
    start: Date,
    end: Date,
    pageToken: string | undefined,
  ): Promise<{ articles: AlpacaNewsArticle[]; nextPageToken: string | undefined }> {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      start: start.toISOString(),
      end: end.toISOString(),
      limit: String(PAGE_LIMIT),
      sort: 'asc',
    });
    if (pageToken !== undefined) params.set('page_token', pageToken);

    await this.rateLimiter.acquire();
    const response = await this.fetchImpl(`${this.baseUrl}/v1beta1/news?${params}`, {
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.apiSecret,
      },
    });
    if (!response.ok) {
      throw new Error(
        `AlpacaNewsClient: Alpaca returned HTTP ${response.status} ${response.statusText}.`,
      );
    }

    const parsed: unknown = await response.json();
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(
        `AlpacaNewsClient: malformed response: expected an object, got ` +
          truncateForError(JSON.stringify(parsed)),
      );
    }
    const body = parsed as { news?: unknown; next_page_token?: unknown };
    const news = Array.isArray(body.news) ? body.news : [];
    const articles = news.map((rawArticle) => validateArticle(rawArticle));
    const nextPageToken =
      typeof body.next_page_token === 'string' && body.next_page_token.length > 0
        ? body.next_page_token
        : undefined;
    return { articles, nextPageToken };
  }

  async fetchNews(
    symbols: readonly string[],
    start: Date,
    end: Date,
  ): Promise<AlpacaNewsArticle[]> {
    if (symbols.length === 0) return [];

    const byId = new Map<string, AlpacaNewsArticle>();
    let pageToken: string | undefined;
    let pages = 0;

    do {
      pages++;
      if (pages > MAX_PAGES) {
        throw new Error(
          `AlpacaNewsClient: exceeded ${MAX_PAGES} pages for ${symbols.join(',')} — refusing ` +
            'to follow next_page_token further (malformed/cyclical pagination guard).',
        );
      }

      const page = await this.#fetchNewsPage(symbols, start, end, pageToken);
      for (const article of page.articles) {
        byId.set(article.id, article);
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);

    return [...byId.values()].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }
}
