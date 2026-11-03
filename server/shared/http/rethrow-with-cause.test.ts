import { describe, expect, it } from 'vitest';
import { startRedirectingServer } from './redirecting-server.js';
import { rethrowWithCause } from './rethrow-with-cause.js';

function thrownBy(error: unknown): unknown {
  try {
    rethrowWithCause(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('rethrowWithCause returned');
}

describe('rethrowWithCause', () => {
  it('appends the cause message to a TypeError and keeps the cause', () => {
    const cause = new Error('unexpected redirect');
    const thrown = thrownBy(new TypeError('fetch failed', { cause }));
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({ message: 'fetch failed: unexpected redirect', cause });
  });

  it('rethrows a TypeError without an Error cause unchanged', () => {
    const plain = new TypeError('fetch failed', { cause: 'text' });
    expect(thrownBy(plain)).toBe(plain);
  });

  it('rethrows a non-TypeError unchanged', () => {
    const abort = new DOMException('The operation timed out.', 'TimeoutError');
    expect(thrownBy(abort)).toBe(abort);
  });
});

describe('startRedirectingServer', () => {
  it('redirects every request and records each method and path', async () => {
    const server = await startRedirectingServer(307);
    try {
      const response = await fetch(`${server.origin}/a?b=1`, { redirect: 'manual' });
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('/followed/a?b=1');
      expect(server.hits).toEqual(['GET /a?b=1']);
    } finally {
      await server.close();
    }
  });
});
