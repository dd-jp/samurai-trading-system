import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicApiError,
  AnthropicHttpMessagesClient,
  DEFAULT_ANTHROPIC_MODEL,
} from './anthropic-http-client.js';

const FAKE_KEY = 'test-fake-anthropic-key';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

describe('AnthropicHttpMessagesClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('throws if no API key is available', () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicHttpMessagesClient()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('POSTs to the Messages API with the proven request shape and returns the parsed body', async () => {
    const responseBody = { content: [{ type: 'text', text: 'hello' }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });
    const result = await client.createMessage({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result).toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(FAKE_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      model: DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('respects a custom baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ content: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({
      apiKey: FAKE_KEY,
      baseUrl: 'https://example.test',
    });
    await client.createMessage({ model: 'm', max_tokens: 1, messages: [] });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://example.test/v1/messages');
  });

  it('throws a typed AnthropicApiError carrying the HTTP status when the API returns a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'rate limited' }, 429));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });

    await expect(
      client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      client.createMessage({ model: 'm', max_tokens: 1, messages: [] }),
    ).rejects.toBeInstanceOf(AnthropicApiError);
  });

  it('prefers the Anthropic error envelope (type/message) over bare statusText', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { type: 'invalid_request_error', message: 'model not found' } }, 400),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });

    await expect(client.createMessage({ model: 'm', max_tokens: 1, messages: [] })).rejects.toThrow(
      /invalid_request_error: model not found/,
    );
  });

  it('throws rather than returning a body whose "content" is not an array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unexpected: 'shape' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });

    await expect(client.createMessage({ model: 'm', max_tokens: 1, messages: [] })).rejects.toThrow(
      /content/,
    );
  });

  it('truncates an oversized malformed body instead of dumping it verbatim into the error message', async () => {
    const oversized = { unexpected: 'x'.repeat(1000) };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(oversized));
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });

    await expect(client.createMessage({ model: 'm', max_tokens: 1, messages: [] })).rejects.toThrow(
      /truncated/,
    );
  });

  it('wraps a response.json() failure (e.g. truncated body) in a typed AnthropicApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
      // `as unknown as`: this is a deliberate four-field stand-in for `Response`,
      // which the client only reads `ok`/`status`/`statusText`/`json` from. A
      // direct `as Response` is not a legal assertion between types this far
      // apart.
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY });

    const promise = client.createMessage({ model: 'm', max_tokens: 1, messages: [] });
    await expect(promise).rejects.toBeInstanceOf(AnthropicApiError);
    await expect(promise).rejects.toMatchObject({ status: 200 });
    await expect(promise).rejects.toThrow(/could not be parsed as JSON/);
  });

  it('aborts the underlying fetch once the configured timeout elapses', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(capturedSignal?.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY, timeoutMs: 500 });
    const promise = client.createMessage({ model: 'm', max_tokens: 1, messages: [] });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('aborts the underlying fetch when the caller cancels (#347)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(capturedSignal?.reason));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new AnthropicHttpMessagesClient({ apiKey: FAKE_KEY, timeoutMs: 60_000 });
    const controller = new AbortController();
    const promise = client.createMessage(
      { model: 'm', max_tokens: 1, messages: [] },
      { signal: controller.signal },
    );
    // The caller's own reason survives the `AbortSignal.any` composition, which
    // is what lets the layer above tell a deliberate cancel from a timeout.
    const assertion = expect(promise).rejects.toThrow('budget blown');

    controller.abort(new Error('budget blown'));
    await vi.advanceTimersByTimeAsync(0);
    await assertion;

    // Demonstrated at the fetch layer: the request was aborted, not ignored.
    expect(capturedSignal?.aborted).toBe(true);
  });
});
