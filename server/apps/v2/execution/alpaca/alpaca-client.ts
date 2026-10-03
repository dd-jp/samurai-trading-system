export interface AlpacaOrderLeg {
  id: string;
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

export interface AlpacaBrokerClient {
  submitOrder(request: AlpacaBracketOrderRequest): Promise<AlpacaOrder>;
  submitMarketOrder(request: AlpacaMarketOrderRequest): Promise<AlpacaOrder>;
  submitOcoOrder(request: AlpacaOcoOrderRequest): Promise<AlpacaOrder>;
  cancelOrder(alpacaOrderId: string): Promise<void>;
  getPositions(): Promise<AlpacaPosition[]>;
  getOrder(alpacaOrderId: string): Promise<AlpacaOrder>;
  getOrderByClientOrderId(clientOrderId: string): Promise<AlpacaOrder | null>;
  listOpenOrders(): Promise<AlpacaOrder[]>;
  getAccount(): Promise<AlpacaAccount>;
}

export interface AlpacaAccount {
  cash: string;
  equity: string;
  buying_power?: string;
  last_equity?: never;
}
