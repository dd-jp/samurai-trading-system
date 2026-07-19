import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlmMalformedResponseError,
  LlmProviderError,
  LlmRateLimitError,
  LlmTimeoutError,
} from './errors.js';
import { withRetry } from './retry.js';
import type { LlmRetryConfig } from './types.js';

const CONFIG: LlmRetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 };

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result on first success without delay', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, CONFIG);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a timeout error and succeeds on a later attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmTimeoutError('slow'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on a rate-limit error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmRateLimitError('too many requests'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on a malformed-response error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new LlmMalformedResponseError('not json'))
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, CONFIG);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable provider error', async () => {
    const error = new LlmProviderError('bad request');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, CONFIG)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxAttempts and rethrows the last error', async () => {
    const error = new LlmTimeoutError('still slow');
    const fn = vi.fn().mockRejectedValue(error);

    const promise = withRetry(fn, CONFIG);
    const assertion = expect(promise).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs);
    await vi.advanceTimersByTimeAsync(CONFIG.baseDelayMs * 2);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(CONFIG.maxAttempts);
  });

  it('backs off exponentially between attempts', async () => {
    const config: LlmRetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 };
    const error = new LlmTimeoutError('slow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, config);

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
    const config: LlmRetryConfig = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 150 };
    const error = new LlmTimeoutError('slow');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, config);

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
});
