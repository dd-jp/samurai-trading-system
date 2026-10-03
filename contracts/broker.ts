import type { OrderState } from './primitives.js';

export type BrokerFillId = string & { readonly __brand: 'BrokerFillId' };
export type ExitReason = 'flatten' | 'signal_decay' | 'direction_flip';

export interface NativeBracketRequest {
  client_order_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  size: number;
  entry: number;
  entry_trigger?: number | undefined;
  stop: number;
  target: number;
  time_in_force: string;
}

export interface BrokerAck {
  client_order_id: string;
  broker_order_ids: string[];
  order_state: OrderState;
}

export interface NormalizedFill {
  client_order_id: string;
  broker_fill_id: BrokerFillId;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  fee_currency?: string;
  fx_rate_to_gbp?: number;
  fx_rate_to_gbp_source?: string;
  timestamp: string;
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  qty_is_cumulative?: boolean;
  exit_reason?: ExitReason;
  flatten_idempotency_key?: string;
}

export interface NormalizedOrder {
  client_order_id: string;
  broker_order_ids: string[];
  order_state: OrderState;
  filled_qty: number;
}

export interface NormalizedPosition {
  instrument: string;
  qty: number;
  side: 'buy' | 'sell';
  avg_entry_price: number | null;
}

export interface ProtectedExitRequest {
  readonly entryClientOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: 'buy' | 'sell';
  readonly size: number;
  readonly rearm: { readonly stop: number; readonly target: number } | undefined;
}

export interface ProtectiveReplaceRequest {
  readonly entryClientOrderId: string;
  readonly instrument: string;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  readonly stop: number;
  readonly target: number;
}

export interface BrokerAdapter {
  submitBracket(order: NativeBracketRequest): Promise<BrokerAck>;
  getOrder(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null>;
  resumeFlatten(clientOrderId: string, instrument: string): Promise<NormalizedOrder | null>;
  fetchNewFills(since: string): Promise<NormalizedFill[]>;
  resizeProtectiveLegs(clientOrderId: string, filledQty: number): Promise<void>;
  rearmProtectiveLegs(
    clientOrderId: string,
    instrument: string,
    side: 'buy' | 'sell',
    qty: number,
    stop: number,
    target: number,
  ): Promise<void>;
  submitFlatten(
    instrument: string,
    side: 'buy' | 'sell',
    size: number,
    clientOrderId: string,
    timeInForce?: string,
  ): Promise<BrokerAck>;
  cancel(clientOrderId: string, instrument: string): Promise<void>;
  getOpenPositions(): Promise<NormalizedPosition[]>;
  readonly prices_own_fills?: boolean;
  submitProtectedExit?(request: ProtectedExitRequest): Promise<BrokerAck>;
  replaceProtectiveLegs?(request: ProtectiveReplaceRequest): Promise<number>;
}
