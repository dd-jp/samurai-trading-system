import { describe, expect, it } from 'vitest';
import { applyGuardrail, boundedStep, moveDirection } from './guardrails.js';
import type { TunableDial } from './types.js';

function makeDial(overrides: Partial<TunableDial> = {}): TunableDial {
  return { max_step: 0.05, floor: 0.1, ceiling: 0.9, tighten_is: 'decrease', ...overrides };
}

describe('boundedStep', () => {
  it('caps an upward move at max_step', () => {
    expect(boundedStep(0.5, 0.9, makeDial())).toBeCloseTo(0.55, 10);
  });

  it('caps a downward move at max_step', () => {
    expect(boundedStep(0.5, 0.1, makeDial())).toBeCloseTo(0.45, 10);
  });

  it('lands exactly on a target already inside the step cap', () => {
    expect(boundedStep(0.5, 0.52, makeDial())).toBeCloseTo(0.52, 10);
  });

  it('never crosses the ceiling even when the step would allow it', () => {
    expect(boundedStep(0.88, 5, makeDial())).toBe(0.9);
  });

  it('never crosses the floor even when the step would allow it', () => {
    expect(boundedStep(0.12, -5, makeDial())).toBe(0.1);
  });

  it('pulls a value already outside the band back inside — the hard band wins', () => {
    // An operator narrowed the band after the value was written.
    expect(boundedStep(2, 2, makeDial())).toBe(0.9);
  });
});

describe('moveDirection', () => {
  it('reads a decrease as tightening when tighten_is decrease', () => {
    expect(moveDirection(0.5, 0.4, makeDial({ tighten_is: 'decrease' }))).toBe('tighten');
  });

  it('reads an increase as loosening when tighten_is decrease', () => {
    expect(moveDirection(0.5, 0.6, makeDial({ tighten_is: 'decrease' }))).toBe('loosen');
  });

  it('reads an increase as tightening when tighten_is increase', () => {
    expect(moveDirection(0.5, 0.6, makeDial({ tighten_is: 'increase' }))).toBe('tighten');
  });

  it('reads a decrease as loosening when tighten_is increase', () => {
    expect(moveDirection(0.5, 0.4, makeDial({ tighten_is: 'increase' }))).toBe('loosen');
  });

  it('treats a no-op as tightening — it relaxes nothing, so it needs no approval', () => {
    expect(moveDirection(0.5, 0.5, makeDial())).toBe('tighten');
  });
});

describe('applyGuardrail', () => {
  it('gates a loosening when gating is on', () => {
    const outcome = applyGuardrail(0.5, 0.9, makeDial({ tighten_is: 'decrease' }), true);
    expect(outcome).toEqual({ to: 0.55, direction: 'loosen', gated: true });
  });

  it('does not gate a tightening', () => {
    const outcome = applyGuardrail(0.5, 0.1, makeDial({ tighten_is: 'decrease' }), true);
    expect(outcome).toEqual({ to: 0.45, direction: 'tighten', gated: false });
  });

  it('never gates when gating is off, even for a loosening', () => {
    const outcome = applyGuardrail(0.5, 0.9, makeDial({ tighten_is: 'decrease' }), false);
    expect(outcome.gated).toBe(false);
  });

  it('reports the direction of the BOUNDED move, not the raw target', () => {
    // Target is far past the ceiling; the bounded move is still a loosening.
    const outcome = applyGuardrail(0.5, 99, makeDial({ tighten_is: 'decrease' }), true);
    expect(outcome.to).toBeCloseTo(0.55, 10);
    expect(outcome.direction).toBe('loosen');
  });

  it('does not gate a move the hard band flattens to a no-op', () => {
    // Already at the ceiling, asked to loosen further: nothing to approve.
    const outcome = applyGuardrail(0.9, 99, makeDial({ tighten_is: 'decrease' }), true);
    expect(outcome).toEqual({ to: 0.9, direction: 'tighten', gated: false });
  });
});
