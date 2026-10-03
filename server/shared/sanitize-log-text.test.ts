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
    const long = 'a'.repeat(MAX_ERROR_BODY_CHARS * 20);
    expect(maskCredentials(long)).toHaveLength(long.length);
    expect(maskCredentials(long)).not.toContain('truncated');
  });

  it('leaves a real failure reason verbatim', () => {
    const reason = 'computeIndicator: sma(14) needs 14 bars but received 13';
    expect(maskCredentials(reason)).toBe(reason);
    expect(maskCredentials('trace 9f2c4ae1b7d340e8 at 2026-09-02T10:15:00Z')).toBe(
      'trace 9f2c4ae1b7d340e8 at 2026-09-02T10:15:00Z',
    );
  });
});

describe('camelCase/underscore keys, Basic/Token auth and DSN passwords (#1367)', () => {
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
        name: 'real env-var key: ALPACA_API_SECRET (_SECRET suffix)',
        input: '{"region":"eu-west-2","ALPACA_API_SECRET":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"region":"eu-west-2"',
      },
      {
        name: 'real env-var key: SAXO_SIM_ACCESS_TOKEN (_TOKEN suffix)',
        input: '{"venue":"saxo","SAXO_SIM_ACCESS_TOKEN":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"venue":"saxo"',
      },
      {
        name: 'synthetic env-var key: DB_PASSWORD (_PASSWORD suffix)',
        input: '{"engine":"postgres","DB_PASSWORD":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"engine":"postgres"',
      },
      {
        name: 'synthetic env-var key: APP_PASSWD (_PASSWD suffix)',
        input: '{"service":"redis","APP_PASSWD":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"service":"redis"',
      },
      {
        name: 'lowercase env-var-shaped key: polygon_api_key (_api_key suffix)',
        input: 'GET failed: polygon_api_key=skFAKE0000',
        secret: 'skFAKE0000',
        survives: 'GET failed: ',
      },
      {
        name: 'lowercase env-var-shaped key: alpaca_api_secret_key (_secret_key suffix)',
        input: 'alpaca_api_secret_key=skFAKE0000 rejected',
        secret: 'skFAKE0000',
        survives: ' rejected',
      },
      {
        name: 'lowercase env-var-shaped key: apca_api_secret_key (_secret_key suffix)',
        input: 'apca_api_secret_key=skFAKE0000 rejected',
        secret: 'skFAKE0000',
        survives: ' rejected',
      },
      {
        name: 'lowercase env-var-shaped key: alpaca_api_secret (_api_secret suffix)',
        input: 'alpaca_api_secret=skFAKE0000 rejected',
        secret: 'skFAKE0000',
        survives: ' rejected',
      },
      {
        name: 'lowercase env-var-shaped key: api_secret_key, JSON-quoted',
        input: '{"provider":"generic","api_secret_key":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"provider":"generic"',
      },
      {
        name: 'F8 (#358): apiKey in a URL query string keeps its trailing params',
        input:
          'GET https://api.polygon.io/v2/aggs?apiKey=skFAKE0000&adjusted=true&limit=5000 failed 429',
        secret: 'skFAKE0000',
        survives: '&adjusted=true&limit=5000 failed 429',
      },
      {
        name: 'underscore-prefixed compound: oauth_clientSecret',
        input: '{"scope":"oauth","oauth_clientSecret":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"scope":"oauth"',
      },
      {
        name: 'Authorization: Basic',
        input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
        secret: 'dXNlcjpwYXNzd29yZA==',
        survives: 'Authorization: ',
      },
      {
        name: 'Authorization: Basic, JSON-quoted',
        input: '{"Authorization":"Basic ZkFLRTAwMDA="}',
        secret: 'ZkFLRTAwMDA=',
        survives: '"Authorization"',
      },
      {
        name: 'Authorization: Basic, single-quoted object literal',
        input: "headers: { Authorization: 'Basic ZkFLRTAwMDA=' }",
        secret: 'ZkFLRTAwMDA=',
        survives: 'headers: { Authorization: ',
      },
      {
        name: 'Authorization: Token (Tiingo)',
        input: 'Authorization: Token skFAKE0000tiingo',
        secret: 'skFAKE0000tiingo',
        survives: 'Authorization: ',
      },
      {
        name: 'DSN password',
        input: 'postgres://user:supersecretpw@db.internal:5432/samurai',
        secret: 'supersecretpw',
        survives: 'postgres://user:',
      },
      {
        name: 'DSN password, no username',
        input: 'redis://:skFAKE0000@host:6379',
        secret: 'skFAKE0000',
        survives: 'redis://:',
      },
      {
        name: 'F1 (#1367 round 4): access_token in a query string keeps its trailing params',
        input: 'access_token=skFAKE0000&adjusted=true',
        secret: 'skFAKE0000',
        survives: '&adjusted=true',
      },
      {
        name: 'F1 (#1367 round 4): ALPACA_API_SECRET in a query string keeps its trailing params',
        input: 'ALPACA_API_SECRET=skFAKE0000&adjusted=true',
        secret: 'skFAKE0000',
        survives: '&adjusted=true',
      },
      {
        name: 'F1 (#1367 round 4): polygon_api_key in a query string keeps its trailing params',
        input: 'polygon_api_key=skFAKE0000&adjusted=true',
        secret: 'skFAKE0000',
        survives: '&adjusted=true',
      },
      {
        name: 'F1 (#1367 round 4): Authorization Basic in a query string keeps its trailing params',
        input: 'Authorization: Basic ZkFLRTAwMDA=&adjusted=true',
        secret: 'ZkFLRTAwMDA=',
        survives: '&adjusted=true',
      },
    ];

  it.each(positive)('masks the secret in: $name', ({ input, secret, survives }) => {
    expect(maskCredentials(input)).not.toContain(secret);
    expect(maskCredentials(input)).toContain('[REDACTED]');
    expect(maskCredentials(input)).toContain(survives);
  });

  it('the DSN pattern replaces only the password segment', () => {
    expect(maskCredentials('postgres://user:supersecretpw@db.internal:5432/samurai')).toBe(
      'postgres://user:[REDACTED]@db.internal:5432/samurai',
    );
  });

  it('the DSN pattern does not over-match through a quote into a sibling JSON field (#358)', () => {
    const out = maskCredentials('{"dsn":"redis://h:6379","email":"a@b.com"}');
    expect(out).toBe('{"dsn":"redis://h:6379","email":"a@b.com"}');
  });

  it('the env-var pattern is case-sensitive, so a lowercase pagination cursor is not a false positive', () => {
    expect(maskCredentials('next_page_token=abc123continuation')).toBe(
      'next_page_token=abc123continuation',
    );
  });

  it('newline after the key does not swallow the following line as the value (#1367 round 2, F7)', () => {
    expect(maskCredentials('token:\nStack trace at foo()')).toBe('token:\nStack trace at foo()');
    expect(maskCredentials('accessToken:\n    at Client.request (/app/x.ts:1:1)')).toBe(
      'accessToken:\n    at Client.request (/app/x.ts:1:1)',
    );
  });

  it('existing bareword keys still mask, independently, with no regression', () => {
    const out = maskCredentials('{"token":"plainmatch123"} / {"password":"hunter2"}');
    expect(out).not.toContain('plainmatch123');
    expect(out).not.toContain('hunter2');
    expect(out).toBe('{"[REDACTED]"} / {"[REDACTED]"}');
  });

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
      where: 'apps/v2/execution/saxo/saxo-http-client.ts',
    },
    {
      name: '"Basic" as ordinary English, no Authorization: prefix',
      input: "Alpaca's Basic (free) subscription allows 200 req/min",
      where: 'tools/backtest/free-stack-aggregates-client.ts',
    },
    {
      name: 'residual gap: lowercase _token-suffixed name (saxo_session_token)',
      input: 'saxo_session_token=skFAKE0000',
      where:
        "not found as a real lowercase field in server/ — the residual gap this row pins is deliberate, see this row's comment",
    },
    {
      name: 'residual gap: mixed-case _token-suffixed name (Saxo_Session_Token)',
      input: 'Saxo_Session_Token=skFAKE0000',
      where:
        'same residual gap as the row above — neither the all-caps branch (mixed case) nor the lowercase branch (bare _token) reaches it',
    },
    {
      name: 'residual gap: SSH_PRIVATE_KEY (no bare _KEY suffix)',
      input: 'SSH_PRIVATE_KEY=skFAKE0000',
      where: 'not a real env name in server/ — synthetic, pins the suffix list stayed narrow',
    },
    {
      name: 'residual gap: SAXO_APP_KEY (no bare _KEY suffix)',
      input: 'SAXO_APP_KEY=skFAKE0000',
      where: 'not a real env name in server/ — synthetic, pins the suffix list stayed narrow',
    },
    {
      name: 'residual gap: A_CREDENTIALS (no _CREDENTIALS suffix)',
      input: 'A_CREDENTIALS=skFAKE0000',
      where: 'not a real env name in server/ — synthetic, pins the suffix list stayed narrow',
    },
    {
      name: 'the substring "key" inside ordinary English: "keyword"',
      input: '{"keyword":"leveraged etf"}',
      where: "not a real field — see this row's comment for the actual grep hits",
    },
    {
      name: 'api_key_id (structural redaction covers this, text masking does not)',
      input: '{"api_key_id":"xyz-not-really-secret"}',
      where: 'not found as a real field anywhere in server/ — synthetic, from the #1367 brief',
    },
    {
      name: 'maskCredentials does not reach alpacaSecretKey (redactPayload does, structurally)',
      input: '{"alpacaSecretKey":"would-be-a-real-secret"}',
      where: 'tools/backtest/free-stack-aggregates-client.ts, tools/stage2-source.ts',
    },
    {
      name: 'maskCredentials does not reach polygonApiKey (redactPayload does, structurally)',
      input: '{"polygonApiKey":"would-be-a-real-secret"}',
      where: 'apps/service-api/provider-status.ts',
    },
    {
      name: 'F1 (#1367 round 4): newline after ALPACA_API_SECRET does not swallow the following line',
      input: 'ALPACA_API_SECRET:\n    at foo()',
      where:
        'all-caps env-var pattern (:93) — same newline hazard F7 fixed on the bareword pattern',
    },
    {
      name: 'F1 (#1367 round 4): newline after polygon_api_key does not swallow the following line',
      input: 'polygon_api_key:\n    at foo()',
      where:
        'lowercase env-var pattern (:113) — same newline hazard F7 fixed on the bareword pattern',
    },
    {
      name: 'F1 (#1367 round 4): newline between Authorization: and Basic does not mask anything',
      input: 'Authorization:\nBasic ZkFLRTAwMDA=',
      where:
        'Authorization pattern\'s lookbehind separator (:137) — a newline there means the lookbehind never matches before "Basic", so nothing is masked at all (not the scheme-to-value \\s+ gap F4 describes, a different mechanism with the same observable result)',
    },
    {
      name: 'F2 (#1367 round 4): Alpaca_Api_Key (mixed case) is not masked',
      input: 'Alpaca_Api_Key=skFAKE0000',
      where:
        "lowercase env-var pattern (:113) — anchored `[a-z][a-z0-9_]` with no `i` flag, so a mixed-case spelling doesn't match it, and the all-caps pattern (:93) doesn't match it either because the prefix isn't all-caps",
    },
  ];

  it.each(negative)('does NOT mask: $name', ({ input }) => {
    expect(maskCredentials(input)).toBe(input);
  });
});

