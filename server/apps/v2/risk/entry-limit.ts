import type { OrderSide, SleeveDecision } from '../../../../contracts/index.js';

// David ruled 2026-09-29 on #1815 (superseding doc 72's 0 bps): a buy rests at the decision
// close x 1.005, a short at x 0.995. 50 bps is a judgement with no measurement behind it;
// changing the reference or the cap is a new counted trial (Q16)
export const ENTRY_LIMIT_OFFSET = { reference: 'decision_close', capBps: 50 } as const;

const BPS = 10_000;

export function marketableLimit(side: OrderSide, decisionClose: number): number {
  const offset = (decisionClose * ENTRY_LIMIT_OFFSET.capBps) / BPS;
  return side === 'buy' ? decisionClose + offset : decisionClose - offset;
}

export function entryLimitFor(side: OrderSide, decision: SleeveDecision): number {
  return decision.entry_limit ?? marketableLimit(side, decision.price);
}

export function offsetRefusal(
  side: OrderSide,
  limit: number,
  stop: number,
  target: number,
): 'offset_past_stop' | 'offset_past_target' | undefined {
  const buy = side === 'buy';
  if (buy ? limit <= stop : limit >= stop) return 'offset_past_stop';
  if (buy ? limit >= target : limit <= target) return 'offset_past_target';
  return undefined;
}
