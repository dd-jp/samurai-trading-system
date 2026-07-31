import { describe, expect, it, vi } from 'vitest';
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

    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });
    const aggregates = await client.fetchAggregates('SPY', window);

    expect(aggregates).toEqual([{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/aggs/ticker/SPY/range/1/day/2021-01-01/2021-01-10');
    expect(url).not.toContain(FAKE_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('maps crypto symbols to X:<BASE>USD in the request URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    await client.fetchAggregates('BTC-USD', window);

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain('/v2/aggs/ticker/X%3ABTCUSD/range/1/day/');
  });

  it('treats a missing results key as an empty page', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    const aggregates = await client.fetchAggregates('SPY', window);
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

    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });
    const aggregates = await client.fetchAggregates('SPY', window);

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

    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    await expect(client.fetchAggregates('SPY', window)).rejects.toThrow(/exceeded .* pages/);
  });

  it('throws on a non-ok HTTP response without leaking the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    await expect(client.fetchAggregates('SPY', window)).rejects.toThrow(/HTTP 500/);
    await expect(client.fetchAggregates('SPY', window)).rejects.not.toThrow(new RegExp(FAKE_KEY));
  });
});