describe('escaped (nested) JSON credentials (#1377)', () => {
  const positive: ReadonlyArray<{ name: string; input: string; secret: string; survives: string }> =
    [
      {
        name: 'the issue reproduction: bareword api_key, escaped',
        input: String.raw`{"error":"401","body":"{\"api_key\":\"skFAKE0000\"}"}`,
        secret: 'skFAKE0000',
        survives: '"error":"401"',
      },
      {
        name: 'a sibling field after the escaped credential survives',
        input: String.raw`{"body":"{\"api_key\":\"skFAKE0000\",\"symbol\":\"SPY\"}"}`,
        secret: 'skFAKE0000',
        survives: String.raw`\"symbol\":\"SPY\"`,
      },
      {
        name: 'camelCase clientSecret, escaped',
        input: String.raw`{"body":"{\"clientSecret\":\"sk-live-abcdef123456\"}"}`,
        secret: 'sk-live-abcdef123456',
        survives: '{"body":"{\\"',
      },
      {
        name: 'all-caps env-var ALPACA_API_SECRET, escaped',
        input: String.raw`{"region":"eu-west-2","body":"{\"ALPACA_API_SECRET\":\"skFAKE0000\"}"}`,
        secret: 'skFAKE0000',
        survives: '"region":"eu-west-2"',
      },
      {
        name: 'lowercase env-var polygon_api_key, escaped',
        input: String.raw`{"body":"{\"polygon_api_key\":\"skFAKE0000\"}"}`,
        secret: 'skFAKE0000',
        survives: '{"body":"{\\"',
      },
      {
        name: 'Authorization: Basic, escaped',
        input: String.raw`{"body":"{\"Authorization\":\"Basic ZkFLRTAwMDA=\"}"}`,
        secret: 'ZkFLRTAwMDA=',
        survives: String.raw`\"Authorization\"`,
      },
      {
        name: 'Authorization: Token, escaped',
        input: String.raw`{"body":"{\"Authorization\":\"Token skFAKE0000tiingo\"}"}`,
        secret: 'skFAKE0000tiingo',
        survives: String.raw`{"body":"{\"Authorization\":\"`,
      },
      {
        name: 'DSN password, escaped',
        input: String.raw`{"body":"{\"dsn\":\"postgres://user:supersecretpw@db.internal:5432/samurai\"}"}`,
        secret: 'supersecretpw',
        survives: 'postgres://user:',
      },
    ];

  it.each(positive)('masks the secret in: $name', ({ input, secret, survives }) => {
    expect(maskCredentials(input)).not.toContain(secret);
    expect(maskCredentials(input)).toContain('[REDACTED]');
    expect(maskCredentials(input)).toContain(survives);
  });

  it('bareword: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(String.raw`{"body":"{\"api_key\":\"skFAKE0000\",\"symbol\":\"SPY\"}"}`),
    ).toBe(String.raw`{"body":"{\"[REDACTED]\",\"symbol\":\"SPY\"}"}`);
  });

  it('Bearer: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(
        String.raw`{"body":"{\"Authorization\":\"Bearer sk-ant-abc123\",\"ok\":true}"}`,
      ),
    ).toBe(String.raw`{"body":"{\"Authorization\":\"[REDACTED]\",\"ok\":true}"}`);
  });

  it('compound clientSecret: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(
        String.raw`{"body":"{\"clientSecret\":\"sk-live-abcdef123456\",\"ok\":true}"}`,
      ),
    ).toBe(String.raw`{"body":"{\"[REDACTED]\",\"ok\":true}"}`);
  });

  it('all-caps env-var ALPACA_API_SECRET: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(String.raw`{"body":"{\"ALPACA_API_SECRET\":\"skFAKE0000\",\"ok\":true}"}`),
    ).toBe(String.raw`{"body":"{\"[REDACTED]\",\"ok\":true}"}`);
  });

  it('lowercase env-var polygon_api_key: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(String.raw`{"body":"{\"polygon_api_key\":\"skFAKE0000\",\"ok\":true}"}`),
    ).toBe(String.raw`{"body":"{\"[REDACTED]\",\"ok\":true}"}`);
  });

  it('Authorization Basic: the value stops before its own escaped closing quote, sibling field byte-exact', () => {
    expect(
      maskCredentials(
        String.raw`{"body":"{\"Authorization\":\"Basic ZkFLRTAwMDA=\",\"ok\":true}"}`,
      ),
    ).toBe(String.raw`{"body":"{\"Authorization\":\"[REDACTED]\",\"ok\":true}"}`);
  });

  it('DSN: escaped-JSON reachability, byte-exact (value class unmodified from main — see the module doc comment)', () => {
    expect(
      maskCredentials(
        String.raw`{"body":"{\"dsn\":\"postgres://user:supersecretpw@db.internal:5432/samurai\",\"ok\":true}"}`,
      ),
    ).toBe(
      String.raw`{"body":"{\"dsn\":\"postgres://user:[REDACTED]@db.internal:5432/samurai\",\"ok\":true}"}`,
    );
  });

  it('ALPACA_API_SECRET: a literal backslash with no following quote is consumed as part of the value, matching main', () => {
    expect(maskCredentials('ALPACA_API_SECRET:\\Users\\me\\file.txt')).toBe('[REDACTED]');
  });

  it('DSN: a password containing a literal backslash still matches in full, unmodified from main', () => {
    expect(maskCredentials('redis://user:pa\\ss@host:6379')).toBe(
      'redis://user:[REDACTED]@host:6379',
    );
  });

  it('Bearer: a token containing a literal backslash not followed by a quote still matches in full, matching main', () => {
    expect(maskCredentials('Bearer skFAKE\\0000END')).toBe('[REDACTED]');
  });

  it('Authorization Basic: a value containing a literal backslash not followed by a quote still matches in full, matching main', () => {
    expect(maskCredentials('Authorization: Basic YWJj\\ZGVm')).toBe('Authorization: [REDACTED]');
  });

  it('bareword: a value containing a literal backslash not followed by a quote still matches in full, matching main', () => {
    expect(maskCredentials('api_secret=abc\\def')).toBe('[REDACTED]');
  });

  it('compound clientSecret: a value containing a literal backslash not followed by a quote still matches in full, matching main', () => {
    expect(maskCredentials('clientSecret=abc\\def')).toBe('[REDACTED]');
  });

  it('lowercase env polygon_api_key: a value containing a literal backslash not followed by a quote still matches in full, matching main', () => {
    expect(maskCredentials('polygon_api_key=abc\\def')).toBe('[REDACTED]');
  });

  const negative: ReadonlyArray<{ name: string; input: string }> = [
    {
      name: 'pagination cursor next_page_token, escaped, survives',
      input: String.raw`{"body":"{\"next_page_token\":\"abc\"}"}`,
    },
    {
      name: 'LLM request budget maxTokens, escaped, survives',
      input: String.raw`{"body":"{\"maxTokens\":1024}"}`,
    },
    {
      name: 'residual gap SSH_PRIVATE_KEY (no bare _KEY suffix), escaped, survives',
      input: String.raw`{"body":"{\"SSH_PRIVATE_KEY\":\"skFAKE0000\"}"}`,
    },
    {
      name: 'maskCredentials does not reach alpacaSecretKey, escaped, survives (redactPayload does, structurally)',
      input: String.raw`{"body":"{\"alpacaSecretKey\":\"would-be-a-real-secret\"}"}`,
    },
    {
      name: 'DSN does not over-match through a quote into a sibling field, escaped',
      input: String.raw`{"body":"{\"dsn\":\"redis://h:6379\",\"email\":\"a@b.com\"}"}`,
    },
    {
      name: 'residual gap: double-escaped credential is not reached',
      input: String.raw`{"outer":"{\\\"api_key\\\":\\\"skFAKE0000\\\"}"}`,
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
