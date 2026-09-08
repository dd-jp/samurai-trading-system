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
  // `survives`: a substring the mask must leave untouched, distinct from
  // `secret` — proves each pattern replaces only the credential, not the
  // whole line, and (via a sibling field on the camelCase rows) that only the
  // intended key's value is consumed, not a neighbour's.
  const positive: ReadonlyArray<{ name: string; input: string; secret: string; survives: string }> =
    [
      {
        name: 'camelCase nested key: clientSecret',
        input: '{"credentials":{"clientSecret":"sk-live-abcdef123456"}}',
        secret: 'sk-live-abcdef123456',
        survives: '"credentials"',
      },
      {
        name: 'camelCase key: accessToken',
        input: '{"tokenType":"Bearer","accessToken":"ya29.a0AfH6SMB-verysecret"}',
        secret: 'ya29.a0AfH6SMB-verysecret',
        survives: '"tokenType":"Bearer"',
      },
      {
        name: 'camelCase key: refreshToken',
        input: '{"grantType":"refresh","refreshToken":"rt_9f8e7d6c5b4a"}',
        secret: 'rt_9f8e7d6c5b4a',
        survives: '"grantType":"refresh"',
      },
      {
        name: 'underscore-joined env-var key: APCA_API_SECRET_KEY',
        input: '{"region":"us-east-1","APCA_API_SECRET_KEY":"zzzz"}',
        secret: 'zzzz',
        survives: '"region":"us-east-1"',
      },
      {
        name: 'Authorization: Basic',
        input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        secret: 'dXNlcjpwYXNzd29yZA==',
        survives: 'Authorization: ',
      },
      {
        name: 'DSN password',
        input: 'postgres://user:supersecretpw@db.internal:5432/samurai',
        secret: 'supersecretpw',
        // The scheme, username, host, port and database — what an operator
        // needs to tell which connection failed — must all survive.
        survives: 'postgres://user:',
      },
    ];

  it.each(positive)('masks the secret in: $name', ({ input, secret, survives }) => {
    expect(maskCredentials(input)).not.toContain(secret);
    expect(maskCredentials(input)).toContain('[REDACTED]');
    expect(maskCredentials(input)).toContain(survives);
  });

  it('the DSN pattern replaces only the password segment', () => {
    // Look-around, not a whole-match replace like the other patterns, so
    // this is exact-equality, not just "the substring survives".
    expect(maskCredentials('postgres://user:supersecretpw@db.internal:5432/samurai')).toBe(
      'postgres://user:[REDACTED]@db.internal:5432/samurai',
    );
  });

  it('existing bareword keys still mask, independently, with no regression', () => {
    // Two separate matches in one string, not one match spanning both —
    // proves the `/g` flag and the loop over patterns don't merge them.
    const out = maskCredentials('{"token":"plainmatch123"} / {"password":"hunter2"}');
    expect(out).not.toContain('plainmatch123');
    expect(out).not.toContain('hunter2');
    expect(out).toBe('{"[REDACTED]"} / {"[REDACTED]"}');
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
      // `anthropic-client.ts` uses only the snake_case `max_tokens` field
      // above; the camelCase form is a distinct provider's client — grepped,
      // not assumed, after an earlier draft of this row named the wrong file.
      name: 'LLM request budget: maxTokens',
      input: '{"maxTokens":1024}',
      where: 'providers/market-intelligence/grok/x-search-client.ts',
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
      // Not a real logged field — grepped repo-wide and found none; the
      // only hit for "keyword" anywhere in server/ is this file's own prose
      // ("broader keyword sweep", line 157), not a JSON key. Kept anyway
      // because #1367's own brief named "keyword" as an example substring
      // risk (the bareword pattern's `api[_-]?key` alternative sits inside
      // it) — this pins that no pattern here is a bare `key` match.
      name: 'the substring "key" inside ordinary English: "keyword"',
      input: '{"keyword":"leveraged etf"}',
      where: 'providers/universe-pool/lse-etp-pool.ts:157 (comment prose only)',
    },
    {
      // The bareword pattern's trailing `\b` requires the credential word to
      // be the LAST segment (`api[_-]?key\b`); `_id` after it breaks that
      // boundary, so this stays unmasked here. Deliberately asymmetric with
      // `redact-payload.ts`'s `redactPayload`: its `CREDENTIAL_KEYS` set
      // includes `apikeyid` and redacts a same-named object KEY wholesale,
      // structurally — the two mechanisms cover different failure modes (see
      // that module's doc comment) and are not expected to agree here.
      name: 'api_key_id (structural redaction covers this, text masking does not)',
      input: '{"api_key_id":"xyz-not-really-secret"}',
      where: 'not found as a real field anywhere in server/ — synthetic, from the #1367 brief',
    },
    {
      // A real credential, and NOT caught: `alpacaSecretKey` has no
      // `client`/`access`/`refresh` prefix and no underscore before
      // `SECRET_KEY`, so none of the four new patterns reach it — same
      // camelCase-boundary gap the issue reported, one layer further out.
      // Accepted scope boundary (named compounds, not a suffix rule) rather
      // than a miss: `free-stack-aggregates-client.ts` never logs this
      // option object, and any caller that does log a payload containing it
      // goes through `redactPayload`, whose structural `CREDENTIAL_KEYS`
      // check has no camelCase-boundary problem to begin with.
      name: 'residual gap: alpacaSecretKey (vendor-prefixed, no named-compound match)',
      input: '{"alpacaSecretKey":"would-be-a-real-secret"}',
      where: 'tools/backtest/free-stack-aggregates-client.ts, tools/stage2-source.ts',
    },
    {
      name: 'residual gap: polygonApiKey (vendor-prefixed, no named-compound match)',
      input: '{"polygonApiKey":"would-be-a-real-secret"}',
      where: 'apps/service-api/provider-status.ts',
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
