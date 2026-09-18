
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
