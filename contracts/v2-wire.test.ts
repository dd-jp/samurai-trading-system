import { describe, expect, it } from 'vitest';
import { V2_CONTRACT_VERSION, v2WireFieldPaths } from './v2-wire.js';
import { contractVersionOf } from './version.js';

describe('V2_CONTRACT_VERSION', () => {
  it('is derived from every wire field path', () => {
    expect(V2_CONTRACT_VERSION).toBe(contractVersionOf(v2WireFieldPaths()));
    expect(V2_CONTRACT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it('names each field by its type, so a rename in one type changes the version', () => {
    const paths = v2WireFieldPaths();
    expect(paths).toContain('overview.loss_budget');
    expect(paths).toContain('controlRow.set_at');
    expect(paths).toContain('panel.ticket');
    expect(new Set(paths).size).toBe(paths.length);
  });
});
