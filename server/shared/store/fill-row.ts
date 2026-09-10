/**
 * The `fills` row shape and its mapper — see `open-position-row.ts` for why
 * one module owns the column list for both of the table's readers. Every
 * `SELECT` that feeds `fromFillRow` must return every column below.
 */

import type { ExitReason, Fill } from '../types/records.js';
import { toBrokerFillId } from '../types/records.js';
import { fromStoredTimestamp } from './sqlite-utils.js';

/** One `fills` row exactly as `better-sqlite3` returns it. */
export interface FillRow {
  idempotency_key: string;
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: string;
  cost_breakdown_json: string | null;
  /** #793, migration 0031 — see `Fill.exit_reason`. */
  exit_reason: ExitReason | null;
  /** #1001, migration 0037 — see `Fill.flatten_idempotency_key`. */
  flatten_idempotency_key: string | null;
  /** #1220, migration 0054 — see `Fill.fee_currency`. */
  fee_currency: string | null;
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
  };
}
