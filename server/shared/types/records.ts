/**
 * Domain records — the shapes that travel between stages and land in the store.
 * See `primitives.ts` for the vocabulary and `ports.ts` for read/write interfaces.
 */
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { LotHeldQuantity } from '../held-quantity.js';
import type { AssetClass, TradingArm } from './primitives.js';

/**
 * The bracket handed from Trader to Risk Manager. Defined here, not in
 * server/pipeline/trader, because `metadata.debate_id` is a cross-spec join key
 * (docs/specs/cross-spec-contracts.md registry #1).
 */
export interface OrderIntent {
  /**
   * sha256(instrument, bar, side[, arm if not 'live']) — NOT debate_id, since
   * debate re-runs from scratch on crash and would make the key unstable
   * across retries (CONTEXT.md idempotency invariant)
   */
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** A reversal is exit-then-fresh-entry, not a single zero-crossing bracket */
  intent_type: 'entry' | 'scale_in' | 'exit';
  size: number;
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
  /**
   * The bar coordinate — `debate.bar_timestamp` floored to
   * DEBATE_BAR_TIMEFRAME_MS (1h). Stable per-bar key input; freshness gates
   * use `decided_at` instead.
   */
  decision_timestamp: Date;
  /**
   * Wall-clock instant this intent was decided (`clock.now()` in decide.ts),
   * never floored to a bar — used for the freshness gate; `decision_timestamp`
   * is the bar coordinate instead
   */
  decided_at: Date;
  metadata: OrderIntentMetadata;
}

/**
 * `debate_id`: non-optional at every hop (OrderIntent.metadata ->
 * VerdictDecision -> every Execution record -> setup store, registry #1).
 * Deterministic hash(instrument + bar + AnalystView set).
 */
/**
 * Closed union of exit causes (not free text) so they're greppable/countable.
 * A bracket hit (stop/target) is deliberately NOT a member — it produces no
 * OrderIntent, and is named separately in `ClosedTrade.close_reason`.
 */
export type ExitReason =
  /**
   * ADR-0014: flat-by-close window opened (time, not price/signal). Also
   * reused by residual re-flatten (execution/residual-reflatten.ts) without a
   * Trader decision behind it — counts vs `flatten_submissions` won't balance.
   */
  | 'flatten'
  /** The momentum axis no longer supports the held side. Signal, not price or time. */
  | 'signal_decay'
  /** The debate resolved opposite to the held side. Decision path only. */
  | 'direction_flip';

export interface OrderIntentMetadata {
  debate_id: string;
  /**
   * `'live'` (default, optional=absent) or `'control'` (falsifier arm 2, no
   * model call). This is the decision record's own copy — `open_positions`/
   * `closed_trades` carry their own stamped `arm` column instead.
   */
  arm?: TradingArm;
  /**
   * Optional because entry/scale_in genuinely have none — not because an
   * exit may omit it: `buildFlattenExit` requires the argument
   */
  exit_reason?: ExitReason;
  /**
   * Set only on a flatten exit with entry/stop/target all zero because no
   * mark was readable. `VerdictImpl.decide` skips `stale_feed`/`drift` for
   * such an intent — those gates cannot reason about an unpriced bracket.
   */
  unpriced_exit?: true;
  /**
   * ADR-0014's mandatory flat-by-close flatten, set by `buildFlattenExit`
   * only inside the flatten window. Kept as a separate field (not derived
   * from `exit_reason`) so widening its gate exemption takes an edit here.
   */
  mandatory_flatten?: true;
  /**
   * Trader's per-lot breakdown of `heldSize` at decide-time. `executeExit`
   * diffs it lot-by-lot against its own re-derived view, catching a
   * compensating swap that a total-only `size !== heldSize` guard would miss.
   */
  lot_held_quantities?: readonly LotHeldQuantity[];
  conviction: number;
  converged: boolean;
  sizing: {
    /** After conviction scaling */
    base_risk_fraction: number;
    conviction_multiplier: number;
    /**
     * Effect of max(ATR, vol_floor). When `frozen_bracket` is present this
     * describes the ATR read only — it moved neither geometry nor size.
     */
    vol_floor_factor: number;
    /** 1.0 if converged */
    non_converged_haircut: number;
    /** 0.5-1.5, or 0.75 no-precedent default */
    cosine_multiplier: number;
    /**
     * ADR-0018 D3/D5's frozen bracket for this decision. `round_trip_cost_pct`
     * doesn't enter geometry/size — it's the quote the accuracy bar was
     * measured against (0.18%/0.41%, ADR-0018's single unmeasured figure).
     */
    frozen_bracket?: {
      take_profit_pct: number;
      stop_pct: number;
      deployment_fraction: number;
      round_trip_cost_pct: number;
      /**
       * Deployed at `deployment_fraction x (1 - headroom_reserve_fraction) x
       * equity`. Absence means "predates this field, full fraction used" —
       * `0` is a distinct legal configured value, so the two must stay separate.
       */
      headroom_reserve_fraction?: number;
    };
    /**
     * The size D5 sized before `whole_share_sizing` floored it to the
     * venue's quantity grid. Present only when the floor moved the number —
     * diff against `size` for the realized deployment shortfall.
     */
    unquantised_size?: number;
  };
  cosine_precedent: {
    neighbor_count: number;
    weighted_mean_r: number | null;
    no_precedent: boolean;
  };
}

