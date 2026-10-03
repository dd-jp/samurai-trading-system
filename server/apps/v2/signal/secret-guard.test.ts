import { describe, expect, it } from 'vitest';
import type { LlmSpendRecord } from '../../../pipeline/debate-engine/index.js';
import {
  type KnownSecret,
  leakedSecret,
  MIN_SECRET_LENGTH,
  type OutgoingRequest,
  SECRET_ENV_NAMES,
  SECRET_WITHHELD,
  secretGuardedSink,
  secretsFromEnv,
} from './secret-guard.js';

const PROVIDER_KEY = 'fake-nous-key-1a2b3c';
const OTHER = 'fake-alpaca-secret+/=4d5e';
const SECRETS: KnownSecret[] = [
  { name: 'NOUS_API_KEY', value: PROVIDER_KEY },
  { name: 'NOUS_DEBATE_API_KEY', value: PROVIDER_KEY },
  { name: 'ALPACA_API_SECRET', value: OTHER },
];
const AUTH = { header: 'authorization', key: PROVIDER_KEY };

const clean = (overrides: Partial<OutgoingRequest> = {}): OutgoingRequest => ({
  url: 'https://nous.test/v1/chat/completions',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVIDER_KEY}` },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'UP beats on revenue' }] }),
  ...overrides,
});

describe('leakedSecret', () => {
  it('allows the provider key in its own auth header', () => {
    expect(leakedSecret(SECRETS, clean(), AUTH)).toBeUndefined();
  });

  it('matches the auth header name case-insensitively', () => {
    const request = clean({ headers: { Authorization: `Bearer ${PROVIDER_KEY}` } });
    expect(leakedSecret(SECRETS, request, AUTH)).toBeUndefined();
  });

  it('refuses the provider key in the body, the URL or another header', () => {
    expect(leakedSecret(SECRETS, clean({ body: `{"k":"${PROVIDER_KEY}"}` }), AUTH)).toBe(
      'NOUS_API_KEY',
    );
    expect(
      leakedSecret(SECRETS, clean({ url: `https://nous.test/v1?k=${PROVIDER_KEY}` }), AUTH),
    ).toBe('NOUS_API_KEY');
    const headers = { authorization: `Bearer ${PROVIDER_KEY}`, 'x-extra': PROVIDER_KEY };
    expect(leakedSecret(SECRETS, clean({ headers }), AUTH)).toBe('NOUS_API_KEY');
  });

  it('refuses another secret in the auth header beside the provider key', () => {
    const headers = { authorization: `Bearer ${PROVIDER_KEY} ${OTHER}` };
    expect(leakedSecret(SECRETS, clean({ headers }), AUTH)).toBe('ALPACA_API_SECRET');
  });

  it('refuses another secret raw, URL-encoded or JSON-escaped', () => {
    expect(leakedSecret(SECRETS, clean({ body: `cash ${OTHER}` }), AUTH)).toBe('ALPACA_API_SECRET');
    const encoded = `https://nous.test/v1?q=${encodeURIComponent(OTHER)}`;
    expect(leakedSecret(SECRETS, clean({ url: encoded }), AUTH)).toBe('ALPACA_API_SECRET');
    const quoted: KnownSecret = { name: 'SAXO_TOKEN', value: 'fake"saxo\\token' };
    const body = JSON.stringify({ content: `token ${quoted.value}` });
    expect(leakedSecret([quoted], clean({ body }), AUTH)).toBe('SAXO_TOKEN');
  });

  it('ignores a value shorter than the minimum and catches one at it', () => {
    const short: KnownSecret = { name: 'SHORT', value: 'x'.repeat(MIN_SECRET_LENGTH - 1) };
    const edge: KnownSecret = { name: 'EDGE', value: 'y'.repeat(MIN_SECRET_LENGTH) };
    expect(leakedSecret([short], clean({ body: short.value }), AUTH)).toBeUndefined();
    expect(leakedSecret([edge], clean({ body: edge.value }), AUTH)).toBe('EDGE');
    expect(leakedSecret([{ name: 'EMPTY', value: '' }], clean(), AUTH)).toBeUndefined();
  });
});

describe('secretsFromEnv', () => {
  it('reads every named variable and treats an unset one as empty', () => {
    const secrets = secretsFromEnv({ TELEGRAM_BOT_TOKEN: 'fake-telegram-token' });
    expect(secrets.map((secret) => secret.name)).toEqual([...SECRET_ENV_NAMES]);
    expect(secrets.find((secret) => secret.name === 'TELEGRAM_BOT_TOKEN')?.value).toBe(
      'fake-telegram-token',
    );
    expect(secrets.find((secret) => secret.name === 'ALPACA_API_KEY')?.value).toBe('');
  });

  it('guards the Saxo account keys, so an LLM prompt naming one is refused (#1881)', () => {
    const secrets = secretsFromEnv({
      SAXO_SIM_ACCOUNT_KEY: 'fake-sim-account-key-1a2b',
      SAXO_LIVE_ACCOUNT_KEY: 'fake-live-account-key-3c4d',
    });
    const prompt = (key: string) => clean({ body: JSON.stringify({ content: `acct ${key}` }) });
    expect(leakedSecret(secrets, prompt('fake-sim-account-key-1a2b'), AUTH)).toBe(
      'SAXO_SIM_ACCOUNT_KEY',
    );
    expect(leakedSecret(secrets, prompt('fake-live-account-key-3c4d'), AUTH)).toBe(
      'SAXO_LIVE_ACCOUNT_KEY',
    );
  });
});

describe('secretGuardedSink', () => {
  const entry: LlmSpendRecord = {
    trace_id: 't',
    stage: 'debate',
    model: 'm',
    usage: { input_tokens: 0, output_tokens: 0 },
    latency_ms: 1,
    timestamp: new Date('2026-10-01T07:30:00.000Z'),
    prompt: 'p',
  };
  const recorded = () => {
    const records: LlmSpendRecord[] = [];
    return { records, sink: { record: (record: LlmSpendRecord) => records.push(record) } };
  };

  it('passes a record carrying no known secret through unchanged', () => {
    const { records, sink } = recorded();
    const passed = { ...entry, response: 'r', stop_reason: 'end_turn' };
    secretGuardedSink(sink, () => SECRETS).record(passed);
    expect(records).toEqual([passed]);
  });

  it.each([
    ['prompt', { prompt: `a ${OTHER}` }],
    ['response', { response: encodeURIComponent(OTHER) }],
    ['error message', { error_class: 'LlmProviderError', error_message: JSON.stringify(OTHER) }],
    ['stop reason', { stop_reason: PROVIDER_KEY }],
    ['error class', { error_class: PROVIDER_KEY }],
  ])('withholds every text field when the %s carries a secret', (_, fields) => {
    const { records, sink } = recorded();
    secretGuardedSink(sink, () => SECRETS).record({ ...entry, ...fields });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ usage: entry.usage, error_class: SECRET_WITHHELD });
    for (const field of ['prompt', 'response', 'error_message', 'stop_reason'] as const) {
      expect(records[0]?.[field]).toBeUndefined();
    }
  });
});
