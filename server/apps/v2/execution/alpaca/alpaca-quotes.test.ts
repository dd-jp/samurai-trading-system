import { describe, expect, it, vi } from 'vitest';
import type { AlpacaQuoteClient } from './alpaca-client.js';
import { alpacaLatestQuotes, alpacaQuotesFor } from './alpaca-quotes.js';

function quoteClient(ap: number, bp = 24.9): AlpacaQuoteClient {
  return {
    getLatestQuote: vi.fn().mockResolvedValue({ t: '2026-09-30T14:00:01.5Z', ap, bp }),
  };
}

describe('alpacaLatestQuotes', () => {
  it('maps the latest quote to its ask, bid and time', async () => {
    const client = quoteClient(25.01);
    await expect(alpacaLatestQuotes(() => client).latestQuote('UP')).resolves.toEqual({
      ask: 25.01,
      bid: 24.9,
      quoted_at: '2026-09-30T14:00:01.500Z',
    });
    expect(client.getLatestQuote).toHaveBeenCalledWith('UP');
  });

  it('refuses a quote with no ask', async () => {
    await expect(alpacaLatestQuotes(() => quoteClient(0)).latestQuote('UP')).rejects.toThrow(
      'Alpaca latest UP quote at 2026-09-30T14:00:01.5Z has no ask',
    );
  });
});

describe('alpacaQuotesFor', () => {
  it('builds its client only when a quote is first read, so a missing key fails that read', async () => {
    vi.stubEnv('ALPACA_API_KEY', '');
    try {
      const quotes = alpacaQuotesFor('paper');
      await expect(quotes.latestQuote('UP')).rejects.toThrow(/ALPACA_API_KEY is not set/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads with the key pair of the environment it was built for', async () => {
    vi.stubEnv('ALPACA_API_KEY', '');
    vi.stubEnv('ALPACA_API_SECRET', '');
    vi.stubEnv('ALPACA_LIVE_API_KEY', 'test-fake-live-key');
    vi.stubEnv('ALPACA_LIVE_API_SECRET', 'test-fake-live-secret');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ quote: { t: '2026-09-30T14:00:01Z', ap: 25, bp: 24.9 } })),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(alpacaQuotesFor('live').latestQuote('UP')).resolves.toMatchObject({ ask: 25 });
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
        'APCA-API-KEY-ID': 'test-fake-live-key',
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('reads the data host with the paper pair and reuses one client', async () => {
    vi.stubEnv('ALPACA_API_KEY', 'test-fake-alpaca-key');
    vi.stubEnv('ALPACA_API_SECRET', 'test-fake-alpaca-secret');
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ symbol: 'UP', quote: { t: '2026-09-30T14:00:01Z', ap: 25, bp: 24.9 } }),
          {
            status: 200,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const quotes = alpacaQuotesFor('paper');
      await quotes.latestQuote('UP');
      await quotes.latestQuote('UP');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://data.alpaca.markets/v2/stocks/UP/quotes/latest',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
