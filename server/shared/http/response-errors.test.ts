import { parseRetryAfterMs, truncateForError } from './response-errors.js';

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
});
