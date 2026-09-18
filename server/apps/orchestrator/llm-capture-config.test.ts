import { captureLlmTextFromEnvironment } from './production/environment.js';

describe('captureLlmTextFromEnvironment', () => {
  it('is ON when the variable is unset', () => {
    expect(captureLlmTextFromEnvironment(undefined)).toBe(true);
  });

  it('is OFF only when explicitly switched off', () => {
    expect(captureLlmTextFromEnvironment('off')).toBe(false);
    expect(captureLlmTextFromEnvironment('OFF')).toBe(false);
    expect(captureLlmTextFromEnvironment('  off  ')).toBe(false);
  });

  it('stays ON for any other value, including an empty string', () => {
    expect(captureLlmTextFromEnvironment('')).toBe(true);
    expect(captureLlmTextFromEnvironment('on')).toBe(true);
    expect(captureLlmTextFromEnvironment('true')).toBe(true);
    expect(captureLlmTextFromEnvironment('offf')).toBe(true);
    expect(captureLlmTextFromEnvironment('disabled')).toBe(true);
  });
});
