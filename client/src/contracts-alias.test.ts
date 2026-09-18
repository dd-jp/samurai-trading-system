import { PIPELINE_STAGES, STORE_MODES } from '@contracts';
import { expect, it } from 'vitest';

it('resolves a value import through the @contracts alias', () => {
  expect(PIPELINE_STAGES).toContain('analysts');
  expect(PIPELINE_STAGES).toContain('execution');
  expect(STORE_MODES).toContain('paper');
});
