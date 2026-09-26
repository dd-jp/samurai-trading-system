import { CONTRACT_VERSION, DASHBOARD_SNAPSHOT_FIELD_NAMES } from './snapshot.js';
import { contractVersionOf } from './version.js';

describe('contractVersionOf', () => {
  it('is deterministic for the same field list', () => {
    const fields = ['generated_at', 'as_of', 'mode'];
    expect(contractVersionOf(fields)).toBe(contractVersionOf([...fields]));
  });

  it('changes when a field is renamed', () => {
    const before = contractVersionOf(['generated_at', 'as_of', 'mode']);
    const after = contractVersionOf(['generated_at', 'as_of', 'run_mode']);
    expect(after).not.toBe(before);
  });

  it('changes when a field is added', () => {
    const before = contractVersionOf(['generated_at', 'as_of']);
    const after = contractVersionOf(['generated_at', 'as_of', 'contract_version']);
    expect(after).not.toBe(before);
  });

  it('changes when a field is removed', () => {
    const before = contractVersionOf(['generated_at', 'as_of', 'mode']);
    const after = contractVersionOf(['generated_at', 'as_of']);
    expect(after).not.toBe(before);
  });

  it('changes when field order changes, since a positional shift is still a shape change a stale reader could misparse', () => {
    const before = contractVersionOf(['a', 'b']);
    const after = contractVersionOf(['b', 'a']);
    expect(after).not.toBe(before);
  });

  it('is stable in-process across repeated reads of the real DashboardSnapshot field list', () => {
    expect(contractVersionOf(DASHBOARD_SNAPSHOT_FIELD_NAMES)).toBe(CONTRACT_VERSION);
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION.length).toBeGreaterThan(0);
  });
});
