import type {
  AssetClassCostConfig,
  CostConfig,
  CostFloors,
  CostModel,
  CostModelResult,
  CostVenue,
  FillRequest,
  MarketState,
} from './types.js';

const DEFAULT_COST_FLOORS: CostFloors = Object.freeze({
  minHalfSpreadRate: 0.0001,
  minCommissionRate: 0.0001,
});

function assertPositiveFloor(name: keyof CostFloors, value: number): void {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(
      `CostModelImpl: CostConfig.floors.${name} must be a finite number > 0 (got ${value}). ` +
        `Principle 1 (cost-model-backtest-spec.md:148) requires a non-zero spread+commission ` +
        `floor be structurally unrepresentable, not merely the current default's behaviour.`,
    );
  }
}

function assertValidOverrideFields(
  venue: CostVenue,
  override: Partial<AssetClassCostConfig>,
): void {
  for (const [field, value] of Object.entries(override) as Array<
    [keyof AssetClassCostConfig, number | undefined]
  >) {
    if (value === undefined) continue;
    if (!(Number.isFinite(value) && value >= 0)) {
      throw new Error(
        `CostModelImpl: CostConfig.venues.${venue}.${field} must be a finite number >= 0 ` +
          `(got ${value}).`,
      );
    }
  }
}

function assertValidVenueOverrides(venues: CostConfig['venues']): void {
  if (!venues) return;
  for (const [venue, override] of Object.entries(venues) as Array<
    [CostVenue, Partial<AssetClassCostConfig> | undefined]
  >) {
    if (!override) continue;
    assertValidOverrideFields(venue, override);
  }
}

export const SAXO_COMMISSION_RATE = 0.0008;

export class CostModelImpl implements CostModel {
  private readonly floors: CostFloors;

  constructor(private readonly config: CostConfig) {
    this.floors = config.floors ?? DEFAULT_COST_FLOORS;
    assertPositiveFloor('minHalfSpreadRate', this.floors.minHalfSpreadRate);
    assertPositiveFloor('minCommissionRate', this.floors.minCommissionRate);
    assertValidVenueOverrides(config.venues);
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
