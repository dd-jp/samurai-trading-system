import { describe, expect, it } from 'vitest';
import { clampTimeoutToBudget } from './nous-wire.js';

describe('clampTimeoutToBudget', () => {
  it('returns the configured timeout unchanged when no gate budget is set', () => {
    expect(clampTimeoutToBudget(5_000, undefined, 800)).toBe(5_000);
  });

  it('shrinks the timeout to whatever budget the gate wait left behind', () => {
    expect(clampTimeoutToBudget(5_000, 1_000, 800)).toBe(200);
  });

  it('never returns more than the configured timeout, even with budget to spare', () => {
    expect(clampTimeoutToBudget(5_000, 100_000, 0)).toBe(5_000);
  });

  it('floors at zero rather than going negative when the wait already exceeded the budget', () => {
    expect(clampTimeoutToBudget(5_000, 1_000, 1_500)).toBe(0);
  });
});
