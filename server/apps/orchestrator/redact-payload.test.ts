/**
 * Central payload redaction (#1035).
 *
 * The load-bearing test here is the first one in `formatLogLine integration`.
 * The rejected implementation — running `sanitizeLogText` over the SERIALIZED
 * string — produces `{"auth":[REDACTED]"scheme":"basic"}}` for that payload,
 * because the pattern's value class excludes `"` and `}` but not `{`. That is
 * an unparseable line on a format whose whole contract is one JSON object per
 * line, so it breaks every reader an operator reaches for mid-incident. These
 * assert the property that rules that implementation out, not merely that
 * something got redacted.
 *
 * Kept in its own file rather than appended to `logger.test.ts` because the
 * walker is its own module with its own bounds, and the integration cases
 * below are the seam between the two.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../shared/index.js';
import { formatLogLine, JsonLogger, type StdoutStream } from './logger.js';
import { redactPayload } from './redact-payload.js';

const ENTRY: LogEntry = {
  trace_id: 'trace-1',
  stage: 'trader',
  level: 'info',
  message: 'decided',
};

describe('redactPayload', () => {
  it('replaces a credential key wholesale, whatever the value type', () => {
    // Rule 1's reason for existing: as prose, a bare token under `api_key` has
    // no assignment syntax around it, so `maskCredentials` cannot see it.
    // Structure is the only place that information exists.
    expect(redactPayload({ api_key: 'PKabc123' })).toEqual({ api_key: '[REDACTED]' });
    expect(redactPayload({ auth: { scheme: 'basic', value: 'x' } })).toEqual({
      auth: '[REDACTED]',
    });
    expect(redactPayload({ apiKey: 'x', 'api-secret': 'y' })).toEqual({
      apiKey: '[REDACTED]',
      'api-secret': '[REDACTED]',
    });
  });

  it('covers the compound credential key spellings, which rule 2 cannot see', () => {
    // A bare token under `access_token` has no assignment syntax around it, so
    // `maskCredentials` never matches it — the key name is the only evidence
    // there is. These are the spellings a provider SDK actually uses.
    for (const key of [
      'access_token',
      'refresh_token',
      'client_secret',
      'secret_key',
      'api_key_id',
      'accessToken',
      'botToken',
      'signing_secret',
    ]) {
      expect(redactPayload({ [key]: 'xoxb-real-value' })).toEqual({ [key]: '[REDACTED]' });
    }
  });

  it('covers vendor-prefixed camelCase names sanitizeLogText cannot reach as prose', () => {
    // alpacaSecretKey/polygonApiKey have no client/access/refresh prefix, so
    // none of sanitize-log-text.ts's named-compound patterns match them as
    // free text — this structural check is what actually closes that gap.
    expect(redactPayload({ alpacaSecretKey: 'skFAKE0000' })).toEqual({
      alpacaSecretKey: '[REDACTED]',
    });
    expect(redactPayload({ polygonApiKey: 'skFAKE0000' })).toEqual({
      polygonApiKey: '[REDACTED]',
    });
  });

  it('leaves pagination cursors readable', () => {
    // Why the key list enumerates compounds instead of suffix-matching
    // `token`: these are cursors, not secrets, and they are exactly what a
    // reader needs when a paged provider fetch stalls part-way.
    expect(
      redactPayload({ next_page_token: 'CAESBQ', pageToken: 'abc', max_tokens: 1_024 }),
    ).toEqual({ next_page_token: 'CAESBQ', pageToken: 'abc', max_tokens: 1_024 });
  });

  it('masks credential syntaxes inside string leaves', () => {
    expect(redactPayload({ error: 'Authorization: Bearer sk-ant-abc123' })).toEqual({
      error: 'Authorization: [REDACTED]',
    });
  });

  it('leaves a real failure reason and ordinary values untouched', () => {
    const payload = {
      reason: 'computeIndicator: sma(14) needs 14 bars but received 13',
      confidence: 0.62,
      rounds: 3,
      converged: true,
      missing: null,
    };
    expect(redactPayload(payload)).toEqual(payload);
  });

  it('walks arrays and preserves their shape', () => {
    expect(redactPayload({ views: [{ token: 'x' }, { stance: 'bullish' }] })).toEqual({
      views: [{ token: '[REDACTED]' }, { stance: 'bullish' }],
    });
  });

  it('renders an Error as masked text rather than an empty object', () => {
    // `JSON.stringify(new Error('x'))` is `{}` — the message, which is exactly
    // the free text worth masking and worth reading, would be lost entirely.
    expect(redactPayload({ cause: new Error('upstream: Bearer sk-ant-leaked') })).toEqual({
      cause: 'Error: upstream: [REDACTED]',
    });
  });

  it('stops descending past the depth bound', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };

    expect(JSON.stringify(redactPayload(deep))).toContain('REDACTION_DEPTH_LIMIT');
  });

  it('stops after the node bound on a very wide payload', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i += 1) wide[`k${i}`] = 'v';

    const out = redactPayload(wide) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain('REDACTION_TRUNCATED');
    // The bound has to cut the OUTPUT, not just stop recursing. Mapping every
    // remaining sibling to the marker would keep all 5,000 entries and put a
    // 5,000-key object on a log line — bounding nothing that matters.
    expect(Object.keys(out).length).toBeLessThan(2_100);
  });

  it('bounds a very wide ARRAY too, in work and in line length', () => {
    // Sibling iteration was the hole: recursion into `walk` was bounded from
    // the start, but `value.map(...)` still visited every element of a huge
    // array and emitted one entry per element.
    const wide = Array.from({ length: 50_000 }, () => 'v');

    const out = redactPayload(wide) as unknown[];
    expect(out.length).toBeLessThan(2_100);
    expect(out.at(-1)).toBe('[REDACTION_TRUNCATED]');
  });
});

describe('formatLogLine integration', () => {
  const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

  it('emits parseable JSON for a nested credential key', () => {
    const line = formatLogLine({ ...ENTRY, payload: { auth: { scheme: 'basic' } } });

    expect(() => parse(line)).not.toThrow();
    expect(parse(line).payload).toEqual({ auth: '[REDACTED]' });
  });

  it('redacts a credential key however deeply it is nested', () => {
    const line = formatLogLine({
      ...ENTRY,
      payload: { venue: { client: { api_key: 'PK-live-abc123', base_url: 'https://x' } } },
    });

    expect(line).not.toContain('PK-live-abc123');
    expect(parse(line).payload).toEqual({
      venue: { client: { api_key: '[REDACTED]', base_url: 'https://x' } },
    });
  });

  it('survives a cyclic payload, which used to throw out of JSON.stringify', () => {
    // Before #1035 this threw UNCAUGHT — and `formatLogLine` is what
    // `degradationLine` builds on, so the throw landed on the both-sinks-dead
    // path that writes the run's last trace. The depth bound absorbs it: the
    // cycle is cut at MAX_DEPTH and the line is emitted, which is strictly
    // better than losing the payload to the guard.
    const cyclic: Record<string, unknown> = { stage: 'trader' };
    cyclic.self = cyclic;

    const line = formatLogLine({ ...ENTRY, payload: cyclic });

    expect(() => parse(line)).not.toThrow();
    expect(line).toContain('REDACTION_DEPTH_LIMIT');
    expect(parse(line).message).toBe(ENTRY.message);
  });

  it('degrades the payload, not the line, when it cannot be serialized at all', () => {
    // `JSON.stringify` throws a TypeError on a BigInt, and the walker passes
    // primitives through untouched — so this is a payload that survives
    // redaction and still cannot go on the wire. The guard must cost the
    // payload and keep the line.
    const line = formatLogLine({ ...ENTRY, payload: { size: 1n } });

    expect(() => parse(line)).not.toThrow();
    expect(parse(line).payload).toEqual({ redaction_failed: true });
    expect(parse(line).message).toBe(ENTRY.message);
  });

  it('leaves an entry with no payload alone', () => {
    expect(parse(formatLogLine(ENTRY)).payload).toBeUndefined();
  });

  it('still writes a parseable #714 degradation notice when both sinks are gone', () => {
    // `degradationLine` bypasses the walker entirely. This pins that the
    // bypass did not change the notice's shape, and that the last-resort
    // stderr write still happens before the throw.
    const stdout: StdoutStream = {
      write() {
        throw new Error('EBADF');
      },
      on() {
        return undefined;
      },
    };
    const stderrLines: string[] = [];
    const logger = new JsonLogger(undefined, stdout, {
      write: (line: string) => stderrLines.push(line),
    });

    // Throws the ORIGINAL stdio error, not the no-sink message: with no file
    // sink there is nothing durable to record the degradation on, so
    // `writeToStdout` rethrows rather than degrading. `logger.ts`'s module doc
    // states this ordering — the point here is that the last-resort stderr
    // notice is written BEFORE the throw, and is parseable.
    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
    expect(stderrLines.join('')).toContain('"log_file_sink":"degraded"');
    expect(stderrLines.join('')).toContain('#714');
    for (const line of stderrLines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
