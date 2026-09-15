import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetryAttemptReport, RetryConfig } from './retry.js';
import { withRetry, worstCaseFetchMs } from './retry.js';

const CONFIG: RetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

/** A generic retryable failure carrying an optional `Retry-After`-style hint. */
class RetryableError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

class FatalError extends Error {}

const isRetryable = (error: unknown): boolean => error instanceof RetryableError;

describe('withRetry (generic)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Backoff is full-jitter (`Math.random() * capped`), so the delay a test
    // observes is a draw, not a constant. Pinning the draw to 1 makes the
    // observed delay the jitter window's UPPER BOUND — which is exactly the
    // deterministic schedule these tests were written against, so each
    // exact-delay assertion below now reads as "never waits longer than this".
    // The jitter itself is exercised by its own test, which re-pins the draw.
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the result on first success without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, CONFIG, isRetryable);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable error and succeeds on a later attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG, isRetryable);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error the injected predicate rejects', async () => {
    const error = new FatalError('bad request');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, CONFIG, isRetryable)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with an Error, not undefined, when maxAttempts < 1', async () => {
    const config: RetryConfig = { maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 1_000 };
    const fn = vi.fn();

    await expect(withRetry(fn, config, isRetryable)).rejects.toThrow(
      'RetryConfig.maxAttempts must be >= 1, got 0',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('exhausts maxAttempts and rethrows the last error', async () => {
    const error = new RetryableError('still slow');
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn, CONFIG, isRetryable);
    const assertion = expect(promise).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs * 2);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(CONFIG.maxAttempts);
  });

  it('draws the backoff from within the exponential window rather than waiting the full ceiling', async () => {
    // Full jitter: the delay is a uniform draw from [0, capped], so half a
    // draw is half the window. Asserting through the timer (rather than
    // exporting the private `backoffDelayMs`) keeps the test on the observable
    // behaviour — when the retry actually fires.
    vi.mocked(Math.random).mockReturnValue(0.5);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG, isRetryable);

    // Window is 100ms; the 0.5 draw fires at 50ms, well before the ceiling.
    await vi.advanceTimersByTimeAsync(49);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe('ok');
  });

  it('de-correlates concurrent callers: independent draws produce different delays', async () => {
    // The thundering-herd property the jitter exists for — asserted against
    // the real RNG, since a mocked one cannot show independence.
    vi.mocked(Math.random).mockRestore();
    const delays = new Set<number>();

    for (let i = 0; i < 20; i++) {
      // Fake timers advance the clock to each timer's firing time, so the gap
      // between the two attempts IS the delay the loop chose.
      const attemptTimes: number[] = [];
      const fn = () => {
        attemptTimes.push(Date.now());
        throw new RetryableError('slow');
      };

      const promise = withRetry(fn, CONFIG, isRetryable).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(CONFIG.maxDelayMs * 4);
      await promise;

      const gap = (attemptTimes[1] ?? 0) - (attemptTimes[0] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(CONFIG.baseDelayMs);
      delays.add(gap);
    }

    // 20 identical gaps across independent draws would mean the backoff is
    // still deterministic.
    expect(delays.size).toBeGreaterThan(1);
  });

  it('never waits longer than the exponential ceiling', async () => {
    const config: RetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 };
    const error = new RetryableError('slow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, config, isRetryable);

    // First retry delay: 100ms (base * 2^0).
    await vi.advanceTimersByTimeAsync(99);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry delay: 200ms (base * 2^1).
    await vi.advanceTimersByTimeAsync(199);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe('ok');
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const config: RetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 };
    const error = new RetryableError('slow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, config, isRetryable);

    // First retry delay: 100ms (base * 2^0, under the cap).
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);

    // Second retry delay would be 200ms uncapped; the 150ms cap fires it earlier.
    await vi.advanceTimersByTimeAsync(149);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe('ok');
  });

  it('honors retryAfterMs on a retryable error, overriding the computed backoff', async () => {
    // Computed backoff for attempt 1 would be 100ms; the hint says wait 500ms instead
    // (under CONFIG.maxDelayMs of 1000ms, so it isn't clamped).
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('rate limited', 500))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG, isRetryable);

    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe('ok');
  });

  it('clamps a retryAfterMs hint that exceeds maxDelayMs', async () => {
    // CONFIG.maxDelayMs is 1000ms; a provider hint of 5000ms must not bypass it.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('rate limited', 5_000))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG, isRetryable);

    await vi.advanceTimersByTimeAsync(CONFIG.maxDelayMs - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe('ok');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'falls back to computed backoff when retryAfterMs is invalid (%s)',
    async (invalidHint) => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new RetryableError('rate limited', invalidHint))
        .mockResolvedValueOnce('ok');

      const promise = withRetry(fn, CONFIG, isRetryable);

      await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs - 1);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);

      await expect(promise).resolves.toBe('ok');
    },
  );

  it('falls back to computed backoff when retryAfterMs is absent', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RetryableError('slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG, isRetryable);

    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    await expect(promise).resolves.toBe('ok');
  });
});