/**
 * Cosine-similarity retrieval vector: debate + market-regime features
 * combined so retrieval matches "this kind of debate in this kind of market."
 */
export interface SetupVector {
  /** conviction, direction, converged, disagreement magnitude */
  debate_features: number[];
  /** volatility bucket, trend, key indicators at decision time */
  market_features: number[];
}

/**
 * A past setup's vector + realized R-multiple + close time. `SetupStore`
 * only returns neighbors already closed as of query `asOf` — no lookahead.
 */
export interface SetupNeighbor {
  vector: SetupVector;
  r_multiple: number;
  closed_at: Date;
}

/**
 * Distinguishes genuine non-convergence from a latency-budget force-stop —
 * `DebateLog.converged: false` alone can't tell them apart. On
 * `'latency_truncated'` the row holds a partial synthesis, not a completed one.
 */
export type DebateTermination = 'converged' | 'non_converged' | 'latency_truncated';

/**
 * `'budget'`: asset-class timer fired. `'llm_failure'`: an `LlmClient` call
 * failed and arrived first. NULL when not `'latency_truncated'` or on a
 * pre-migration row — never guessed.
 */
export type DebateTerminationCause = 'budget' | 'llm_failure';

/**
 * Append-only, written once per completed debate — distinct from the
 * ephemeral round-by-round state discarded/re-run on crash. FL's
 * system-of-record for per-analyst attribution, joined by `debate_id`.
 */
export interface DebateLog {
  /** Same deterministic hash Trader/Verdict/FL join on */
  debate_id: string;
  instrument: string;
  bar_timestamp: Date;
  /** influence_score, stance, per analyst — read by FL's weight attribution */
  contributions: AnalystContribution[];
  direction: Direction;
  rounds: number;
  created_at: Date;
  /**
   * Lets the dashboard find the row without guessing from instrument+recency.
   * Not stable across a retry (fresh trace_id per attempt); first-write-wins
   * owns the row. Absent on pre-migration rows.
   */
  trace_id?: string;
  /**
   * Lets this row REPLAY the debate, not just describe it. All optional
   * together (pre-migration-0026 rows carry none); a row without
   * `confidence` is treated as un-replayable and the debate re-runs, rather
   * than fabricating a position.
   */
  confidence?: number;
  synthesis?: string;
  position?: string;
  disagreement_summary?: string;
  open_items?: string[];
  converged?: boolean;
  /**
   * Present from migration 0041; NULL before it, genuinely indeterminate
   * (never guessed). Derived from `DebateResult`: `timed_out` set ⇒
   * `'latency_truncated'`, else mirrors the `converged` boolean.
   */
  termination?: DebateTermination;
  /**
   * Present only when `termination === 'latency_truncated'`. Derived from
   * `DebateResult.timed_out.cause` — see `DebateTerminationCause` for values.
   */
  termination_cause?: DebateTerminationCause;
}

