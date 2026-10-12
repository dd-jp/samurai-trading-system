import {
  ALPACA_CORPORATE_ACTIONS_URL,
  AlpacaSplitsClient,
  AlpacaSplitsError,
  actionChunks,
  actionsUrl,
  parseActionPage,
  splitsWithin,
} from './alpaca-splits.js';

const CREDENTIALS = { apiKey: 'alpaca-key-value', apiSecret: 'alpaca-secret-value' };
const NOW = new Date('2026-10-09T21:30:00.000Z');

// shape of GET /v1/corporate-actions per Alpaca's market-data reference; rates as new over old shares
function forward(symbol: string, ex_date: string, new_rate: number, old_rate: number) {
  return {
    id: `f-${ex_date}`,
    symbol,
    cusip: '037833100',
    new_rate,
    old_rate,
    process_date: ex_date,
    ex_date,
    record_date: ex_date,
    payable_date: ex_date,
  };
}

function page(forwardSplits: unknown[], reverseSplits: unknown[] = [], next: unknown = null) {
  return {
    corporate_actions: { forward_splits: forwardSplits, reverse_splits: reverseSplits },
    next_page_token: next,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function clientReturning(
  responses: readonly (Response | Error)[],
  seen: { url: URL; init: RequestInit | undefined }[] = [],
): AlpacaSplitsClient {
  let call = 0;
  const fetchImpl = (async (input: URL, init?: RequestInit) => {
    seen.push({ url: input, init });
    const response = responses[Math.min(call, responses.length - 1)] as Response | Error;
    call += 1;
    if (response instanceof Error) throw response;
    return response.clone();
  }) as typeof fetch;
  return new AlpacaSplitsClient(CREDENTIALS, fetchImpl, () => NOW);
}

async function reason(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof AlpacaSplitsError ? error.reason : error),
  );
}

describe('parseActionPage', () => {
  it('reads a 6:5 forward split and a 1:200 reverse split as new over old shares', () => {
    expect(
      parseActionPage(
        page([forward('AAPL', '2025-06-16', 6, 5)], [forward('AAPL', '2026-03-02', 1, 200)], 'abc'),
        'AAPL',
      ),
    ).toEqual({
      splits: [
        { date: '2025-06-16', ratio: 1.2 },
        { date: '2026-03-02', ratio: 0.005 },
      ],
      next: 'abc',
    });
  });

  it('treats missing lists and an empty token as nothing more to read', () => {
    expect(parseActionPage({ corporate_actions: {} }, 'AAPL')).toEqual({
      splits: [],
      next: undefined,
    });
    expect(parseActionPage({}, 'AAPL')).toEqual({ splits: [], next: undefined });
    expect(parseActionPage({ next_page_token: '' }, 'AAPL').next).toBeUndefined();
  });

  it.each([
    ['a non-object body', null],
    ['a string body', 'nope'],
    ['a non-array list', { corporate_actions: { forward_splits: {} } }],
    ['a non-object action', page([7])],
    ['another symbol', page([forward('MSFT', '2025-06-16', 2, 1)])],
    ['a zero rate', page([forward('AAPL', '2025-06-16', 2, 0)])],
    ['a negative rate', page([forward('AAPL', '2025-06-16', -2, 1)])],
    ['a string rate', page([{ ...forward('AAPL', '2025-06-16', 2, 1), new_rate: '2' }])],
    [
      'an infinite rate',
      page([{ ...forward('AAPL', '2025-06-16', 2, 1), old_rate: Number.POSITIVE_INFINITY }]),
    ],
    ['a bad date', page([forward('AAPL', '16/06/2025', 2, 1)])],
    ['a missing date', page([{ ...forward('AAPL', '2025-06-16', 2, 1), ex_date: undefined }])],
    ['a numeric token', page([], [], 5)],
  ])('refuses %s', (_, body) => {
    expect(() => parseActionPage(body, 'AAPL')).toThrow(AlpacaSplitsError);
  });
});

describe('splitsWithin', () => {
  it('sorts, keeps the window inclusive and refuses two splits on one ex-date', () => {
    const window = { from: '2026-01-02', to: '2026-01-05' };
    expect(
      splitsWithin(
        [
          { date: '2026-01-05', ratio: 2 },
          { date: '2026-01-01', ratio: 3 },
          { date: '2026-01-02', ratio: 4 },
          { date: '2026-01-06', ratio: 5 },
        ],
        window,
      ),
    ).toEqual([
      { date: '2026-01-02', ratio: 4 },
      { date: '2026-01-05', ratio: 2 },
    ]);
    expect(() =>
      splitsWithin(
        [
          { date: '2026-01-03', ratio: 2 },
          { date: '2026-01-03', ratio: 2 },
        ],
        window,
      ),
    ).toThrow(AlpacaSplitsError);
  });
});

