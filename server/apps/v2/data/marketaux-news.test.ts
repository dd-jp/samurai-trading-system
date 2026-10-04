import type { LogEntry } from '../../../shared/index.js';
import { guardedStore } from '../../../shared/store/index.js';
import { migratedMemoryStore } from '../../../shared/store/migrated-template.js';
import {
  type MarketauxArticle,
  type MarketauxFetch,
  MarketauxRequestError,
  type MarketauxResult,
} from './marketaux-client.js';
import {
  admission,
  classify,
  isDegraded,
  MARKETAUX_LOOKBACK_CALENDAR_DAYS,
  MARKETAUX_REQUEST_CEILING,
  MarketauxNewsSource,
  newsWindow,
  pointInTime,
  selectHeadlines,
  ukNewsCoverage,
  utcDayStart,
  windowCoverage,
} from './marketaux-news.js';
import { MAX_HEADLINES_PER_NAME } from './news.js';
import { type NewsRecord, SqliteNewsLedger } from './news-ledger.js';

const NOW = new Date('2026-09-29T07:00:00.000Z');
const TRADING_DATE = '2026-09-29';
const WINDOW = { start: new Date('2026-09-26T00:00:00.000Z'), end: NOW };

function article(title: string, publishedAt: string, companyCount = 1): MarketauxArticle {
  return { title, publishedAt, companyCount };
}

function result(found: number, articles: readonly MarketauxArticle[]): MarketauxResult {
  return { found, articles };
}

function record(overrides: Partial<NewsRecord> = {}): NewsRecord {
  return {
    tradingDate: TRADING_DATE,
    symbol: 'AZN',
    provider: 'marketaux',
    status: 'ok',
    reason: 'found=1',
    requested: true,
    found: 1,
    headlines: [{ title: 'h', publishedAt: '2026-09-28T09:00:00.000Z' }],
    fetchedAt: NOW.toISOString(),
    ...overrides,
  };
}

function scripted(
  responses: Record<string, MarketauxResult | MarketauxRequestError | Error>,
): MarketauxFetch & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchArticles: (tidm) => {
      calls.push(tidm);
      const response = responses[tidm] ?? result(0, []);
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
}

function build(
  client: MarketauxFetch | undefined,
  options: { ceiling?: number; logs?: LogEntry[] } = {},
) {
  const db = migratedMemoryStore();
  const ledger = new SqliteNewsLedger(guardedStore(db, 'v2', { enabled: true }));
  const source = new MarketauxNewsSource({
    client,
    ledger,
    ceiling: options.ceiling,
    logger: { log: (entry) => options.logs?.push(entry) },
  });
  return { db, ledger, source };
}

describe('newsWindow', () => {
  it('opens at midnight UTC the lookback days before the trading date and closes at now', () => {
    expect(MARKETAUX_LOOKBACK_CALENDAR_DAYS).toBe(3);
    expect(newsWindow(TRADING_DATE, NOW)).toEqual(WINDOW);
  });

  it('is undefined when the window would not have opened by now', () => {
    expect(newsWindow('2026-10-20', NOW)).toBeUndefined();
    expect(newsWindow('2026-10-02', new Date('2026-09-29T00:00:00.000Z'))).toBeUndefined();
    expect(newsWindow('2026-10-01', new Date('2026-09-28T00:00:00.000Z'))).toBeUndefined();
  });

  it('treats a start equal to now as not open', () => {
    expect(newsWindow('2026-09-29', new Date('2026-09-26T00:00:00.000Z'))).toBeUndefined();
    expect(newsWindow('2026-09-29', new Date('2026-09-26T00:00:00.001Z'))).toBeDefined();
  });
});

describe('utcDayStart', () => {
  it('is midnight UTC of the day', () => {
    expect(utcDayStart(new Date('2026-09-29T23:59:59.999Z'))).toBe('2026-09-29T00:00:00.000Z');
  });
});

describe('admission', () => {
  it('admits below the ceiling and stops at it', () => {
    const at = (requests: number) => admission({ requests, quotaRefused: false });
    expect(MARKETAUX_REQUEST_CEILING).toBe(80);
    expect(at(0)).toBe('admit');
    expect(at(79)).toBe('admit');
    expect(at(80)).toBe('budget_stop');
    expect(at(150)).toBe('budget_stop');
  });

  it('honours an explicit ceiling', () => {
    expect(admission({ requests: 2, quotaRefused: false }, 3)).toBe('admit');
    expect(admission({ requests: 3, quotaRefused: false }, 3)).toBe('budget_stop');
  });

  it('stops for the day once the provider itself refused on quota, whatever the count', () => {
    expect(admission({ requests: 1, quotaRefused: true })).toBe('provider_quota_refused');
  });
});

