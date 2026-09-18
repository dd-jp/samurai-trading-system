import { TokenBucket } from '../../shared/index.js';
import {
  FreeStackAggregatesClient,
  isCryptoSymbol,
  maxAlpacaPagesFor,
} from './free-stack-aggregates-client.js';
import type { DateRange } from './universe.js';

const FAKE_KEY = 'test-fake-alpaca-key';
const FAKE_SECRET = 'test-fake-alpaca-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(handler: (url: string, call: number) => Response): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return handler(url, calls.length);
  };
  return { fetchImpl, calls };
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

function candle(epochSeconds: number, close: number): number[] {
  return [epochSeconds, close - 1, close + 1, close, close, 100];
}

const WINDOW: DateRange = {
  start: new Date('2024-01-01T00:00:00.000Z'),
  end: new Date('2024-01-04T00:00:00.000Z'),
};

describe('FreeStackAggregatesClient — crypto via Coinbase', () => {
  it('maps Coinbase candle tuples to aggregates in ascending time order', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse([
        candle(1_704_240_000, 300),
        candle(1_704_153_600, 200),
        candle(1_704_067_200, 100),
      ]),
    );

    const bars = await client(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1d');

    expect(bars.map((b) => b.c)).toEqual([100, 200, 300]);
    expect(bars.map((b) => b.t)).toEqual([1_704_067_200_000, 1_704_153_600_000, 1_704_240_000_000]);
    expect(bars[0]).toMatchObject({ o: 100, h: 101, l: 99, v: 100 });
  });

  it('pages past the 300-candle per-request cap and de-duplicates overlap', async () => {
    const { fetchImpl, calls } = recordingFetch((_url, call) =>
      call === 1
        ? jsonResponse([candle(1_704_153_600, 200), candle(1_704_067_200, 100)])
        : jsonResponse([candle(1_704_240_000, 300), candle(1_704_153_600, 200)]),
    );

    const wide: DateRange = {
      start: new Date('2024-01-01T00:00:00.000Z'),
      end: new Date('2026-01-01T00:00:00.000Z'),
    };
    const bars = await client(fetchImpl).fetchAggregates('BTC-USD', wide, '1d');

    expect(calls.length).toBeGreaterThan(1);
    expect(bars.map((b) => b.c)).toEqual([100, 200, 300]);
  });

  it('throws naming Coinbase when the venue rejects the request', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: 'nope' }, 429));

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1d')).rejects.toThrow(
      /Coinbase/,
    );
  });

  it('rejects a malformed candle rather than coercing it', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse([[1_704_067_200, 'not-a-number', 1, 1, 1, 1]]),
    );

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1d')).rejects.toThrow(
      /malformed candle/,
    );
  });

  it('refuses a page above the documented 300-candle cap rather than trusting it', async () => {
    const overCap = Array.from({ length: 301 }, (_, i) => candle(1_704_067_200 + i * 86_400, 100));
    const { fetchImpl } = recordingFetch(() => jsonResponse(overCap));

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1d')).rejects.toThrow(
      /above its documented 300 cap/,
    );
  });
});

describe('FreeStackAggregatesClient — equities via Alpaca', () => {
  it('follows next_page_token until the venue stops returning one', async () => {
    const { fetchImpl, calls } = recordingFetch((_url, call) =>
      call === 1
        ? jsonResponse({
            bars: { SPY: [{ t: '2024-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] },
            next_page_token: 'page-2',
          })
        : jsonResponse({
            bars: { SPY: [{ t: '2024-01-03T05:00:00Z', o: 2, h: 3, l: 1.5, c: 2.5, v: 20 }] },
            next_page_token: null,
          }),
    );

    const bars = await client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');

    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('page_token=page-2');
    expect(bars.map((b) => b.c)).toEqual([1.5, 2.5]);
    expect(bars[0]?.t).toBe(Date.parse('2024-01-02T05:00:00Z'));
  });

  it('de-duplicates bars repeated across pages', async () => {
    const { fetchImpl } = recordingFetch((_url, call) =>
      call === 1
        ? jsonResponse({
            bars: { SPY: [{ t: '2024-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] },
            next_page_token: 'page-2',
          })
        : jsonResponse({
            bars: {
              SPY: [
                { t: '2024-01-02T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
                { t: '2024-01-03T05:00:00Z', o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
              ],
            },
            next_page_token: null,
          }),
    );

    const bars = await client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');

    expect(bars.map((b) => b.c)).toEqual([1.5, 2.5]);
  });

  it('returns an empty series when the venue serves no bars for the symbol', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ bars: {} }));

    await expect(client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d')).resolves.toEqual([]);
  });

  it('throws naming Alpaca when the venue rejects the request', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: 'forbidden' }, 403));

    await expect(client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d')).rejects.toThrow(/Alpaca/);
  });

  it('rejects a malformed bar rather than coercing it', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        bars: { SPY: [{ t: '2024-01-02T05:00:00Z', o: 'x', h: 2, l: 1, c: 1, v: 1 }] },
      }),
    );

    await expect(client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d')).rejects.toThrow(
      /malformed bar/,
    );
  });

  it('sends credentials in headers, never in the URL', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(init);
      expect(String(input)).not.toContain(FAKE_SECRET);
      expect(String(input)).not.toContain(FAKE_KEY);
      return jsonResponse({ bars: { SPY: [] } });
    };

    await client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');

    expect(seen[0]?.headers).toMatchObject({
      'APCA-API-KEY-ID': FAKE_KEY,
      'APCA-API-SECRET-KEY': FAKE_SECRET,
    });
  });
});

