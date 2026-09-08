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

describe('camelCase/underscore keys, Basic/Token auth and DSN passwords (#1367)', () => {
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
        // Real env names, grepped from this repo's `process.env.*` reads —
        // not just the one Alpaca `_SECRET_KEY` name above. `_SECRET` and
        // `_TOKEN` are real suffixes here (`ALPACA_API_SECRET`,
        // `SAXO_OPENAPI_TOKEN`), not just `_SECRET_KEY`/`_API_KEY`.
        name: 'real env-var key: ALPACA_API_SECRET (_SECRET suffix)',
        input: '{"region":"eu-west-2","ALPACA_API_SECRET":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"region":"eu-west-2"',
      },
      {
        name: 'real env-var key: SAXO_OPENAPI_TOKEN (_TOKEN suffix)',
        input: '{"venue":"saxo","SAXO_OPENAPI_TOKEN":"skFAKE0000"}',
        secret: 'skFAKE0000',
        survives: '"venue":"saxo"',
      },
      {
        // Round-2 review (F3): the suffix list was extended to close this
        // gap — `password`/`passwd` env names — not widened to a bare
        // `_KEY`, which would over-mask `SORT_KEY`/`ACCOUNT_KEY`-shaped
        // names (see the negative rows for what stayed deliberately out).
        // Synthetic name, unlike the two rows above: grepping this repo's
        // `process.env.*` reads for a `_PASSWORD`/`_PASSWD` name today
        // returns nothing, so this pins the pattern shape, not a name in
        // the tree.
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
        // Round-2 review (F2): the case-sensitive all-caps branch above
        // only reaches SCREAMING_SNAKE names, but this masking runs over
        // upstream-controlled text (this module's doc comment, line 2), not
        // a JSON field name whose case this codebase controls — so a real
        // lowercase credential shape must still be caught. Measured
        // unmasked before the lowercase-anchored pattern existed.
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
        // `_` is a word character, so a trailing `\b` (as the bareword and
        // env-var patterns use) does not block a match starting right after
        // one — this pins that the lookbehind used here (excludes only
        // alnum) reaches an underscore-PREFIXED compound too, not just the
        // plain and underscore-joined forms above. Lowercase-prefixed
        // (`oauth_`, not `X_`) deliberately: an all-caps prefix would also
        // be caught by the env-var pattern below (its suffix list now
        // includes bare `SECRET`/`TOKEN`), which would leave this row
        // green under either pattern and prove nothing about this one.
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
        // The issue's stated reachable path (`service-api/server.ts` →
        // `sanitizeLogText(describeThrownSafely(err))` → `describeThrown`,
        // a JSON.stringify ladder) delivers exactly this quoted shape — a
        // bare `Authorization:\s*` lookbehind (no quote handling) misses it.
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
        // `tools/backtest/http-tiingo-client.ts:156` sends this exact header
        // shape (`Authorization: \`Token ${this.apiKey}\``) — a real caller,
        // not a hypothetical scheme.
        name: 'Authorization: Token (Tiingo)',
        input: 'Authorization: Token skFAKE0000tiingo',
        secret: 'skFAKE0000tiingo',
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
      {
        // Username is optional in a DSN (`redis://:pw@host`); the value
        // class's username quantifier must accept zero characters too.
        name: 'DSN password, no username',
        input: 'redis://:skFAKE0000@host:6379',
        secret: 'skFAKE0000',
        survives: 'redis://:',
      },
      // Round-4 review (F1): the `&`-exclusion row above (F8) only exercises
      // the bareword pattern (:55). The camelCase/underscore, all-caps
      // env-var and Authorization patterns each got the identical `&`
      // exclusion, but nothing pinned it there — reverting `&` from any of
      // their value classes left every existing test green. These four
      // close that gap, one per pattern.
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
    // Look-around, not a whole-match replace like the other patterns, so
    // this is exact-equality, not just "the substring survives".
    expect(maskCredentials('postgres://user:supersecretpw@db.internal:5432/samurai')).toBe(
      'postgres://user:[REDACTED]@db.internal:5432/samurai',
    );
  });

  it('the DSN pattern does not over-match through a quote into a sibling JSON field (#358)', () => {
    // A value class that admits `"`, `,` or `;` reaches past the DSN's own
    // closing quote — deleting the port and merging into the next field's
    // `@`. This is the header's own stated failure mode: an over-masked
    // line whose surviving text is actively misleading, not just short.
    const out = maskCredentials('{"dsn":"redis://h:6379","email":"a@b.com"}');
    expect(out).toBe('{"dsn":"redis://h:6379","email":"a@b.com"}');
  });

  it('the env-var pattern is case-sensitive, so a lowercase pagination cursor is not a false positive', () => {
    // What case-sensitivity actually buys (round-2 review, F2/F5): NOT that
    // lowercase credential shapes leak in general — `my_secret_key=abc123`
    // is exactly the `_secret_key` shape the lowercase-anchored pattern
    // above now masks, so pinning THAT as correct-to-leak would be pinning
    // a bug. What it buys is that `next_page_token` (a real pagination
    // cursor this codebase logs, lowercase) doesn't fall to the all-caps
    // branch, and isn't a `_secret_key`/`_api_key`/`_api_secret` shape
    // either, so the lowercase-anchored branch doesn't reach it either.
    expect(maskCredentials('next_page_token=abc123continuation')).toBe(
      'next_page_token=abc123continuation',
    );
  });

  it('newline after the key does not swallow the following line as the value (#1367 round 2, F7)', () => {
    // `\s*` around the key-to-value operator admits a newline; a caught
    // error's `message` embedding a stack trace (`token:\n    at ...`) is
    // not a credential assignment, but the old pattern read the stack
    // trace's first word as the "value" and destroyed it.
    expect(maskCredentials('token:\nStack trace at foo()')).toBe('token:\nStack trace at foo()');
    expect(maskCredentials('accessToken:\n    at Client.request (/app/x.ts:1:1)')).toBe(
      'accessToken:\n    at Client.request (/app/x.ts:1:1)',
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
      // above; the camelCase form lives in a different provider's client.
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
      // Round-2 review, F2: the lowercase-anchored pattern only covers
      // `_secret_key`/`_api_key`/`_api_secret` — deliberately NOT a bare
      // `_token` suffix, because that would re-catch `next_page_token`. A
      // lowercase or mixed-case name ending only in `_token` is an
      // intentional, documented residual gap, not an oversight.
      name: 'residual gap: lowercase _token-suffixed name (saxo_openapi_token)',
      input: 'saxo_openapi_token=skFAKE0000',
      where:
        "not found as a real lowercase field in server/ — the residual gap this row pins is deliberate, see this row's comment",
    },
    {
      name: 'residual gap: mixed-case _token-suffixed name (Saxo_Openapi_Token)',
      input: 'Saxo_Openapi_Token=skFAKE0000',
      where:
        'same residual gap as the row above — neither the all-caps branch (mixed case) nor the lowercase branch (bare _token) reaches it',
    },
    {
      // Round-2 review, F3: the all-caps suffix list was extended to close
      // a real gap (`PASSWORD`/`PASSWD`), not widened to `_KEY` generally —
      // a bare `_KEY` suffix would mask `SORT_KEY`/`ACCOUNT_KEY`/
      // `IDEMPOTENCY_KEY`-shaped names, none of which are credentials. No
      // real `_PRIVATE_KEY`/`_APP_KEY`/`_CREDENTIALS` env name exists in
      // this repo today (grepped); these three pin that the suffix list
      // stayed narrow rather than growing to match every plausible name.
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
      // Not a real logged field. `grep -rn -i keyword server/` (repo-wide,
      // case-insensitive) finds five hits, none a JSON key: this describe
      // block's own comments, `lse-etp-pool.ts:157` ("broader keyword
      // sweep", prose) and `:375` (a real Saxo query param, `Keywords=
      // <ticker|ISIN>` — capitalized, plural, a different shape),
      // `write-guard.ts:233`, and `spec-schema-drift.test.ts:100`. Kept
      // anyway because #1367's own brief named "keyword" as an example
      // substring risk (the bareword pattern's `api[_-]?key` alternative
      // sits inside it) — this pins that no pattern here is a bare `key`
      // match.
      name: 'the substring "key" inside ordinary English: "keyword"',
      input: '{"keyword":"leveraged etf"}',
      where: "not a real field — see this row's comment for the actual grep hits",
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
      // `alpacaSecretKey` has no `client`/`access`/`refresh` prefix and no
      // underscore before `SECRET_KEY`, so this text-based mechanism does
      // not reach it — not a gap left open: `redactPayload`'s structural
      // `CREDENTIAL_KEYS` set now covers it by exact key (added alongside
      // this row; see `redact-payload.ts` and its test), which has no
      // camelCase-boundary problem to begin with. This row pins what
      // `maskCredentials` specifically does and does not do, not the
      // combined coverage of both mechanisms.
      name: 'maskCredentials does not reach alpacaSecretKey (redactPayload does, structurally)',
      input: '{"alpacaSecretKey":"would-be-a-real-secret"}',
      where: 'tools/backtest/free-stack-aggregates-client.ts, tools/stage2-source.ts',
    },
    {
      name: 'maskCredentials does not reach polygonApiKey (redactPayload does, structurally)',
      input: '{"polygonApiKey":"would-be-a-real-secret"}',
      where: 'apps/service-api/provider-status.ts',
    },
    // Round-4 review (F1): F7's `[ \t]*` fix on the bareword pattern (:55)
    // was pinned by the dedicated newline test above, but nothing pinned it
    // on the all-caps env-var, lowercase env-var or Authorization patterns
    // — reverting `[ \t]*` back to `\s*` on any of them left every existing
    // test green. These three close that gap: a newline right after the
    // key must NOT be treated as the key-to-value separator, so a stack
    // trace embedded in an error message survives untouched.
    {
      name: 'F1 (#1367 round 4): newline after ALPACA_API_SECRET does not swallow the following line',
      input: 'ALPACA_API_SECRET:\n    at foo()',
      where:
        'all-caps env-var pattern (:86) — same newline hazard F7 fixed on the bareword pattern',
    },
    {
      name: 'F1 (#1367 round 4): newline after polygon_api_key does not swallow the following line',
      input: 'polygon_api_key:\n    at foo()',
      where:
        'lowercase env-var pattern (:100) — same newline hazard F7 fixed on the bareword pattern',
    },
    {
      name: 'F1 (#1367 round 4): newline between Authorization: and Basic does not mask anything',
      input: 'Authorization:\nBasic ZkFLRTAwMDA=',
      where:
        'Authorization pattern\'s lookbehind separator (:119) — a newline there means the lookbehind never matches before "Basic", so nothing is masked at all (not the scheme-to-value \\s+ gap F4 describes, a different mechanism with the same observable result)',
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
