import { describe, expect, it } from 'vitest';
import {
  type KnownSecret,
  leakedSecret,
  MIN_SECRET_LENGTH,
  type OutgoingRequest,
  SECRET_ENV_NAMES,
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
});
