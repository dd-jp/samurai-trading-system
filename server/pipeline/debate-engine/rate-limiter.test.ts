import { SimulatedClock } from '../../shared/index.js';
import { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';

const start = new Date('2026-07-19T00:00:00.000Z');

function makeConfig(overrides: Partial<RateLimiterConfig['default']> = {}): RateLimiterConfig {
  return {
    default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 3, ...overrides },
  };
}

/**
 * `reserve` is TOTAL over `AssetClass` — it returns a `ReserveResult` for every
 * value the type admits and never throws.
 *
 * This is not a general robustness test; it is the specific guarantee
 * `buildDebateStep` relies on to call `reserve` OUTSIDE its try/catch (PR #390
 * review). `SequentialTickRunner` does not catch a stage throw, so anything
 * that throws there discards the whole tick pass rather than one instrument —
 * the exact failure the refusal path is designed to avoid. If `reserve` could
 * throw on a reachable input, that protection would sit one line too late.
 *
 * The case worth pinning hardest is an asset class with no `perAssetClass`
 * entry, because a wrong asset class reaching this path is not hypothetical:
 * mutation M11 (`tick-runner` hard-coding `asset_class: 'crypto'`) was exactly
 * that, and it survived a green suite. What these tests establish is that such
 * a value FALLS BACK to `default` rather than throwing — which is also why M11
 * was silent rather than loud.
 */
/**
 * The construction-time preconditions that make `reserve`'s totality ENFORCED
 * rather than merely documented (PR #390 review).
 *
 * Each case below is one of the three shapes that were empirically found to
 * make `reserve` throw mid-debate. They are all total, permanent
 * misconfigurations, so the right time to fail is boot — loudly, before any
 * timer exists — not the first debate, where a throw reads as "this instrument
 * silently never trades" for the length of a 14-day soak.
 */
describe('RateLimiter refuses a misconfigured budget at construction', () => {
  const clock = new SimulatedClock(start);

  it('refuses a config with no `default`', () => {
    expect(() => new RateLimiter(clock, {} as unknown as RateLimiterConfig)).toThrow(
      /config\.default is required/,
    );
  });

  it('refuses a null config', () => {
    expect(() => new RateLimiter(clock, null as unknown as RateLimiterConfig)).toThrow(
      /config is required/,
    );
  });

  it('refuses a clock that does not return a Date', () => {
    // Would otherwise throw on `clock.now().getTime()` at the first debate
    expect(
      () => new RateLimiter({ now: () => undefined } as unknown as SimulatedClock, makeConfig()),
    ).toThrow(/must return a Date/);
  });

  it('refuses a per-asset-class entry that is malformed, naming the field', () => {
    expect(
      () =>
        new RateLimiter(clock, {
          default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 3 },
          perAssetClass: { stocks: { maxLlmCalls: 5 } as never },
        }),
    ).toThrow(/perAssetClass\.stocks\.windowMs/);
  });

  /**
   * `windowMs: 0` is the dangerous one: `currentWindow`'s
   * `now - windowStart < windowMs` is never true, so every call mints a fresh
   * window and the limiter enforces NOTHING while reading as configured
   */
  it('refuses windowMs: 0, which would silently disable enforcement', () => {
    expect(() => new RateLimiter(clock, makeConfig({ windowMs: 0 }))).toThrow(
      /default\.windowMs must be a finite positive number/,
    );
  });

  it('refuses a negative windowMs too', () => {
    expect(() => new RateLimiter(clock, makeConfig({ windowMs: -1 }))).toThrow(
      /default\.windowMs must be a finite positive number/,
    );
  });

  it('refuses a negative counter, while still allowing zero', () => {
    expect(() => new RateLimiter(clock, makeConfig({ maxLlmCalls: -1 }))).toThrow(
      /default\.maxLlmCalls must be a finite non-negative number/,
    );
    expect(() => new RateLimiter(clock, makeConfig({ maxLlmCalls: 0 }))).not.toThrow();
  });

  it('accepts a budget of zero debates — "admit nothing" is a valid setting', () => {
    expect(() => new RateLimiter(clock, makeConfig({ maxDebates: 0 }))).not.toThrow();
  });
});