describe('actionChunks', () => {
  it('reaches back a week and cuts the window into 90-day queries', () => {
    expect(actionChunks({ from: '2026-01-08', to: '2026-01-08' })).toEqual([
      { from: '2026-01-01', to: '2026-01-08' },
    ]);
    expect(actionChunks({ from: '2026-01-08', to: '2026-03-31' })).toEqual([
      { from: '2026-01-01', to: '2026-03-31' },
    ]);
    expect(actionChunks({ from: '2026-01-08', to: '2026-04-01' })).toEqual([
      { from: '2026-01-01', to: '2026-03-31' },
      { from: '2026-04-01', to: '2026-04-01' },
    ]);
  });
});

describe('actionsUrl', () => {
  it('asks for both split kinds of one symbol over the chunk', () => {
    const url = actionsUrl('AAPL', { from: '2026-01-01', to: '2026-03-31' });
    expect(`${url.origin}${url.pathname}`).toBe(ALPACA_CORPORATE_ACTIONS_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbols: 'AAPL',
      types: 'forward_split,reverse_split',
      start: '2026-01-01',
      end: '2026-03-31',
      limit: '1000',
    });
    expect(
      actionsUrl('AAPL', { from: '2026-01-01', to: '2026-01-02' }, 'tok').searchParams.get(
        'page_token',
      ),
    ).toBe('tok');
  });
});

describe('AlpacaSplitsClient', () => {
  const WINDOW = { from: '2026-01-08', to: '2026-04-01' };

  it('reads every chunk and page with the key headers, and returns the window splits', async () => {
    const seen: { url: URL; init: RequestInit | undefined }[] = [];
    const client = clientReturning(
      [
        jsonResponse(page([forward('AAPL', '2026-01-05', 2, 1)], [], 'next')),
        jsonResponse(page([], [forward('AAPL', '2026-03-02', 1, 200)])),
        jsonResponse(page([forward('AAPL', '2026-04-01', 6, 5)])),
      ],
      seen,
    );
    expect(await client.splits('AAPL', WINDOW)).toEqual({
      symbol: 'AAPL',
      from: '2026-01-08',
      to: '2026-04-01',
      asOf: '2026-10-09',
      splits: [
        { date: '2026-03-02', ratio: 0.005 },
        { date: '2026-04-01', ratio: 1.2 },
      ],
    });
    expect(
      seen.map(({ url }) => [url.searchParams.get('start'), url.searchParams.get('page_token')]),
    ).toEqual([
      ['2026-01-01', null],
      ['2026-01-01', 'next'],
      ['2026-04-01', null],
    ]);
    expect(seen[0]?.init?.headers).toEqual({
      'APCA-API-KEY-ID': 'alpaca-key-value',
      'APCA-API-SECRET-KEY': 'alpaca-secret-value',
    });
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a window that ends before it starts, before any request', async () => {
    const seen: { url: URL; init: RequestInit | undefined }[] = [];
    const client = clientReturning([jsonResponse(page([]))], seen);
    await expect(client.splits('AAPL', { from: '2026-02-01', to: '2026-01-01' })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('fails on an endless page chain, a timeout, a network error, a bad status or body', async () => {
    const endless = clientReturning([jsonResponse(page([], [], 'again'))]);
    expect(await reason(endless.splits('AAPL', { from: '2026-01-08', to: '2026-01-08' }))).toBe(
      'too_many_pages',
    );
    const timeout = Object.assign(new Error('slow'), { name: 'TimeoutError' });
    expect(await reason(clientReturning([timeout]).splits('AAPL', WINDOW))).toBe('timeout');
    expect(await reason(clientReturning([new Error('reset')]).splits('AAPL', WINDOW))).toBe(
      'network',
    );
    expect(await reason(clientReturning(['x' as unknown as Error]).splits('AAPL', WINDOW))).toBe(
      'network',
    );
    expect(await reason(clientReturning([jsonResponse({}, 403)]).splits('AAPL', WINDOW))).toBe(
      'http_403',
    );
    expect(
      await reason(
        clientReturning([new Response('not json', { status: 200 })]).splits('AAPL', WINDOW),
      ),
    ).toBe('bad_body');
  });

  it('stops at exactly twenty pages', async () => {
    let calls = 0;
    const responses = Array.from({ length: 20 }, (_, index) =>
      jsonResponse(page([], [], index < 19 ? `p${index}` : null)),
    );
    const fetchImpl = (async () => {
      const response = responses[calls] as Response;
      calls += 1;
      return response;
    }) as typeof fetch;
    const client = new AlpacaSplitsClient(CREDENTIALS, fetchImpl, () => NOW);
    expect((await client.splits('AAPL', { from: '2026-01-08', to: '2026-01-08' })).splits).toEqual(
      [],
    );
    expect(calls).toBe(20);
  });
});
