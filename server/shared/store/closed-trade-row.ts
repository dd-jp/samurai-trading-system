import type { ClosedTrade, ExitReason } from '../types/records.js';
import { fromStoredTimestamp } from './sqlite-utils.js';

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
  close_reason: 'stop' | 'target' | 'exit' | ExitReason;
  modelled_cost_charged: 0 | 1;
}

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
    opened_at: fromStoredTimestamp(row.opened_at),
    closed_at: fromStoredTimestamp(row.closed_at),
    close_reason: row.close_reason,
    modelled_cost_charged: row.modelled_cost_charged === 1,
  };
}
