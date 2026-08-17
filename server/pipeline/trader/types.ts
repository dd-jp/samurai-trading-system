/**
 * Domain types & config for the Trader (Stage 3).
 * See docs/specs/trader-spec.md ("Key Interfaces") and
 * docs/specs/cross-spec-contracts.md (registry #1 OrderIntent, #2 DebateResult).
 * Implementation ticket #73 — the no-position entry path only.
 *
 * `OrderIntent` / `OrderIntentMetadata` are NOT redefined here: they are
 * cross-spec types owned by server/shared/types.ts (registry #1).
 */
import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
/** Asset classes the risk multiplier is keyed on, matching `Mark.asset_class`. */
import type {
  AssetClass,
  Clock,
  OpenPosition,
  OrderIntent,
  SetupStore,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { DEFAULT_EARLY_EXIT_CONFIG, type EarlyExitConfig } from './early-exit.js';

export type { AssetClass };

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
   * How long before the session close the book must be flat (#668).
   *
   * ADR-0014 records the horizon as **intraday, flat by market close, no
   * overnight carry**, and #657 fixed the rule at **close − 5 minutes**
   * resolved through the instrument's own `TradingCalendar`. An OFFSET rather
   * than a wall-clock constant, deliberately: the paper venue closes 16:00 ET
   * and the live LSE leg closes 16:30 London (12:30 on a half-day), and #656
   * measured only a two-hour overlap between the two sessions, so any shared
   * constant would be wrong for one of them.
   *
   * Inside this window the Trader flattens what it holds and opens nothing new.
   */
  flatten_before_close_ms: number;
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
  /**
   * Order time-in-force, **per asset class** (#381).
   *
   * One value cannot serve both, and this is a venue constraint rather than a
   * tuning knob. Alpaca's crypto venue accepts `gtc`/`ioc` only and rejects
   * `day` at submission; equities take `day`, which is also the reading that
   * matches an instrument whose session ends — a `day` order on a 24/7 venue
   * has no day to expire at, which is why `gtc` is the portable crypto choice
   * across ccxt/Kraken too, not merely the Alpaca-shaped one.
   *
   * Was a single `string` until the paper universe widened past BTC-USD
   * alone; the profile carried a `gtc` override precisely because the flat
   * field could not express both.
   */
  time_in_force: Record<'crypto' | 'stocks', string>;
  /**
   * #74: minimum conviction rise (current debate minus the position's
   * stored `conviction`) that qualifies a same-direction hold for a bounded
   * `scale_in` instead of a hold. Config, tuned in paper trading, like
   * every other threshold here.
   */
  scale_in_conviction_delta: number;
  /**
   * The indicator-based early exit's decay criterion (#748) — injected, so the
   * threshold that can close a real position is never a constant read out of
   * module scope. See `early-exit.ts` for the read it configures and
   * `DEFAULT_EARLY_EXIT_CONFIG` for the default's reasoning.
   *
   * Non-optional, for the reason `sessionCalendars` is: an optional block would
   * let the composition root drop it and leave the exit silently unarmed, which
   * in a soak log looks exactly like a session whose positions never decayed.
   */
  early_exit: EarlyExitConfig;
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
  time_in_force: { crypto: 'gtc', stocks: 'day' },
  scale_in_conviction_delta: 0.1,
  flatten_before_close_ms: 5 * 60 * 1_000,
  early_exit: DEFAULT_EARLY_EXIT_CONFIG,
};

/**
 * Refuse a `TraderConfig` that would silently disable a safety rule (#691).
 *
 * Called from the composition root, alongside `assertAutomationLevelSupported`
 * and for the same reason: a bad config should be refused while nothing is
 * half-constructed, on every boot, rather than on a branch something has to
 * reach first.
 *
 * `withinFlattenWindow` carries the same check, and keeping both is the point.
 * The runtime one alone was the whole objection to this fix on review: a
 * `flatten_before_close_ms` of 0 DEPLOYS CLEANLY, and first surfaces on a tick
 * that has already reached the Trader — which on a soak means hours of a
 * process that looks healthy and cannot honour ADR-0014. This one turns that
 * into a boot failure. The runtime one stays as the backstop for a config that
 * never passed through this seam (tests, the backtest harness, a future caller
 * constructing `TraderInput` directly).
 *
 * Deliberately narrow: only the fields whose bad values are SILENT. A wrong
 * `conviction_floor` produces visibly wrong trading; a zero
 * `flatten_before_close_ms` produces a rule that is simply never enforced, and
 * nothing in `trader_log` distinguishes that from a session with no positions
 * to flatten.
 */
export function assertTraderConfigSound(config: TraderConfig): void {
  if (!(config.flatten_before_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_before_close_ms must be > 0 (got ${config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
}

/** Fully deterministic given its inputs + the clock-scoped market data. */
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
   * When each asset class's venue closes (#668) — the input the flat-by-close
   * rule resolves through.
   *
   * REQUIRED and not optional, on purpose. This repo's dominant defect class is
   * a tested mechanism nothing calls (#364's store, #388's rate limiter), and
   * an optional calendar here would let the composition root drop it and leave
   * the flatten silently unarmed — which looks exactly like a quiet market in a
   * soak log. Keyed by asset class rather than by instrument because that is
   * the shape the composition root already builds (`sessionCalendars`), and
   * because the choice must follow the INSTRUMENT rather than the runtime
   * mode: the crypto leg and the equity leg run under different venues in the
   * same process.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /**
   * #74: position-aware branching. Live snapshot, not point-in-time — the
   * Trader only ever runs on the current tick, unlike replay-scoped market
   * data. Narrowed to a single function (matching
   * `server/apps/orchestrator/production/direct-bind.ts`'s `getOpenPositions`
   * dependency), not the full `SharedStore`. `decide()` filters the
   * returned lots down to `instrument` itself.
   */
  positionState: () => Promise<OpenPosition[]>;
  /**
   * #568: each named lot's already-closed quantity (`SharedStore`'s
   * `getExitFillSizes`), narrowed to one function for the same reason
   * `positionState` is. An exit sizes to what the venue still HOLDS, and
   * `OpenPosition.filled_size` is the entry total that no exit fill reduces —
   * a partially-flattened lot stays open at its ORIGINAL size, so without
   * this the flatten oversells into a reverse position (see
   * `shared/held-quantity.ts`).
   *
   * Required, not optional: an optional reader is one a composition root can
   * forget, and forgetting it restores exactly the entry-only sizing this
   * closes — silently, on the money path.
   */
  exitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  /**
   * #432: the cosine precedent store, read at decision time for neighbors and
   * written at decision time with the new setup (trader-spec.md stories 13 and
   * 16). Owned by the Feedback Loop, which labels the realized R on close.
   *
   * Required, not optional. An optional store would let a composition root
   * forget it and silently fall back to the permanent 0.75x haircut this
   * ticket exists to remove — exactly the no-caller shape #430 closes.
   */
  setupStore: SetupStore;
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
