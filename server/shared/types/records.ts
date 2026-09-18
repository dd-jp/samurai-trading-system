import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { LotHeldQuantity } from '../held-quantity.js';
import type { AssetClass, TradingArm } from './primitives.js';

export interface OrderIntent {
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in' | 'exit';
  size: number;
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
  decision_timestamp: Date;
  decided_at: Date;
  metadata: OrderIntentMetadata;
}

export type ExitReason =
  | 'flatten'
  | 'signal_decay'
  | 'direction_flip';

interface OrderIntentMetadata {
  debate_id: string;
  arm?: TradingArm;
  exit_reason?: ExitReason;
  unpriced_exit?: true;
  mandatory_flatten?: true;
  lot_held_quantities?: readonly LotHeldQuantity[];
  conviction: number;
  converged: boolean;
  sizing: {
    base_risk_fraction: number;
    conviction_multiplier: number;
    vol_floor_factor: number;
    non_converged_haircut: number;
    cosine_multiplier: number;
    frozen_bracket?: {
      take_profit_pct: number;
      stop_pct: number;
      deployment_fraction: number;
      round_trip_cost_pct: number;
      headroom_reserve_fraction?: number;
    };
    unquantised_size?: number;
  };
  cosine_precedent: {
    neighbor_count: number;
    weighted_mean_r: number | null;
    no_precedent: boolean;
  };
}

export interface SetupVector {
  debate_features: number[];
  market_features: number[];
}

export interface SetupNeighbor {
  vector: SetupVector;
  r_multiple: number;
  closed_at: Date;
}

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

export interface VerdictLog {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  status: 'go' | 'no_go';
  no_go_reason: string | null;
  no_go_detail_measured_ms: number | null;
  no_go_detail_bound_ms: number | null;
  hitl_override: boolean;
  timestamp: Date;
}

export type { OrderState } from '../../../contracts/index.js';

import type { OrderState } from '../../../contracts/index.js';

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

export type BrokerFillId = string & { readonly __brand: 'BrokerFillId' };
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

export interface ClosedTrade {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  filled_size: number;
  realized_pnl_net: number;
  fees_total: number;
  opened_at: Date;
  closed_at: Date;
  close_reason: 'stop' | 'target' | 'exit' | ExitReason;
  modelled_cost_charged: boolean;
}
