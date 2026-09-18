import type { TunableDial } from './types.js';

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function boundedStep(current: number, target: number, dial: TunableDial): number {
  const step = clamp(target - current, -dial.max_step, dial.max_step);
  return clamp(current + step, dial.floor, dial.ceiling);
}

export function moveDirection(from: number, to: number, dial: TunableDial): 'tighten' | 'loosen' {
  if (to === from) {
    return 'tighten';
  }
  const increased = to > from;
  return increased === (dial.tighten_is === 'increase') ? 'tighten' : 'loosen';
}

export interface GuardrailOutcome {
  to: number;
  direction: 'tighten' | 'loosen';
}

export function applyGuardrail(
  current: number,
  target: number,
  dial: TunableDial,
): GuardrailOutcome {
  const to = boundedStep(current, target, dial);
  return { to, direction: moveDirection(current, to, dial) };
}
