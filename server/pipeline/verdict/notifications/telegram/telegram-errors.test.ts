import {
  classifyTelegramResponse,
  classifyTelegramThrown,
  isRetryableTelegramError,
  TelegramNetworkError,
  TelegramProviderError,
  TelegramRateLimitError,
  TelegramTimeoutError,
} from './telegram-errors.js';

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    statusText: 'Error',
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as Response;
}

describe('classifyTelegramResponse', () => {
  it('maps 429 to a rate-limit error carrying Telegram’s own retry_after (seconds -> ms)', async () => {
    const error = await classifyTelegramResponse(
      response(
        429,
        '{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":7}}',
      ),
      'sendMessage',
    );

    expect(error).toBeInstanceOf(TelegramRateLimitError);
    expect((error as TelegramRateLimitError).retryAfterMs).toBe(7_000);
    expect(error.message).toContain('Too Many Requests');
    expect(error.message).toContain('sendMessage');
  });

  it('falls back to a Retry-After header when the body carries no hint', async () => {
    const error = await classifyTelegramResponse(
      response(429, '{"ok":false}', { 'retry-after': '3' }),
      'sendMessage',
    );
    expect((error as TelegramRateLimitError).retryAfterMs).toBe(3_000);
  });

  it('maps 408/504 to a timeout error', async () => {
    expect(await classifyTelegramResponse(response(408, ''), 'getUpdates')).toBeInstanceOf(
      TelegramTimeoutError,
    );
    expect(await classifyTelegramResponse(response(504, ''), 'getUpdates')).toBeInstanceOf(
      TelegramTimeoutError,
    );
  });

  it('maps everything else to a provider error that keeps the status', async () => {
    const conflict = await classifyTelegramResponse(
      response(409, '{"ok":false,"description":"Conflict: terminated by other getUpdates"}'),
      'getUpdates',
    );
    expect(conflict).toBeInstanceOf(TelegramProviderError);
    expect((conflict as TelegramProviderError).status).toBe(409);
    expect(conflict.message).toContain('Conflict');
  });

  it('falls back to the raw body when it is not Telegram’s JSON envelope', async () => {
    const error = await classifyTelegramResponse(response(502, '<html>bad gateway</html>'), 'x');
    expect(error.message).toContain('bad gateway');
  });
});

describe('isRetryableTelegramError', () => {
  it('retries timeouts and rate limits', () => {
    expect(isRetryableTelegramError(new TelegramTimeoutError('t'))).toBe(true);
    expect(isRetryableTelegramError(new TelegramRateLimitError('r', 1))).toBe(true);
  });

  it('retries 5xx provider errors only', () => {
    expect(isRetryableTelegramError(new TelegramProviderError('p', 503))).toBe(true);
    expect(isRetryableTelegramError(new TelegramProviderError('p', 401))).toBe(false);
    // 409 = another process holds the bot token; a tight retry only fights it.
    expect(isRetryableTelegramError(new TelegramProviderError('p', 409))).toBe(false);
    expect(isRetryableTelegramError(new TelegramProviderError('p'))).toBe(false);
  });

  it('never retries an unrelated error', () => {
    expect(isRetryableTelegramError(new Error('boom'))).toBe(false);
    expect(isRetryableTelegramError(undefined)).toBe(false);
  });

  it('retries a bare network failure (#1108)', () => {
    expect(isRetryableTelegramError(new TelegramNetworkError('n'))).toBe(true);
  });
});

describe('classifyTelegramThrown', () => {
  it('maps fetchWithTimeout’s TimeoutError DOMException to a timeout error', () => {
    const error = classifyTelegramThrown(
      new DOMException('The operation timed out.', 'TimeoutError'),
      'getUpdates',
    );
    expect(error).toBeInstanceOf(TelegramTimeoutError);
  });

  it('maps a caller-initiated abort to a non-retryable provider error, not a timeout', () => {
    const error = classifyTelegramThrown(new DOMException('Aborted.', 'AbortError'), 'getUpdates');
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  it('maps a bare network failure to a retryable network error, not a provider error (#1108)', () => {
    const error = classifyTelegramThrown(new TypeError('fetch failed'), 'sendMessage');
    expect(error).toBeInstanceOf(TelegramNetworkError);
    expect(error).not.toBeInstanceOf(TelegramProviderError);
    expect(isRetryableTelegramError(error)).toBe(true);
  });

  it('maps a circular-JSON TypeError to a non-retryable provider error, not a network error (finding 3)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let thrown: unknown;
    try {
      JSON.stringify(circular);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);

    const error = classifyTelegramThrown(thrown, 'sendMessage');
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  it('maps a bad-baseUrl TypeError to a non-retryable provider error, not a network error (finding 3)', () => {
    let thrown: unknown;
    try {
      new URL('not a valid url');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);

    const error = classifyTelegramThrown(thrown, 'sendMessage');
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  it('maps a RangeError to a non-retryable provider error, not a network error (finding 3)', () => {
    const error = classifyTelegramThrown(new RangeError('Invalid string length'), 'sendMessage');
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  it('passes an already-classified error through untouched', () => {
    const original = new TelegramRateLimitError('r', 5);
    expect(classifyTelegramThrown(original, 'sendMessage')).toBe(original);
  });
});
