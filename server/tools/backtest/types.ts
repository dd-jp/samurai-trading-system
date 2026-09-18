import type { TickOutcome } from '../../apps/orchestrator/index.js';
import type { DateRange } from './universe.js';

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

export interface AssetClassCostConfig {
  spreadVolatilityCoefficient: number;
  commissionRate: number;
  slippageCoefficient: number;
  impactK: number;
}

export type CostVenue = 'saxo';

export interface CostFloors {
  minHalfSpreadRate: number;
  minCommissionRate: number;
}

export interface CostConfig {
  crypto: AssetClassCostConfig;
  stocks: AssetClassCostConfig;
  floors?: CostFloors;
  venues?: Partial<Record<CostVenue, Partial<AssetClassCostConfig>>>;
}

export interface CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult;
}

export interface ReplayTimeline {
  barTimestamps(window: DateRange): Promise<readonly Date[]>;
}

export interface BacktestReport {
  config_hash: string;
  seed: number;
  tick_outcomes: TickOutcome[];
  lookahead_audit: 'passed';
}
