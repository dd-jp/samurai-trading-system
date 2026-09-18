import { venuePacingEnvVars } from '../../shared/http/venue-pacing.js';
import { resolvePolygonPacing, TokenBucket } from '../../shared/index.js';
import { HttpPolygonClient, toPolygonTicker } from './http-polygon-client.js';
import type { DateRange } from './universe.js';

const FAKE_KEY = 'test-fake-polygon-key';

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

describe('toPolygonTicker', () => {
  it('passes equities through unchanged', () => {
    expect(toPolygonTicker('SPY')).toBe('SPY');
    expect(toPolygonTicker('AAPL')).toBe('AAPL');
  });

  it('maps crypto <BASE>-USD symbols to X:<BASE>USD', () => {
    expect(toPolygonTicker('BTC-USD')).toBe('X:BTCUSD');
    expect(toPolygonTicker('ETH-USD')).toBe('X:ETHUSD');
  });
});

describe('HttpPolygonClient', () => {
  const window: DateRange = {
    start: new Date(Date.UTC(2021, 0, 1)),
    end: new Date(Date.UTC(2021, 0, 10)),
  };

  it('throws if no API key is available', () => {
    const previous = process.env.POLYGON_API_KEY;
    delete process.env.POLYGON_API_KEY;
    try {
      expect(
        () => new HttpPolygonClient({ fetchImpl: vi.fn() as unknown as typeof fetch }),
      ).toThrow(/POLYGON_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.POLYGON_API_KEY = previous;
    }
  });

  it('fetches a single page, unwraps results, and drops vw/n', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.2, n: 5 }],
      }),
    );

    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });
    const aggregates = await client.fetchAggregates('SPY', window, '1d');

    expect(aggregates).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/aggs/ticker/SPY/range/1/day/2021-01-01/2021-01-10');
    expect(url).not.toContain(FAKE_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('maps crypto symbols to X:<BASE>USD in the request URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await client.fetchAggregates('BTC-USD', window, '1d');

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain('/v2/aggs/ticker/X%3ABTCUSD/range/1/day/');
  });

  it('treats a missing results key as an empty page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    const aggregates = await client.fetchAggregates('SPY', window, '1d');
    expect(aggregates).toEqual([]);
  });

  it('follows next_url pagination, reusing the same auth header, until exhausted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
          next_url: 'https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/x/y?cursor=abc',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ t: 2, o: 2, h: 2, l: 2, c: 2, v: 2 }],
        }),
      );

    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });
    const aggregates = await client.fetchAggregates('SPY', window, '1d');

    expect(aggregates).toEqual([
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: 2, o: 2, h: 2, l: 2, c: 2, v: 2 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const secondCall = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(secondCall[0]).toBe(
      'https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/x/y?cursor=abc',
    );
    expect((secondCall[1].headers as Record<string, string>).Authorization).toBe(
      `Bearer ${FAKE_KEY}`,
    );
  });

  it('caps pagination so a cyclical next_url cannot loop forever', async () => {
    const cyclicalUrl = 'https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/x/y?cursor=loop';
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
        next_url: cyclicalUrl,
      }),
    );

    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(/exceeded .* pages/);
  });

  it('throws on a non-ok HTTP response without leaking the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(/HTTP 500/);
    await expect(client.fetchAggregates('SPY', window, '1d')).rejects.not.toThrow(
      new RegExp(FAKE_KEY),
    );
  });

  describe('wire validation (#509)', () => {
    it('rejects a truncated aggregate missing required fields', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [{ t: 1, o: 1 }] }));
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(
        /malformed aggregate/,
      );
    });

    it('rejects an aggregate whose OHLCV field is the wrong type (out-of-type body)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [{ t: 1, o: '1', h: 2, l: 0.5, c: 1.5, v: 100 }],
        }),
      );
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(
        /malformed aggregate/,
      );
    });

    it('rejects an aggregate carrying a non-finite OHLCV field', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [{ t: 1, o: Number.NaN, h: 2, l: 0.5, c: 1.5, v: 100 }],
        }),
      );
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(
        /malformed aggregate/,
      );
    });

    it('rejects a response body that is not an object at all', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null));
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(
        /malformed response body/,
      );
    });

    it("rejects a 'results' field that is not an array", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: { not: 'an array' } }));
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      await expect(client.fetchAggregates('SPY', window, '1d')).rejects.toThrow(
        /malformed 'results'/,
      );
    });

    it('stops pagination rather than throwing when next_url is present but the wrong type', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
          next_url: 12345,
        }),
      );
      const client = new HttpPolygonClient({
        apiKey: FAKE_KEY,
        fetchImpl,
        rateLimiter: unlimitedBucket(),
      });

      const aggregates = await client.fetchAggregates('SPY', window, '1d');
      expect(aggregates).toEqual([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});

describe('HttpPolygonClient free-tier pacing (#510)', () => {
  const window: DateRange = {
    start: new Date(Date.UTC(2021, 0, 1)),
    end: new Date(Date.UTC(2021, 0, 10)),
  };

  const polygonEnvVars = Object.values(venuePacingEnvVars('polygon'));
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    vi.useFakeTimers();
    for (const name of polygonEnvVars) {
      previousEnv.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previousEnv.clear();
  });

  it('acquires from the injected bucket before firing the request, not just holding it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl, rateLimiter: bucket });
    const pending = client.fetchAggregates('SPY', window, '1d');

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paces a burst of more than 5 calls through the default bucket rather than firing them at once', async () => {
    const { capacity, refillPerSecond } = resolvePolygonPacing();
    const stepMs = 1_000 / refillPerSecond;

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    const burst = 6;
    const pending = Promise.all(
      Array.from({ length: burst }, (_, i) => client.fetchAggregates(`SYM${i}`, window, '1d')),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(capacity);

    for (let called = capacity + 1; called <= burst; called++) {
      await vi.advanceTimersByTimeAsync(stepMs);
      expect(fetchImpl).toHaveBeenCalledTimes(called);
    }

    await pending;
  });

  it('is unaffected by a malformed UNRELATED venue override — no coupling in either direction', () => {
    const previous = process.env.SAMURAI_PACING_ALPACA_REFILL_PER_SEC;
    process.env.SAMURAI_PACING_ALPACA_REFILL_PER_SEC = 'not-a-number';
    try {
      expect(() => new HttpPolygonClient({ apiKey: FAKE_KEY })).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.SAMURAI_PACING_ALPACA_REFILL_PER_SEC;
      else process.env.SAMURAI_PACING_ALPACA_REFILL_PER_SEC = previous;
    }
  });

  it('still throws loudly, naming the variable, when SAMURAI_PACING_POLYGON_* itself is malformed', () => {
    process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC = 'not-a-number';
    try {
      expect(() => new HttpPolygonClient({ apiKey: FAKE_KEY })).toThrow(
        /SAMURAI_PACING_POLYGON_REFILL_PER_SEC/,
      );
    } finally {
      delete process.env.SAMURAI_PACING_POLYGON_REFILL_PER_SEC;
    }
  });
});

describe('HttpPolygonClient — timeframe (#664)', () => {
  it('refuses a non-daily request rather than silently serving day bars', async () => {
    const client = new HttpPolygonClient({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('{}'),
      rateLimiter: new TokenBucket({ capacity: 100, refillPerSecond: 1000 }),
    });

    await expect(
      client.fetchAggregates('SPY', { start: new Date(0), end: new Date(1) }, '1m'),
    ).rejects.toThrow(/serves '1d' only/);
  });
});
