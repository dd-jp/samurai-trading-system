import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './fetch-with-timeout.js';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves with the response when fetch settles before the deadline', async () => {
    const response = new Response('ok');
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchWithTimeout('https://example.test/resource', {}, 1_000);

    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it('aborts the request once timeoutMs elapses', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchWithTimeout('https://example.test/slow', {}, 500);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the request when the caller-supplied signal aborts, before the timeout', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const callerController = new AbortController();
    const promise = fetchWithTimeout(
      'https://example.test/slow',
      { signal: callerController.signal },
      10_000,
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    callerController.abort();
    await assertion;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('still aborts on timeout when the caller supplies a signal that never fires', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const callerController = new AbortController();
    const promise = fetchWithTimeout(
      'https://example.test/slow',
      { signal: callerController.signal },
      500,
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('passes through caller-supplied init fields alongside the abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithTimeout(
      'https://example.test/resource',
      { method: 'POST', headers: { Authorization: 'Bearer test-token' } },
      1_000,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/resource');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token' });
  });
});
