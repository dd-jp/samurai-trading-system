import { describe, expect, it } from 'vitest';
import type { AlpacaNewsArticle } from '../../../providers/market-intelligence/sources/alpaca-news-client.js';
import { guardedStore, openSharedStore } from '../../../shared/store/index.js';
import { journalledNewsSource } from './journalled-news.js';
import {
  ALPACA_NEWS_PROVIDER,
  AlpacaNewsSource,
  MAX_HEADLINES_PER_NAME,
  NO_NEWS,
  newsFailureReason,
  newsForVenue,
  perNameHeadlines,
} from './news.js';
import { SqliteNewsLedger } from './news-ledger.js';

function journal() {
  const db = openSharedStore(':memory:');
  return new SqliteNewsLedger(guardedStore(db, 'v2', { enabled: true }));
}

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

describe('US headline journal (#1981)', () => {
  const NOW = new Date('2026-09-25T07:00:00.000Z');
  const fetcher = (articles: AlpacaNewsArticle[]) => ({
    fetchNews: () => Promise.resolve(articles),
  });

  it('journals the headlines the debate reads, with their source ids and publish times, before returning them', async () => {
    const ledger = journal();
    const source = new AlpacaNewsSource(
      fetcher([
        article(1, ' NVDA beats ', ['NVDA']),
        article(2, 'roundup', ['A', 'B', 'C', 'D', 'E', 'F']),
      ]),
      ledger,
    );
    expect(await source.headlines('NVDA', '2026-09-25', NOW)).toEqual(['NVDA beats']);
    expect(ledger.forDate('2026-09-25')).toEqual([
      {
        tradingDate: '2026-09-25',
        symbol: 'NVDA',
        provider: ALPACA_NEWS_PROVIDER,
        status: 'ok',
        reason: '',
        requested: true,
        found: 2,
        headlines: [
          { title: 'NVDA beats', publishedAt: '2026-09-24T01:00:00.000Z', sourceId: '1' },
        ],
        fetchedAt: NOW.toISOString(),
      },
    ]);
  });

  it('journals one no_news row when nothing survives the filters', async () => {
    const ledger = journal();
    await new AlpacaNewsSource(fetcher([]), ledger).headlines('NVDA', '2026-09-25', NOW);
    expect(ledger.forDate('2026-09-25')).toMatchObject([
      { symbol: 'NVDA', status: 'no_news', found: 0, headlines: [] },
    ]);
  });

  it('journals a failed fetch as error with its masked reason and still throws', async () => {
    const ledger = journal();
    const source = new AlpacaNewsSource(
      { fetchNews: () => Promise.reject(new Error('HTTP 500 Bearer abcdefghijklmnopqrstuvwxyz')) },
      ledger,
    );
    await expect(source.headlines('NVDA', '2026-09-25', NOW)).rejects.toThrow('HTTP 500');
    const [row] = ledger.forDate('2026-09-25');
    expect(row).toMatchObject({ status: 'error', found: undefined, headlines: [] });
    expect(row?.reason).toContain('HTTP 500');
    expect(row?.reason).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('rethrows the fetch error, not a ledger failure, and masks the reason the cycle journals', async () => {
    const failing = {
      record: () => {
        throw new Error('SQLITE_BUSY');
      },
    };
    const source = new AlpacaNewsSource(
      { fetchNews: () => Promise.reject(new Error('HTTP 500')) },
      failing,
    );
    await expect(source.headlines('NVDA', '2026-09-25', NOW)).rejects.toEqual(
      new Error('HTTP 500'),
    );
    const masked = newsFailureReason(new Error('HTTP 500 Bearer abcdefghijklmnopqrstuvwxyz'));
    expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(newsFailureReason(new Error(masked))).toBe(masked);
  });

  it('skips the name when the ledger cannot record a successful fetch', async () => {
    const failing = {
      record: () => {
        throw new Error('SQLITE_FULL');
      },
    };
    const source = new AlpacaNewsSource(fetcher([article(1, 'x', ['NVDA'])]), failing);
    await expect(source.headlines('NVDA', '2026-09-25', NOW)).rejects.toThrow('SQLITE_FULL');
  });

  it('replays the first journalled lookup per name, US failures rejected and UK failures as NO_NEWS, and falls back otherwise', async () => {
    const ledger = journal();
    const live = new AlpacaNewsSource(fetcher([article(1, 'first', ['NVDA'])]), ledger);
    await live.headlines('NVDA', '2026-09-25', NOW);
    await new AlpacaNewsSource(fetcher([article(2, 'rerun', ['NVDA'])]), ledger).headlines(
      'NVDA',
      '2026-09-25',
      NOW,
    );
    await new AlpacaNewsSource({ fetchNews: () => Promise.reject(new Error('HTTP 503')) }, ledger)
      .headlines('AMD', '2026-09-25', NOW)
      .catch(() => undefined);
    const uk = {
      tradingDate: '2026-09-25',
      provider: 'marketaux',
      requested: true,
      fetchedAt: NOW.toISOString(),
    };
    ledger.record({
      ...uk,
      symbol: 'VOD',
      status: 'ok',
      reason: 'found=2',
      found: 2,
      headlines: [
        { title: 'uk', publishedAt: '2026-09-24T09:00:00.000Z' },
        { title: 'after fetch', publishedAt: '2026-09-25T08:00:00.000Z' },
      ],
    });
    ledger.record({ ...uk, symbol: 'VOD', status: 'ok', reason: 'rerun', found: 0, headlines: [] });
    ledger.record({
      ...uk,
      symbol: 'BP',
      status: 'error',
      reason: 'http_500',
      found: undefined,
      headlines: [],
    });
    const replayed = journalledNewsSource(ledger, {
      headlines: (symbol) => Promise.resolve([`fallback ${symbol}`]),
    });
    expect(await replayed.headlines('NVDA', '2026-09-25', NOW)).toEqual(['first']);
    await expect(replayed.headlines('AMD', '2026-09-25', NOW)).rejects.toEqual(
      new Error('HTTP 503'),
    );
    expect(await replayed.headlines('VOD', '2026-09-25', NOW)).toEqual(['uk']);
    expect(await replayed.headlines('BP', '2026-09-25', NOW)).toEqual([]);
    expect(await replayed.headlines('SHEL', '2026-09-25', NOW)).toEqual(['fallback SHEL']);
    expect(await replayed.headlines('NVDA', '2026-09-24', NOW)).toEqual(['fallback NVDA']);
  });
});
