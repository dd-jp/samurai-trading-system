/**
 * The dedicated test this module never had (#1035).
 *
 * Until the `maskCredentials` split there was no `sanitize-log-text.test.ts`
 * at all: the only coverage was indirect, through `safe-log.test.ts` and
 * through the pass-through case pinned at
 * `orchestrator/production/analysts-adapter.test.ts` ("computeIndicator:
 * sma(14) …"). That case staying green UNCHANGED is the regression guard for
 * the split — it asserts, from a caller, that a real failure reason still
 * reaches the log verbatim. What is added here is the property the split
 * introduced and nothing else covers: masking and capping are now separable,
 * and each half does exactly its own job.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ERROR_BODY_CHARS } from './http/response-errors.js';
import { maskAndCap, maskCredentials, sanitizeLogText } from './sanitize-log-text.js';

describe('maskCredentials', () => {
  it('masks a Telegram bot token in a URL path', () => {
    const line = 'POST https://api.telegram.org/bot123456:AAEEbbCC-dd_ff/sendMessage';
    expect(maskCredentials(line)).toContain('[REDACTED]');
    expect(maskCredentials(line)).not.toContain('AAEEbbCC');
  });

  it('masks a Bearer token and the Alpaca header names', () => {
    expect(maskCredentials('Authorization: Bearer sk-ant-abc123')).not.toContain('sk-ant-abc123');
    expect(maskCredentials('APCA-API-SECRET-KEY: shhh-not-in-the-log')).not.toContain(
      'shhh-not-in-the-log',
    );
  });

  it('does NOT truncate, however long the text', () => {
    // The whole reason for the split: `sanitizeLogText`'s 500-char cap would
    // destroy a ~6.8 KB rendered prompt, which is the LLM capture path's input.
    const long = 'a'.repeat(MAX_ERROR_BODY_CHARS * 20);
    expect(maskCredentials(long)).toHaveLength(long.length);
    expect(maskCredentials(long)).not.toContain('truncated');
  });

  it('leaves a real failure reason verbatim', () => {
    // The module's stated non-goal: over-masking would put us back at #358, a
    // failure whose cause says nothing. A bare high-entropy string is not a
    // credential syntax and must survive.
    const reason = 'computeIndicator: sma(14) needs 14 bars but received 13';
    expect(maskCredentials(reason)).toBe(reason);
    expect(maskCredentials('trace 9f2c4ae1b7d340e8 at 2026-09-02T10:15:00Z')).toBe(
      'trace 9f2c4ae1b7d340e8 at 2026-09-02T10:15:00Z',
    );
  });
});

describe('sanitizeLogText', () => {
  it('still caps at MAX_ERROR_BODY_CHARS after the split', () => {
    const long = 'a'.repeat(MAX_ERROR_BODY_CHARS + 100);
    const out = sanitizeLogText(long);
    expect(out).toContain(`(truncated, ${long.length} chars total)`);
    expect(out.length).toBeLessThan(long.length);
  });

  it('masks before it caps, so truncation cannot bisect a token', () => {
    // The token sits past the cap. If capping ran first the tail would be
    // dropped un-masked from a longer body; masking first means the secret is
    // already gone whichever side of the boundary it falls on.
    const text = `${'a'.repeat(MAX_ERROR_BODY_CHARS - 10)}Bearer sk-ant-supersecretvalue`;
    expect(sanitizeLogText(text)).not.toContain('supersecretvalue');
  });
});

describe('maskAndCap', () => {
  it('caps at the caller-chosen bound with the shared suffix', () => {
    const out = maskAndCap('b'.repeat(100), 10);
    expect(out).toBe(`${'b'.repeat(10)}… (truncated, 100 chars total)`);
  });

  it('returns the text untouched when it is under the bound', () => {
    expect(maskAndCap('short prompt', 16_384)).toBe('short prompt');
  });

  it('masks before capping, so a credential past the bound is still gone', () => {
    const out = maskAndCap(`${'c'.repeat(50)} Bearer sk-ant-leaked`, 20);
    expect(out).not.toContain('sk-ant-leaked');
  });
});
