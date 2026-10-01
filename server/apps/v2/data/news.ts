import type { AlpacaNewsArticle } from '../../../providers/market-intelligence/sources/alpaca-news-client.js';
import { addDays } from './macro-calendar.js';

export const MAX_HEADLINES_PER_NAME = 10;
const NEWS_LOOKBACK_CALENDAR_DAYS = 1;
export const ROUNDUP_SYMBOL_LIMIT = 5;

export interface NewsSource {
  headlines(symbol: string, tradingDate: string, now: Date): Promise<readonly string[]>;
}

export interface NewsFetcher {
  fetchNews(symbols: readonly string[], start: Date, end: Date): Promise<AlpacaNewsArticle[]>;
}

export const NO_NEWS: NewsSource = { headlines: () => Promise.resolve([]) };

export function perNameHeadlines(articles: readonly AlpacaNewsArticle[]): readonly string[] {
  return articles
    .filter((article) => article.symbols.length <= ROUNDUP_SYMBOL_LIMIT)
    .map((article) => article.headline.trim())
    .filter((headline) => headline.length > 0)
    .slice(-MAX_HEADLINES_PER_NAME);
}

export class AlpacaNewsSource implements NewsSource {
  constructor(private readonly client: NewsFetcher) {}

  async headlines(symbol: string, tradingDate: string, now: Date): Promise<readonly string[]> {
    const start = new Date(`${addDays(tradingDate, -NEWS_LOOKBACK_CALENDAR_DAYS)}T00:00:00.000Z`);
    return perNameHeadlines(await this.client.fetchNews([symbol], start, now));
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
