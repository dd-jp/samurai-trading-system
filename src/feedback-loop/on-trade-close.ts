/**
 * Setup-store R-labelling on trade close (#92). See
 * docs/specs/feedback-loop-spec.md ("Module: Setup Store Labelling").
 *
 * Event-driven, separate from the daily weight batch: fires once per
 * `ClosedTrade`, labelling the matching setup-store entry with the realized
 * R-multiple so the Trader's cosine precedent retrieval has ground truth.
 * Per-lot `ClosedTrade`/`debate_id` design (shared/types.ts) means a
 * scale-in's several per-lot closes each join to and label their own setup
 * entry independently.
 */
import type { ClosedTrade } from '../shared/index.js';
import { realizedR } from './attribution.js';
import type { OnTradeCloseInput } from './types.js';

/**
 * R = realized_pnl_net / (|entry - stop| x filled_size) — computed by
 * `realizedR` (frozen by cross-spec-contracts.md §4, shared with #91's
 * attribution so the formula is defined once). Joined to the setup store by
 * `debate_id`, the same key the Trader wrote the setup under
 * (`SetupStore.writeSetup`) — per-lot, so it doubles as the idempotency join
 * the issue describes: each lot's `ClosedTrade`/`debate_id` pair is unique.
 *
 * Skips (does not label) a trade with undefined R — a zero-width bracket or
 * a lot that never filled — the same rule #91's attribution uses: no
 * denominator, no label, rather than writing an infinite/undefined outcome.
 */
export function onTradeClose(
  trade: ClosedTrade,
  _trace_id: string,
  input: OnTradeCloseInput,
): void {
  const r = realizedR(trade);
  if (r === null) {
    return;
  }

  input.setup_store.labelSetup(trade.debate_id, r, trade.closed_at);
}