describe('RateLimiter.reserve is total over AssetClass', () => {
  const assetClasses = ['crypto', 'stocks'] as const;

  it.each(
    assetClasses,
  )('returns a result for %s when only `default` is configured', (assetClass) => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig());

    expect(() => limiter.reserve(assetClass, 4)).not.toThrow();
    expect(limiter.reserve(assetClass, 4)).toEqual({ granted: true });
  });

  it('falls back to `default` for a class absent from perAssetClass, rather than throwing', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), {
      default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 3 },
      perAssetClass: { crypto: { windowMs: 60_000, maxLlmCalls: 99, maxDebates: 99 } },
    });

    // `stocks` has no entry. It must be governed by `default` (maxDebates 3),
    // not error and not inherit crypto's 99
    expect(limiter.reserve('stocks', 4)).toEqual({ granted: true });
    limiter.reserve('stocks', 4);
    limiter.reserve('stocks', 4);
    expect(limiter.reserve('stocks', 4).granted).toBe(false);
  });

  it('does not throw on recordCall for a class absent from perAssetClass', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), {
      default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 3 },
      perAssetClass: { crypto: { windowMs: 60_000, maxLlmCalls: 99, maxDebates: 99 } },
    });

    // Shares `currentWindow` with `reserve`, and runs INSIDE the debate via
    // `RateLimitedLlmClient` — a throw here would fail the debate mid-flight
    expect(() => limiter.recordCall('stocks')).not.toThrow();
    expect(limiter.snapshot().stocks?.llmCallsUsed).toBe(1);
  });
});

describe('RateLimiter', () => {
  it('grants reserve() when worst-case budget is available', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig());

    const result = limiter.reserve('crypto', 4);

    expect(result).toEqual({ granted: true });
  });

  it('tracks LLM call count within the configured window', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig());

    limiter.reserve('crypto', 4);
    limiter.recordCall('crypto');
    limiter.recordCall('crypto');

    // 2 calls used, 8 remain — a further worst-case-8 reservation should fit exactly
    const result = limiter.reserve('crypto', 8);

    expect(result).toEqual({ granted: true });
  });

  it('decrements remaining LLM-call budget as a debate progresses', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig({ maxLlmCalls: 4 }));

    limiter.reserve('crypto', 4);
    limiter.recordCall('crypto');
    limiter.recordCall('crypto');
    limiter.recordCall('crypto');
    limiter.recordCall('crypto');

    const result = limiter.reserve('crypto', 1);

    expect(result).toEqual({
      granted: false,
      reason: 'LLM call budget insufficient for crypto: 4/4 used, 1 needed for worst case',
    });
  });

  it('returns a rate-limit error immediately when LLM call budget is exhausted, without partial reservation', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig({ maxLlmCalls: 3 }));

    const result = limiter.reserve('crypto', 4);

    expect(result).toEqual({
      granted: false,
      reason: 'LLM call budget insufficient for crypto: 0/3 used, 4 needed for worst case',
    });

    // Rejection must not consume any debate-count budget either
    const followUp = limiter.reserve('crypto', 3);
    expect(followUp).toEqual({ granted: true });
  });

  it('returns a rate-limit error when the debate-count budget is exhausted', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), makeConfig({ maxDebates: 1 }));

    const first = limiter.reserve('crypto', 1);
    const second = limiter.reserve('crypto', 1);

    expect(first).toEqual({ granted: true });
    expect(second).toEqual({
      granted: false,
      reason: 'debate budget exhausted for crypto: 1/1 debates used this window',
    });
  });

  it('supports different limits per asset class', () => {
    const limiter = new RateLimiter(new SimulatedClock(start), {
      default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 5 },
      perAssetClass: {
        crypto: { windowMs: 60_000, maxLlmCalls: 2, maxDebates: 1 },
      },
    });

    const cryptoResult = limiter.reserve('crypto', 3);
    const stocksResult = limiter.reserve('stocks', 3);

    expect(cryptoResult).toEqual({
      granted: false,
      reason: 'LLM call budget insufficient for crypto: 0/2 used, 3 needed for worst case',
    });
    expect(stocksResult).toEqual({ granted: true });
  });

  it('replenishes budget once the window elapses', () => {
    const clock = new SimulatedClock(start);
    const limiter = new RateLimiter(clock, makeConfig({ maxDebates: 1, windowMs: 60_000 }));

    expect(limiter.reserve('crypto', 1)).toEqual({ granted: true });
    expect(limiter.reserve('crypto', 1)).toEqual({
      granted: false,
      reason: 'debate budget exhausted for crypto: 1/1 debates used this window',
    });

    clock.advanceTo(new Date(start.getTime() + 60_001));

    expect(limiter.reserve('crypto', 1)).toEqual({ granted: true });
  });
});
