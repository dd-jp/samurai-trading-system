import { describe, expect, it } from 'vitest';
import { credentialReader } from './require-credential.js';

describe('credentialReader', () => {
  const requireCredential = credentialReader('SomeClient');

  it('returns a set value', () => {
    expect(requireCredential('key', 'SOME_KEY', 'apiKey')).toBe('key');
  });

  it.each([undefined, ''])('names the owner, variable and option when the value is %j', (value) => {
    expect(() => requireCredential(value, 'SOME_KEY', 'apiKey')).toThrow(
      'SomeClient: SOME_KEY is not set. Provide it via the environment (.env.local) or pass { apiKey } explicitly.',
    );
  });
});
