/**
 * Cost Model — core fill() (ticket #87). See docs/specs/cost-model-backtest-spec.md
 * ("Module: Cost Model" — Fill-price construction).
 */
import type { CostConfig, CostModel, CostModelResult, FillRequest, MarketState } from './types.js';

/**
 * Structural non-zero floor (Principle 1): applied beneath whatever a
 * `CostConfig` supplies, so even the most optimistic config cannot
 * construct a frictionless fill. Expressed as a fraction of notional /
 * volatility so the floor scales sensibly rather than being a fixed
 * currency amount.
 */
const STRUCTURAL_MIN_HALF_SPREAD_RATE = 0.0001; // 1 bp of mid
const STRUCTURAL_MIN_COMMISSION_RATE = 0.0001; // 1 bp of notional

export class CostModelImpl implements CostModel {
  constructor(private readonly config: CostConfig) {}

  fill(request: FillRequest, marketState: MarketState): CostModelResult {
    if (marketState.adv <= 0) {
      throw new Error(
        `CostModel.fill: marketState.adv must be > 0 (got ${marketState.adv}) for ${request.instrument}`,
      );
    }

    const assetConfig = this.config[marketState.asset_class];
    const sign = request.side === 'buy' ? 1 : -1;

    const rawSpread =
      marketState.spread ?? marketState.volatility * assetConfig.spreadVolatilityCoefficient;
    const half_spread = Math.max(rawSpread / 2, marketState.mid * STRUCTURAL_MIN_HALF_SPREAD_RATE);

    const notional = request.size * marketState.mid;
    const commission = Math.max(
      assetConfig.commissionRate * notional,
      STRUCTURAL_MIN_COMMISSION_RATE * notional,
    );

    const slippage = marketState.volatility * assetConfig.slippageCoefficient;

    const market_impact =
      assetConfig.impactK * marketState.volatility * Math.sqrt(request.size / marketState.adv);

    const fill_price = marketState.mid + sign * (half_spread + slippage + market_impact);

    return {
      fill_price,
      filled_size: request.size,
      cost_breakdown: {
        spread_cost: half_spread,
        commission,
        slippage,
        market_impact,
      },
    };
  }
}
