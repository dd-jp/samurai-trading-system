import { CONTROL_REASON_MAX_CHARS, V2_CONTRACT_VERSION } from '@contracts';
import { expect, it } from 'vitest';

it('resolves a value import through the @contracts alias', () => {
  expect(V2_CONTRACT_VERSION).toMatch(/\S/);
  expect(CONTROL_REASON_MAX_CHARS).toBe(250);
});