/**
 * #1080: the loop was silent, and that silence is what made a 30s timed-out
 * attempt inside a 60s debate budget unmeasurable — it appears in no log line
 * and, because `AnthropicLlmClient` meters only attempts that RETURN, in no
 * `llm_spend` row either.
 */
describe('withRetry retry observer (#1080)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports every attempt it retries, and not the attempt the caller sees fail', async () => {
    const reports: RetryAttemptReport[] = [];
    const boom = new RetryableError('slow');
    // Three attempts configured, all failing: attempts 1 and 2 are retried and
    // must be reported; attempt 3's error is rethrown to the caller, which can
    // log it itself, so reporting it here would double-count.
    const fn = vi.fn().mockRejectedValue(boom);

    const promise = withRetry(fn, CONFIG, isRetryable, (report) => reports.push(report));
    const settled = expect(promise).rejects.toBe(boom);
    await vi.advanceTimersByTimeAsync(CONFIG.maxDelayMs * CONFIG.maxAttempts);
    await settled;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(reports.map((report) => report.attempt)).toEqual([1, 2]);
    expect(reports.map((report) => report.maxAttempts)).toEqual([3, 3]);
    expect(reports.map((report) => report.error)).toEqual([boom, boom]);
    // The delay the loop is about to sleep, not one it already slept: full
    // jitter pinned to its upper bound, doubling per attempt to the cap.
    expect(reports.map((report) => report.delay_ms)).toEqual([100, 200]);
  });

  it('reports the failed attempt OWN elapsed time, not the cumulative time', async () => {
    const reports: RetryAttemptReport[] = [];
    let call = 0;
    const fn = vi.fn().mockImplementation(async () => {
      call += 1;
      const spend = call * 1_000;
      await new Promise((resolve) => setTimeout(resolve, spend));
      if (call === 1) {
        throw new RetryableError('slow');
      }
      return 'ok';
    });

    const promise = withRetry(fn, CONFIG, isRetryable, (report) => reports.push(report));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toBe('ok');
    expect(reports).toHaveLength(1);
    // 1,000ms of attempt 1 — the backoff and attempt 2's own 2,000ms are not
    // part of it. The cumulative figure is recoverable by summing these; the
    // per-attempt one is not recoverable from a cumulative total.
    expect(reports[0]?.elapsed_ms).toBe(1_000);
  });

  it('does not report an error the predicate rejects', async () => {
    const reports: RetryAttemptReport[] = [];
    const fn = vi.fn().mockRejectedValue(new FatalError('bad request'));

    await expect(
      withRetry(fn, CONFIG, isRetryable, (report) => reports.push(report)),
    ).rejects.toBeInstanceOf(FatalError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });

  it('lets the provider error through when the observer itself throws', async () => {
    // This loop is on the path of every LLM and HTTP call in the system. A
    // telemetry sink that fails must not convert a recoverable timeout into an
    // unclassified crash.
    const fn = vi.fn().mockRejectedValueOnce(new RetryableError('slow')).mockResolvedValue('ok');

    const promise = withRetry(fn, CONFIG, isRetryable, () => {
      throw new Error('logger is broken');
    });
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('worstCaseFetchMs', () => {
  it('sums every attempt timeout plus every backoff cap between attempts, not after the last one', () => {
    // 3 attempts against ALPACA_BARS_RETRY_CONFIG-shaped config: 3 timeouts,
    // and backoff caps for attempts 1 and 2 only (min(250*2^0,4000)=250,
    // min(250*2^1,4000)=500) — attempt 3 is the last and is not followed by a
    // sleep.
    const config: RetryConfig = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4_000 };
    expect(worstCaseFetchMs(10_000, config)).toBe(3 * 10_000 + 250 + 500);
  });

  it('is a single-attempt bound at maxAttempts 1: no backoff at all', () => {
    const config: RetryConfig = { maxAttempts: 1, baseDelayMs: 250, maxDelayMs: 4_000 };
    expect(worstCaseFetchMs(10_000, config)).toBe(10_000);
  });

  it('caps each backoff term at maxDelayMs once the exponential curve exceeds it', () => {
    const config: RetryConfig = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 1_500 };
    // Uncapped terms would be 1000, 2000, 4000; capped: 1000, 1500, 1500.
    expect(worstCaseFetchMs(0, config)).toBe(1_000 + 1_500 + 1_500);
  });
});
