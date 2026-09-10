/**
 * The `open_positions` row shape and its mapper, in one place — the same
 * arrangement `closed-trade-row.ts` gives `closed_trades`.
 *
 * Two readers cross this row: Execution's store (the table's sole writer) and
 * the dashboard's read-only query store. A second hand-kept copy of the row
 * cannot see a column it was never told about — the dashboard's copy omitted
 * every migration-0037 field until this module replaced it — so the column
 * list lives here and nowhere else. Every `SELECT` that feeds
 * `fromOpenPositionRow` must return every column below; `SELECT *` does.
 *
 * `OpenPositionRow` is deliberately NOT `OpenPosition`: timestamps are stored
 * TEXT, booleans are 0/1, JSON columns are strings. `fromOpenPositionRow` is
 * the only crossing.
 */

import type { OpenPosition, OrderState } from '../types/records.js';
import { fromStoredTimestamp } from './sqlite-utils.js';

/** One `open_positions` row exactly as `better-sqlite3` returns it. */
export interface OpenPositionRow {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string;
  opened_at: string;
  decision_timestamp: string;
  conviction: number;
  converged: 0 | 1;
  /** NULL unless a #549 unprotected-residual episode is open — migration 0024. */
  residual_unprotected_since: string | null;
  /** NULL until that episode's operator alert was posted — migration 0024. */
  residual_rearm_alerted_at: string | null;
  /** #1001, migration 0037 — see `OpenPosition.decision_price`. */
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: string | null;
  modelled_cost_breakdown_json: string | null;
  /** #1186, migration 0056 — set only when `order_state = 'abandoned'`. */
  abandon_reason: string | null;
}

export type ModelledCostBreakdown = NonNullable<OpenPosition['modelled_cost_breakdown']>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Degrades to `null` rather than throwing: the column is instrumentation a
 * pre-migration-0037 row and every failed submit-time capture already leave
 * `null`, and a corrupted byte in it must not abort the read of a REAL
 * position or fill (#1014 review, finding 4). `NaN`/`Infinity` are refused
 * with the wrong types — JSON cannot encode them, so their presence means the
 * column was not written by this codebase's `JSON.stringify`. The result is
 * rebuilt from four individually checked numbers so no `as` is needed (#509).
 */
export function parseModelledCostBreakdownColumn(raw: string | null): ModelledCostBreakdown | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate: Record<string, unknown> = parsed as Record<string, unknown>;

  const spread_cost = candidate['spread_cost'];
  const commission = candidate['commission'];
  const slippage = candidate['slippage'];
  const market_impact = candidate['market_impact'];
  if (
    !isFiniteNumber(spread_cost) ||
    !isFiniteNumber(commission) ||
    !isFiniteNumber(slippage) ||
    !isFiniteNumber(market_impact)
  ) {
    return null;
  }

  return { spread_cost, commission, slippage, market_impact };
}

export function fromOpenPositionRow(row: OpenPositionRow): OpenPosition {
  const modelledCostBreakdown = parseModelledCostBreakdownColumn(row.modelled_cost_breakdown_json);

  return {
    idempotency_key: row.idempotency_key,
    debate_id: row.debate_id,
    instrument: row.instrument,
    asset_class: row.asset_class,
    side: row.side,
    intent_type: row.intent_type,
    requested_size: row.requested_size,
    filled_size: row.filled_size,
    avg_entry_price: row.avg_entry_price,
    stop: row.stop,
    target: row.target,
    order_state: row.order_state,
    broker_order_ids: JSON.parse(row.broker_order_ids) as string[],
    opened_at: fromStoredTimestamp(row.opened_at),
    decision_timestamp: fromStoredTimestamp(row.decision_timestamp),
    conviction: row.conviction,
    converged: row.converged === 1,
    // Optional domain fields are OMITTED, not `null`, on a pre-migration row
    // (`exactOptionalPropertyTypes`) — the same convention as `fromFillRow`.
    ...(row.decision_price === null ? {} : { decision_price: row.decision_price }),
    ...(row.quote_bid === null ? {} : { quote_bid: row.quote_bid }),
    ...(row.quote_ask === null ? {} : { quote_ask: row.quote_ask }),
    ...(row.quote_mid === null ? {} : { quote_mid: row.quote_mid }),
    ...(row.quote_observed_at === null
      ? {}
      : { quote_observed_at: fromStoredTimestamp(row.quote_observed_at) }),
    ...(modelledCostBreakdown === null ? {} : { modelled_cost_breakdown: modelledCostBreakdown }),
    ...(row.abandon_reason === null ? {} : { abandon_reason: row.abandon_reason }),
  };
}