describe('windowCoverage', () => {
  it('keeps articles from the window start up to but not including now', () => {
    const coverage = windowCoverage(
      [
        article('before', '2026-09-25T23:59:59.999Z'),
        article('at start', '2026-09-26T00:00:00.000Z'),
        article('inside', '2026-09-28T12:00:00.000000Z'),
        article('just before now', '2026-09-29T06:59:59.999Z'),
        article('at now', '2026-09-29T07:00:00.000Z'),
        article('future', '2026-09-30T00:00:00.000Z'),
        article('garbage', 'not a date'),
      ],
      WINDOW,
    );
    expect(coverage.inWindow.map((a) => a.title)).toEqual([
      'at start',
      'inside',
      'just before now',
    ]);
    expect(coverage.outOfWindow).toBe(4);
  });
});

describe('selectHeadlines', () => {
  it('drops roundups above five tagged entities and counts them', () => {
    const selected = selectHeadlines([
      article('five', '2026-09-28T10:00:00Z', 5),
      article('six', '2026-09-28T11:00:00Z', 6),
      article('zero', '2026-09-28T12:00:00Z', 0),
    ]);
    expect(selected.headlines.map((h) => h.title)).toEqual(['five', 'zero']);
    expect(selected.roundups).toBe(1);
  });

  it('drops blank titles, trims, orders oldest first and keeps the latest ten', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      article(` h${i} `, `2026-09-28T${String(i + 6).padStart(2, '0')}:00:00Z`),
    ).reverse();
    const selected = selectHeadlines([article('   ', '2026-09-28T05:00:00Z'), ...many]);
    expect(selected.headlines).toHaveLength(MAX_HEADLINES_PER_NAME);
    expect(selected.headlines[0]).toEqual({ title: 'h2', publishedAt: '2026-09-28T08:00:00.000Z' });
    expect(selected.headlines.at(-1)?.title).toBe('h11');
  });
});

describe('selectHeadlines blanks', () => {
  it('drops an article whose title is only whitespace, even when nothing else competes', () => {
    const selected = selectHeadlines([article('  \t ', '2026-09-28T10:00:00Z')]);
    expect(selected.headlines).toEqual([]);
  });

  it('trims the title it keeps', () => {
    expect(
      selectHeadlines([article('  padded  ', '2026-09-28T10:00:00Z')]).headlines[0]?.title,
    ).toBe('padded');
  });
});

describe('classify', () => {
  it('is ok with the headlines and the found count', () => {
    const classified = classify(result(1, [article('a', '2026-09-28T10:00:00Z')]), WINDOW);
    expect(classified).toMatchObject({ status: 'ok', reason: 'found=1', found: 1 });
    expect(classified.headlines).toEqual([{ title: 'a', publishedAt: '2026-09-28T10:00:00.000Z' }]);
  });

  it('is no_news with reason empty when the provider found nothing', () => {
    expect(classify(result(0, []), WINDOW)).toEqual({
      status: 'no_news',
      reason: 'empty',
      found: 0,
      headlines: [],
    });
  });

  it('records truncation when found exceeds what the page returned', () => {
    const classified = classify(
      result(39, [article('a', '2026-09-28T10:00:00Z'), article('b', '2026-09-28T11:00:00Z')]),
      WINDOW,
    );
    expect(classified.status).toBe('ok');
    expect(classified.reason).toBe('found=39,truncated=37');
  });

  it('drops out-of-window articles and says so, so a server that ignores the window is visible', () => {
    const classified = classify(
      result(2, [article('old', '2026-08-01T10:00:00Z'), article('new', '2026-09-28T10:00:00Z')]),
      WINDOW,
    );
    expect(classified.headlines.map((h) => h.title)).toEqual(['new']);
    expect(classified.reason).toBe('found=2,out_of_window=1');
  });

  it('is no_news, not empty, when everything returned was filtered out', () => {
    const classified = classify(
      result(2, [
        article('old', '2026-08-01T10:00:00Z'),
        article('wire', '2026-09-28T10:00:00Z', 9),
      ]),
      WINDOW,
    );
    expect(classified.status).toBe('no_news');
    expect(classified.reason).toBe('found=2,out_of_window=1,roundup=1');
  });
});

describe('pointInTime', () => {
  const stored = [
    { title: 'early', publishedAt: '2026-09-29T05:00:00.000Z' },
    { title: 'at now', publishedAt: '2026-09-29T07:00:00.000Z' },
    { title: 'later', publishedAt: '2026-09-29T08:00:00.000Z' },
  ];

  it('returns only what was published strictly before now', () => {
    expect(pointInTime(stored, NOW)).toEqual(['early']);
    expect(pointInTime(stored, new Date('2026-09-29T09:00:00.000Z'))).toEqual([
      'early',
      'at now',
      'later',
    ]);
  });
});

