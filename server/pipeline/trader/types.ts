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
  InstrumentSubclass,
  OpenPosition,
  OrderIntent,
  SetupStore,
  TradingArm,
} from '../../shared/index.js';
import type { DebateResult } from '../debate-engine/index.js';
import { DEFAULT_EARLY_EXIT_CONFIG, type EarlyExitConfig } from './early-exit.js';
import { ADR_0018_SUBCLASS_BRACKETS, type SubclassBracketTable } from './subclass-bracket.js';

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
   * How long AFTER the session close the flatten stays enforceable (#1389).
   *
   * The window used to end at the bell, because it was resolved from
   * `TradingCalendar.sessionEnd` and every conforming calendar answers that
   * strictly forward — one instant past the close it named TOMORROW's close and
   * the window silently shut. A lot the pre-close window did not reach (a
   * saturated pass; #1390's own coverage bound) therefore got no second chance
   * that day at all, which is how seven control lots carried overnight on
   * 2026-09-08.
   *
   * The grace is bounded from both ends and neither bound is cosmetic:
   *
   *   - **Below**, by the tick interval. The flatten is evaluated ON a tick, so
   *     a grace shorter than one interval is a grace no tick lands in —
   *     `assertFlattenWindowCoversTickInterval` refuses it at boot, the same
   *     way it refuses too narrow a pre-close window (#670).
   *   - **Above**, by Verdict's `max_mark_age.stocks` (gate 2a). A PRICED
   *     flatten is not exempt from the price-staleness gate, so past that age
   *     every post-bell flatten is refused `stale_feed` and a longer grace buys
   *     nothing but ticks that cannot produce a `go`.
   *     `assertFlattenGraceWithinMarkAge` refuses that at boot too.
   *
   * The default is five minutes: long enough for several ticks at any cadence
   * the coupling assertion admits, short enough to sit well inside the 15-minute
   * ceiling. What it is NOT is a modelled claim about post-close fill quality on
   * a GBP LSE ETP after the closing auction — nothing in this repo models that,
   * and widening it is David's call, not a tuning exercise.
   */
  flatten_after_close_ms: number;
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
  /**
   * ADR-0018 D3's frozen bracket and D5's deployment envelope, per subclass
   * (#739) — the live exit geometry and the live sizing denominator wherever
   * `subclass_of` classifies the instrument.
   *
   * Config rather than constants because every number in it is still a single
   * unmeasured quote (ADR-0016 Known weakness; delivery owned by #1053).
   * ADR-0018 says "both brackets and both bars move directly with them".
   * `ADR_0018_SUBCLASS_BRACKETS` is the checked-in default.
   */
  subclass_brackets: SubclassBracketTable;
  /**
   * Instrument -> the subclass ADR-0018 prices it under, built at the
   * composition root from the universe (`subclassOfUniverse`) — the SAME
   * derivation that feeds `SubclassDeploymentCap.subclass_of`, so the Trader's
   * bracket and the Risk Manager's envelope cannot disagree about what an
   * instrument is.
   *
   * **Empty means the per-subclass regime is not armed**, which is the state
   * `DEFAULT_UNIVERSE` and `SMOKE_TEST_UNIVERSE` are in (neither holds a
   * leveraged ETP ADR-0018 prices), and the pre-ADR-0018 ATR geometry still
   * sizes those. A PARTLY populated map arms it and unclassified names throw —
   * identical arming semantics to the Risk Manager's D5 gate, deliberately, so
   * one pool file arms both stages or neither.
   */
  subclass_of: Readonly<Record<string, InstrumentSubclass>>;
  /** Timeframe of the bars ATR is computed from. */
  atr_timeframe: string;
  /** Number of true-range periods averaged into ATR. */
  atr_lookback: number;
  /**
   * Stop distance = atr_k x max(ATR, vol floor) — the PRE-ADR-0018 geometry.
   *
   * **Inert wherever `subclass_of` arms the frozen bracket** (#739): under
   * ADR-0018 D3 the stop is a frozen percentage of entry per subclass, and
   * trader-spec.md's "Sizing math" withdraws the ATR-floating stop as the live
   * rule. It still sizes the universes that declare no subclass at all.
   *
   * Kept rather than deleted, and `atrFor` with it, because ATR has three
   * other jobs the frozen stop does not touch: the setup vector cosine
   * precedent retrieves on, the Feedback Loop's realized-R labelling, and the
   * volatility halt ADR-0018's sizing amendment names as "the only
   * volatility-responsive mechanism until the stop floats". Deleting the keys
   * and the ATR computation in one change is how that halt loses its input
   * while the diff reads as a cleanup.
   */
  atr_k: number;
  /**
   * The volatility floor, expressed as a fraction of entry price rather than
   * an absolute price distance: ATR is in price units, so an absolute floor
   * could not be one config shared across BTC-USD and AAPL. Bounds size from
   * below when volatility is ultra-low.
   *
   * Inert under a frozen bracket, exactly as `atr_k` is.
   */
  vol_floor_fraction: number;
  /** Applied when the debate did not converge (`converged: false`). */
  non_converged_haircut: number;
  /**
   * Target distance as a multiple of the stop distance. trader-spec.md
   * requires a target on the bracket but does not pin how far out it sits;
   * deriving it from the stop keeps the reward:risk ratio constant across
   * volatility regimes rather than fixing an arbitrary price distance.
   *
   * **Inert wherever the frozen bracket applies** (#739), and it has to be:
   * ADR-0018 D3's take-profit is a measured level, not a ratio off the stop,
   * and 2.0 x the frozen 2.16% index stop would place the target at 4.32%
   * rather than the declared +2.00%. Kept for the unarmed universes, alongside
   * `atr_k` and `vol_floor_fraction`.
   */
  reward_risk_multiple: number;
  /**
   * Minimum viable position notional (size x entry). Below this the Trader
   * skips rather than placing dust. Stands in for the broker minimum order
   * size until the broker abstraction lands (Execution, epic #57).
   */
  min_viable_notional: number;
  /**
   * Quantise entry size to whole shares (#941).
   *
   * A VENUE constraint, not a tuning knob, and the reason it exists is
   * measured rather than assumed: Alpaca refuses `order_class: 'bracket'` at
   * any fractional quantity — `422 42210000 fractional orders must be simple
   * orders` — long or short alike, and refuses a fractional SHORT outright
   * (`fractional orders cannot be sold short`) even as a plain limit. A
   * whole-share bracket, short included, is accepted. ADR-0018 D5 sizes by
   * CASH (35%/25% of equity), so almost every intent it produces is
   * fractional, and two of the paper soak's three entries were rejected at
   * submission for exactly this.
   *
   * **Default `false`, and unlike `time_in_force` this venue constraint is
   * deliberately NOT carried in the shared default.** Time-in-force is inert
   * in simulation — the simulated broker never expires an order — so pinning
   * it globally changes nothing that is measured. Flooring changes the FILL
   * SIZE, so switching it on globally would silently move every backtest and
   * fixture result and make runs on either side of this change
   * incomparable. It is therefore opted into by the profiles that actually
   * talk to a venue (`paper-profile.ts`, `live-profile.ts`) and left off for
   * `DEFAULT_TRADER_CONFIG`, backtests and fixtures.
   *
   * Equities-shaped, because the profiles that set it are equities-only
   * (ADR-0015's 2026-08-16 amendment). A fractional venue is the norm in
   * crypto — Alpaca's own crypto leg accepts fractional quantities, and a
   * whole-unit BTC entry at a £250 deployment would floor to zero and trade
   * never. If crypto re-enters scope this must become per-asset-class, the
   * way `time_in_force` already is, rather than being set true anywhere a
   * crypto instrument can be ticked.
   */
  whole_share_sizing: boolean;
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
  subclass_brackets: ADR_0018_SUBCLASS_BRACKETS,
  // Empty by default: the brackets are declared, the regime is not armed until
  // a universe classifies its instruments. `paperTradingProfile` fills this
  // from the universe it schedules, so arming is a pool-file edit rather than
  // a code change.
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
  // #1389. Silent in exactly the way the field above is: a zero grace restores
  // the forward-only window this ticket removed — the bell shuts the flatten
  // off mid-tick and a lot the pre-close window missed gets no second chance,
  // with nothing in `trader_log` distinguishing that from a session that had
  // nothing left to flatten.
  if (!(config.flatten_after_close_ms > 0)) {
    throw new Error(
      `traderConfig.flatten_after_close_ms must be > 0 (got ${config.flatten_after_close_ms}); ` +
        'a non-positive grace restores the forward-only flatten window #1389 removed',
    );
  }
}

/** Fully deterministic given its inputs + the clock-scoped market data. */
export interface TraderInput {
  /** Cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data. */
  trace_id: string;
  /**
   * Which arm of #753's measurement this decision belongs to. Absent means
   * `'live'` — the debate-driven arm, which is what every caller was before
   * falsifier arm 2 existed.
   *
   * **Optional here, and the reason matters.** Every other seam this repo
   * makes REQUIRED is one whose omission silently disarms a mechanism
   * (`sessionCalendars` and the flatten, `breakerState` and the sticky
   * breakers). This one is the opposite: the value it defaults to is the value
   * every pre-#753 call site meant, so a forgotten `arm` cannot mislabel a
   * live trade as a control one or vice versa — it can only fail to *create*
   * the control arm, which the composition-root test (`control-arm-wiring`)
   * catches at the root rather than at the field.
   *
   * It reaches two places and only two: the intent's `idempotency_key` (so the
   * two arms cannot dedupe each other's orders away — see
   * `computeIdempotencyKey`) and `OrderIntentMetadata.arm` (so the decision
   * records say which arm decided). It changes NO decision logic: the
   * conviction floor, the frozen ADR-0018 D3 bracket, the stop, the sizing and
   * the exit rules are read from the same config and the same
   * `subclass-bracket.ts` constants for both arms, which is what makes the
   * control a matched control rather than a reimplementation.
   */
  arm?: TradingArm;
  /**
   * `DebateResult` carries no instrument, but `OrderIntent.instrument` cannot
   * be constructed without one. The Orchestrator's tick is per-instrument
   * (orchestrator-spec.md), so it is threaded in alongside the debate.
   */
  instrument: string;
  debate: DebateResult;
  /** Wall-clock live, simulated T in replay. */
  clock: Clock;
  marketData: MarketDataService;
  /**
   * Portfolio equity to size against — a THUNK, not a value (#847), for the
   * same reason `positionState` below is one: only the branches that size
   * may pay for it, and only they may fail on it.
   *
   * The whole-book valuation behind this can refuse (`computePortfolioView`
   * throws when ANY held instrument's mark is dark or stale). Passing the
   * number in eagerly meant that refusal aborted the WHOLE decision pass
   * before `routeDecision` could reach the flat-by-close branch — so one dark
   * name delayed a newly decided flatten by a tick, against ADR-0014.
   * `buildExitIntent` never reads equity; only `buildBracket` does, and it
   * awaits this FIRST (see there).
   *
   * The strictness is unchanged and must stay unchanged: this thunk must
   * either return an equity derived from a whole-book valuation or throw.
   * Returning a partial/degraded figure would silently under-count exposure
   * and over-size the entry — every exposure cap reads an absent instrument
   * as ZERO exposure (`SubclassDeploymentCap`, risk-manager/types.ts).
   */
  equity: () => Promise<number>;
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
   * #1389: every flatten this arm has SENT but not yet resolved
   * (`SharedStore.getUnresolvedFlattens` — `submitting`, or `submitted` with
   * fills not yet swept). The Trader produces no flatten intent for an
   * instrument this set names.
   *
   * **A second guard, deliberately independent of the idempotency key.** The
   * key dedups one COORDINATE; it was never a per-instrument in-flight guard,
   * and every design #1389's re-analysis discarded failed at exactly that gap:
   * while a first flatten is submitted-but-unswept, `getExitFillSizes` still
   * reports nothing closed, so a second flatten sized off `filled_size` would
   * sell the whole lot again — into a short, on a 3x leveraged ETP.
   *
   * Required, not optional, for the reason `exitFillSizes` is: an optional
   * reader is one a composition root can forget, and forgetting this one
   * restores the over-sell silently, on the money path. It must be bound to the
   * SAME store instance `positionState` and `exitFillSizes` read, which also
   * makes it arm-scoped for free (migration 0050) — the live arm must not see
   * the control arm's in-flight flattens, or either arm would block the other.
   *
   * The honest cost: a wedged fill poll leaves rows unresolved indefinitely and
   * blocks flattening for that instrument until it is unwedged. That is bounded
   * by the carried-lot alert, not by code — see ADR-0014's 2026-09-10
   * amendment.
   */
  unresolvedFlattens: () => Promise<readonly UnresolvedFlatten[]>;
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
  /**
   * #826: raised when the mandatory flat-by-close flatten was built WITHOUT a
   * mark, because the instrument's own mark read failed (an Alpaca stall). The
   * exit still goes out — see `buildFlattenExit` for why — and this is what
   * stops that degradation from being silent.
   *
   * Optional, and the degradation does NOT depend on it. That distinction is
   * deliberate and is the opposite call to `sessionCalendars`/`exitFillSizes`
   * above, which are required precisely because forgetting them disarms a
   * safety rule. Here, forgetting it costs an operator page and nothing else:
   * the flatten is built the same way whether or not a channel is wired, so a
   * composition root that omits this cannot reintroduce the missed exit. Same
   * shape as `exitValuationAlerts` (#841) one stage down, which the live root
   * routes this into.
   *
   * Must not throw — the flatten is already committed by the time it is
   * called, and a page that could abort it would reinstate exactly the
   * suppression #826 removes. `buildFlattenExit` guards it anyway.
   */
  onUnpricedFlatten?: (report: UnpricedFlattenReport) => void;
}

/**
 * One flatten this arm has sent and not yet resolved (#1389), as much of it as
 * the Trader needs.
 *
 * Structural on purpose: `UnresolvedFlattenSubmission` lives in
 * `pipeline/execution`, and the Trader importing from a stage DOWNSTREAM of it
 * would be a new dependency edge between two stages that today share only
 * `contracts/` and `shared/`. The execution store's richer row is assignable to
 * this, so the composition root binds it directly with no adapter.
 */
export interface UnresolvedFlatten {
  readonly instrument: string;
}

/** One mandatory flatten built without a mark (#826). */
export interface UnpricedFlattenReport {
  instrument: string;
  /** The mark read's own failure, rendered — the only form a thrown value survives in. */
  reason: string;
}

/** The single test seam. `decide` in ./decide.ts is its implementation. */
export interface Trader {
  /**
   * null = skip / no-trade. A projection of `decideWithReason`, which is what
   * production calls: this signature drops the skip reason, and nineteen
   * distinct causes of "no order" collapse into one `null` here.
   */
  decide(input: TraderInput): Promise<OrderIntent | null>;
}
