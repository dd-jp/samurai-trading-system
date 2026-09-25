import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenBucket } from '../../../shared/index.js';
import { AlpacaNewsClient } from './alpaca-news-client.js';

const START = new Date('2026-09-24T00:00:00Z');
const END = new Date('2026-09-25T08:00:00Z');

function article(id: number | string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, headline: `headline ${id}`, created_at: createdAt, ...extra };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function clientWith(fetchImpl: typeof fetch): AlpacaNewsClient {
  return new AlpacaNewsClient({
    apiKey: 'key',
    apiSecret: 'secret',
    baseUrl: 'https://news.test',
    fetchImpl,
    rateLimiter: new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 }),
  });
}

describe('AlpacaNewsClient construction', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to start without a key or secret', () => {
    vi.stubEnv('ALPACA_API_KEY', '');
    vi.stubEnv('ALPACA_API_SECRET', 'secret');
    expect(() => new AlpacaNewsClient()).toThrow('ALPACA_API_KEY is not set');
    expect(() => new AlpacaNewsClient({ apiKey: 'key', apiSecret: '' })).toThrow(
      'ALPACA_API_SECRET is not set',
    );
  });

  it('falls back to the environment for credentials', () => {
    vi.stubEnv('ALPACA_API_KEY', 'env-key');
    vi.stubEnv('ALPACA_API_SECRET', 'env-secret');
    expect(() => new AlpacaNewsClient()).not.toThrow();
  });
});

describe('AlpacaNewsClient.fetchNews', () => {
  it('returns nothing and makes no request for an empty symbol list', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await clientWith(fetchImpl).fetchNews([], START, END)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the query and auth headers Alpaca expects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ news: [] }));
    await clientWith(fetchImpl).fetchNews(['AAPL', 'MSFT'], START, END);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://news.test/v1beta1/news');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      symbols: 'AAPL,MSFT',
      start: START.toISOString(),
      end: END.toISOString(),
      limit: '50',
      sort: 'asc',
    });
    expect(init?.headers).toEqual({ 'APCA-API-KEY-ID': 'key', 'APCA-API-SECRET-KEY': 'secret' });
  });

  it('follows next_page_token, de-duplicates by id and sorts by creation time', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          news: [article(2, '2026-09-24T12:00:00Z'), article(1, '2026-09-24T10:00:00Z')],
          next_page_token: 'page-2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          news: [
            article('2', '2026-09-24T12:00:00Z', { summary: 'updated' }),
            article(3, '2026-09-24T09:00:00Z'),
          ],
          next_page_token: '',
        }),
      );

    const news = await clientWith(fetchImpl).fetchNews(['AAPL'], START, END);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get('page_token')).toBe(
      'page-2',
    );
    expect(news.map((item) => item.id)).toEqual(['3', '1', '2']);
    expect(news.find((item) => item.id === '2')?.summary).toBe('updated');
  });

  it('refuses to follow pagination past 40 pages', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse({ news: [], next_page_token: 'again' }));
    await expect(clientWith(fetchImpl).fetchNews(['AAPL'], START, END)).rejects.toThrow(
      'exceeded 40 pages for AAPL',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(40);
  });

  it('surfaces an HTTP error with its status', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 403, statusText: 'Forbidden' }));
    await expect(clientWith(fetchImpl).fetchNews(['AAPL'], START, END)).rejects.toThrow(
      'HTTP 403 Forbidden',
    );
  });

  it('rejects a body that is not an object and treats a missing news array as empty', async () => {
    const notObject = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse('text'));
    await expect(clientWith(notObject).fetchNews(['AAPL'], START, END)).rejects.toThrow(
      'malformed response: expected an object, got "text"',
    );
    const noNews = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ news: 'x' }));
    expect(await clientWith(noNews).fetchNews(['AAPL'], START, END)).toEqual([]);
  });
});

describe('AlpacaNewsClient article validation', () => {
  async function fetchOne(raw: unknown) {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ news: [raw] }));
    return clientWith(fetchImpl).fetchNews(['AAPL'], START, END);
  }

  it('fills optional fields with defaults and keeps the raw payload', async () => {
    const raw = article(7, '2026-09-24T10:00:00Z', { symbols: ['AAPL', 3, 'MSFT'] });
    const [item] = await fetchOne(raw);
    expect(item).toEqual({
      id: '7',
      headline: 'headline 7',
      summary: '',
      symbols: ['AAPL', 'MSFT'],
      source: 'alpaca',
      url: '',
      created_at: new Date('2026-09-24T10:00:00Z'),
      updated_at: new Date('2026-09-24T10:00:00Z'),
      payload: JSON.stringify(raw),
    });
  });

  it('keeps provided optional fields and a valid updated_at', async () => {
    const [item] = await fetchOne(
      article(8, '2026-09-24T10:00:00Z', {
        summary: 's',
        source: 'benzinga',
        url: 'https://x',
        updated_at: '2026-09-24T11:00:00Z',
        symbols: 'AAPL',
      }),
    );
    expect(item?.summary).toBe('s');
    expect(item?.source).toBe('benzinga');
    expect(item?.url).toBe('https://x');
    expect(item?.symbols).toEqual([]);
    expect(item?.updated_at).toEqual(new Date('2026-09-24T11:00:00Z'));
  });

  it.each([
    ['a non-object', 'text'],
    ['null', null],
    ['a missing id', { headline: 'h', created_at: '2026-09-24T10:00:00Z' }],
    ['a missing headline', { id: 1, created_at: '2026-09-24T10:00:00Z' }],
    ['an unparseable created_at', { id: 1, headline: 'h', created_at: 'yesterday' }],
    ['a non-string created_at', { id: 1, headline: 'h', created_at: 5 }],
  ])('rejects an article with %s', async (_label, raw) => {
    await expect(fetchOne(raw)).rejects.toThrow('malformed article');
  });

  it('truncates a long malformed article in the error', async () => {
    const raw = { id: 1, created_at: 'bad', headline: 'x'.repeat(500) };
    await expect(fetchOne(raw)).rejects.toThrow(/malformed article: .{200}…$/);
  });
});
