import { TokenBucket } from '../../../shared/index.js';
import { PolygonBarsClient, toPolygonRange } from './polygon-bars-client.js';
import {
  isRetryablePolygonBarsError,
  PolygonBarsProviderError,
  PolygonBarsRateLimitError,
  PolygonBarsTimeoutError,
} from './polygon-bars-errors.js';

const SYMBOL = 'SPY';
const ASOF = new Date('2026-08-07T12:00:00Z');

function aggregate(isoOpenTime: string, o: number, h: number, l: number, c: number, v = 10) {
  return { t: new Date(isoOpenTime).getTime(), o, h, l, c, v };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('PolygonBarsClient.getBars', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POLYGON_API_KEY;
  });

  beforeEach(() => {
    process.env.POLYGON_API_KEY = 'test-key';
  });

  it('throws naming the variable when POLYGON_API_KEY is not set and no apiKey is passed', () => {
    delete process.env.POLYGON_API_KEY;
    expect(() => new PolygonBarsClient()).toThrow(/POLYGON_API_KEY/);
  });

  it('maps a raw aggregate to a Bar stamped source: polygon', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ results: [aggregate('2026-08-07T11:00:00Z', 100, 105, 99, 104, 7)] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1);

    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      instrument: SYMBOL,
      timeframe: '1h',
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 7,
      source: 'polygon',
    });
    expect(bars[0]?.open_time.toISOString()).toBe('2026-08-07T11:00:00.000Z');
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it("sends adjusted=false — not HttpPolygonClient's adjusted=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new PolygonBarsClient().getBars(SYMBOL, '1d', ASOF, 1);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('adjusted')).toBe('false');
  });

  it('sends Authorization: Bearer <key> and never exposes it in a thrown error', async () => {
    process.env.POLYGON_API_KEY = 'super-secret-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    let thrown: unknown;
    try {
      // maxAttempts: 1 — a 500 is retryable by default; this test is about
      // the auth header and secret-masking, not the retry path (covered
      // separately below), so it stays single-attempt and fast
      await new PolygonBarsClient({
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      }).getBars(SYMBOL, '1h', ASOF, 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain('super-secret-key');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer super-secret-key');
  });

  it('routes /range/{multiplier}/{timespan}/ per timeframe — 1/hour for 1h, 1/day for 1d', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1);
    await new PolygonBarsClient().getBars(SYMBOL, '1d', ASOF, 1);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain('/range/1/hour/');
    expect(urls[1]).toContain('/range/1/day/');
  });

  it('does not apply the daily 4-day weekend floor to an intraday (1h) request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1);

    // ASOF is 2026-08-07. A 4-day floor misapplied to an intraday timeframe
    // would push `from` back to 2026-08-03; the correct small buffer keeps
    // `from` on the same day as `asOf`
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/range/1/hour/2026-08-07/2026-08-07');
  });

  it('toPolygonRange throws on an unsupported timeframe', () => {
    expect(() => toPolygonRange('3w')).toThrow(/unsupported timeframe/);
  });

  it('excludes a forming bar whose close_time is after asOf', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            aggregate('2026-08-07T11:00:00Z', 100, 105, 99, 104), // closes exactly at ASOF
            aggregate('2026-08-07T12:00:00Z', 104, 110, 104, 108), // closes after ASOF — forming
          ],
        }),
      ),
    );

    const bars = await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 5);

    expect(bars).toHaveLength(1);
    expect(bars[0]?.close_time.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  it('sorts ascending and trims to the most recent `limit` bars regardless of wire order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          results: [
            aggregate('2026-08-07T09:00:00Z', 80, 85, 81, 84),
            aggregate('2026-08-07T11:00:00Z', 100, 105, 99, 104),
            aggregate('2026-08-07T10:00:00Z', 90, 95, 91, 94),
          ],
        }),
      ),
    );

    const bars = await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 2);

    expect(bars.map((b) => b.close_time.toISOString())).toEqual([
      '2026-08-07T11:00:00.000Z',
      '2026-08-07T12:00:00.000Z',
    ]);
  });

  it('returns [] for limit <= 0 without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const bars = await new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 0);

    expect(bars).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws naming the symbol/timeframe/status on a non-OK response, without echoing a response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    );

    await expect(new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 5)).rejects.toThrow(
      /SPY 1h.*HTTP 429/,
    );
  });

  it('throws on a malformed results array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: 'not-an-array' })));

    await expect(new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /malformed 'results'/,
    );
  });

  it('throws on an aggregate field that is not a finite number, naming the symbol', async () => {
    const malformed = aggregate('2026-08-07T11:00:00Z', 100, 105, 99, 104);
    (malformed as { c: unknown }).c = Number.NaN;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [malformed] })));

    await expect(new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toThrow(
      /malformed aggregate for SPY/,
    );
  });

  it('acquires from the injected rate limiter before each request — no bespoke sleep', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [] })));
    const rateLimiter = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
    const acquireSpy = vi.spyOn(rateLimiter, 'acquireBackground');

    await new PolygonBarsClient({ rateLimiter }).getBars(SYMBOL, '1h', ASOF, 1);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  describe('retry (#1238)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries a 503 once and succeeds, re-acquiring the rate limiter per attempt', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockResolvedValueOnce(
          jsonResponse({ results: [aggregate('2026-08-07T11:00:00Z', 100, 105, 99, 104)] }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const rateLimiter = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
      const acquireSpy = vi.spyOn(rateLimiter, 'acquireBackground');

      // `settled` absorbs a rejection into a resolution, so no promise is
      // left unhandled while control sits inside advanceTimersByTimeAsync
      // The sibling "exhausts retries" test can assert on the raw promise
      // because `.rejects` settles the same way whenever the rejection
      // lands; `.resolves` cannot — under a mutation that removes the
      // retry, getBars rejects before any timer is even scheduled
      const settled = new PolygonBarsClient({ rateLimiter })
        .getBars(SYMBOL, '1h', ASOF, 1)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(settled).resolves.toHaveLength(1);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(acquireSpy).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 — retrying would fight the free tier ceiling that produced it', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1)).rejects.toBeInstanceOf(
        PolygonBarsRateLimitError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('exhausts retries and throws the classified error on a persistent 503', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);

      const promise = new PolygonBarsClient().getBars(SYMBOL, '1h', ASOF, 1);
      const assertion = expect(promise).rejects.toBeInstanceOf(PolygonBarsProviderError);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('isRetryablePolygonBarsError', () => {
    // Mutation evidence in both directions: widening this predicate to match
    // the other three transport clients' shape (RateLimit always retryable)
    // must fail here, and so must narrowing it to drop the 5xx branch
    it('retries Timeout and 5xx ProviderError, never RateLimit or non-5xx ProviderError', () => {
      expect(isRetryablePolygonBarsError(new PolygonBarsTimeoutError('x'))).toBe(true);
      expect(isRetryablePolygonBarsError(new PolygonBarsProviderError('x', 503))).toBe(true);
      expect(isRetryablePolygonBarsError(new PolygonBarsProviderError('x', 599))).toBe(true);
      expect(isRetryablePolygonBarsError(new PolygonBarsProviderError('x', 400))).toBe(false);
      expect(isRetryablePolygonBarsError(new PolygonBarsProviderError('x', undefined))).toBe(false);
      expect(isRetryablePolygonBarsError(new PolygonBarsRateLimitError('x'))).toBe(false);
    });
  });
});
