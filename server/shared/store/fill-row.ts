import type { ExitReason, Fill } from '../types/records.js';
import { toBrokerFillId } from '../types/records.js';
import { fromStoredTimestamp } from './sqlite-utils.js';

export interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
  cost_breakdown_json: string | null;
  exit_reason: ExitReason | null;
  flatten_idempotency_key: string | null;
  fee_currency: string | null;
  fx_rate_to_gbp: number | null;
  fx_rate_to_gbp_source: string | null;
}

export function fromFillRow(row: FillRow): Fill {
  return {
    idempotency_key: row.idempotency_key,
    broker_fill_id: toBrokerFillId(row.broker_fill_id),
    leg: row.leg,
    price: row.price,
    qty: row.qty,
    fee: row.fee,
    timestamp: fromStoredTimestamp(row.timestamp),
    ...(row.cost_breakdown_json === null
      ? {}
      : {
          cost_breakdown: JSON.parse(row.cost_breakdown_json) as NonNullable<
            Fill['cost_breakdown']
          >,
        }),
    ...(row.exit_reason === null ? {} : { exit_reason: row.exit_reason }),
    ...(row.flatten_idempotency_key === null
      ? {}
      : { flatten_idempotency_key: row.flatten_idempotency_key }),
    ...(row.fee_currency === null ? {} : { fee_currency: row.fee_currency }),
    ...(row.fx_rate_to_gbp === null ? {} : { fx_rate_to_gbp: row.fx_rate_to_gbp }),
    ...(row.fx_rate_to_gbp_source === null
      ? {}
      : { fx_rate_to_gbp_source: row.fx_rate_to_gbp_source }),
  };
}
