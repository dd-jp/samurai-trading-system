import {
  isServerErrorStatus,
  parseRetryAfterMs,
  readErrorBody,
  truncateForError,
} from './response-errors.js';

describe('isServerErrorStatus', () => {
  it('is true across the whole 500-599 range', () => {
    expect(isServerErrorStatus(500)).toBe(true);
    expect(isServerErrorStatus(503)).toBe(true);
    expect(isServerErrorStatus(599)).toBe(true);
  });

  it('is false at the boundary above 599 (#1172) — not a valid HTTP status', () => {
    expect(isServerErrorStatus(600)).toBe(false);
  });

  it('is false below 500 and for undefined', () => {
    expect(isServerErrorStatus(499)).toBe(false);
    expect(isServerErrorStatus(404)).toBe(false);
    expect(isServerErrorStatus(undefined)).toBe(false);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses a numeric Retry-After header (seconds) into milliseconds', () => {
    const response = new Response(null, { headers: { 'retry-after': '2' } });
    expect(parseRetryAfterMs(response)).toBe(2000);
  });

  it('returns undefined when no Retry-After header is present', () => {
    const response = new Response(null);
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });

  it('returns undefined for a non-numeric Retry-After header', () => {
    const response = new Response(null, { headers: { 'retry-after': 'not-a-number' } });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });

  it('returns undefined for an empty Retry-After header (Number("") is 0, must not be trusted)', () => {
    const response = new Response(null, { headers: { 'retry-after': '' } });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });

  it('returns undefined for a whitespace-only Retry-After header', () => {
    const response = new Response(null, { headers: { 'retry-after': '   ' } });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });

  it('returns undefined for a negative Retry-After value', () => {
    const response = new Response(null, { headers: { 'retry-after': '-1' } });
    expect(parseRetryAfterMs(response)).toBeUndefined();
  });
});

describe('truncateForError', () => {
  it('leaves a short string unchanged', () => {
    expect(truncateForError('short body')).toBe('short body');
  });

  it('truncates an oversized string and notes the original length', () => {
    const oversized = 'x'.repeat(1000);
    const result = truncateForError(oversized);
    expect(result).toContain('truncated, 1000 chars total');
    expect(result.length).toBeLessThan(1000);
  });

  it('backs off the cut rather than splitting a surrogate pair (finding 8)', () => {
    // 500 'x' chars puts an emoji's high surrogate exactly at index 499 — the
    // cut point — so an unguarded slice would keep the high surrogate and
    // drop its low surrogate, leaving a lone (invalid) surrogate on disk.
    const oversized = `${'x'.repeat(499)}😀${'y'.repeat(10)}`;
    const result = truncateForError(oversized);
    const kept = result.slice(0, result.indexOf('…'));
    expect(kept).toBe('x'.repeat(499));
  });
});

describe('readErrorBody (#953)', () => {
  it('extracts a numeric code and the truncated detail from an Alpaca-shaped JSON body', async () => {
    const body = JSON.stringify({
      code: 42210000,
      message: 'fractional orders must be simple orders',
    });
    const response = new Response(body, { status: 422, statusText: 'Unprocessable Entity' });
    expect(await readErrorBody(response)).toEqual({
      detail: body,
      code: '42210000',
      message: 'fractional orders must be simple orders',
    });
  });

  it('degrades a string code to undefined — never lets venue-controlled text into the structured code field', async () => {
    const body = JSON.stringify({ code: 'forbidden', message: 'nope' });
    const response = new Response(body, { status: 403, statusText: 'Forbidden' });
    expect((await readErrorBody(response)).code).toBeUndefined();
  });

  it('returns undefined code for JSON with no code key, detail unaffected', async () => {
    const body = JSON.stringify({ message: 'bad request' });
    const response = new Response(body, { status: 400, statusText: 'Bad Request' });
    expect(await readErrorBody(response)).toEqual({
      detail: body,
      code: undefined,
      message: 'bad request',
    });
  });

  it('returns undefined code for a non-JSON body (e.g. an HTML error page), detail still the truncated text', async () => {
    const body = '<html>502 Bad Gateway</html>';
    const response = new Response(body, { status: 502, statusText: 'Bad Gateway' });
    expect(await readErrorBody(response)).toEqual({
      detail: body,
      code: undefined,
      message: undefined,
    });
  });

  it('degrades to statusText with an undefined code when the body cannot be read at all', async () => {
    const response = {
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.reject(new Error('stream already consumed')),
    } as unknown as Response;
    expect(await readErrorBody(response)).toEqual({
      detail: 'Internal Server Error',
      code: undefined,
      message: undefined,
    });
  });
});

describe('readErrorBody message field (#1003)', () => {
  it('extracts the venue message string, independent of whether a code is present', async () => {
    const body = JSON.stringify({
      code: 42210000,
      message:
        'invalid take_profit.limit_price 746.96416125. sub-penny increment does not fulfill ' +
        'minimum pricing criteria',
    });
    const response = new Response(body, { status: 422, statusText: 'Unprocessable Entity' });
    expect((await readErrorBody(response)).message).toBe(
      'invalid take_profit.limit_price 746.96416125. sub-penny increment does not fulfill ' +
        'minimum pricing criteria',
    );
  });

  it('returns undefined message for JSON with no message key', async () => {
    const body = JSON.stringify({ code: 42210000 });
    const response = new Response(body, { status: 422, statusText: 'Unprocessable Entity' });
    expect((await readErrorBody(response)).message).toBeUndefined();
  });

  it('degrades a non-string message to undefined — never lets an object/array into the structured message field', async () => {
    const body = JSON.stringify({ message: { nested: 'not a string' } });
    const response = new Response(body, { status: 400, statusText: 'Bad Request' });
    expect((await readErrorBody(response)).message).toBeUndefined();
  });

  it('rejects an empty message string the same way an empty code is rejected', async () => {
    const body = JSON.stringify({ message: '' });
    const response = new Response(body, { status: 400, statusText: 'Bad Request' });
    expect((await readErrorBody(response)).message).toBeUndefined();
  });

  it('truncates an oversized message the same way an oversized detail is truncated', async () => {
    const oversized = 'x'.repeat(1000);
    const body = JSON.stringify({ message: oversized });
    const response = new Response(body, { status: 400, statusText: 'Bad Request' });
    const message = (await readErrorBody(response)).message;
    expect(message).toContain('truncated, 1000 chars total');
    expect(message?.length).toBeLessThan(1000);
  });
});
