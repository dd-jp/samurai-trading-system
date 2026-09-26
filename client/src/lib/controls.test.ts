import { CONTROL_REASON_MAX_CHARS, V2_CONTRACT_VERSION } from '@contracts';
import { describe, expect, it, vi } from 'vitest';
import { controlRequest, sendControl } from './controls.ts';

const PREVIOUS = { action: 'pause', reason: 'news', idempotency_key: 'key-previous' } as const;
const newKey = () => 'key-new';

describe('controlRequest', () => {
  it('trims the reason and refuses an empty one', () => {
    expect(controlRequest('halt', '   ', null, newKey)).toEqual({ error: 'A reason is required.' });
    expect(controlRequest('halt', '  gap  ', null, newKey)).toEqual({
      action: 'halt',
      reason: 'gap',
      idempotency_key: 'key-new',
    });
  });

  it('accepts a reason at the cap and refuses one past it', () => {
    const atCap = 'r'.repeat(CONTROL_REASON_MAX_CHARS);
    expect(controlRequest('pause', atCap, null, newKey)).toMatchObject({ reason: atCap });
    expect(controlRequest('pause', `${atCap}r`, null, newKey)).toEqual({
      error: `The reason is longer than ${CONTROL_REASON_MAX_CHARS} characters.`,
    });
  });

  it('reuses the key only when both action and reason repeat', () => {
    expect(controlRequest('pause', ' news ', PREVIOUS, newKey)).toMatchObject({
      idempotency_key: 'key-previous',
    });
    expect(controlRequest('halt', 'news', PREVIOUS, newKey)).toMatchObject({
      idempotency_key: 'key-new',
    });
    expect(controlRequest('pause', 'other', PREVIOUS, newKey)).toMatchObject({
      idempotency_key: 'key-new',
    });
  });
});

describe('sendControl', () => {
  const request = { action: 'pause', reason: 'news', idempotency_key: 'key-00000001' } as const;

  function answering(response: Response): typeof fetch {
    return vi.fn(async () => response);
  }

  it('reads the server error, falling back to the status', async () => {
    const withError = new Response(JSON.stringify({ error: 'key reused' }), { status: 409 });
    expect(await sendControl(request, 't', answering(withError))).toEqual({
      kind: 'refused',
      error: 'key reused',
    });
    const withoutError = new Response(JSON.stringify({ error: 7 }), { status: 400 });
    expect(await sendControl(request, 't', answering(withoutError))).toEqual({
      kind: 'refused',
      error: 'HTTP 400',
    });
    const notJson = new Response('<html>', { status: 502 });
    expect(await sendControl(request, 't', answering(notJson))).toEqual({
      kind: 'refused',
      error: 'HTTP 502',
    });
  });

  it.each([
    ['7', 7],
    ['soon', 10],
    [null, 10],
  ])('reads Retry-After %s as %s seconds', async (header, seconds) => {
    const headers: Record<string, string> = header === null ? {} : { 'Retry-After': header };
    const tooSoon = new Response('{}', { status: 429, headers });
    expect(await sendControl(request, 't', answering(tooSoon))).toEqual({
      kind: 'too-soon',
      retryAfterSeconds: seconds,
    });
  });

  it('refuses to report a control recorded under another contract', async () => {
    const other = new Response(
      JSON.stringify({ contract_version: 'v0', control: {}, replayed: false }),
    );
    expect(await sendControl(request, 't', answering(other))).toEqual({
      kind: 'failed',
      error: 'the server runs a different contract version',
    });
  });

  it('posts the request as JSON with the token', async () => {
    const recorded = new Response(
      JSON.stringify({ contract_version: V2_CONTRACT_VERSION, control: { id: 1 }, replayed: true }),
    );
    const fetchImpl = answering(recorded);
    expect(await sendControl(request, 't', fetchImpl)).toEqual({
      kind: 'recorded',
      control: { id: 1 },
      replayed: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v2/controls', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  });
});