describe('FreeStackAggregatesClient — routing', () => {
  it('routes -USD symbols to Coinbase and everything else to Alpaca', async () => {
    const { fetchImpl, calls } = recordingFetch((url) =>
      url.includes('coinbase')
        ? jsonResponse([candle(1_704_067_200, 100)])
        : jsonResponse({ bars: { SPY: [] } }),
    );

    const c = client(fetchImpl);
    await c.fetchAggregates('ETH-USD', WINDOW, '1d');
    await c.fetchAggregates('SPY', WINDOW, '1d');

    expect(new URL(calls[0] as string).host).toContain('coinbase');
    expect(new URL(calls[1] as string).host).toContain('alpaca');
  });

  it('never issues a zero-length final chunk', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse([]));

    await client(fetchImpl).fetchAggregates(
      'BTC-USD',
      {
        start: new Date('2024-01-01T00:00:00.000Z'),
        end: new Date('2026-01-01T00:00:00.000Z'),
      },
      '1d',
    );

    for (const url of calls) {
      const params = new URL(url).searchParams;
      expect(params.get('start')).not.toBe(params.get('end'));
    }
  });

  it('classifies symbols by the -USD suffix', () => {
    expect(isCryptoSymbol('BTC-USD')).toBe(true);
    expect(isCryptoSymbol('ETH-USD')).toBe(true);
    expect(isCryptoSymbol('SPY')).toBe(false);
    expect(isCryptoSymbol('AAPL')).toBe(false);
  });

  it('refuses to construct without Alpaca credentials', () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}));

    expect(
      () =>
        new FreeStackAggregatesClient({
          alpacaKeyId: '',
          alpacaSecretKey: '',
          fetchImpl,
          rateLimiter: unlimitedBucket(),
        }),
    ).toThrow(/ALPACA_API_KEY/);
  });
});

describe('FreeStackAggregatesClient — intraday (#664)', () => {
  it('asks Alpaca for the requested resolution, not always 1Day', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ bars: { SPY: [] } }));

    await client(fetchImpl).fetchAggregates('SPY', WINDOW, '1m');

    const requested = new URL(calls[0] as string).searchParams.get('timeframe');
    expect(requested).toBe('1Min');
  });

  it('still asks for 1Day when the caller asks for daily', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ bars: { SPY: [] } }));

    await client(fetchImpl).fetchAggregates('SPY', WINDOW, '1d');

    expect(new URL(calls[0] as string).searchParams.get('timeframe')).toBe('1Day');
  });

  it('refuses an intraday crypto request rather than serving daily candles for it', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse([]));

    await expect(client(fetchImpl).fetchAggregates('BTC-USD', WINDOW, '1m')).rejects.toThrow(
      /crypto \(BTC-USD\) is served at '1d' only/,
    );
    expect(calls).toHaveLength(0);
  });

  it('sizes the page guard to the window and timeframe, not a fixed 200', () => {
    const tenYears: DateRange = {
      start: new Date('2016-01-04T00:00:00.000Z'),
      end: new Date('2026-01-04T00:00:00.000Z'),
    };

    expect(maxAlpacaPagesFor(tenYears, '1d')).toBe(200);

    expect(maxAlpacaPagesFor(tenYears, '1m')).toBeGreaterThan(526);
  });

  it("paces every page through the shared bucket, at or under Alpaca's 200/min", async () => {
    let acquired = 0;
    const bucket = {
      acquire: async () => {
        acquired++;
      },
    } as unknown as TokenBucket;

    let page = 0;
    const { fetchImpl } = recordingFetch(() => {
      page++;
      return jsonResponse(
        page < 3 ? { bars: { SPY: [] }, next_page_token: `p${page}` } : { bars: { SPY: [] } },
      );
    });

    await new FreeStackAggregatesClient({
      alpacaKeyId: FAKE_KEY,
      alpacaSecretKey: FAKE_SECRET,
      fetchImpl,
      rateLimiter: bucket,
    }).fetchAggregates('SPY', WINDOW, '1m');

    expect(acquired).toBe(3);
  });
});
