import {
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
});
