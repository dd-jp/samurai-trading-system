import { describe, expect, it } from 'vitest';
import type { AlpacaNewsArticle } from '../../../providers/market-intelligence/sources/alpaca-news-client.js';
import {
  AlpacaNewsSource,
  MAX_HEADLINES_PER_NAME,
  NO_NEWS,
  newsForVenue,
  perNameHeadlines,
} from './news.js';

function article(id: number, headline: string, symbols: string[]): AlpacaNewsArticle {
  return {
    id: String(id),
    headline,
    summary: '',
    symbols,
    source: 'benzinga',
    url: '',
    created_at: new Date(Date.UTC(2026, 8, 24, id)),
    updated_at: new Date(Date.UTC(2026, 8, 24, id)),
    payload: '',
  };
}

describe('news', () => {
  it('drops class-wide roundups and blank headlines and keeps the latest ten', () => {
    const articles = [
      article(0, 'roundup', ['A', 'B', 'C', 'D', 'E', 'F']),
      article(1, '  ', ['AAPL']),
      ...Array.from({ length: 12 }, (_, i) => article(i + 2, `h${i}`, ['AAPL', 'MSFT'])),
    ];
    const headlines = perNameHeadlines(articles);
    expect(headlines).toHaveLength(MAX_HEADLINES_PER_NAME);
    expect(headlines[0]).toBe('h2');
    expect(headlines.at(-1)).toBe('h11');
    expect(perNameHeadlines([article(0, 'five', ['A', 'B', 'C', 'D', 'E'])])).toEqual(['five']);
  });

  it('queries the US symbol from the prior calendar day to now', async () => {
    const calls: unknown[] = [];
    const source = new AlpacaNewsSource({
      fetchNews: (symbols, start, end) => {
        calls.push([symbols, start.toISOString(), end.toISOString()]);
        return Promise.resolve([article(1, 'x', ['NVDA'])]);
      },
    });
    const now = new Date('2026-09-25T07:00:00.000Z');
    expect(await source.headlines('NVDA', '2026-09-25', now)).toEqual(['x']);
    expect(calls).toEqual([[['NVDA'], '2026-09-24T00:00:00.000Z', '2026-09-25T07:00:00.000Z']]);
    expect(await NO_NEWS.headlines('NVDA', '2026-09-25', now)).toEqual([]);
  });

  it('routes UK stocks to their own source, LSE ETFs to no news and everything else through (doc 66 G18(2))', async () => {
    const source = (headline: string) => ({ headlines: () => Promise.resolve([headline]) });
    const routed = newsForVenue({
      us: source('us'),
      ukStock: source('uk'),
      isUkStock: (symbol) => symbol === 'VOD',
      isLseEtf: (symbol) => symbol === 'ISF',
    });
    const now = new Date('2026-09-25T07:00:00.000Z');
    expect(await routed.headlines('ISF', '2026-09-25', now)).toEqual([]);
    expect(await routed.headlines('VOD', '2026-09-25', now)).toEqual(['uk']);
    expect(await routed.headlines('AAPL', '2026-09-25', now)).toEqual(['us']);
  });

  it('sends a symbol that is both UK stock and LSE line to the UK source', async () => {
    const routed = newsForVenue({
      us: NO_NEWS,
      ukStock: { headlines: () => Promise.resolve(['uk']) },
      isUkStock: () => true,
      isLseEtf: () => true,
    });
    expect(await routed.headlines('X', '2026-09-25', new Date())).toEqual(['uk']);
  });
});
