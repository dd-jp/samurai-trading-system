/**
 * Domain types & config for the Trader (Stage 3).
 *
 * `OrderIntent` / `OrderIntentMetadata` are NOT redefined here: they are
 * cross-spec types owned by server/shared/types.ts (registry #1).
 */
import type {
  MarketDataService,
  TradingCalendar,
} from '../../providers/market-data-service/index.js';
/** Asset classes the risk multiplier is keyed on, matching `Mark.asset_class` */
import type {
  AssetClass,
  Clock,
  InstrumentSubclass,
  OpenPosition,
  SetupStore,
  TradingArm,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { DEFAULT_EARLY_EXIT_CONFIG, type EarlyExitConfig } from './early-exit.js';
import { ADR_0018_SUBCLASS_BRACKETS, type SubclassBracketTable } from './subclass-bracket.js';

export type { AssetClass };

/**
 * Defaults here are starting points, not tuned values — every field is
 * config tuned in paper trading. Injected rather than module-global so
 * tests can pin thresholds explicitly.
 */
export interface TraderConfig {
  /** Below this conviction there is no edge to act on — no entry */
  conviction_floor: number;
  /**
   * How long before session close the book must be flat (ADR-0014: intraday,
   * flat by close, no overnight carry). An offset rather than a wall-clock
   * constant because paper and live venues close at different times.
   */
  flatten_before_close_ms: number;
  /**
   * How long AFTER session close the flatten stays enforceable (#1389).
   * Bounded below by the tick interval and above by Verdict's
   * `max_mark_age.stocks` — both enforced at boot, not just here.
   */
  flatten_after_close_ms: number;
  /**
   * Hard per-trade risk cap as a fraction of equity, reached at conviction
   * 1.0 — deliberately well under Kelly. Portfolio/asset-class caps live in
   * the Risk Manager, not here.
   */
  max_risk_per_trade: number;
  /**
   * Scales `max_risk_per_trade` down per asset class. Crypto is more
   * conservative than stocks (fat-tailed markets warrant quarter-Kelly).
   */
  asset_class_risk_multiplier: Record<AssetClass, number>;
  /**
   * ADR-0018 D3's frozen bracket and D5's deployment envelope, per subclass.
   * Config rather than constants because these figures are still a single
   * unmeasured quote (delivery owned by #1053).
   */
  subclass_brackets: SubclassBracketTable;
  /**
   * Instrument -> the subclass ADR-0018 prices it under, built at the
   * composition root from the universe. **Empty means the per-subclass
   * regime is unarmed** and the pre-ADR-0018 ATR geometry sizes instead.
   */
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  /** Timeframe of the bars ATR is computed from */
  atr_timeframe: string;
  /** Number of true-range periods averaged into ATR */
  atr_lookback: number;
  /**
   * Stop distance = atr_k x max(ATR, vol floor) — the PRE-ADR-0018 geometry,
   * inert wherever `subclass_of` arms the frozen bracket. Kept because ATR
   * also feeds precedent retrieval, realized-R labelling, and the
   * volatility halt.
   */
  atr_k: number;
  /**
   * Volatility floor as a fraction of entry price rather than an absolute
   * distance, so one config can cover both BTC-USD and AAPL. Inert under a
   * frozen bracket, same as `atr_k`.
   */
  vol_floor_fraction: number;
  /** Applied when the debate did not converge (`converged: false`) */
  non_converged_haircut: number;
  /**
   * Target distance as a multiple of stop distance, keeping reward:risk
   * constant across volatility regimes. Inert wherever the frozen bracket
   * applies — ADR-0018 D3's take-profit is a measured level, not a ratio.
   */
  reward_risk_multiple: number;
  /**
   * Minimum viable position notional (size x entry); below this the Trader
   * skips rather than placing dust. Stands in for the broker minimum order
   * size until the broker abstraction lands (Execution, epic #57).
   */
  min_viable_notional: number;
  /**
   * Quantise entry size to whole shares (#941) — a venue constraint, not a
   * tuning knob: Alpaca refuses fractional brackets and fractional shorts.
   * Default `false`, opted into only by profiles that talk to a real venue,
   * since flooring changes fill size and would move every backtest result.
   */
  whole_share_sizing: boolean;
  /**
   * Order time-in-force, per asset class (#381) — a venue constraint, not a
   * tuning knob: Alpaca's crypto leg accepts only `gtc`/`ioc`, equities take
   * `day`
   */
  time_in_force: Record<'crypto' | 'stocks', string>;
  /**
   * Minimum conviction rise (current debate minus the position's stored
   * conviction) that qualifies a same-direction hold for `scale_in` (#74)
   */
  scale_in_conviction_delta: number;
  /**
   * The indicator-based early exit's decay criterion (#748), injected so the
   * threshold is never a bare module constant. Non-optional so a
   * composition root cannot silently leave the exit unarmed.
   */
  early_exit: EarlyExitConfig;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  conviction_floor: 0.55,
  max_risk_per_trade: 0.01,
  subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
  // Empty by default: brackets are declared but the regime is unarmed until a
  // universe classifies its instruments (see `paperTradingProfile`)
  subclass_of: {},
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
  whole_share_sizing: false,
  time_in_force: { crypto: 'gtc', stocks: 'day' },
  scale_in_conviction_delta: 0.1,
  flatten_before_close_ms: 5 * 60 * 1_000,
  flatten_after_close_ms: 5 * 60 * 1_000,
  early_exit: DEFAULT_EARLY_EXIT_CONFIG,
};

/**
 * Refuse a `TraderConfig` that would silently disable a safety rule (#691) —
 * called at the composition root so a bad config fails at boot rather than on
 * whichever branch reaches it first. `withinFlattenWindow` carries the same
 * check as a runtime backstop for callers that bypass this seam.
 */
export function assertTraderConfigSound(config: TraderConfig): void {
  if (!(config.flatten_before_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_before_close_ms must be > 0 (got ${config.flatten_before_close_ms}); ` +
        `a non-positive window disables flat-by-close, which ADR-0014 requires`,
    );
  }
  // #1389: a zero grace restores the forward-only window this ticket removed
  if (!(config.flatten_after_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_after_close_ms must be > 0 (got ${config.flatten_after_close_ms}); ` +
        'a non-positive grace restores the forward-only flatten window #1389 removed',
    );
  }
}

/** Fully deterministic given its inputs + the clock-scoped market data */
export interface TraderInput {
  /** Cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data */
  trace_id: string;
  /**
   * Which arm of #753's measurement this decision belongs to. Absent means
   * `'live'`. Reaches only the intent's `idempotency_key` and
   * `OrderIntentMetadata.arm` — it changes no decision logic, which is what
   * makes the control arm a matched control.
   */
  arm?: TradingArm;
  /**
   * `DebateResult` carries no instrument, but `OrderIntent.instrument` needs
   * one — threaded in from the Orchestrator's per-instrument tick
   */
  instrument: string;
  debate: DebateResult;
  /** Wall-clock live, simulated T in replay */
  clock: Clock;
  marketData: MarketDataService;
  /**
   * Portfolio equity to size against — a thunk, not a value (#847), so only
   * the branches that size pay for (and can fail on) a whole-book valuation.
   * Must either return equity or throw; never a partial/degraded figure,
   * since every exposure cap reads an absent instrument as ZERO exposure.
   */
  equity: () => Promise<number>;
  config: TraderConfig;
  /**
   * When each asset class's venue closes (#668). Required, not optional — an
   * absent calendar would leave the flatten silently unarmed, indistinguishable
   * from a quiet market in a soak log.
   */
  sessionCalendars: Record<AssetClass, TradingCalendar>;
  /**
   * Live snapshot for position-aware branching (#74), narrowed to a single
   * function rather than the full `SharedStore`. `decide()` filters the
   * returned lots down to `instrument` itself.
   */
  positionState: () => Promise<OpenPosition[]>;
  /**
   * Each named lot's already-closed quantity (#568). Required: without it a
   * partially-flattened lot stays open at its original size and the flatten
   * oversells into a reverse position.
   */
  exitFillSizes: (idempotency_keys: readonly string[]) => Promise<Map<string, number>>;
  /**
   * Every flatten this arm has SENT but not yet resolved (#1389); the Trader
   * produces no new flatten intent for an instrument this set names. A
   * second guard independent of the idempotency key, required because
   * `exitFillSizes` still reports nothing closed while a flatten is in
   * flight — omitting this would double-sell a lot.
   */
  unresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
  /**
   * The cosine precedent store (#432), read and written at decision time.
   * Required — an optional store would silently fall back to the permanent
   * 0.75x haircut #430 removed.
   */
  setupStore: SetupStore;
  /**
   * Raised when a mandatory flat-by-close flatten was built without a mark
   * because the instrument's own mark read failed (#826). Optional — the
   * flatten still goes out either way, so omitting this only costs a page.
   * Must not throw: the flatten is already committed by the time it's called.
   */
  onUnpricedFlatten?: (report: UnpricedFlattenReport) => void;
}

/**
 * One flatten this arm has sent and not yet resolved (#1389). Structural on
 * purpose, so the Trader does not gain a dependency edge on `pipeline/execution`.
 */
export interface UnresolvedFlatten {
  readonly instrument: string;
}

/** One mandatory flatten built without a mark (#826) */
interface UnpricedFlattenReport {
  instrument: string;
  /** The mark read's own failure, rendered — the only form a thrown value survives in */
  reason: string;
}

/**
 * Every distinct way the Trader can decline to trade (#475) — a closed union
 * rather than free text so the set is greppable and typo-proof. Ordered
 * roughly by expected frequency in a healthy run.
 */
export type TraderSkipReason =
  | 'neutral_direction_while_flat'
  | 'below_conviction_floor'
  // Inside the flat-by-close window: distinct from a quiet market (#668)
  | 'session_closing'
  | 'below_min_notional'
  | 'holding_neutral_or_non_converged'
  | 'scale_in_conviction_delta_not_met'
  | 'exit_no_filled_size'
  // A lot whose recorded exit fills exceed what it ever opened (#568) — a
  // store self-inconsistency, not a quiet "nothing to close"
  | 'exit_held_quantity_diverged'
  // This arm already sent an unresolved flatten for this instrument (#1389)
  | 'flatten_in_flight'
  // Tick path only: no lot is open, so the exit check has nothing to evaluate
  | 'no_open_position'
  // Tick path only (#748): a lot is held and momentum still supports it
  // Replaces the old `flatten_not_due`, which is no longer reachable now
  // that the early exit runs on every non-flatten tick
  | 'signal_still_supports_position'
  // Tick path only (#748): held lot, flatten not due, momentum unreadable
  // (e.g. still in MACD warm-up) — distinct from a signal that was read.
  | 'early_exit_signal_unavailable'
  | 'no_position_side'
  | 'atr_insufficient_bars'
  | 'atr_not_finite'
  | 'mark_not_finite'
  | 'stop_distance_not_positive'
  | 'size_not_finite'
  // Sized to less than one whole share on a whole-shares-only venue (#941)
  | 'rounds_to_zero_shares'
  // `arm === 'control'` only: a whole-book valuation refusal from `equity()`
  // that the live arm would instead let propagate (#1089)
  | 'control_arm_valuation_refused';

/**
 * The compared value and threshold missed, for a skip reason that is a
 * numeric gate (#1109) — lets a near-miss be told apart from a decisive one
 * without re-deriving either number from a log line
 */
export interface TraderReasonDetail {
  compared_value: number;
  threshold: number;
}

/**
 * A condition the Trader detected but did not treat as fatal (#698) —
 * distinct from `TraderSkipReason`: a skip reason is a correct decision, a
 * diagnostic means the Trader ran in a degraded state and papered over it.
 * Returned as data rather than logged inline, so `decide` stays side-effect-free.
 */
export type TraderDiagnosticKind =
  /**
   * `sessionEnd` returned null for a non-crypto class — the documented
   * answer for crypto, but a broken calendar for anything else
   */
  | 'session_end_absent_on_non_crypto'
  /**
   * ATR came back non-finite on a full window — corrupt bar data. Distinct
   * from `atr_insufficient_bars`, which is an expected early-soak warm-up gap.
   */
  | 'atr_not_finite'
  /**
   * `arm === 'control'` only: paired with the `control_arm_valuation_refused`
   * skip reason, raised from `buildBracket`'s equity read (#1089)
   */
  | 'control_arm_valuation_refused'
  /**
   * A lot is still open after `flatten_after_close_ms` expired (#1389) —
   * flat-by-close was missed and the position carries overnight against
   * ADR-0014. Raised from the fill-sync poll, not from `decide`, since the
   * tick loop has already stopped by the time the grace expires.
   */
  | 'lot_carried_past_session_close';
