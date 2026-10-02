import { MARKETAUX_PROVIDER, pointInTime } from './marketaux-news.js';
import { ALPACA_NEWS_PROVIDER, type NewsSource } from './news.js';
import type { NewsLedger, NewsRecord } from './news-ledger.js';

function usHeadlines(record: NewsRecord): Promise<readonly string[]> {
  if (record.status === 'error') return Promise.reject(new Error(record.reason));
  return Promise.resolve(record.headlines.map((headline) => headline.title));
}

// A UK lookup that failed served NO_NEWS live, and its row's empty headline list replays that
function ukHeadlines(record: NewsRecord): Promise<readonly string[]> {
  return Promise.resolve(pointInTime(record.headlines, new Date(record.fetchedAt)));
}

export function journalledNewsSource(
  ledger: Pick<NewsLedger, 'first'>,
  fallback: NewsSource,
): NewsSource {
  return {
    headlines: (symbol, tradingDate, now) => {
      const us = ledger.first(ALPACA_NEWS_PROVIDER, tradingDate, symbol);
      if (us !== undefined) return usHeadlines(us);
      const uk = ledger.first(MARKETAUX_PROVIDER, tradingDate, symbol);
      if (uk !== undefined) return ukHeadlines(uk);
      return fallback.headlines(symbol, tradingDate, now);
    },
  };
}