/**
 * One row per round, separate from `DebateLog` (which is write-once per
 * debate_id) — so a flip-rate query (round 1 vs max round direction) is a
 * plain `GROUP BY debate_id`. Written once, never updated.
 */
export interface DebateRoundLogEntry {
  debate_id: string;
  /** 1-indexed, matching `RoundVerdict.round` */
  round: number;
  direction: Direction;
  confidence: number;
  created_at: Date;
}

/**
 * Real-field companion to the generic `audit_log` (digests/hashes only).
 * Keyed by `trace_id` (Orchestrator tick correlation), not `idempotency_key`
 * — that's retained only for cross-reference to open_positions/fills.
 */
export interface VerdictLog {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  status: 'go' | 'no_go';
  /** The gate that fired; null iff `status === 'go'` */
  no_go_reason: string | null;
  /**
   * Signal age for `staleness`; mark age at read time for `stale_feed`
   * (negative when the mark is stamped ahead of us). Null otherwise.
   */
  no_go_detail_measured_ms: number | null;
  no_go_detail_bound_ms: number | null;
  /**
   * True iff `approval_path !== 'automated'`. NOT `would_require_approval`,
   * which is also true on an automated bypass where no override occurred.
   */
  hitl_override: boolean;
  timestamp: Date;
}

/**
 * Declared in `contracts/primitives.ts`, re-exported here: `PositionRow`
 * carries it to the browser, which must not import the execution registry
 */
export type { OrderState } from '../../../contracts/index.js';

// Also imported, not just re-exported: `export … from` publishes the name
// without binding it locally, and `OpenPosition` below annotates with it
import type { OrderState } from '../../../contracts/index.js';

/**
 * A live open lot. Cross-spec registry type (§4): Execution is its sole
 * writer; Risk and Trader read it. Per-lot by design — each entry/scale_in
 * is its own record, which is what keeps FL's single-entry-bracket R assumption true.
 */
export interface OpenPosition {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** Exits close a lot; they never create one — hence no 'exit' here */
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  /**
   * Downstream (Risk exposure, FL's R) reads THIS, never `requested_size`.
   * Zero on the write-ahead record — nothing has filled yet.
   */
  filled_size: number;
  /** Zero until the first fill lands, for the same reason as `filled_size` */
  avg_entry_price: number;
  /** Live protective legs; resized to filled qty on partial fill */
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string[];
  opened_at: Date;
  /** The bar/decision time, carried from the OrderIntent */
  decision_timestamp: Date;
  /**
   * Carried from `OrderIntentMetadata`. Read by the Trader's position-aware
   * branching to decide whether conviction rose enough to warrant a `scale_in`.
   */
  conviction: number;
  converged: boolean;
  /**
   * `OrderIntent.entry`, unchanged through Debate/Risk/Verdict — NOT the
   * post-rounding wire price (`broker_brackets.entry_price` carries that).
   * Absent on a pre-migration-0037 row; omission means "not captured", never 0.
   */
  decision_price?: number;
  /**
   * Submit-time quote sides from `MarketDataService.getQuote` — genuinely
   * observed, never derived from a scalar spread. Both absent together when
   * the source has no `fetchQuote` (e.g. Alpaca) or predates migration 0037.
   */
  quote_bid?: number;
  quote_ask?: number;
  /** (quote_bid + quote_ask) / 2 — a real midpoint of the SAME observed quote. Absent iff the pair is. */
  quote_mid?: number;
  /** The quote's own timestamp — distinct from `decision_timestamp` and `opened_at` (pipeline latency separates all three) */
  quote_observed_at?: Date;
  /**
   * Captured at submit time via `CostModel.fill()`. `toFill` prorates this
   * onto a real-broker fill's `Fill.cost_breakdown` since the venue reports
   * none of its own. Absent pre-migration-0037 or on a failed capture.
   */
  modelled_cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * Same submit-time estimate for the bracket's stop/target legs — priced
   * once since they're OCO and cost identically. Absent on an exit intent,
   * pre-migration-0061 row, or whenever `modelled_cost_breakdown` is absent.
   */
  modelled_protective_exit_cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * Set only when `order_state === 'abandoned'`: why
   * `wedged-zero-fill-sweep.ts` retired this lot without ever seeing a fill
   */
  abandon_reason?: string;
}

