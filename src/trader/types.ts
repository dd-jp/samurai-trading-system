/**
 * Domain types & config for the Trader (Stage 3).
 * See docs/specs/trader-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (registry #1 OrderIntent, #2 DebateResult).
 * Implementation ticket #73 — the no-position entry path only.
 *
 * `OrderIntent` / `OrderIntentMetadata` are NOT redefined here: they are
 * cross-spec types owned by src/shared/types.ts (registry #1).
 */
import type { DebateResult } from '../debate-engine/index.js';
import type { MarketDataService } from '../market-data-service/index.js';
import type { Clock, OpenPosition, OrderIntent } from '../shared/index.js';

/** Asset classes the risk multiplier is keyed on, matching `Mark.asset_class`. */
export type AssetClass = 'crypto' | 'stocks';

/**
 * Every field here is flagged "config, tuned in paper trading" by
 * trader-spec.md ("Out of Scope" → Exact parameter values); the defaults in
 * DEFAULT_TRADER_CONFIG are starting points, not tuned values. Injected
 * rather than module-global so tests can pin thresholds explicitly.
 */
export interface TraderConfig {
  /** Below this conviction there is no edge to act on — no entry. */
  conviction_floor: number;
  /**
   * Hard per-trade risk cap as a fraction of equity, reached at conviction
   * 1.0. Deliberately a small fraction, well under Kelly (research: full
   * Kelly implies 50-80% drawdowns). The Trader enforces only this per-trade
   * cap; portfolio and asset-class exposure caps are the Risk Manager's.
   */
  max_risk_per_trade: number;
  /**
   * Scales `max_risk_per_trade` down per asset class. Crypto is strictly
   * more conservative than stocks (research: fat-tailed markets warrant
   * quarter-Kelly or less), so the same conviction yields a smaller crypto
   * position than an equivalent stock position.
   */
  asset_class_risk_multiplier: Record<AssetClass, number>;
  /** Timeframe of the bars ATR is computed from. */
  atr_timeframe: string;
  /** Number of true-range periods averaged into ATR. */
  atr_lookback: number;
  /** Stop distance = atr_k x max(ATR, vol floor). */
  atr_k: number;
  /**
   * The volatility floor, expressed as a fraction of entry price rather than
   * an absolute price distance: ATR is in price units, so an absolute floor
   * could not be one config shared across BTC-USD and AAPL. Bounds size from
   * below when volatility is ultra-low.
   */
  vol_floor_fraction: number;
  /** Applied when the debate did not converge (`converged: false`). */
  non_converged_haircut: number;
  /**
   * Target distance as a multiple of the stop distance. trader-spec.md
   * requires a target on the bracket but does not pin how far out it sits;
   * deriving it from the stop keeps the reward:risk ratio constant across
   * volatility regimes rather than fixing an arbitrary price distance.
   */
  reward_risk_multiple: number;
  /**
   * Minimum viable position notional (size x entry). Below this the Trader
   * skips rather than placing dust. Stands in for the broker minimum order
   * size until the broker abstraction lands (Execution, epic #57).
   */
  min_viable_notional: number;
  time_in_force: string;
  /**
   * #74: minimum conviction rise (current debate minus the position's
   * stored `conviction`) that qualifies a same-direction hold for a bounded
   * `scale_in` instead of a hold. Config, tuned in paper trading, like
   * every other threshold here.
   */
  scale_in_conviction_delta: number;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  conviction_floor: 0.55,
  max_risk_per_trade: 0.01,
  asset_class_risk_multiplier: {
    crypto: 0.5,
    stocks: 1.0,
  },
  atr_timeframe: '1h',
  atr_lookback: 14,
  atr_k: 2.0,
  vol_floor_fraction: 0.002,
  non_converged_haircut: 0.5,
  reward_risk_multiple: 2.0,
  min_viable_notional: 10,
  time_in_force: 'day',
  scale_in_conviction_delta: 0.1,
};

/**
 * Fully deterministic given its inputs + the clock-scoped market data.
 *
 * Narrower than trader-spec.md's `TraderInput`: `setupStore` (#75, cosine
 * precedent) is absent — nothing in this codebase consults it yet.
 */
export interface TraderInput {
  /** Cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /**
   * Not on trader-spec.md's `TraderInput`, and `DebateResult` carries no
   * instrument either — but `OrderIntent.instrument` cannot be constructed
   * without it. The Orchestrator's tick is per-instrument (orchestrator-spec.md),
   * so it is threaded in alongside the debate.
   */
  instrument: string;
  debate: DebateResult;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  marketData: MarketDataService;
  equity: number;
  config: TraderConfig;
  /**
   * #74: position-aware branching. Live snapshot, not point-in-time — the
   * Trader only ever runs on the current tick, unlike replay-scoped market
   * data. Narrowed to a single function (matching
   * `src/orchestrator/production/direct-bind.ts`'s `getOpenPositions`
   * dependency), not the full `SharedStore`. `decide()` filters the
   * returned lots down to `instrument` itself.
   */
  positionState: () => Promise<OpenPosition[]>;
}

/** The single test seam. `decide` in ./decide.ts is its implementation. */
export interface Trader {
  /**
   * Async, where trader-spec.md writes it synchronously: `getMark`/`getBars`
   * return promises, so the spec's signature is shorthand rather than a
   * constraint. null = skip / no-trade.
   */
  decide(input: TraderInput): Promise<OrderIntent | null>;
}
