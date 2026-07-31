import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetryConfig } from './retry.js';
import { withRetry } from './retry.js';

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
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('backs off exponentially between attempts', async () => {
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

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
  ])('falls back to computed backoff when retryAfterMs is invalid (%s)', async (invalidHint) => {
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
  });

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
