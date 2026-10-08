import type { BrokerActivityStatus } from '../../../../../contracts/index.js';

export interface AlpacaOrderLeg {
  id: string;
  client_order_id?: string;
  side?: 'buy' | 'sell';
  qty?: string;
  type: 'limit' | 'stop';
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  stop_price?: string | null;
  limit_price?: string | null;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  order_class: string;
  type?: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
  legs?: AlpacaOrderLeg[];
  limit_price?: string | null;
  stop_price?: string | null;
}

export interface AlpacaBracketOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  limit_price: string;
  stop_price?: string;
  time_in_force: string;
  client_order_id: string;
  order_class: 'bracket';
  take_profit: { limit_price: string };
  stop_loss: { stop_price: string };
}

export interface AlpacaOcoOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  time_in_force: string;
  client_order_id: string;
  order_class: 'oco';
  take_profit: { limit_price: string };
  stop_loss: { stop_price: string };
}

export interface AlpacaMarketOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: string;
  time_in_force: string;
  client_order_id: string;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  side: 'long' | 'short';
  avg_entry_price: string;
}

// Alpaca's GET /v2/orders reference: limit "defaults to 50 and max is 500"; measured on paper
// 2026-10-07 (#2086), `nested=true` counts legs toward it
export const ALPACA_ORDER_PAGE_LIMIT = 500;
export const ALPACA_ORDER_MAX_PAGES = 20;

export interface AlpacaBrokerClient {
  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder>;
  submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder>;
  submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder>;
  cancelOrder(alpacaOrderId: string): Promise<void>;
  getPositions(): Promise<AlpacaPosition[]>;
  getOrder(alpacaOrderId: string): Promise<AlpacaOrder>;
  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null>;
  // Both listings page through every match or throw: a listing cut at the page limit is never complete
  listOpenOrders(): Promise<AlpacaOrder[]>;
  listOrderHistory(symbols: readonly string[]): Promise<AlpacaOrder[]>;
  getAccount(): Promise<AlpacaAccount>;
  listCashInLieu?(after: string, pageToken?: string): Promise<AlpacaCashInLieuActivity[]>;
  listCashActivities?(
    types: readonly string[],
    after: string,
    pageToken?: string,
  ): Promise<AlpacaCashActivity[]>;
}

export interface AlpacaCashActivity {
  id: string;
  activity_type: string;
  date: string;
  net_amount: string;
  status: BrokerActivityStatus;
}

export interface AlpacaCashInLieuActivity {
  id: string;
  activity_type: 'CIL';
  date: string;
  net_amount: string;
  symbol: string;
  qty?: string | null;
  status: BrokerActivityStatus;
}

export interface AlpacaAccount {
  cash: string;
  equity: string;
  buying_power?: string;
  last_equity?: never;
}
