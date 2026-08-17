import { describe, expect, it, vi } from 'vitest';
import { TokenBucket } from '../../../shared/index.js';
import { PolymarketClient } from './polymarket-client.js';

const MARKET = {
  slug: 'will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649',
  question: 'Will the Fed increase interest rates by 25 bps?',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.295", "0.705"]',
  clobTokenIds: '["11111", "22222"]',
  bestBid: 0.29,
  bestAsk: 0.3,
  spread: 0.01,
  volume24hr: 533307.68,
  liquidityNum: 2149190,
  updatedAt: '2026-08-17T20:10:06.481099Z',
  closed: false,
};

const EVENT = [
  {
    slug: 'fed-decision-in-september-762',
    title: 'Fed decision in September?',
    markets: [MARKET],
  },
];

function clientWith(
  handler: (url: string) => Response | Promise<Response>,
  options: { rateLimiter?: TokenBucket } = {},
) {
  const fetchImpl = vi.fn(async (input: string | URL) =>
    handler(String(input)),
  ) as unknown as typeof fetch;
  return {
    fetchImpl,
    client: new PolymarketClient({
      fetchImpl,
      rateLimiter: options.rateLimiter ?? new TokenBucket({ capacity: 50, refillPerSecond: 50 }),
    }),
  };
}

describe('PolymarketClient.fetchEventMarket', () => {
  it('parses the JSON-encoded outcome arrays into a typed market', async () => {
    const { client } = clientWith(() => new Response(JSON.stringify(EVENT)));

    const market = await client.fetchEventMarket(
      'fed-decision-in-september-762',
      'will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649',
    );

    expect(market).toEqual({
      slug: 'will-the-fed-increase-interest-rates-by-25-bps-after-the-september-2026-meeting-649',
      question: 'Will the Fed increase interest rates by 25 bps?',
      // Gamma serialises these two as JSON *strings*, not arrays — the whole
      // reason this parse exists rather than a cast.
      outcomes: ['Yes', 'No'],
      outcomePrices: [0.295, 0.705],
      tokenIds: ['11111', '22222'],
      bestBid: 0.29,
      bestAsk: 0.3,
      spread: 0.01,
      volume24hr: 533307.68,
      liquidity: 2149190,
      updatedAt: new Date('2026-08-17T20:10:06.481099Z'),
      closed: false,
      payload: expect.any(String),
    });
  });

  it('pins the request to the configured host and asks for the requested slug', async () => {
    const seen: string[] = [];
    const { client } = clientWith((url) => {
      seen.push(url);
      return new Response(JSON.stringify(EVENT));
    });

    await client.fetchEventMarket('fed-decision-in-september-762', MARKET.slug);

    expect(seen[0]).toBe(
      'https://gamma-api.polymarket.com/events?slug=fed-decision-in-september-762',
    );
  });

  it('returns undefined when the event exists but the curated market slug does not', async () => {
    const { client } = clientWith(() => new Response(JSON.stringify(EVENT)));

    await expect(
      client.fetchEventMarket('fed-decision-in-september-762', 'a-slug-that-rotted'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the event slug itself has rotted (empty array)', async () => {
    const { client } = clientWith(() => new Response('[]'));

    await expect(client.fetchEventMarket('gone', 'gone')).resolves.toBeUndefined();
  });

  it('throws on a non-OK response rather than reporting a rotted slug', async () => {
    const { client } = clientWith(() => new Response('nope', { status: 500 }));

    await expect(client.fetchEventMarket('fed', 'fed')).rejects.toThrow(/500/);
  });

  it('refuses a market whose outcome and price arrays disagree in length', async () => {
    const broken = [
      {
        slug: 'e',
        markets: [{ ...MARKET, slug: 'm', outcomePrices: '["0.295"]' }],
      },
    ];
    const { client } = clientWith(() => new Response(JSON.stringify(broken)));

    await expect(client.fetchEventMarket('e', 'm')).rejects.toThrow(/outcome/i);
  });
});

describe('PolymarketClient.fetchPriceHistory', () => {
  it('returns the series oldest-first with parsed timestamps', async () => {
    const { client } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            history: [
              { t: 1786914018, p: 0.31 },
              { t: 1786917618, p: 0.295 },
            ],
          }),
        ),
    );

    await expect(client.fetchPriceHistory('11111')).resolves.toEqual([
      { at: new Date(1786914018 * 1000), probability: 0.31 },
      { at: new Date(1786917618 * 1000), probability: 0.295 },
    ]);
  });

  it('asks CLOB for a one-day window at hourly fidelity', async () => {
    const seen: string[] = [];
    const { client } = clientWith((url) => {
      seen.push(url);
      return new Response(JSON.stringify({ history: [] }));
    });

    await client.fetchPriceHistory('11111');

    expect(seen[0]).toBe(
      'https://clob.polymarket.com/prices-history?market=11111&interval=1d&fidelity=60',
    );
  });

  it('waits on the rate limiter before every request', async () => {
    const limiter = new TokenBucket({ capacity: 1, refillPerSecond: 1000 });
    const acquire = vi.spyOn(limiter, 'acquire');
    const { client } = clientWith(() => new Response(JSON.stringify({ history: [] })), {
      rateLimiter: limiter,
    });

    await client.fetchPriceHistory('11111');
    await client.fetchPriceHistory('22222');

    expect(acquire).toHaveBeenCalledTimes(2);
  });
});
