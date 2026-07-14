import { describe, expect, it } from 'vitest';
import { SystemClock } from './clock.js';

describe('SystemClock', () => {
  it('returns a Date close to real time', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
