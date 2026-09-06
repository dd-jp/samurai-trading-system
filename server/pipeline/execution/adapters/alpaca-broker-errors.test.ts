import {
  AlpacaBrokerProviderError,
  AlpacaBrokerRateLimitError,
  AlpacaBrokerTimeoutError,
  isRetryableAlpacaBrokerError,
} from './alpaca-broker-errors.js';

describe('isRetryableAlpacaBrokerError', () => {
  it('retries timeouts and rate limits', () => {
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerTimeoutError('t'))).toBe(true);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerRateLimitError('r'))).toBe(true);
  });

  it('retries 5xx provider errors only', () => {
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p', 503))).toBe(true);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p', 401))).toBe(false);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p'))).toBe(false);
  });

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    // 599 is the top of the valid 5xx range; 600 cannot be a real HTTP status —
    // a hostile/broken upstream, not a transient server error to retry against.
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p', 599))).toBe(true);
    expect(isRetryableAlpacaBrokerError(new AlpacaBrokerProviderError('p', 600))).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableAlpacaBrokerError(new Error('boom'))).toBe(false);
    expect(isRetryableAlpacaBrokerError(undefined)).toBe(false);
  });
});
