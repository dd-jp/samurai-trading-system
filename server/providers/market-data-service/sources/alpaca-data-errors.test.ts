import {
  AlpacaDataProviderError,
  AlpacaDataRateLimitError,
  AlpacaDataTimeoutError,
  isRetryableAlpacaDataError,
} from './alpaca-data-errors.js';

describe('isRetryableAlpacaDataError', () => {
  it('retries timeouts and rate limits', () => {
    expect(isRetryableAlpacaDataError(new AlpacaDataTimeoutError('t'))).toBe(true);
    expect(isRetryableAlpacaDataError(new AlpacaDataRateLimitError('r'))).toBe(true);
  });

  it('retries 5xx provider errors only', () => {
    expect(isRetryableAlpacaDataError(new AlpacaDataProviderError('p', 503))).toBe(true);
    expect(isRetryableAlpacaDataError(new AlpacaDataProviderError('p', 401))).toBe(false);
    expect(isRetryableAlpacaDataError(new AlpacaDataProviderError('p'))).toBe(false);
  });

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    expect(isRetryableAlpacaDataError(new AlpacaDataProviderError('p', 599))).toBe(true);
    expect(isRetryableAlpacaDataError(new AlpacaDataProviderError('p', 600))).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableAlpacaDataError(new Error('boom'))).toBe(false);
    expect(isRetryableAlpacaDataError(undefined)).toBe(false);
  });
});
