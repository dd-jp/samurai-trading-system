import { describe, expect, it } from 'vitest';
import {
  nousCredentials,
  nousEndpoint,
  tryNousCredentials,
  tryNousEndpoint,
} from './nous-config.js';

const BASE = { NOUS_BASE_URL: ' https://nous.test/v1 ', NOUS_DEBATE_API_KEY: ' debate-key ' };

describe('nousEndpoint', () => {
  it('resolves the base URL and key trimmed, NOUS_DEBATE_API_KEY before NOUS_API_KEY', () => {
    expect(nousEndpoint('debate', BASE)).toEqual({
      baseUrl: 'https://nous.test/v1',
      apiKey: 'debate-key',
    });
    expect(nousEndpoint('debate', { ...BASE, NOUS_API_KEY: 'shared' }).apiKey).toBe('debate-key');
    expect(
      nousEndpoint('debate', { NOUS_BASE_URL: 'https://nous.test/v1', NOUS_API_KEY: 'shared' })
        .apiKey,
    ).toBe('shared');
  });

  it('throws on a missing base URL or key, treating whitespace as missing', () => {
    expect(() => nousEndpoint('debate', { NOUS_DEBATE_API_KEY: 'k' })).toThrow(/NOUS_BASE_URL/);
    expect(() => nousEndpoint('debate', { NOUS_BASE_URL: 'u', NOUS_DEBATE_API_KEY: '  ' })).toThrow(
      /no API key for the "debate" role/,
    );
    expect(
      tryNousEndpoint('debate', { NOUS_BASE_URL: '  ', NOUS_DEBATE_API_KEY: 'k' }),
    ).toBeUndefined();
    expect(tryNousEndpoint('debate', {})).toBeUndefined();
  });

  it("ignores the role's model knob entirely", () => {
    const env = { ...BASE, NOUS_DEBATE_MODEL: 'vendor/unpriced-model' };
    expect(tryNousEndpoint('debate', env)).toEqual({
      baseUrl: 'https://nous.test/v1',
      apiKey: 'debate-key',
    });
  });
});

describe('nousCredentials', () => {
  it('still refuses an unpriced model for v1 callers', () => {
    const env = { ...BASE, NOUS_DEBATE_MODEL: 'vendor/unpriced-model' };
    expect(() => nousCredentials('debate', env)).toThrow(/MODEL_RATES/);
    expect(() => tryNousCredentials('debate', env)).toThrow(/MODEL_RATES/);
  });

  it('returns the endpoint plus the resolved model, defaulting per role', () => {
    expect(nousCredentials('debate', BASE)).toEqual({
      baseUrl: 'https://nous.test/v1',
      apiKey: 'debate-key',
      model: 'anthropic/claude-haiku-4.5',
    });
    expect(nousCredentials('debate', { ...BASE, NOUS_MODEL: 'openai/gpt-5.6-luna' }).model).toBe(
      'openai/gpt-5.6-luna',
    );
    expect(tryNousCredentials('debate', {})).toBeUndefined();
  });
});
