export interface FillRequest {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;
  order_type: 'market' | 'limit';
  limit_price?: number;
  idempotency_key: string;
}

export interface MarketState {
  mid: number;
  spread?: number | null;
  adv: number;
  volatility: number;
  asset_class: 'crypto' | 'stocks';
  venue?: CostVenue;
  timestamp: Date;
}

export interface CostBreakdown {
  spread_cost: number;
  commission: number;
  slippage: number;
  market_impact: number;
}

export interface CostModelResult {
  fill_price: number;
  filled_size: number;
  cost_breakdown: CostBreakdown;
  seed?: number;
}

export type CostVenue = 'saxo';

export interface CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult;
}
