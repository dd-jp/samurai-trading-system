/**
 * The `closed_trades` row shape and its mapper, in one place.
 *
 * Previously hand-copied into three modules — `dashboard/sqlite-query-store.ts`,
 * `feedback-loop/sqlite-closed-trade-store.ts` and
 * `execution/sqlite-store-harness.ts` — whose `fromClosedTradeRow` bodies were
 * byte-identical (md5 `995699e4…`). Consolidated per the code-quality audit's
 * M2; `sqlite-shared-store.ts` already gestured at this move in a comment.
 *
 * **`ClosedTradeRow` is deliberately NOT `ClosedTrade`.** The row is what SQLite
 * hands back — `opened_at`/`closed_at` are ISO-8601 TEXT. The domain record has
 * them as `Date`. Collapsing the two would push string-vs-Date confusion into
 * every consumer, so the boundary stays explicit and `fromClosedTradeRow` is the
 * only crossing.
 *
 * Execution is `closed_trades`' sole writer (shared-sqlite-store-spec.md,
 * cross-spec §4). Nothing here writes; this module is the read shape only.
 */

import type { ClosedTrade } from '../types/records.js';

/**
 * One `closed_trades` row exactly as `better-sqlite3` returns it.
 *
 * `asset_class` is spelled as the inlined union rather than the `AssetClass`
 * alias so this module stays a leaf — `shared/types.ts` defines `AssetClass` as
 * precisely `'crypto' | 'stocks'`, so the two spellings are the same type.
 */
export interface ClosedTradeRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: string;
  closed_at: string;
  close_reason: 'stop' | 'target' | 'exit';
}

/** Widens the stored ISO-8601 timestamps back into `Date`s. */
export function fromClosedTradeRow(row: ClosedTradeRow): ClosedTrade {
  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    entry: row.entry,
    stop: row.stop,
    filled_size: row.filled_size,
    realized_pnl_net: row.realized_pnl_net,
    fees_total: row.fees_total,
    opened_at: new Date(row.opened_at),
    closed_at: new Date(row.closed_at),
    close_reason: row.close_reason,
  };
}