describe('ukNewsCoverage', () => {
  it('counts the latest record per name and the counts add up to the names asked', () => {
    const coverage = ukNewsCoverage([
      record({ symbol: 'AZN' }),
      record({ symbol: 'HSBA', status: 'no_news', reason: 'empty', headlines: [] }),
      record({ symbol: 'BP', status: 'error', reason: 'http_500', headlines: [] }),
      record({ symbol: 'BP', status: 'ok' }),
      record({ symbol: 'RR', status: 'budget_stop', headlines: [] }),
      record({ symbol: 'SHEL', status: 'no_key', headlines: [] }),
    ]);
    expect(coverage).toEqual({
      names: 5,
      withHeadlines: 2,
      noNews: 3,
      byStatus: { ok: 2, no_news: 1, error: 0, budget_stop: 1, no_key: 1 },
    });
    expect(coverage.withHeadlines + coverage.noNews).toBe(coverage.names);
  });

  it('is all zeros with no records', () => {
    expect(ukNewsCoverage([])).toMatchObject({ names: 0, withHeadlines: 0, noNews: 0 });
  });

  it('flags a degraded day only for error, budget_stop or no_key', () => {
    const degraded = (status: NewsRecord['status']) =>
      isDegraded(ukNewsCoverage([record({ status })]));
    expect(degraded('ok')).toBe(false);
    expect(degraded('no_news')).toBe(false);
    expect(degraded('error')).toBe(true);
    expect(degraded('budget_stop')).toBe(true);
    expect(degraded('no_key')).toBe(true);
  });
});

