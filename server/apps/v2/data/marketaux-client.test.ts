import {
  MARKETAUX_NEWS_URL,
  MARKETAUX_PAGE_LIMIT,
  MarketauxClient,
  MarketauxRequestError,
  marketauxSymbol,
  parseMarketauxBody,
} from './marketaux-client.js';

const API_KEY = 'secret-token-value';
const START = new Date('2026-09-26T00:00:00.000Z');
const END = new Date('2026-09-29T07:00:00.123Z');

function body(found: number, data: unknown[]): unknown {
  return { meta: { found, returned: data.length, limit: 3, page: 1 }, data };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('marketauxSymbol', () => {
  it('appends the London suffix to the bare ticker', () => {
    expect(marketauxSymbol('VOD')).toBe('VOD.L');
  });
});

describe('parseMarketauxBody', () => {
  it('reads found, titles, publish times and entity counts', () => {
    const parsed = parseMarketauxBody(
      body(7, [
        {
          title: 'A',
          published_at: '2026-09-28T10:00:00.000000Z',
          entities: [{ name: 'X' }, { name: 'Y' }],
        },
        { title: 'B', published_at: '2026-09-28T11:00:00.000000Z' },
      ]),
    );
    expect(parsed).toEqual({
      found: 7,
      articles: [
        { title: 'A', publishedAt: '2026-09-28T10:00:00.000000Z', companyCount: 2 },
        { title: 'B', publishedAt: '2026-09-28T11:00:00.000000Z', companyCount: 0 },
      ],
    });
  });

  it('counts an entity per company: cross-listings sharing a name are one', () => {
    const entities = [
      { symbol: 'AZN', name: 'AstraZeneca PLC' },
      { symbol: 'AZN.L', name: 'AstraZeneca PLC' },
      { symbol: '0A4J.L', name: 'AstraZeneca PLC' },
      { symbol: 'LLY', name: 'Eli Lilly and Company' },
      { symbol: 'NOVO', symbol2: 'x' },
      { symbol: 'NOVO', symbol2: 'y' },
      { symbol: 'ROG' },
      {},
      { name: 7, symbol: 8 },
      'junk',
      null,
    ];
    const parsed = parseMarketauxBody(
      body(1, [{ title: 'A', published_at: '2026-09-28T10:00:00Z', entities }]),
    );
    expect(parsed.articles[0]?.companyCount).toBe(4);
  });

  it('skips articles missing a title or a publish time', () => {
    const parsed = parseMarketauxBody(
      body(3, [
        { title: 'ok', published_at: '2026-09-28T10:00:00Z' },
        { published_at: '2026-09-28T10:00:00Z' },
        { title: 'no time' },
        'text',
        null,
      ]),
    );
    expect(parsed.articles.map((article) => article.title)).toEqual(['ok']);
  });

  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['no meta', { data: [] }],
    ['null meta', { meta: null, data: [] }],
    ['no data', { meta: { found: 1 } }],
    ['non-array data', { meta: { found: 1 }, data: {} }],
    ['string found', { meta: { found: '1' }, data: [] }],
    ['fractional found', { meta: { found: 1.5 }, data: [] }],
    ['negative found', { meta: { found: -1 }, data: [] }],
  ])('rejects %s as a bad body', (_label, payload) => {
    expect(() => parseMarketauxBody(payload)).toThrow(MarketauxRequestError);
    expect(() => parseMarketauxBody(payload)).toThrow('bad_body');
  });

  it('accepts a body with found of zero and no articles', () => {
    expect(parseMarketauxBody(body(0, []))).toEqual({ found: 0, articles: [] });
  });
});

describe('MarketauxClient', () => {
  it('requests the .L symbol over the window with the free-tier page size', async () => {
    const urls: URL[] = [];
    const client = new MarketauxClient(API_KEY, (input) => {
      urls.push(input as URL);
      return Promise.resolve(jsonResponse(body(0, [])));
    });
    await client.fetchArticles('AZN', START, END);
    const [url] = urls;
    expect(`${url?.origin}${url?.pathname}`).toBe(MARKETAUX_NEWS_URL);
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      symbols: 'AZN.L',
      published_after: '2026-09-26T00:00:00',
      published_before: '2026-09-29T07:00:00',
      language: 'en',
      limit: String(MARKETAUX_PAGE_LIMIT),
      api_token: API_KEY,
    });
    expect(MARKETAUX_PAGE_LIMIT).toBe(3);
  });

  it('returns the parsed result on success', async () => {
    const client = new MarketauxClient(API_KEY, () =>
      Promise.resolve(
        jsonResponse(body(1, [{ title: 'h', published_at: '2026-09-28T09:00:00Z' }])),
      ),
    );
    expect(await client.fetchArticles('AZN', START, END)).toEqual({
      found: 1,
      articles: [{ title: 'h', publishedAt: '2026-09-28T09:00:00Z', companyCount: 0 }],
    });
  });

  it.each([402, 429, 500])('reports http_%i from the status alone', async (status) => {
    const client = new MarketauxClient(API_KEY, () =>
      Promise.resolve(jsonResponse({ error: { message: `token ${API_KEY} rejected` } }, status)),
    );
    const error = await rejection(client.fetchArticles('AZN', START, END));
    expect(error).toBeInstanceOf(MarketauxRequestError);
    expect((error as MarketauxRequestError).reason).toBe(`http_${status}`);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('reports a non-JSON body as bad_body', async () => {
    const client = new MarketauxClient(API_KEY, () => Promise.resolve(new Response('<html>')));
    expect(((await rejection(client.fetchArticles('AZN', START, END))) as Error).message).toBe(
      'bad_body',
    );
  });

  it('never lets the token into the error when the network fails', async () => {
    const client = new MarketauxClient(API_KEY, (input) =>
      Promise.reject(new TypeError(`fetch failed for ${String(input)}`)),
    );
    const error = (await rejection(client.fetchArticles('AZN', START, END))) as Error;
    expect(error).toBeInstanceOf(MarketauxRequestError);
    expect(error.message).toBe('network');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(error.stack ?? '').not.toContain(API_KEY);
  });

  it('reports an aborted request as a timeout', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const client = new MarketauxClient(API_KEY, () => Promise.reject(timeout));
    expect(((await rejection(client.fetchArticles('AZN', START, END))) as Error).message).toBe(
      'timeout',
    );
  });

  it('hands fetch an abort signal so a hung request cannot stall the cycle', async () => {
    let signal: AbortSignal | undefined;
    const client = new MarketauxClient(API_KEY, (_input, init) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(jsonResponse(body(0, [])));
    });
    await client.fetchArticles('AZN', START, END);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
