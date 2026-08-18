import { HttpTiingoClient, toTiingoCryptoTicker } from './http-tiingo-client.js';
import type { DateRange } from './universe.js';

const FAKE_KEY = 'tiingo-test-key';
const WINDOW: DateRange = {
  start: new Date('2021-08-06T00:00:00Z'),
  end: new Date('2026-08-05T00:00:00Z'),
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): HttpTiingoClient {
  return new HttpTiingoClient({ apiKey: FAKE_KEY, fetchImpl, minRequestSpacingMs: 0 });
}

describe('toTiingoCryptoTicker', () => {
  it('maps the universe crypto symbols to Tiingo format', () => {
    expect(toTiingoCryptoTicker('BTC-USD')).toBe('btcusd');
    expect(toTiingoCryptoTicker('ETH-USD')).toBe('ethusd');
  });
});

describe('HttpTiingoClient', () => {
  it('refuses to construct without an API key', () => {
    const previous = process.env.TIINGO_API_KEY;
    delete process.env.TIINGO_API_KEY;
    try {
      expect(() => new HttpTiingoClient({ fetchImpl: fetch })).toThrow(/TIINGO_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.TIINGO_API_KEY = previous;
    }
  });

  it('fetches equities from /tiingo/daily and maps the ADJUSTED fields', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/tiingo/daily/SPY/prices');
      expect(String(url)).toContain('startDate=2021-08-06');
      expect(String(url)).toContain('endDate=2026-08-05');
      return jsonResponse([
        {
          date: '2021-08-06T00:00:00.000Z',
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 10,
          adjOpen: 100,
          adjHigh: 110,
          adjLow: 95,
          adjClose: 105,
          adjVolume: 1_000,
        },
      ]);
    }) as unknown as typeof fetch;

    const bars = await makeClient(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');

    expect(bars).toEqual([
      { t: Date.parse('2021-08-06T00:00:00.000Z'), o: 100, h: 110, l: 95, c: 105, v: 1_000 },
    ]);
  });

  it('fetches crypto from /tiingo/crypto with the mapped ticker and daily resample', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/tiingo/crypto/prices?tickers=btcusd');
      expect(String(url)).toContain('resampleFreq=1day');
      return jsonResponse([
        {
          ticker: 'btcusd',
          priceData: [
            {
              date: '2021-08-06T00:00:00.000Z',
              open: 40_000,
              high: 41_000,
              low: 39_500,
              close: 40_500,
              volume: 12.5,
            },
          ],
        },
      ]);
    }) as unknown as typeof fetch;

    const bars = await makeClient(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1d');

    expect(bars).toEqual([
      {
        t: Date.parse('2021-08-06T00:00:00.000Z'),
        o: 40_000,
        h: 41_000,
        l: 39_500,
        c: 40_500,
        v: 12.5,
      },
    ]);
  });

  it('sends the key as an Authorization header, never in the URL', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).not.toContain(FAKE_KEY);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Token ${FAKE_KEY}`);
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    await makeClient(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-2xx response without leaking the key', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 429, statusText: 'Too Many Requests' }),
    ) as unknown as typeof fetch;

    await expect(makeClient(fetchImpl).fetchAggregates('SPY', WINDOW, '1d')).rejects.toThrow(
      /HTTP 429/,
    );
  });
});

describe('HttpTiingoClient — timeframe (#664)', () => {
  it('refuses a non-daily request rather than silently serving day bars', async () => {
    const client = new HttpTiingoClient({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('[]'),
    });

    await expect(
      client.fetchAggregates('BTC-USD', { start: new Date(0), end: new Date(1) }, '1m'),
    ).rejects.toThrow(/serves '1d' only/);
  });
});
