import { TokenBucket } from '../shared/index.js';
import { FreeStackAggregatesClient } from './free-stack-aggregates-client.js';
import type { DateRange } from './universe.js';

const FAKE_KEY = 'test-fake-alpaca-key';
const FAKE_SECRET = 'test-fake-alpaca-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

function unlimitedBucket(): TokenBucket {
  return new TokenBucket({ capacity: 1_000, refillPerSecond: 1_000 });
}

function client(fetchImpl: typeof fetch): FreeStackAggregatesClient {
  return new FreeStackAggregatesClient({
    alpacaKeyId: FAKE_KEY,
    alpacaSecretKey: FAKE_SECRET,
    fetchImpl,
    rateLimiter: unlimitedBucket(),
  });
}

/** Coinbase candle tuple order: [time, low, high, open, close, volume]. */
function candle(epochSeconds: number, close: number): number[] {
  return [epochSeconds, close - 1, close + 1, close, close, 100];
}

describe('FreeStackAggregatesClient — crypto via Coinbase', () => {
  const window: DateRange = {
    start: new Date('2024-01-01T00:00:00.000Z'),
    end: new Date('2024-01-04T00:00:00.000Z'),
  };

  it('maps Coinbase candle tuples to aggregates in ascending time order', async () => {
    // Coinbase returns newest-first; the store's contract is ascending.
    const fetchImpl = (async () =>
      jsonResponse([
        candle(1_704_240_000, 300),
        candle(1_704_153_600, 200),
        candle(1_704_067_200, 100),
      ])) as unknown as typeof fetch;

    const bars = await client(fetchImpl).fetchAggregates('BTC-USD', window);

    expect(bars.map((b) => b.c)).toEqual([100, 200, 300]);
    expect(bars.map((b) => b.t)).toEqual([1_704_067_200_000, 1_704_153_600_000, 1_704_240_000_000]);
    expect(bars[0]).toMatchObject({ o: 100, h: 101, l: 99, v: 100 });
  });

  it('pages past the 300-candle per-request cap and de-duplicates overlap', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      // Both pages carry the same bar to prove overlap is de-duplicated,
      // which a forward-walking window can produce at chunk boundaries.
      return calls.length === 1
        ? jsonResponse([candle(1_704_153_600, 200), candle(1_704_067_200, 100)])
        : jsonResponse([candle(1_704_240_000, 300), candle(1_704_153_600, 200)]);
    }) as unknown as typeof fetch;

    const wide: DateRange = {
      start: new Date('2024-01-01T00:00:00.000Z'),
      end: new Date('2026-01-01T00:00:00.000Z'),
    };
    const bars = await client(fetchImpl).fetchAggregates('BTC-USD', wide);

    expect(calls.length).toBeGreaterThan(1);
    expect(bars.map((b) => b.c)).toEqual([100, 200, 300]);
  });

  it('throws naming Coinbase when the venue rejects the request', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'nope' }, 429)) as unknown as typeof fetch;

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', window)).rejects.toThrow(/Coinbase/);
  });

  it('rejects a malformed candle rather than coercing it', async () => {
    const fetchImpl = (async () =>
      jsonResponse([[1_704_067_200, 'not-a-number', 1, 1, 1, 1]])) as unknown as typeof fetch;

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', window)).rejects.toThrow(
      /malformed candle/,
    );
  });
});

describe('FreeStackAggregatesClient — equities via Alpaca', () => {
  const window: DateRange = {
    start: new Date('2024-01-01T00:00:00.000Z'),
    end: new Date('2024-01-04T00:00:00.000Z'),
  };

  it('follows next_page_token until the venue stops returning one', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? jsonResponse({
            bars: { SPY: [{ t: '2024-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] },
            next_page_token: 'page-2',
          })
        : jsonResponse({
            bars: { SPY: [{ t: '2024-01-03T05:00:00Z', o: 2, h: 3, l: 1.5, c: 2.5, v: 20 }] },
            next_page_token: null,
          });
    }) as unknown as typeof fetch;

    const bars = await client(fetchImpl).fetchAggregates('SPY', window);

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('page_token=page-2');
    expect(bars.map((b) => b.c)).toEqual([1.5, 2.5]);
    expect(bars[0]?.t).toBe(Date.parse('2024-01-02T05:00:00Z'));
  });

  it('returns an empty series when the venue serves no bars for the symbol', async () => {
    const fetchImpl = (async () => jsonResponse({ bars: {} })) as unknown as typeof fetch;

    await expect(client(fetchImpl).fetchAggregates('SPY', window)).resolves.toEqual([]);
  });

  it('throws naming Alpaca when the venue rejects the request', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: 'forbidden' }, 403)) as unknown as typeof fetch;

    await expect(client(fetchImpl).fetchAggregates('SPY', window)).rejects.toThrow(/Alpaca/);
  });

  it('never sends the secret in a URL, only in headers', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ bars: { SPY: [] } });
    }) as unknown as typeof fetch;

    await client(fetchImpl).fetchAggregates('SPY', window);

    expect(seen[0]?.url).not.toContain(FAKE_SECRET);
    expect(seen[0]?.init?.headers).toMatchObject({ 'APCA-API-SECRET-KEY': FAKE_SECRET });
  });
});

describe('FreeStackAggregatesClient — routing', () => {
  it('routes only configured crypto symbols to Coinbase', async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (url: string) => {
      hosts.push(new URL(url).host);
      return url.includes('coinbase')
        ? jsonResponse([candle(1_704_067_200, 100)])
        : jsonResponse({ bars: { SPY: [] } });
    }) as unknown as typeof fetch;

    const c = client(fetchImpl);
    const window: DateRange = {
      start: new Date('2024-01-01T00:00:00.000Z'),
      end: new Date('2024-01-04T00:00:00.000Z'),
    };
    await c.fetchAggregates('ETH-USD', window);
    await c.fetchAggregates('SPY', window);

    expect(hosts[0]).toContain('coinbase');
    expect(hosts[1]).toContain('alpaca');
  });

  it('refuses to construct without Alpaca credentials', () => {
    expect(
      () =>
        new FreeStackAggregatesClient({
          alpacaKeyId: '',
          alpacaSecretKey: '',
          fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
          rateLimiter: unlimitedBucket(),
        }),
    ).toThrow(/ALPACA_API_KEY/);
  });
});
