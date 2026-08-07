import { TokenBucket } from '../shared/index.js';
import { CoinbaseCandlesClient } from './coinbase-candles-client.js';

const SYMBOL = 'BTC-USD';
const ASOF = new Date('2026-08-07T12:00:00Z');

/** `[time, low, high, open, close, volume]` — NOT OHLC order (module doc). */
function row(
  isoOpenTime: string,
  low: number,
  high: number,
  open: number,
  close: number,
  volume = 10,
): unknown[] {
  return [Math.floor(new Date(isoOpenTime).getTime() / 1000), low, high, open, close, volume];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('CoinbaseCandlesClient.getBars', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the positional [time, low, high, open, close, volume] row correctly — not OHLC order', async () => {
    // low !== open, high !== close: a positional swap would fail this assertion.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse([row('2026-08-07T11:00:00Z', 99, 105, 100, 104, 7)]));
    vi.stubGlobal('fetch', fetchMock);

    const client = new CoinbaseCandlesClient();
    const bars = await client.getBars(SYMBOL, '1h', ASOF, 1);

    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      instrument: SYMBOL,
      timeframe: '1h',
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 7,
      source: 'coinbase',
    });
    expect(bars[0]?.open_time.toISOString()).toBe('2026-08-07T11:00:00.000Z');
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it("sorts ascending by close_time regardless of the venue's newest-first order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([
          row('2026-08-07T11:00:00Z', 99, 105, 100, 104),
          row('2026-08-07T10:00:00Z', 90, 95, 91, 94),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 2);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('excludes a forming candle whose close_time is after asOf', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        row('2026-08-07T11:00:00Z', 99, 105, 100, 104), // closes exactly at ASOF
        row('2026-08-07T12:00:00Z', 104, 110, 104, 108), // closes after ASOF — forming
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 5);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('trims to the most recent `limit` bars', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([
          row('2026-08-07T09:00:00Z', 80, 85, 81, 84),
          row('2026-08-07T10:00:00Z', 90, 95, 91, 94),
          row('2026-08-07T11:00:00Z', 99, 105, 100, 104),
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 2);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('returns [] for limit <= 0 without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 0);

    expect(bars).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws naming the symbol/timeframe on a non-OK response, without echoing a response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );

    await expect(new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 5)).rejects.toThrow(
      /BTC-USD 1h/,
    );
  });

  it('throws naming the row index on a malformed candle row (not the vendor bytes)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([['not', 'a', 'candle']])));

    await expect(new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /response index 0/,
    );
  });

  it('throws on a candle field that is not a finite number', async () => {
    const malformed = row('2026-08-07T11:00:00Z', 99, 105, 100, 104);
    malformed[4] = Number.NaN; // close
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([malformed])));

    await expect(new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /not a finite number/,
    );
  });

  it('acquires from the injected rate limiter before each request — no bespoke sleep', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));
    const rateLimiter = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquireBackground');

    await new CoinbaseCandlesClient({ rateLimiter }).getBars(SYMBOL, '1h', ASOF, 1);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('requests granularity=3600 for 1h and granularity=86400 for 1d', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal('fetch', fetchMock);

    await new CoinbaseCandlesClient().getBars(SYMBOL, '1h', ASOF, 1);
    await new CoinbaseCandlesClient().getBars(SYMBOL, '1d', ASOF, 1);

    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls[0]?.searchParams.get('granularity')).toBe('3600');
    expect(urls[1]?.searchParams.get('granularity')).toBe('86400');
  });
});
