/**
 * Bounded, asymmetric guardrails (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Guardrailed Tuning").
 *
 * Two rules, applied in order:
 *  1. BOUNDED — a cycle moves a dial at most `max_step`, and never outside
 *     the human-set `[floor, ceiling]`. This is what stops a single bad day
 *     swinging a weight (acceptance criterion #4).
 *  2. ASYMMETRIC — a risk threshold may auto-TIGHTEN freely; LOOSENING it
 *     requires a human. The loop can never relax its own safety limits
 *     unsupervised.
 *
 * Pure functions: they decide, they do not write.
 */
import type { TunableDial } from './types.js';

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The bounded value a cycle may move `current` to, given where it wants to
 * go. Step-capped first, then hard-clamped — so the hard band wins even if
 * `current` starts outside it (a floor/ceiling an operator has since
 * narrowed).
 */
export function boundedStep(current: number, target: number, dial: TunableDial): number {
  const step = clamp(target - current, -dial.max_step, dial.max_step);
  return clamp(current + step, dial.floor, dial.ceiling);
}

/**
 * Which way a move points relative to the dial's declared safe direction.
 * A no-op move (`to === from`) reports 'tighten': it relaxes nothing, so
 * treating it as a loosening would queue a pointless approval request.
 */
export function moveDirection(from: number, to: number, dial: TunableDial): 'tighten' | 'loosen' {
  if (to === from) {
    return 'tighten';
  }
  const increased = to > from;
  return increased === (dial.tighten_is === 'increase') ? 'tighten' : 'loosen';
}

export interface GuardrailOutcome {
  /** The bounded value — written iff `gated` is false. */
  to: number;
  direction: 'tighten' | 'loosen';
  /**
   * True when this move must wait for a human. Only ever true for a risk
   * threshold moving in its loosening direction.
   */
  gated: boolean;
}

/**
 * Route one proposed move through the guardrails.
 *
 * `gate_loosening` is true for risk thresholds and false for strategy params
 * and analyst weights — the spec gates only the safety dials; the other two
 * tune freely inside their bounds.
 */
export function applyGuardrail(
  current: number,
  target: number,
  dial: TunableDial,
  gate_loosening: boolean,
): GuardrailOutcome {
  const to = boundedStep(current, target, dial);
  const direction = moveDirection(current, to, dial);
  return { to, direction, gated: gate_loosening && direction === 'loosen' };
}
