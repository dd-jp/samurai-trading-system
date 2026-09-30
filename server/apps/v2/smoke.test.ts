import { describe, expect, it } from 'vitest';
import { printSmoke, runV2Smoke } from './smoke.js';

describe('v2 smoke', () => {
  it('passes every probe against the local bar store', { timeout: 180_000 }, async () => {
    const result = await runV2Smoke();
    expect(result.probes.filter((probe) => !probe.passed)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.probes).toHaveLength(24);
  });

  it('prints one line per probe and exits 0 on green, 1 on red', () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const probes = [
      { name: 'a', passed: true, detail: 'x' },
      { name: 'b', passed: false, detail: 'y' },
    ];
    expect(printSmoke({ probes, passed: false }, write)).toBe(1);
    expect(lines).toEqual(['PASS a — x\n', 'FAIL b — y\n', 'v2 smoke: RED\n']);
    lines.length = 0;
    expect(printSmoke({ probes: [], passed: true }, write)).toBe(0);
    expect(lines).toEqual(['v2 smoke: GREEN\n']);
  });
});
