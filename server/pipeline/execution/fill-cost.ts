/**
 * Fill cost accounting shared by every path that turns a venue fill into a
 * persisted `Fill` row — `toFill` and `cumulativeTopUp` (ingest-fills.ts) for
 * entry legs, `splitFlattenFills` (flatten-attribution.ts) for flatten legs.
 * Pure: how the modelled estimate is prorated and how the venue's reported fee
 * is topped up to it, with nothing about where either number came from.
 */

import type { Fill, OpenPosition } from '../../shared/index.js';

/**
 * #1121: the charge a real-broker fill carries — the venue's own reported fee
 * TOPPED UP to the modelled commission, never stacked on top of it.
 *
 * `venueFee + max(0, modelled − venueFee)`, i.e. `max(venueFee, modelled)`,
 * never `venueFee + modelled` — the two numbers are the same commission.
 * `venueFee + modelled` is correct only for a commission-free venue, which is
 * an Alpaca-paper accident, not a property of the mechanism: `saxo-adapter.ts`
 * reports `price * qty * SAXO_COMMISSION_RATE` and `paper-profile.ts` prices
 * the modelled estimate from the SAME `SAXO_COMMISSION_RATE` constant, so
 * adding them would charge the live arm 2x — with no venue check, no
 * `fee === 0` precondition, and no test that could see it.
 *
 * `max` rather than "defer to the venue whenever it reports anything": a venue
 * that reports a small NON-commission fee (a regulatory or exchange charge)
 * would otherwise suppress the whole modelled commission and put the arms back
 * on different cost bases, which is the defect this ticket exists to close.
 *
 * WHAT `max` COSTS (#1121). `max` treats the venue's report and the model's estimate
 * as two measurements of ONE commission. Where a venue charge is genuinely
 * ADDITIONAL to commission, `max` absorbs it instead of adding it: a levy
 * smaller than the modelled commission is charged nothing extra, and a levy
 * LARGER than it displaces the modelled commission entirely. The alternative
 * (`venueFee + modelled`) has the mirror failure and a worse one — it
 * double-charges the commission itself on every Saxo fill, which is this
 * ticket's whole defect. `max` is chosen on the venues actually in play, not
 * as a general truth: Alpaca paper reports `fee: 0`; `saxo-adapter.ts`'s
 * reported `fee` is commission-only; ADR-0015 records no per-order minimum;
 * SDRT is structurally exempt on the ETFs/ETCs this book trades; and the PTM
 * levy's £10,000 order threshold is unreachable at a £1,000 book. Add a venue
 * with an additive levy and this function is the place that has to change.
 *
 * SCOPE OF "CHARGED ONCE". This is a PER-FILL rule, and it does not aggregate
 * to a per-lot equality, because `max` is applied to each slice separately and
 * `Σ max(aᵢ, bᵢ) ≥ max(Σa, Σb)`. Over a lot's fills the total charge is
 * bounded by `[max(Σvenue, Σmodelled), Σvenue + Σmodelled]`, hitting the lower
 * bound only when one side dominates slice by slice. Both bounds follow from
 * `max(a, b) ≥ a, b` and `max(a, b) ≤ a + b` on non-negative inputs, which the
 * two call sites guarantee (`Math.max(0, …)` on the cumulative top-up;
 * `rawFill.fee * share` with a non-negative venue fee on the flatten split).
 * The gap is real, not hypothetical, wherever the venue's per-increment fee
 * crosses the modelled share: 100 shares filled 50/50 against a modelled 1.0
 * with venue increments 0.7 then 0.3 charges `0.7 + 0.5 = 1.2`, not 1.0. On
 * the cumulative path that is synthetic today (it is Alpaca-only and Alpaca
 * reports 0); on `redistributeOneFlatten`'s multi-raw-fill split it is
 * reachable under Saxo, whose fee tracks each execution's fill price while the
 * modelled share tracks quantity alone. The magnitude there is bps of bps, so
 * the money is negligible — it is the invariant that has to be stated
 * honestly, not the arithmetic that has to change.
 */
export function chargeTopUpTo(venueFee: number, modelledCommission: number | undefined): number {
  return modelledCommission === undefined ? venueFee : Math.max(venueFee, modelledCommission);
}

/**
 * #1001: scales every component of a modelled cost breakdown by `share` — the
 * same linear approximation `redistributeOneFlatten`'s `fee: rawFill.fee *
 * share` already makes for the flatten split, extended to the OTHER money
 * this snapshot carries. Not physically exact for `market_impact` (the
 * cost model's own √-law term is nonlinear in size), but consistent with the
 * existing precedent rather than inventing a second approximation scheme, and
 * still strictly better than attaching the UNSCALED snapshot to every fill a
 * single modelled estimate happens to cover.
 */
export function prorateCostBreakdown(
  breakdown: NonNullable<Fill['cost_breakdown']>,
  share: number,
): NonNullable<Fill['cost_breakdown']> {
  return {
    spread_cost: breakdown.spread_cost * share,
    commission: breakdown.commission * share,
    slippage: breakdown.slippage * share,
    market_impact: breakdown.market_impact * share,
  };
}

/**
 * #1001's fallback source for an `'entry'` leg's modelled cost breakdown —
 * `OpenPosition.modelled_cost_breakdown`, captured once at submit time
 * (`execute.ts`'s `captureSubmitSnapshot`) against the lot's whole
 * `requested_size`. `null` when the lot carries none (pre-migration-0037 row,
 * or the submit-time capture failed) — `toFill`'s caller then leaves
 * `cost_breakdown` unset, exactly as before this ticket.
 */
export interface ModelledEntryCost {
  breakdown: NonNullable<Fill['cost_breakdown']>;
  requestedSize: number;
}

export function modelledEntryCostFor(position: OpenPosition): ModelledEntryCost | null {
  return position.modelled_cost_breakdown === undefined
    ? null
    : { breakdown: position.modelled_cost_breakdown, requestedSize: position.requested_size };
}