describe('MarketauxNewsSource', () => {
  it('returns headlines published before now and journals the request', async () => {
    const client = scripted({
      AZN: result(2, [
        article('early', '2026-09-28T10:00:00Z'),
        article('after now', '2026-09-29T08:00:00Z'),
      ]),
    });
    const { ledger, source } = build(client);
    expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual(['early']);
    expect(ledger.forDate(TRADING_DATE)).toEqual([
      expect.objectContaining({
        symbol: 'AZN',
        status: 'ok',
        requested: true,
        fetchedAt: NOW.toISOString(),
      }),
    ]);
  });

  it('serves a name from the per-day cache without a second request', async () => {
    const client = scripted({ AZN: result(1, [article('a', '2026-09-28T10:00:00Z')]) });
    const { ledger, source } = build(client);
    await source.headlines('AZN', TRADING_DATE, NOW);
    const later = new Date('2026-09-29T07:30:00.000Z');
    expect(await source.headlines('AZN', TRADING_DATE, later)).toEqual(['a']);
    expect(client.calls).toEqual(['AZN']);
    expect(ledger.forDate(TRADING_DATE)).toHaveLength(1);
  });

  it('caches an empty answer too, so a quiet name is not re-asked all day', async () => {
    const client = scripted({});
    const { source } = build(client);
    await source.headlines('GAW', TRADING_DATE, NOW);
    expect(await source.headlines('GAW', TRADING_DATE, NOW)).toEqual([]);
    expect(client.calls).toEqual(['GAW']);
  });

  it('asks again on another trading date and for another name', async () => {
    const client = scripted({});
    const { source } = build(client);
    await source.headlines('AZN', TRADING_DATE, NOW);
    await source.headlines('AZN', '2026-09-30', new Date('2026-09-30T07:00:00.000Z'));
    await source.headlines('BP', TRADING_DATE, NOW);
    expect(client.calls).toEqual(['AZN', 'AZN', 'BP']);
  });

  it('replays a cached day point-in-time when now is earlier than a stored headline', async () => {
    const client = scripted({
      AZN: result(2, [article('a', '2026-09-28T10:00:00Z'), article('b', '2026-09-29T06:00:00Z')]),
    });
    const { source } = build(client);
    await source.headlines('AZN', TRADING_DATE, NOW);
    expect(await source.headlines('AZN', TRADING_DATE, new Date('2026-09-29T05:00:00Z'))).toEqual([
      'a',
    ]);
  });

  it('returns nothing and journals the reason when the request fails, without throwing', async () => {
    const client = scripted({ AZN: new MarketauxRequestError('http_500') });
    const { ledger, source } = build(client);
    expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual([]);
    expect(ledger.forDate(TRADING_DATE)).toEqual([
      expect.objectContaining({
        status: 'error',
        reason: 'http_500',
        requested: true,
        found: undefined,
        headlines: [],
      }),
    ]);
  });

  it('retries a failed name on the next call rather than caching the failure', async () => {
    const client = scripted({ AZN: new MarketauxRequestError('timeout') });
    const { source } = build(client);
    await source.headlines('AZN', TRADING_DATE, NOW);
    await source.headlines('AZN', TRADING_DATE, NOW);
    expect(client.calls).toEqual(['AZN', 'AZN']);
  });

  it('records an unexpected error as internal without its text', async () => {
    const client = scripted({ AZN: new Error('boom with api_token=secret') });
    const { ledger, source } = build(client);
    expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual([]);
    expect(JSON.stringify(ledger.forDate(TRADING_DATE))).not.toContain('secret');
    expect(ledger.forDate(TRADING_DATE)[0]).toMatchObject({
      status: 'error',
      reason: 'internal',
      headlines: [],
    });
  });

  it('returns nothing without a key and makes no request', async () => {
    const { ledger, source } = build(undefined);
    expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual([]);
    expect(ledger.forDate(TRADING_DATE)).toEqual([
      expect.objectContaining({
        status: 'no_key',
        reason: 'no_api_key',
        requested: false,
        found: undefined,
        headlines: [],
      }),
    ]);
  });

  it('returns nothing for a trading date whose window has not opened', async () => {
    const client = scripted({});
    const { ledger, source } = build(client);
    expect(await source.headlines('AZN', '2026-12-01', NOW)).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(ledger.forDate('2026-12-01')[0]).toMatchObject({
      headlines: [],
      status: 'no_news',
      reason: 'window_not_open',
      requested: false,
    });
  });

  it('hard-stops at the ceiling: later names get no request and a budget_stop row', async () => {
    const client = scripted({});
    const { ledger, source } = build(client, { ceiling: 3 });
    const names = ['A', 'B', 'C', 'D', 'E'];
    for (const name of names) expect(await source.headlines(name, TRADING_DATE, NOW)).toEqual([]);
    expect(client.calls).toEqual(['A', 'B', 'C']);
    expect(ledger.forDate(TRADING_DATE).map((row) => [row.symbol, row.status, row.reason])).toEqual(
      [
        ['A', 'no_news', 'empty'],
        ['B', 'no_news', 'empty'],
        ['C', 'no_news', 'empty'],
        ['D', 'budget_stop', 'budget_stop'],
        ['E', 'budget_stop', 'budget_stop'],
      ],
    );
  });

  it('counts spent requests across sources sharing a store and across failures', async () => {
    const db = migratedMemoryStore();
    const ledger = new SqliteNewsLedger(guardedStore(db, 'v2', { enabled: true }));
    const failing = scripted({ A: new MarketauxRequestError('http_500') });
    const first = new MarketauxNewsSource({ client: failing, ledger, ceiling: 2 });
    await first.headlines('A', TRADING_DATE, NOW);
    await first.headlines('B', TRADING_DATE, NOW);
    const restarted = scripted({});
    const second = new MarketauxNewsSource({ client: restarted, ledger, ceiling: 2 });
    await second.headlines('C', TRADING_DATE, NOW);
    expect(restarted.calls).toEqual([]);
  });

  it('starts a fresh budget on the next UTC day', async () => {
    const client = scripted({});
    const { source } = build(client, { ceiling: 1 });
    await source.headlines('A', TRADING_DATE, NOW);
    await source.headlines('B', TRADING_DATE, NOW);
    const tomorrow = new Date('2026-09-30T00:00:00.000Z');
    await source.headlines('C', '2026-09-30', tomorrow);
    expect(client.calls).toEqual(['A', 'C']);
  });

  it('stops for the day once the provider reports its usage limit (402)', async () => {
    const client = scripted({ A: new MarketauxRequestError('http_402') });
    const { ledger, source } = build(client);
    await source.headlines('A', TRADING_DATE, NOW);
    await source.headlines('B', TRADING_DATE, new Date('2026-09-29T20:00:00.000Z'));
    expect(client.calls).toEqual(['A']);
    expect(ledger.forDate(TRADING_DATE)[1]).toMatchObject({
      status: 'budget_stop',
      reason: 'provider_quota_refused',
    });
  });

  it('pauses for a minute after a 429 and then resumes', async () => {
    const client = scripted({ A: new MarketauxRequestError('http_429') });
    const { ledger, source } = build(client);
    await source.headlines('A', TRADING_DATE, NOW);
    await source.headlines('B', TRADING_DATE, new Date(NOW.getTime() + 59_999));
    await source.headlines('C', TRADING_DATE, new Date(NOW.getTime() + 60_000));
    expect(client.calls).toEqual(['A', 'C']);
    expect(ledger.forDate(TRADING_DATE)[1]).toMatchObject({
      symbol: 'B',
      status: 'budget_stop',
      reason: 'rate_limited',
      requested: false,
    });
  });

  it('does not throw into the cycle when the store fails', async () => {
    const client = scripted({});
    const { db, source } = build(client);
    db.close();
    expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual([]);
  });

  it('logs a failure line naming the reason but never the key', async () => {
    const logs: LogEntry[] = [];
    const client = scripted({});
    const { db, source } = build(client, { logs });
    db.close();
    await source.headlines('AZN', TRADING_DATE, NOW);
    expect(logs).toEqual([
      {
        trace_id: 'v2-2026-09-29-AZN',
        stage: 'v2',
        level: 'warn',
        event: 'v2_uk_news_failed',
        message: 'UK news for AZN failed: internal',
      },
    ]);
  });

  describe('journalCoverage', () => {
    it('logs how many UK names got headlines against NO_NEWS at info when nothing degraded', async () => {
      const logs: LogEntry[] = [];
      const client = scripted({
        AZN: result(1, [article('a', '2026-09-28T10:00:00Z')]),
        HSBA: result(1, [article('b', '2026-09-28T10:00:00Z')]),
      });
      const { source } = build(client, { logs });
      for (const name of ['AZN', 'HSBA', 'GAW']) await source.headlines(name, TRADING_DATE, NOW);
      const coverage = source.journalCoverage(TRADING_DATE);
      expect(coverage).toMatchObject({ names: 3, withHeadlines: 2, noNews: 1 });
      expect(logs).toEqual([
        {
          trace_id: 'v2-2026-09-29',
          stage: 'v2',
          level: 'info',
          event: 'v2_uk_news_coverage',
          message: 'UK news: 2 of 3 names had headlines, 1 NO_NEWS',
          payload: expect.objectContaining({
            trading_date: TRADING_DATE,
            names: 3,
            withHeadlines: 2,
            noNews: 1,
          }),
        },
      ]);
    });

    it('logs at warn when a name failed, ran out of budget or had no key', async () => {
      const logs: LogEntry[] = [];
      const { source } = build(undefined, { logs });
      await source.headlines('AZN', TRADING_DATE, NOW);
      source.journalCoverage(TRADING_DATE);
      expect(logs[0]).toMatchObject({ level: 'warn', event: 'v2_uk_news_coverage' });
    });

    it('neither counts nor serves from cache the US rows sharing v2_news (#1981)', async () => {
      const client = scripted({});
      const { ledger, source } = build(client);
      ledger.record({
        tradingDate: TRADING_DATE,
        symbol: 'AZN',
        provider: 'alpaca',
        status: 'ok',
        reason: '',
        requested: true,
        found: 1,
        headlines: [{ title: 'us', publishedAt: '2026-09-28T10:00:00.000Z', sourceId: '7' }],
        fetchedAt: NOW.toISOString(),
      });
      expect(source.journalCoverage(TRADING_DATE)).toBeUndefined();
      expect(await source.headlines('AZN', TRADING_DATE, NOW)).toEqual([]);
      expect(client.calls).toEqual(['AZN']);
    });

    it('says nothing on a day with no UK names', () => {
      const logs: LogEntry[] = [];
      const { source } = build(scripted({}), { logs });
      expect(source.journalCoverage(TRADING_DATE)).toBeUndefined();
      expect(logs).toEqual([]);
    });

    it('never throws when the store is gone', () => {
      const logs: LogEntry[] = [];
      const { db, source } = build(scripted({}), { logs });
      db.close();
      expect(source.journalCoverage(TRADING_DATE)).toBeUndefined();
      expect(logs).toEqual([
        expect.objectContaining({
          event: 'v2_uk_news_failed',
          message: 'UK news for coverage failed: internal',
        }),
      ]);
    });

    it('works without a logger', async () => {
      const db = migratedMemoryStore();
      const ledger = new SqliteNewsLedger(guardedStore(db, 'v2', { enabled: true }));
      const source = new MarketauxNewsSource({ client: scripted({}), ledger });
      await source.headlines('AZN', TRADING_DATE, NOW);
      expect(source.journalCoverage(TRADING_DATE)).toMatchObject({ names: 1 });
      db.close();
      expect(await source.headlines('BP', TRADING_DATE, NOW)).toEqual([]);
      expect(source.journalCoverage(TRADING_DATE)).toBeUndefined();
    });
  });
});
