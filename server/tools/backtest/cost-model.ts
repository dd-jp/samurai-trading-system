/**
 * Cost Model — core fill() (ticket #87). See docs/specs/cost-model-backtest-spec.md
 * ("Module: Cost Model" — Fill-price construction).
 */
import type {
  AssetClassCostConfig,
  CostConfig,
  CostFloors,
  CostModel,
  CostModelResult,
  FillRequest,
  MarketState,
} from './types.js';

/**
 * Structural non-zero floor (Principle 1): applied beneath whatever a
 * `CostConfig` supplies, so even the most optimistic config cannot
 * construct a frictionless fill. Expressed as a fraction of notional /
 * mid so the floor scales sensibly rather than being a fixed currency
 * amount.
 *
 * Calibration-addressable (#1000) via `CostConfig.floors` rather than a
 * hard-coded module constant — this is only the DEFAULT applied when a
 * config omits that field, so every config that predates `floors` keeps
 * behaving exactly as it did before this ticket.
 */
export const DEFAULT_COST_FLOORS: CostFloors = {
  minHalfSpreadRate: 0.0001, // 1 bp of mid
  minCommissionRate: 0.0001, // 1 bp of notional
};

/**
 * Principle 1 (cost-model-backtest-spec.md:148) requires the SUM
 * `half_spread + commission` to be non-zero and unrepresentable-as-zero.
 * Requiring each floor individually finite and > 0 is strictly stronger than
 * that (and simpler to enforce): it also catches the `NaN` case Principle 1
 * doesn't name but the mechanism shares — `Math.max(x, NaN)` evaluates to
 * `NaN`, which would silently corrupt `fill_price` rather than fail loudly.
 */
function assertPositiveFloor(name: keyof CostFloors, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(
      `CostModelImpl: CostConfig.floors.${name} must be a finite number > 0 (got ${value}). ` +
        `Principle 1 (cost-model-backtest-spec.md:148) requires a non-zero spread+commission ` +
        `floor be structurally unrepresentable, not merely the current default's behaviour.`,
    );
  }
}

export class CostModelImpl implements CostModel {
  private readonly floors: CostFloors;

  constructor(private readonly config: CostConfig) {
    this.floors = config.floors ?? DEFAULT_COST_FLOORS;
    assertPositiveFloor('minHalfSpreadRate', this.floors.minHalfSpreadRate);
    assertPositiveFloor('minCommissionRate', this.floors.minCommissionRate);
  }

  fill(request: FillRequest, marketState: MarketState): CostModelResult {
    if (marketState.adv <= 0) {
      throw new Error(
        `CostModel.fill: marketState.adv must be > 0 (got ${marketState.adv}) for ${request.instrument}`,
      );
    }

    const assetConfig = this.resolveAssetConfig(marketState);
    const sign = request.side === 'buy' ? 1 : -1;

    const rawSpread =
      marketState.spread ?? marketState.volatility * assetConfig.spreadVolatilityCoefficient;
    const half_spread = Math.max(rawSpread / 2, marketState.mid * this.floors.minHalfSpreadRate);

    const notional = request.size * marketState.mid;
    const commission = Math.max(
      assetConfig.commissionRate * notional,
      this.floors.minCommissionRate * notional,
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

  /**
   * Resolves the per-asset-class config, with an optional venue-keyed
   * override layered on top (#1000) — e.g. Saxo's 8bps commission rate
   * (ADR-0015:201) vs Alpaca's commission-free US equities, both
   * `asset_class: 'stocks'` and otherwise indistinguishable at this seam.
   * `marketState.venue` is not populated by any caller today (no
   * `SaxoAdapter` exists — ADR-0015's 2026-08-30 amendment), so this is
   * currently always the plain asset-class lookup.
   *
   * Merges field-by-field rather than `{ ...base, ...override }`: a
   * `Partial<AssetClassCostConfig>` that explicitly sets a field to
   * `undefined` would otherwise overwrite a real rate with `undefined` and
   * corrupt every downstream arithmetic op into `NaN`.
   */
  private resolveAssetConfig(marketState: MarketState): AssetClassCostConfig {
    const base = this.config[marketState.asset_class];
    const override = marketState.venue ? this.config.venues?.[marketState.venue] : undefined;
    if (!override) return base;

    const merged = { ...base };
    for (const key of Object.keys(override) as Array<keyof AssetClassCostConfig>) {
      const value = override[key];
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
}
