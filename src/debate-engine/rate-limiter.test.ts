import { SimulatedClock } from '../shared/index.js';
import { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';

const start = new Date('2026-07-19T00:00:00.000Z');

function makeConfig(overrides: Partial<RateLimiterConfig['default']> = {}): RateLimiterConfig {
  return {
    default: { windowMs: 60_000, maxLlmCalls: 10, maxDebates: 3, ...overrides },
  };
}

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

    // 2 calls used, 8 remain — a further worst-case-8 reservation should fit exactly.
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

    // Rejection must not consume any debate-count budget either.
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
