// `venuePacingEnvVars` is deliberately off the `shared/index.js` barrel
// (internal to `venue-pacing.ts` and its own test — see that barrel's
// comment), so this test imports it directly to insulate the default-bucket
// assertions below from whatever `SAMURAI_PACING_POLYGON_*` an operator's
// shell or `.env.local` happens to have set.
import { venuePacingEnvVars } from '../shared/http/venue-pacing.js';
import { resolveVenuePacing, TokenBucket } from '../shared/index.js';
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

/**
 * A bucket that never makes a test wait: every scenario in this file except
 * the pacing describe block below is exercising something other than
 * pacing, and a slow/parked `acquire()` would either time out the test or
 * force it onto fake timers it doesn't otherwise need.
 */
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
    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await client.fetchAggregates('BTC-USD', window);

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

    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });
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

    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await expect(client.fetchAggregates('SPY', window)).rejects.toThrow(/exceeded .* pages/);
  });

  it('throws on a non-ok HTTP response without leaking the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = new HttpPolygonClient({
      apiKey: FAKE_KEY,
      fetchImpl,
      rateLimiter: unlimitedBucket(),
    });

    await expect(client.fetchAggregates('SPY', window)).rejects.toThrow(/HTTP 500/);
    await expect(client.fetchAggregates('SPY', window)).rejects.not.toThrow(new RegExp(FAKE_KEY));
  });
});

/**
 * #510: the free-tier ceiling (5 calls/min) is fired against by a
 * `TokenBucket`, not just documented in a comment. `describe`s below are
 * split by whether they exercise the constructor's OWN default (proving the
 * production code path — every real call site constructs `new
 * HttpPolygonClient()` with no `rateLimiter` override, so a bucket that only
 * works when injected would be the exact "tested in isolation, nothing
 * calls it" defect this batch's reviewers keep catching) or an injected
 * bucket (proving `fetchAggregates` actually awaits `acquire()` rather than
 * merely holding a reference to one).
 */
describe('HttpPolygonClient free-tier pacing (#510)', () => {
  const window: DateRange = {
    start: new Date(Date.UTC(2021, 0, 1)),
    end: new Date(Date.UTC(2021, 0, 10)),
  };

  // The "default bucket" test below constructs `HttpPolygonClient` with no
  // `rateLimiter`, deliberately, to prove the constructor's own default —
  // the only pacing path any real call site takes — actually works. That
  // default reads live `process.env`, so an ambient `SAMURAI_PACING_POLYGON_*`
  // (a developer's shell, an `--env-file`) would otherwise make this test's
  // pass/fail depend on the operator's config rather than the checked-in
  // default. Clearing and restoring them scopes the test to what it claims
  // to test.
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
    // Starts empty (0 of 1 capacity) so the very first call must wait for a
    // token — proving `fetchAggregates` calls `acquire()`, not merely stores
    // the bucket unused (the defect this file's #510 comment above guards).
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    await bucket.acquire();

    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl, rateLimiter: bucket });
    const pending = client.fetchAggregates('SPY', window);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paces a burst of more than 5 calls through the default bucket rather than firing them at once', async () => {
    // No `rateLimiter` override: this is the constructor's OWN default,
    // `resolveVenuePacing().polygon` — the path every real call site
    // (`run-stage2.ts`, `run-stage2-cost-decomposition.ts`,
    // `run-spread-calibration.ts`) actually takes. Expectations are derived
    // from `resolveVenuePacing()` itself, rather than the checked-in numbers
    // hard-coded again here, so this test proves "the client is paced by
    // whatever ops config says" — the actual acceptance criterion — instead
    // of merely reproducing today's `DEFAULT_VENUE_PACING.polygon` values
    // (already covered by `venue-pacing.test.ts`) a second time.
    const { capacity, refillPerSecond } = resolveVenuePacing().polygon;
    const stepMs = 1_000 / refillPerSecond;

    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const client = new HttpPolygonClient({ apiKey: FAKE_KEY, fetchImpl });

    const burst = 6; // > 5, the free-tier ceiling this bucket paces against.
    const pending = Promise.all(
      Array.from({ length: burst }, (_, i) => client.fetchAggregates(`SYM${i}`, window)),
    );

    // The bucket starts full at `capacity`: that many calls fire for free.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(capacity);

    // The rest are paced one token's worth of refill apart — a burst fired
    // all at once would have called `fetchImpl` all 6 times already.
    for (let called = capacity + 1; called <= burst; called++) {
      await vi.advanceTimersByTimeAsync(stepMs);
      expect(fetchImpl).toHaveBeenCalledTimes(called);
    }

    await pending;
  });
});
