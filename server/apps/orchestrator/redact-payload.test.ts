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
    expect(redactPayload({ alpacaSecretKey: 'skFAKE0000' })).toEqual({
      alpacaSecretKey: '[REDACTED]',
    });
    expect(redactPayload({ polygonApiKey: 'skFAKE0000' })).toEqual({
      polygonApiKey: '[REDACTED]',
    });
    expect(redactPayload({ alpacaKeyId: 'AKFAKE0000' })).toEqual({
      alpacaKeyId: '[REDACTED]',
    });
  });

  it('leaves pagination cursors readable', () => {
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
    expect(Object.keys(out).length).toBeLessThan(2_100);
  });

  it('bounds a very wide ARRAY too, in work and in line length', () => {
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
    const cyclic: Record<string, unknown> = { stage: 'trader' };
    cyclic.self = cyclic;

    const line = formatLogLine({ ...ENTRY, payload: cyclic });

    expect(() => parse(line)).not.toThrow();
    expect(line).toContain('REDACTION_DEPTH_LIMIT');
    expect(parse(line).message).toBe(ENTRY.message);
  });

  it('degrades the payload, not the line, when it cannot be serialized at all', () => {
    const line = formatLogLine({ ...ENTRY, payload: { size: 1n } });

    expect(() => parse(line)).not.toThrow();
    expect(parse(line).payload).toEqual({ redaction_failed: true });
    expect(parse(line).message).toBe(ENTRY.message);
  });

  it('leaves an entry with no payload alone', () => {
    expect(parse(formatLogLine(ENTRY)).payload).toBeUndefined();
  });

  it('still writes a parseable #714 degradation notice when both sinks are gone', () => {
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

    expect(() => logger.log(ENTRY)).toThrow(/EBADF/);
    expect(stderrLines.join('')).toContain('"log_file_sink":"degraded"');
    expect(stderrLines.join('')).toContain('#714');
    for (const line of stderrLines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
