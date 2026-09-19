import { isFiniteNumber } from '../is-finite-number.js';
import { parseJsonColumnAsObject } from '../parse-json-column.js';
import type { OpenPosition, OrderState } from '../types/records.js';
import { fromStoredTimestamp } from './sqlite-utils.js';

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
  residual_unprotected_since: string | null;
  residual_rearm_alerted_at: string | null;
  residual_rearm_unsupported_alerted_at: string | null;
  decision_price: number | null;
  quote_bid: number | null;
  quote_ask: number | null;
  quote_mid: number | null;
  quote_observed_at: string | null;
  modelled_cost_breakdown_json: string | null;
  modelled_protective_exit_cost_breakdown_json: string | null;
  abandon_reason: string | null;
}

export type ModelledCostBreakdown = NonNullable<OpenPosition['modelled_cost_breakdown']>;

export function parseModelledCostBreakdownColumn(raw: string | null): ModelledCostBreakdown | null {
  const parsed = parseJsonColumnAsObject(raw);
  if (parsed === null) return null;
  if (
    !('spread_cost' in parsed) ||
    !('commission' in parsed) ||
    !('slippage' in parsed) ||
    !('market_impact' in parsed)
  ) {
    return null;
  }

  const { spread_cost, commission, slippage, market_impact } = parsed;
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
  const modelledProtectiveExitCostBreakdown = parseModelledCostBreakdownColumn(
    row.modelled_protective_exit_cost_breakdown_json,
  );

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
    ...(row.decision_price === null ? {} : { decision_price: row.decision_price }),
    ...(row.quote_bid === null ? {} : { quote_bid: row.quote_bid }),
    ...(row.quote_ask === null ? {} : { quote_ask: row.quote_ask }),
    ...(row.quote_mid === null ? {} : { quote_mid: row.quote_mid }),
    ...(row.quote_observed_at === null
      ? {}
      : { quote_observed_at: fromStoredTimestamp(row.quote_observed_at) }),
    ...(modelledCostBreakdown === null ? {} : { modelled_cost_breakdown: modelledCostBreakdown }),
    ...(modelledProtectiveExitCostBreakdown === null
      ? {}
      : { modelled_protective_exit_cost_breakdown: modelledProtectiveExitCostBreakdown }),
    ...(row.abandon_reason === null ? {} : { abandon_reason: row.abandon_reason }),
  };
}
