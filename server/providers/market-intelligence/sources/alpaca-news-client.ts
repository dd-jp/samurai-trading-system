/**
 * Alpaca News REST — the v1 ticker-layer fetcher (#553, map #552).
 *
 * Surface verified in `docs/research/21-mi-ingestion-architecture.md:51`:
 * `GET https://data.alpaca.markets/v1beta1/news`, same key headers as bars,
 * `symbols=AAPL,TSLA,BTCUSD` (crypto in-band), `start`/`end` RFC-3339, items
 * carrying `id` (int64), `headline`, `summary`, `symbols[]`, `source`, `url`,
 * `created_at`/`updated_at`. History to 2015 on the Benzinga wire, 200 req/min,
 * keys already held, £0.
 *
 * ## Coverage limit, measured — read this before extending the universe
 *
 * During the #553 grilling this endpoint was queried directly for the live
 * universe [ADR-0016](../../../../docs/adr/0016-universe-leveraged-etps-ungated.md)
 * selected. It returned **zero items for 3USL, 3LDE and SGLN**, against five
 * each for AAPL, SPY and BTCUSD. No HTTP error — the wire simply carries
 * nothing for LSE-listed ETPs, which is what a US Benzinga feed would be
 * expected to do.
 *
 * So this fetcher fully serves the **paper soak** universe and does **not**
 * serve the live equity leg. That is why #553 put GDELT in v1 alongside it
 * rather than shipping this alone: a 3x FTSE ETP has no company news of its
 * own, and what moves it is macro, which is the GDELT layer's job. Shipping
 * only this would have made paper and live *different experiments*, breaking
 * the paper→live expectancy transfer #661 needs at the ~126-trade thesis gate.
 */

import { TokenBucket } from '../../../shared/index.js';

const DEFAULT_BASE_URL = 'https://data.alpaca.markets';

/** Alpaca's documented per-request ceiling for news */
const PAGE_LIMIT = 50;

/**
 * Guards a malformed or cyclical `next_page_token`. One refresh window at our
 * cadence is a handful of pages; this is far above any legitimate poll and far
 * below an infinite loop.
 */
const MAX_PAGES = 40;

/** Alpaca free allows 200 req/min; this stays well inside it */
const DEFAULT_PACING = { capacity: 5, refillPerSecond: 2 } as const;

/** One news article as the wire delivers it, after validation */
export interface AlpacaNewsArticle {
  /** int64 on the wire; carried as string because `native_id` is TEXT (#554) */
  id: string;
  headline: string;
  summary: string;
  /** The tickers this article is about — one article becomes one item PER symbol */
  symbols: string[];
  source: string;
  url: string;
  /** Publisher time. NOT our knowledge time; see `ingested_at` in the archive. */
  created_at: Date;
  /** Vendor revision stamp — orders revisions, never gates visibility (#558) */
  updated_at: Date;
  /** The exact bytes, for the archive's raw table (#554 re-normalizability) */
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

/**
 * Rejects rather than defaults.
 *
 * A silently-defaulted `created_at` would land at the epoch and sit outside
 * every context window forever — the item would be archived, counted, and never
 * read, which is indistinguishable from the empty-store defect this whole
 * rework exists to fix. Loud is better.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a flat sequence of independent per-field validations for one wire article; splitting them into sub-functions would scatter one record's validation contract across several places for no gain in readability.
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
  const created =
    typeof article.created_at === 'string' ? Date.parse(article.created_at) : Number.NaN;
  if (Number.isNaN(created)) return bad();
  // Alpaca always sends `updated_at`, but an article that has never been
  // revised is legitimately equal to its creation — so absence falls back to
  // `created_at` rather than failing the whole batch
  const updatedRaw =
    typeof article.updated_at === 'string' ? Date.parse(article.updated_at) : Number.NaN;
  const updated = Number.isNaN(updatedRaw) ? created : updatedRaw;

  const symbols = Array.isArray(article.symbols)
    ? article.symbols.filter((symbol): symbol is string => typeof symbol === 'string')
    : [];

  return {
    id: String(id),
    headline,
    summary: typeof article.summary === 'string' ? article.summary : '',
    symbols,
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
    // Checked in the constructor rather than at first use: a refresh loop that
    // discovers missing credentials on its first poll fails inside the tick,
    // where it reads as "no news today" rather than as a misconfiguration
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

  /**
   * Articles for `symbols` published in `[start, end]`, oldest first.
   *
   * Keyed by `id` on the way out so a page boundary that repeats an article
   * yields one, not two — the archive's `INSERT OR IGNORE` would also absorb it,
   * but that is after the batch has already been counted and scored, and
   * scoring costs money.
   */
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
