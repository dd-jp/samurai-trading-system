import {
  classifySaxoBrokerNetworkError,
  classifySaxoBrokerResponse,
  isRetryableSaxoBrokerError,
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Error',
    headers: new Headers(headers),
    text: async () => '',
  } as Response;
}

describe('isRetryableSaxoBrokerError', () => {
  it('retries timeouts and rate limits on a GET', () => {
    expect(isRetryableSaxoBrokerError(new SaxoBrokerTimeoutError('t', 'GET'))).toBe(true);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerRateLimitError('r', 'GET'))).toBe(true);
  });

  it('retries 5xx provider errors only, and only on a retry-safe verb', () => {
    expect(
      isRetryableSaxoBrokerError(
        new SaxoBrokerProviderError('p', 503, undefined, undefined, false, 'GET'),
      ),
    ).toBe(true);
    expect(
      isRetryableSaxoBrokerError(
        new SaxoBrokerProviderError('p', 401, undefined, undefined, false, 'GET'),
      ),
    ).toBe(false);
    // 409 = the duplicate-request guard; retrying inside the window re-earns it
    expect(
      isRetryableSaxoBrokerError(
        new SaxoBrokerProviderError('p', 409, undefined, undefined, false, 'GET'),
      ),
    ).toBe(false);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p'))).toBe(false);
  });

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    // 599 is the top of the valid 5xx range; 600 cannot be a real HTTP status —
    // a hostile/broken upstream, not a transient server error to retry against
    expect(
      isRetryableSaxoBrokerError(
        new SaxoBrokerProviderError('p', 599, undefined, undefined, false, 'GET'),
      ),
    ).toBe(true);
    expect(
      isRetryableSaxoBrokerError(
        new SaxoBrokerProviderError('p', 600, undefined, undefined, false, 'GET'),
      ),
    ).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableSaxoBrokerError(new Error('boom'))).toBe(false);
    expect(isRetryableSaxoBrokerError(undefined)).toBe(false);
  });

  // #1223: a transport failure (ECONNRESET, DNS failure, socket hangup) never
  // reaches classifyStatus — it has no `status` at all. Retryability for that
  // shape must follow from the request's HTTP method, not default to either
  // extreme
  describe('status-less transport failures (#1223)', () => {
    it('IS retryable when the failing request was a GET (a safe read)', () => {
      const error = classifySaxoBrokerNetworkError(
        new Error('read ECONNRESET'),
        'listOpenOrders',
        'GET',
      );
      expect(error).toBeInstanceOf(SaxoBrokerProviderError);
      expect((error as SaxoBrokerProviderError).status).toBeUndefined();
      expect(isRetryableSaxoBrokerError(error)).toBe(true);
    });

    // This is the money-safety guarantee: a blind retry of a placement whose
    // response was lost can produce a second live order (doc 43). This must
    // stay false independent of `placeOrder`'s own maxAttempts:1 override
    it('is NOT retryable when the failing request was a POST (order placement)', () => {
      const error = classifySaxoBrokerNetworkError(
        new Error('socket hang up'),
        'placeOrder',
        'POST',
      );
      expect(error).toBeInstanceOf(SaxoBrokerProviderError);
      expect((error as SaxoBrokerProviderError).status).toBeUndefined();
      expect(isRetryableSaxoBrokerError(error)).toBe(false);
    });

    // #1273 does not widen this: it was asked to preserve cancel's existing
    // timeout retry, not add a status-less retry cancel does not have today
    // See `classifySaxoBrokerNetworkError`'s doc comment for why this and the
    // DELETE-timeout case below are allowed to disagree
    it('is NOT retryable when the failing request was a DELETE (cancel is not a safe read)', () => {
      const error = classifySaxoBrokerNetworkError(new Error('ETIMEDOUT'), 'cancelOrder', 'DELETE');
      expect(isRetryableSaxoBrokerError(error)).toBe(false);
    });
  });

  // #1273: timeout, rate-limit and 5xx retryability now carries the
  // request's verb instead of firing unconditionally. This is the test
  // #1272 was asked for and did not add
  describe('timeout/rate-limit/5xx retryability is verb-aware (#1273)', () => {
    describe('a fetchWithTimeout deadline abort (classifySaxoBrokerNetworkError)', () => {
      it('a POST timeout is NEVER classified retryable', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifySaxoBrokerNetworkError(abortError, 'placeOrder', 'POST');
        expect(error).toBeInstanceOf(SaxoBrokerTimeoutError);
        expect(isRetryableSaxoBrokerError(error)).toBe(false);
      });

      it('a GET timeout stays retryable', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifySaxoBrokerNetworkError(abortError, 'listOpenOrders', 'GET');
        expect(isRetryableSaxoBrokerError(error)).toBe(true);
      });

      // The preserved behavior: doc 43:33 measured a repeat order-cancel as
      // venue-idempotent (`404 OrderNotFound`), so cancelOrder's existing
      // timeout retry is kept, not withdrawn, by this ticket
      it('a DELETE (cancelOrder) timeout stays retryable (doc 43:33 — repeat cancel is idempotent)', () => {
        const abortError = new DOMException('The operation was aborted', 'TimeoutError');
        const error = classifySaxoBrokerNetworkError(abortError, 'cancelOrder', 'DELETE');
        expect(isRetryableSaxoBrokerError(error)).toBe(true);
      });
    });

    describe('a real response (classifySaxoBrokerResponse)', () => {
      it('a 504 (timeout) on a POST is NOT retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(504), 'placeOrder', 'POST');
        expect(error).toBeInstanceOf(SaxoBrokerTimeoutError);
        expect(isRetryableSaxoBrokerError(error)).toBe(false);
      });

      it('a 504 (timeout) on a DELETE (cancelOrder) IS retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(504), 'cancelOrder', 'DELETE');
        expect(error).toBeInstanceOf(SaxoBrokerTimeoutError);
        expect(isRetryableSaxoBrokerError(error)).toBe(true);
      });

      it('a 429 (rate-limit) on a POST is NOT retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(429), 'placeOrder', 'POST');
        expect(error).toBeInstanceOf(SaxoBrokerRateLimitError);
        expect(isRetryableSaxoBrokerError(error)).toBe(false);
      });

      it('a 429 (rate-limit) on a GET IS retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(429), 'listOpenOrders', 'GET');
        expect(isRetryableSaxoBrokerError(error)).toBe(true);
      });

      it('a 503 (5xx) on a POST is NOT retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(503), 'placeOrder', 'POST');
        expect(error).toBeInstanceOf(SaxoBrokerProviderError);
        expect(isRetryableSaxoBrokerError(error)).toBe(false);
      });

      it('a 503 (5xx) on a DELETE (cancelOrder) IS retryable', async () => {
        const error = await classifySaxoBrokerResponse(fakeResponse(503), 'cancelOrder', 'DELETE');
        expect(isRetryableSaxoBrokerError(error)).toBe(true);
      });
    });
  });
});
