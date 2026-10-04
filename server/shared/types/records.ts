import type { AnalystContribution, Direction } from '../debate/index.js';
import type { AssetClass } from './primitives.js';

export type DebateTermination = 'converged' | 'non_converged' | 'latency_truncated';

export type DebateTerminationCause = 'budget' | 'llm_failure';

export interface DebateLog {
  debate_id: string;
  instrument: string;
  bar_timestamp: Date;
  contributions: AnalystContribution[];
  direction: Direction;
  rounds: number;
  created_at: Date;
  trace_id?: string;
  confidence?: number;
  synthesis?: string;
  position?: string;
  disagreement_summary?: string;
  open_items?: string[];
  converged?: boolean;
  termination?: DebateTermination;
  termination_cause?: DebateTerminationCause;
}

export interface DebateRoundLogEntry {
  debate_id: string;
  round: number;
  direction: Direction;
  confidence: number;
  created_at: Date;
}

export type { BrokerFillId, OrderState } from '../../../contracts/index.js';

import type { BrokerFillId, ExitReason, OrderState } from '../../../contracts/index.js';

export interface OpenPosition {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  filled_size: number;
  avg_entry_price: number;
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string[];
  opened_at: Date;
  decision_timestamp: Date;
  conviction: number;
  converged: boolean;
  decision_price?: number;
  quote_bid?: number;
  quote_ask?: number;
  quote_mid?: number;
  quote_observed_at?: Date;
  modelled_cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  modelled_protective_exit_cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  abandon_reason?: string;
}

export function toBrokerFillId(value: string): BrokerFillId {
  return value as BrokerFillId;
}

export interface Fill {
  idempotency_key: string;
  broker_fill_id: BrokerFillId;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  exit_reason?: ExitReason;
  flatten_idempotency_key?: string;
  fee_currency?: string;
  fx_rate_to_gbp?: number;
  fx_rate_to_gbp_source?: string;
}
