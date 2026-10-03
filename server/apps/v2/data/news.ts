import type { AlpacaNewsArticle } from '../../../providers/news/index.js';
import { describeThrownSafely, maskCredentials } from '../../../shared/index.js';
import { addDays } from './macro-calendar.js';
import type { NewsLedger, NewsRecord, StoredHeadline } from './news-ledger.js';

export const MAX_HEADLINES_PER_NAME = 10;
const NEWS_LOOKBACK_CALENDAR_DAYS = 1;
export const ROUNDUP_SYMBOL_LIMIT = 5;
export const ALPACA_NEWS_PROVIDER = 'alpaca';

export interface NewsSource {
  headlines(symbol: string, tradingDate: string, now: Date): Promise<readonly string[]>;
}

export interface NewsFetcher {
  fetchNews(symbols: readonly string[], start: Date, end: Date): Promise<AlpacaNewsArticle[]>;
}

export const NO_NEWS: NewsSource = { headlines: () => Promise.resolve([]) };

function perNameArticles(articles: readonly AlpacaNewsArticle[]): readonly StoredHeadline[] {
  return articles
    .filter((article) => article.symbols.length <= ROUNDUP_SYMBOL_LIMIT)
    .map((article) => ({
      title: article.headline.trim(),
      publishedAt: article.created_at.toISOString(),
      sourceId: article.id,
    }))
    .filter((headline) => headline.title.length > 0)
    .slice(-MAX_HEADLINES_PER_NAME);
}

export function perNameHeadlines(articles: readonly AlpacaNewsArticle[]): readonly string[] {
  return perNameArticles(articles).map((headline) => headline.title);
}

export function newsFailureReason(error: unknown): string {
  return maskCredentials(describeThrownSafely(error));
}

type FetchOutcome = Pick<NewsRecord, 'status' | 'reason' | 'found' | 'headlines'>;

export class AlpacaNewsSource implements NewsSource {
  constructor(
    private readonly client: NewsFetcher,
    private readonly ledger?: Pick<NewsLedger, 'record'> | undefined,
  ) {}

  async headlines(symbol: string, tradingDate: string, now: Date): Promise<readonly string[]> {
    const start = new Date(`${addDays(tradingDate, -NEWS_LOOKBACK_CALENDAR_DAYS)}T00:00:00.000Z`);
    let articles: AlpacaNewsArticle[];
    try {
      articles = await this.client.fetchNews([symbol], start, now);
    } catch (error) {
      this.#recordFailure(symbol, tradingDate, now, error);
      throw error;
    }
    const headlines = perNameArticles(articles);
    const status = headlines.length === 0 ? 'no_news' : 'ok';
    this.#record(symbol, tradingDate, now, {
      status,
      reason: '',
      found: articles.length,
      headlines,
    });
    return headlines.map((headline) => headline.title);
  }

  // A ledger write failing here must not replace the fetch error the cycle journals as the reason
  #recordFailure(symbol: string, tradingDate: string, now: Date, error: unknown): void {
    const reason = newsFailureReason(error);
    try {
      this.#record(symbol, tradingDate, now, {
        status: 'error',
        reason,
        found: undefined,
        headlines: [],
      });
    } catch {}
  }

  #record(symbol: string, tradingDate: string, now: Date, outcome: FetchOutcome): void {
    this.ledger?.record({
      tradingDate,
      symbol,
      provider: ALPACA_NEWS_PROVIDER,
      requested: true,
      fetchedAt: now.toISOString(),
      ...outcome,
    });
  }
}

export interface NewsRoutes {
  readonly us: NewsSource;
  readonly ukStock: NewsSource;
  readonly isUkStock: (symbol: string) => boolean;
  readonly isLseEtf: (symbol: string) => boolean;
}

// doc 66 G18(2): LSE ETFs stay NO_NEWS — no underlying-key mapping exists for the 22 diversified
// index/commodity/bond ETFs (unlike the leveraged single-stock-proxy ETPs #522/#960 built the
// underlying-key pattern for). UK single stocks are the ones with a per-name news source (#1915)
export function newsForVenue(routes: NewsRoutes): NewsSource {
  return {
    headlines: (symbol, tradingDate, now) => {
      if (routes.isUkStock(symbol)) return routes.ukStock.headlines(symbol, tradingDate, now);
      if (routes.isLseEtf(symbol)) return NO_NEWS.headlines(symbol, tradingDate, now);
      return routes.us.headlines(symbol, tradingDate, now);
    },
  };
}
