import { withRetry } from '../../../shared/index.js';
import {
  AlpacaBrokerProviderError,
  AlpacaBrokerRateLimitError,
  AlpacaBrokerTimeoutError,
  classifyAlpacaBrokerNetworkError,
  classifyAlpacaBrokerResponse,
  isRetryableAlpacaBrokerError,
} from './alpaca-broker-errors.js';

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Error',
    headers: new Headers(headers),
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response;
}

describe('isRetryableAlpacaBrokerError', () => {
  it('retries timeouts and rate limits on a GET', () => {
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerTimeoutError('t', 'GET'))).toBe(true);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerRateLimitError('r', 'GET'))).toBe(true);
  });

  it('retries 5xx provider errors only, and only on a retry-safe verb', () => {
    expect(
      isRetryableAlpacaBrokerError(
        new AlpacaBrokerProviderError('p', 503, undefined, undefined, 'GET'),
      ),
    ).toBe(true);
    expect(
      isRetryableAlpacaBrokerError(
        new AlpacaBrokerProviderError('p', 401, undefined, undefined, 'GET'),
      ),
    ).toBe(false);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p'))).toBe(false);
  });

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    // 599 is the top of the valid 5xx range; 600 cannot be a real HTTP status —
    // a hostile/broken upstream, not a transient server error to retry against.
    expect(
      isRetryableAlpacaBrokerError(
        new AlpacaBrokerProviderError('p', 599, undefined, undefined, 'GET'),
      ),
    ).toBe(true);
    expect(
      isRetryableAlpacaBrokerError(
        new AlpacaBrokerProviderError('p', 600, undefined, undefined, 'GET'),
      ),
    ).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableAlpacaBrokerError(new Error('boom'))).toBe(false);
    expect(isRetryableAlpacaBrokerError(undefined)).toBe(false);
  });

  // #1275 review item 1: `isRetrySafeMethod` reducing to
  // `method !== 'POST'` passed all 165 tests across the three Alpaca files
  // (confirmed by mutation) — every verb this suite exercised (GET/DELETE
  // retry-safe, POST not) reads the same under both forms. What that mutant
  // actually admits is `undefined`, `PUT` and `PATCH`, which nothing here
  // pinned. These two close it.
  describe('the allowlist fails closed on verbs it does not name (#1275 review item 1)', () => {
    it('a 5xx ProviderError with no verb recorded is NOT retryable (fail-closed on absent verb)', () => {
      // `method` is optional only on ProviderError — this is the shape a
      // status-less network error, a JSON-parse failure, or `failValidation`
      // construct, but WITH a `status` attached so the method gate is
      // isolated: `isServerErrorStatus` alone would say true here.
      expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p', 503))).toBe(false);
    });

    it('PUT and PATCH are excluded exactly like POST — the deliberate exclusion documented above', () => {
      expect(isRetryableAlpacaBrokerError(new AlpacaBrokerTimeoutError('t', 'PUT'))).toBe(false);
      expect(isRetryableAlpacaBrokerError(new AlpacaBrokerRateLimitError('r', 'PATCH'))).toBe(
        false,
      );
      expect(
        isRetryableAlpacaBrokerError(
          new AlpacaBrokerProviderError('p', 503, undefined, undefined, 'PUT'),
        ),
      ).toBe(false);
    });
  });

  // #1275: timeout, rate-limit and 5xx retryability now carries the request's
  // verb instead of firing unconditionally — this is the gap #1273 closed for
  // Saxo and deliberately left open here, until now.
  describe('timeout/rate-limit/5xx retryability is verb-aware (#1275)', () => {
    describe('a fetchWithTimeout deadline abort (classifyAlpacaBrokerNetworkError)', () => {
      // This is the money-safety guarantee: a blind retry of a placement
      // whose response was lost can produce a second live order. This must
      // stay false independent of `submitOrder`'s own `maxAttempts: 1`
      // override, and independent of whether Alpaca actually 422s a
      // duplicate `client_order_id` — that has not been probed.
      it('a POST timeout is NEVER classified retryable', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifyAlpacaBrokerNetworkError(abortError, 'submitOrder', 'POST');
        expect(error).toBeInstanceOf(AlpacaBrokerTimeoutError);
        expect(isRetryableAlpacaBrokerError(error)).toBe(false);
      });

      it('a GET timeout stays retryable', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifyAlpacaBrokerNetworkError(abortError, 'getOrder', 'GET');
        expect(isRetryableAlpacaBrokerError(error)).toBe(true);
      });

      it('a DELETE (cancelOrder) timeout stays retryable — repeat cancel is idempotent by construction', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifyAlpacaBrokerNetworkError(abortError, 'cancelOrder', 'DELETE');
        expect(isRetryableAlpacaBrokerError(error)).toBe(true);
      });

      it('a status-less network failure on any verb stays non-retryable (unchanged by #1275)', () => {
        const error = classifyAlpacaBrokerNetworkError(
          new Error('socket hang up'),
          'submitOrder',
          'POST',
        );
        expect(error).toBeInstanceOf(AlpacaBrokerProviderError);
        expect((error as AlpacaBrokerProviderError).status).toBeUndefined();
        expect(isRetryableAlpacaBrokerError(error)).toBe(false);
      });

      // Acceptance criterion, verbatim: a placement POST timeout must produce
      // exactly one fetch attempt through the real retry loop — not "the
      // classifier says false" one step removed from it. Driven through the
      // real `withRetry` (no fake timers needed: baseDelayMs 0 means a
      // mutated, retrying run also completes immediately, so this fails on
      // call count rather than hanging). `submitOrder`'s own `maxAttempts: 1`
      // override is deliberately NOT part of this config — this test proves
      // the classifier alone stops the retry, independent of that override.
      it('a placement POST timeout produces exactly one fetch attempt through withRetry', async () => {
        const fetchLike = vi.fn().mockImplementation(() => {
          throw classifyAlpacaBrokerNetworkError(
            new DOMException('The operation was aborted', 'TimeoutError'),
            'submitOrder',
            'POST',
          );
        });

        await expect(
          withRetry(
            fetchLike,
            { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 },
            isRetryableAlpacaBrokerError,
          ),
        ).rejects.toBeInstanceOf(AlpacaBrokerTimeoutError);
        expect(fetchLike).toHaveBeenCalledTimes(1);
      });
    });

    describe('a real response (classifyAlpacaBrokerResponse)', () => {
      it('a 504 (timeout) on a POST is NOT retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(fakeResponse(504), 'submitOrder', 'POST');
        expect(error).toBeInstanceOf(AlpacaBrokerTimeoutError);
        expect(isRetryableAlpacaBrokerError(error)).toBe(false);
      });

      it('a 504 (timeout) on a DELETE (cancelOrder) IS retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(
          fakeResponse(504),
          'cancelOrder',
          'DELETE',
        );
        expect(error).toBeInstanceOf(AlpacaBrokerTimeoutError);
        expect(isRetryableAlpacaBrokerError(error)).toBe(true);
      });

      it('a 429 (rate-limit) on a POST is NOT retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(fakeResponse(429), 'submitOrder', 'POST');
        expect(error).toBeInstanceOf(AlpacaBrokerRateLimitError);
        expect(isRetryableAlpacaBrokerError(error)).toBe(false);
      });

      it('a 429 (rate-limit) on a GET IS retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(fakeResponse(429), 'getOrder', 'GET');
        expect(isRetryableAlpacaBrokerError(error)).toBe(true);
      });

      it('a 503 (5xx) on a POST is NOT retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(fakeResponse(503), 'submitOrder', 'POST');
        expect(error).toBeInstanceOf(AlpacaBrokerProviderError);
        expect(isRetryableAlpacaBrokerError(error)).toBe(false);
      });

      it('a 503 (5xx) on a DELETE (cancelOrder) IS retryable', async () => {
        const error = await classifyAlpacaBrokerResponse(
          fakeResponse(503),
          'cancelOrder',
          'DELETE',
        );
        expect(isRetryableAlpacaBrokerError(error)).toBe(true);
      });
    });
  });
});
