import { describe, expect, it } from 'vitest';
import { jsonOrTextResult } from './json-or-text.js';

describe('jsonOrTextResult', () => {
  it('parses a JSON body', async () => {
    expect(await jsonOrTextResult(new Response('{"a":1}', { status: 200 }))).toEqual({
      status: 200,
      body: { a: 1 },
    });
  });

  it('keeps a non-JSON body as text', async () => {
    expect(await jsonOrTextResult(new Response('Bad Gateway', { status: 502 }))).toEqual({
      status: 502,
      body: 'Bad Gateway',
    });
  });
});
