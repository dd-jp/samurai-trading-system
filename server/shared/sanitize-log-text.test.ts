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

describe('camelCase/underscore keys, Basic auth and DSN passwords (#1367)', () => {
  // Measured against `b0cc1f3` (PR #1359's review) and re-confirmed against
  // this file's `main` before the fix: every row here masked nothing —
  // `\b`-anchored patterns don't see a credential word joined by camelCase
  // or an underscore, and neither `Authorization: Basic` nor a DSN password
  // had a pattern at all.
  const positive: ReadonlyArray<{ name: string; input: string; secret: string }> = [
    {
      name: 'camelCase nested key: clientSecret',
      input: '{"credentials":{"clientSecret":"sk-live-abcdef123456"}}',
      secret: 'sk-live-abcdef123456',
    },
    {
      name: 'camelCase key: accessToken',
      input: '{"accessToken":"ya29.a0AfH6SMB-verysecret"}',
      secret: 'ya29.a0AfH6SMB-verysecret',
    },
    {
      name: 'camelCase key: refreshToken',
      input: '{"refreshToken":"rt_9f8e7d6c5b4a"}',
      secret: 'rt_9f8e7d6c5b4a',
    },
    {
      name: 'underscore-joined env-var key: APCA_API_SECRET_KEY',
      input: '{"APCA_API_SECRET_KEY":"zzzz"}',
      secret: 'zzzz',
    },
    {
      name: 'Authorization: Basic',
      input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      secret: 'dXNlcjpwYXNzd29yZA==',
    },
    {
      name: 'DSN password',
      input: 'postgres://user:supersecretpw@db.internal:5432/samurai',
      secret: 'supersecretpw',
    },
    {
      name: 'existing bareword keys still mask (no regression)',
      input: '{"token":"plainmatch123"} / {"password":"hunter2"}',
      secret: 'plainmatch123',
    },
  ];

  it.each(positive)('masks the secret in: $name', ({ input, secret }) => {
    expect(maskCredentials(input)).not.toContain(secret);
    expect(maskCredentials(input)).toContain('[REDACTED]');
  });

  it('leaves the non-secret context readable around each new pattern', () => {
    expect(maskCredentials('{"credentials":{"clientSecret":"sk-live-abcdef123456"}}')).toContain(
      '"credentials"',
    );
    expect(maskCredentials('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toContain(
      'Authorization: ',
    );
    // The DSN pattern masks only the password segment (look-around, not a
    // whole-match replace like the other patterns), so the scheme, username,
    // host, port and database — what an operator needs to tell which
    // connection failed — all survive.
    expect(maskCredentials('postgres://user:supersecretpw@db.internal:5432/samurai')).toBe(
      'postgres://user:[REDACTED]@db.internal:5432/samurai',
    );
  });

  // Every name below is a real, non-secret field this codebase logs today.
  // A suffix rule (mask anything ending in `Token`/`Key`/`Secret`) would
  // have caught all of them; the patterns above are named compounds
  // specifically so it doesn't.
  const negative: ReadonlyArray<{ name: string; input: string; where: string }> = [
    {
      name: 'pagination cursor: next_page_token',
      input: '{"next_page_token":"abc123continuation"}',
      where: 'market-data-service/sources/alpaca-http-client.ts',
    },
    {
      name: 'pagination cursor: pageToken',
      input: '{"pageToken":"abc123continuation"}',
      where: 'tools/backtest/free-stack-aggregates-client.ts',
    },
    {
      name: 'LLM request budget: max_tokens',
      input: '{"max_tokens":1024}',
      where: 'orchestrator/production/defaults.ts',
    },
    {
      name: 'LLM request budget: maxTokens',
      input: '{"maxTokens":1024}',
      where: 'debate-engine/llm/anthropic-client.ts',
    },
    {
      name: 'order idempotency key (not a credential, an id)',
      input: '{"idempotencyKey":"debate-42"}',
      where: 'pipeline/verdict/index.ts',
    },
    {
      name: "Saxo's opaque per-account resource id, not a credential",
      input: "{ AccountKey: accountKey, side: 'buy' }",
      where: 'pipeline/execution/adapters/saxo-http-client.ts',
    },
    {
      name: '"Basic" as ordinary English, no Authorization: prefix',
      input: "Alpaca's Basic (free) subscription allows 200 req/min",
      where: 'tools/backtest/free-stack-aggregates-client.ts',
    },
    {
      name: 'a domain field named "keyword", not a credential',
      input: '{"keyword":"leveraged etf"}',
      where: 'providers/universe-pool/lse-etp-pool.ts',
    },
  ];

  it.each(negative)('does NOT mask: $name', ({ input }) => {
    expect(maskCredentials(input)).toBe(input);
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
