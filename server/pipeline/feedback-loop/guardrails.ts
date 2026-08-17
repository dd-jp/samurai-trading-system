/**
 * Bounded, asymmetric guardrails (#91). See
 * docs/specs/feedback-loop-spec.md ("Module: Guardrailed Tuning").
 *
 * One rule: BOUNDED — a cycle moves a dial at most `max_step`, and never
 * outside the human-set `[floor, ceiling]`. This is what stops a single bad
 * day swinging a weight (acceptance criterion #4).
 *
 * The second rule used to be ASYMMETRIC-BY-APPROVAL: a risk threshold could
 * auto-tighten freely, but loosening one waited on a human. **That gate is
 * gone** ([ADR-0013](../../../docs/adr/0013-no-human-gate-anywhere.md)
 * Decision 2, #736) — "a queue that nobody drains is not a control — it is a
 * permanently-stuck dial that reads as governed." Every move now applies.
 *
 * The asymmetry that survives is not approval-vs-no-approval, and it is not
 * enforced here: it is that loosening is BOUNDED where tightening is free —
 * by `[floor, ceiling]` below, and past that by the in-code clamp on the
 * guarded thresholds (`server/shared/threshold-bounds.ts`, #638), which
 * REFUSES a crossing at the tuning store's write door rather than coercing
 * it. This module still only step-caps and clamps; it decides nothing about
 * who may move a dial, because nobody has to be asked.
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
 * calling it a loosening would announce a relaxation that did not happen.
 */
export function moveDirection(from: number, to: number, dial: TunableDial): 'tighten' | 'loosen' {
  if (to === from) {
    return 'tighten';
  }
  const increased = to > from;
  return increased === (dial.tighten_is === 'increase') ? 'tighten' : 'loosen';
}

export interface GuardrailOutcome {
  /** The bounded value. Always written by the caller when it differs from `current`. */
  to: number;
  direction: 'tighten' | 'loosen';
}

/**
 * Route one proposed move through the guardrails.
 *
 * There is no per-dial variation left: weights, strategy params and risk
 * thresholds all step-cap and clamp identically. The `gate_loosening`
 * parameter and the `gated` outcome it produced were removed with the human
 * gate (#736) rather than left defaulted to `false`, so no caller can
 * reintroduce a wait-for-a-human path by passing `true`.
 */
export function applyGuardrail(
  current: number,
  target: number,
  dial: TunableDial,
): GuardrailOutcome {
  const to = boundedStep(current, target, dial);
  return { to, direction: moveDirection(current, to, dial) };
}
