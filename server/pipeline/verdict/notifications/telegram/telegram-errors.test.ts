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

  it('does not retry a status above the valid HTTP range (#1172)', () => {
    // 599 is the top of the valid 5xx range; 600 cannot be a real HTTP status —
    // a hostile/broken upstream, not a transient server error to retry against.
    expect(isRetryableTelegramError(new TelegramProviderError('p', 599))).toBe(true);
    expect(isRetryableTelegramError(new TelegramProviderError('p', 600))).toBe(false);
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
    // Shaped like real Node fetch()/undici: the exact message `fetch failed`
    // with the DNS/connection/refusal detail on `.cause` — confirmed against
    // Node v26.5.0's built-in fetch for ECONNREFUSED, ENOTFOUND, an unknown
    // scheme, and a rejected privileged port; every one throws this way.
    const error = classifyTelegramThrown(
      new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') }),
      'sendMessage',
    );
    expect(error).toBeInstanceOf(TelegramNetworkError);
    expect(error).not.toBeInstanceOf(TelegramProviderError);
    expect(isRetryableTelegramError(error)).toBe(true);
  });

  // #1132: undici's error text carries no stability contract, so the
  // classifier must not depend on the exact wording — only on `fetch()`'s
  // structural signature for a request that never reached a server: a
  // `TypeError` whose `.cause` is a plain `Error` (the transport detail),
  // not a `TypeError` itself (see the next test for why that second clause
  // matters). A differently-worded message with that shape must still
  // retry, or a future runtime wording change silently reproduces #1108.
  it('classifies a differently-worded network TypeError by its cause shape, not exact message text (#1132)', () => {
    const error = classifyTelegramThrown(
      new TypeError('network request failed', { cause: new Error('ECONNRESET') }),
      'sendMessage',
    );
    expect(error).toBeInstanceOf(TelegramNetworkError);
    expect(error).not.toBeInstanceOf(TelegramProviderError);
    expect(isRetryableTelegramError(error)).toBe(true);
  });

  it('does not treat a network-shaped message with no cause as the bare network signal', () => {
    const error = classifyTelegramThrown(new TypeError('fetch failed'), 'sendMessage');
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  // Pins the discriminator's `instanceof TypeError` clause: only `fetch()`
  // itself throws the network `TypeError`, so a differently-typed `Error`
  // that merely happens to carry a `.cause` (an `Error`, not a `TypeError`)
  // must not be treated as the network signal.
  it('does not treat a non-TypeError Error with a cause as the bare network signal', () => {
    const error = classifyTelegramThrown(
      new Error('some other failure', { cause: new Error('detail') }),
      'sendMessage',
    );
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  // Pins the discriminator's `cause instanceof Error` clause as distinct
  // from a looser `cause !== undefined` check: in every network-failure
  // shape probed (ECONNREFUSED, ECONNRESET, ENOTFOUND, an unknown scheme,
  // a rejected privileged port — see the probe note above), `.cause` was
  // an `Error` carrying the OS/DNS detail, never a bare string or other
  // value. A `.cause` of some other shape is not a signal this classifier
  // has been shown to see, so it should not widen what's retried.
  it('does not treat a TypeError with a non-Error cause as the bare network signal', () => {
    const error = classifyTelegramThrown(
      new TypeError('fetch failed', { cause: 'not an Error instance' }),
      'sendMessage',
    );
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
  });

  // A misconfigured `baseUrl` never reaches this classifier via a bare
  // `new URL()` call — `#request` interpolates `#baseUrl` into a string and
  // hands it straight to `fetch()`, which parses the URL itself. This suite
  // fences `globalThis.fetch` against the network (vitest.setup.ts), so the
  // shape below is not exercised live here; it is transcribed from a
  // standalone `node` probe run outside the suite against Node v26.5.0 (this
  // project's floor is Node >=24, so only that one version was checked):
  // `fetch('not a valid url')` throws `TypeError: Failed to parse URL from …`
  // whose `.cause` is itself `TypeError: Invalid URL` — the WHATWG URL spec
  // mandates a `TypeError` on parse failure, a documented, engine-independent
  // contract, unlike undici's own error prose. A cause-presence-only check
  // would misclassify this as the retryable network case, since it does
  // carry a `.cause`; excluding a `TypeError`-shaped cause is what keeps a
  // config fault like this one non-retryable.
  it('maps a real malformed-baseUrl failure shape (TypeError caused by a TypeError) to a non-retryable provider error', () => {
    const error = classifyTelegramThrown(
      new TypeError('Failed to parse URL from not a valid url/botXXXX/sendMessage', {
        cause: new TypeError('Invalid URL'),
      }),
      'sendMessage',
    );
    expect(error).toBeInstanceOf(TelegramProviderError);
    expect(error).not.toBeInstanceOf(TelegramNetworkError);
    expect(isRetryableTelegramError(error)).toBe(false);
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