/**
 * Nominal brand preventing a `broker_fill_id`/`idempotency_key` field swap
 * (both are plain `string`) from silently type-checking. Produce only via
 * `toBrokerFillId`; nothing lints a bare `as BrokerFillId` cast.
 */
export type BrokerFillId = string & { readonly __brand: 'BrokerFillId' };
export function toBrokerFillId(value: string): BrokerFillId {
  return value as BrokerFillId;
}

/**
 * One row per fill, so PnL can be reconstructed from raw records rather
 * than a running total. `broker_fill_id` dedupes — the adapters' feed is
 * inclusive of `since` and re-offers the same fill on the next poll.
 */
export interface Fill {
  idempotency_key: string;
  broker_fill_id: BrokerFillId;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  /**
   * Simulated adapter: `CostModel.fill`'s real result. Real-broker `'entry'`
   * fill: the MODELLED figure prorated from `OpenPosition.modelled_cost_breakdown`
   * — the venue reports no breakdown of its own. Absent on stop/target fills.
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * WHY a `leg: 'exit'` fill closed the position — copied from
   * `flatten_submissions.exit_reason` so `closedTrade()` can read it on any
   * poll, not only the one that ingested it. Absent on other legs.
   */
  exit_reason?: ExitReason;
  /**
   * The FLATTEN's own `idempotency_key` (not the lot's), joining an exit
   * fill back to the specific flatten submission that priced it — needed
   * when a lot was partially flattened more than once
   */
  flatten_idempotency_key?: string;
  /**
   * Venue-reported fee currency, verbatim, never converted. A non-sterling
   * fee is a contradiction, not an FX term — `tradeableUniverse` excludes
   * non-sterling instruments, so `ingestFills()` flags it but still writes
   * the row.
   */
  fee_currency?: string;
  /**
   * Venue-applied conversion rate to GBP, when reported. Absent from
   * Saxo's fill feed — exists for a future surface that can report one.
   * See `fx_rate_to_gbp_source` for why it's absent elsewhere.
   */
  fx_rate_to_gbp?: number;
  /**
   * Why `fx_rate_to_gbp` is absent, e.g. `'not_reported_by_venue'`. Also
   * absent on a book-currency (GBP/GBX) fill, which never needed a rate.
   */
  fx_rate_to_gbp_source?: string;
}

/**
 * Emitted on round-trip-to-flat; the realized record FL and Risk consume.
 * Cross-spec registry type (§4): Execution sole writer. Per-lot like
 * `OpenPosition` — keeps FL's single-entry-bracket R assumption true.
 */
export interface ClosedTrade {
  idempotency_key: string;
  /** Attribution + setup-store join key */
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** Avg entry, derived from the entry fills */
  entry: number;
  /**
   * The INITIAL protective stop (denominator of R) — never a later trailed level
   */
  stop: number;
  /** → initial risk = |entry − stop| × filled_size */
  filled_size: number;
  /** Net of fees across every leg */
  realized_pnl_net: number;
  fees_total: number;
  opened_at: Date;
  closed_at: Date;
  /**
   * `'stop'`/`'target'`: bracket hit (resting at venue). `'exit'`: LEGACY
   * value for a pre-migration-0031 flatten/early-release row. The
   * `ExitReason` members mirror `trader_log.exit_reason` from migration 0031 on.
   */
  close_reason: 'stop' | 'target' | 'exit' | ExitReason;
  /**
   * Did this round trip's legs actually get charged their modelled
   * commission? Computed at close time, never asserted — `false` excludes
   * the row from `SqliteArmComparisonSource` entirely (see `exitClassOf`).
   */
  modelled_cost_charged: boolean;
}
