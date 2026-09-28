import type { AlpacaNewsArticle } from '../../../providers/market-intelligence/sources/alpaca-news-client.js';
import { addDays } from './macro-calendar.js';

export const MAX_HEADLINES_PER_NAME = 10;
const NEWS_LOOKBACK_CALENDAR_DAYS = 1;
const ROUNDUP_SYMBOL_LIMIT = 5;

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

// doc 66 G18(2): "Polymarket and LSE news are skipped for now" — no underlying-key
// mapping exists for the 22 diversified LSE index/commodity/bond ETFs (unlike the
// leveraged single-stock-proxy ETPs #522/#960 built the underlying-key pattern for)
export function newsForVenue(inner: NewsSource, isLse: (symbol: string) => boolean): NewsSource {
  return {
    headlines: (symbol, tradingDate, now) =>
      isLse(symbol)
        ? NO_NEWS.headlines(symbol, tradingDate, now)
        : inner.headlines(symbol, tradingDate, now),
  };
}
