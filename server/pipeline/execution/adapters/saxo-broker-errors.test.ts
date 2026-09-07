import {
  classifySaxoBrokerNetworkError,
  isRetryableSaxoBrokerError,
  SaxoBrokerProviderError,
  SaxoBrokerRateLimitError,
  SaxoBrokerTimeoutError,
} from './saxo-broker-errors.js';

describe('isRetryableSaxoBrokerError', () => {
  it('retries timeouts and rate limits', () => {
    expect(isRetryableSaxoBrokerError(new SaxoBrokerTimeoutError('t'))).toBe(true);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerRateLimitError('r'))).toBe(true);
  });

  it('retries 5xx provider errors only', () => {
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p', 503))).toBe(true);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p', 401))).toBe(false);
    // 409 = the duplicate-request guard; retrying inside the window re-earns it.
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p', 409))).toBe(false);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p'))).toBe(false);
  });

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    // 599 is the top of the valid 5xx range; 600 cannot be a real HTTP status —
    // a hostile/broken upstream, not a transient server error to retry against.
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p', 599))).toBe(true);
    expect(isRetryableSaxoBrokerError(new SaxoBrokerProviderError('p', 600))).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableSaxoBrokerError(new Error('boom'))).toBe(false);
    expect(isRetryableSaxoBrokerError(undefined)).toBe(false);
  });

  // #1223: a transport failure (ECONNRESET, DNS failure, socket hangup) never
  // reaches classifyStatus — it has no `status` at all. Retryability for that
  // shape must follow from the request's HTTP method, not default to either
  // extreme.
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
    // stay false independent of `placeOrder`'s own maxAttempts:1 override.
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

    it('is NOT retryable when the failing request was a DELETE (cancel is not a safe read)', () => {
      const error = classifySaxoBrokerNetworkError(new Error('ETIMEDOUT'), 'cancelOrder', 'DELETE');
      expect(isRetryableSaxoBrokerError(error)).toBe(false);
    });

    it('a timeout abort classifies as SaxoBrokerTimeoutError regardless of method (already retryable)', () => {
      const abortError = new DOMException('The operation was aborted', 'TimeoutError');
      const error = classifySaxoBrokerNetworkError(abortError, 'placeOrder', 'POST');
      expect(error).toBeInstanceOf(SaxoBrokerTimeoutError);
      expect(isRetryableSaxoBrokerError(error)).toBe(true);
    });
  });
});
