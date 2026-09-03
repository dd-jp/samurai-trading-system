/**
 * Pins `PIPELINE_STAGES` to exactly the six decision-path stages, in order
 * (#998). This is the one place a regrowth back to seven — or any other
 * drift — fails a plain assertion instead of only a downstream type error
 * three modules away.
 */

import { describe, expect, it } from 'vitest';
import { PIPELINE_STAGES } from './pipeline.js';

describe('PIPELINE_STAGES', () => {
  it('is the six decision-path stages, in pipeline order, and nothing else', () => {
    expect(PIPELINE_STAGES).toEqual([
      'analysts',
      'debate',
      'trader',
      'risk',
      'verdict',
      'execution',
    ]);
  });

  it('never regrows the retired invalidation placeholder', () => {
    expect(PIPELINE_STAGES).not.toContain('invalidation');
  });
});
