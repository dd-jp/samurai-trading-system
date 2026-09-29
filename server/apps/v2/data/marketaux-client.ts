export const MARKETAUX_NEWS_URL = 'https://api.marketaux.com/v1/news/all';
export const MARKETAUX_PAGE_LIMIT = 3;
const REQUEST_TIMEOUT_MS = 10_000;

export interface MarketauxArticle {
  readonly title: string;
  readonly publishedAt: string;
  readonly companyCount: number;
}

export interface MarketauxResult {
  readonly found: number;
  readonly articles: readonly MarketauxArticle[];
}

export interface MarketauxFetch {
  fetchArticles(tidm: string, start: Date, end: Date): Promise<MarketauxResult>;
}

export class MarketauxRequestError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function marketauxSymbol(tidm: string): string {
  return `${tidm}.L`;
}

function marketauxTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseArticle(raw: unknown): MarketauxArticle | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.title !== 'string' || typeof raw.published_at !== 'string') return undefined;
  return {
    title: raw.title,
    publishedAt: raw.published_at,
    companyCount: distinctCompanies(raw.entities),
  };
}

// one company's cross-listings (AZN, AZN.L, 0A4J.L, AZNCF) arrive as separate entities sharing a name
function distinctCompanies(entities: unknown): number {
  if (!Array.isArray(entities)) return 0;
  const keys = entities
    .filter(isRecord)
    .map((entity) => (typeof entity.name === 'string' ? entity.name : entity.symbol))
    .filter((key): key is string => typeof key === 'string');
  return new Set(keys).size;
}

export function parseMarketauxBody(body: unknown): MarketauxResult {
  if (!isRecord(body) || !isRecord(body.meta) || !Array.isArray(body.data)) {
    throw new MarketauxRequestError('bad_body');
  }
  const { found } = body.meta;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    throw new MarketauxRequestError('bad_body');
  }
  const articles = body.data
    .map(parseArticle)
    .filter((article): article is MarketauxArticle => article !== undefined);
  return { found, articles };
}

function requestUrl(apiKey: string, tidm: string, start: Date, end: Date): URL {
  const url = new URL(MARKETAUX_NEWS_URL);
  url.searchParams.set('symbols', marketauxSymbol(tidm));
  url.searchParams.set('published_after', marketauxTimestamp(start));
  url.searchParams.set('published_before', marketauxTimestamp(end));
  url.searchParams.set('language', 'en');
  url.searchParams.set('limit', String(MARKETAUX_PAGE_LIMIT));
  url.searchParams.set('api_token', apiKey);
  return url;
}

export class MarketauxClient implements MarketauxFetch {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchArticles(tidm: string, start: Date, end: Date): Promise<MarketauxResult> {
    const response = await this.#get(requestUrl(this.apiKey, tidm, start, end));
    if (!response.ok) throw new MarketauxRequestError(`http_${response.status}`);
    return parseMarketauxBody(await response.json().catch(() => undefined));
  }

  // the caught error is discarded on purpose: fetch failures can embed the URL, and the URL carries api_token
  async #get(url: URL): Promise<Response> {
    try {
      return await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new MarketauxRequestError(timedOut ? 'timeout' : 'network');
    }
  }
}
