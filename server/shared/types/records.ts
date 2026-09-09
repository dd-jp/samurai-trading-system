/**
 * Domain records — the shapes that travel between stages and land in the store
 * (#308). See `primitives.ts` for the vocabulary and `ports.ts` for the
 * interfaces that read and write these.
 */
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { AssetClass, TradingArm } from './primitives.js';

/**
 * The bracket handed from the Trader to the Risk Manager. See
 * docs/specs/trader-spec.md ("Key Interfaces"). Defined here (not in
 * server/pipeline/trader) because `metadata.debate_id` is the join key three other
 * consumers (Verdict, cosine setup store, Feedback Loop) rely on — see
 * docs/specs/cross-spec-contracts.md registry #1.
 */
export interface OrderIntent {
  /**
   * hash(instrument + bar/timestamp) — the market decision coordinate.
   * Deliberately NOT keyed on debate_id: the Debate Engine re-runs debates
   * from scratch on crash (no persistence), so a debate id is volatile;
   * keying on (instrument + bar) keeps the key stable across re-runs so
   * Execution dedupes to one fill (CONTEXT.md idempotency invariant).
   */
  idempotency_key: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** A reversal is exit-then-fresh-entry, not a single zero-crossing bracket. */
  intent_type: 'entry' | 'scale_in' | 'exit';
  size: number;
  /** Limit/entry price. */
  entry: number;
  stop: number;
  target: number;
  time_in_force: string;
  /**
   * The bar/decision COORDINATE (retained from the idempotency-key hash
   * input) — `debate.bar_timestamp`, floored to `DEBATE_BAR_TIMEFRAME_MS`
   * (1h). Downstream consumers that need a stable per-bar key (the
   * idempotency hash, `OpenPosition.decision_timestamp`) read this; nothing
   * bounds a freshness gate against it any more (#1190) — see `decided_at`.
   */
  decision_timestamp: Date;
  /**
   * The wall-clock instant this intent was actually decided — `clock.now()`
   * read at the top of the Trader function that built it (`asOf` in
   * `decide.ts`), never floored to a bar.
   *
   * Split from `decision_timestamp` by #1190: that field is the 1h DEBATE bar
   * coordinate, so a decision late in its bar carried a signal age that grew
   * structurally toward 60 minutes against a 15-minute `max_signal_age`,
   * purely as a function of where in the bar the tick landed — 23 `staleness`
   * no-gos with zero stale feeds behind them. #894 hit the same shape on
   * flattens first and exempted the mandatory flatten from the gate entirely;
   * this field fixes the gate itself for every intent that does not carry
   * that exemption, without touching what `decision_timestamp` means to its
   * other consumers.
   */
  decided_at: Date;
  metadata: OrderIntentMetadata;
}

/**
 * Non-optional: must be present on OrderIntent.metadata -> VerdictDecision ->
 * every Execution record (OpenPosition/Fill/ClosedTrade) -> setup store
 * (cross-spec-contracts.md registry #1). `debate_id` is the Debate Engine's
 * deterministic hash(instrument + bar + AnalystView set).
 */
/**
 * WHY an exit intent exists — #748's "three named reasons, not one".
 *
 * Before this the system had exactly one in-process exit reason: an
 * `intent_type: 'exit'` and nothing else, which collapsed a mandatory
 * flat-by-close flatten, a debate reversing direction, and (once #748 added it)
 * an indicator-driven early release into a single indistinguishable row. A
 * closed union rather than free text, for the same reason `TraderSkipReason`
 * is one: the set is greppable, countable across a soak, and impossible to typo
 * into a new category that looks like a new phenomenon.
 *
 * The FOURTH way a position ends — a bracket hit — is deliberately not a member.
 * A stop or target rests at the venue and produces no `OrderIntent` at all, so
 * it is distinguishable by the absence of this field, and it is named
 * separately in `ClosedTrade.close_reason` as `'stop'` / `'target'`. The three
 * members above ARE named in `close_reason` too (#793, migration 0031) — same
 * values, same meaning, one table down from `trader_log.exit_reason`.
 */
export type ExitReason =
  /** #668/ADR-0014: the flat-by-close window opened. Time, not price or signal. */
  | 'flatten'
  /** #748: the momentum axis no longer supports the held side. Signal, not price or time. */
  | 'signal_decay'
  /** The debate resolved opposite to the held side. Decision path only. */
  | 'direction_flip';

export interface OrderIntentMetadata {
  debate_id: string;
  /**
   * Which arm of #753's measurement produced this intent — `'live'` for the
   * debate-driven arm, `'control'` for falsifier arm 2 (the deterministic axis
   * vote thresholded, debate stage bypassed, no model call anywhere in the
   * path).
   *
   * Optional in the TYPE for the same reason `TraderInput.arm` is: absent means
   * the live arm, which is what every record written before falsifier arm 2
   * existed means. `decide.ts` sets it on every intent it builds — including
   * the live ones — so a *new* record never omits it.
   *
   * This is the DECISION record's copy. It is not what makes a control trade
   * distinguishable in `open_positions`/`closed_trades`: those carry their own
   * `arm` column (migration 0033), stamped by the arm-scoped store instance
   * that writes them, so the queryable property does not depend on an optional
   * field surviving four stages.
   */
  arm?: TradingArm;
  /**
   * Set on every `intent_type: 'exit'` intent and absent on every other
   * (#748). Optional in the TYPE because an entry or scale-in genuinely has
   * none — not because an exit may omit it: `buildFlattenExit` requires the
   * argument, so no exit can be constructed without one.
   */
  exit_reason?: ExitReason;
  /**
   * #826: this exit carries NO reference price. `entry`, `stop` and `target`
   * are all zero because the instrument's own mark could not be read at all —
   * the Alpaca-served mark stalled — and ADR-0014's flat-by-close invariant
   * makes a missed exit worse than an unpriced one.
   *
   * Set by `buildFlattenExit` (trader/decide.ts) and ONLY on
   * `exit_reason: 'flatten'`, the one exit the horizon makes mandatory. Read by
   * `VerdictImpl.decide`, which skips its two price gates (`stale_feed`,
   * `drift`) for such an intent — a bracket with no reference price is not one
   * those gates can reason about, and refusing it would re-create exactly the
   * missed exit this flag exists to prevent.
   *
   * Optional in the TYPE and literally `true` when present, so `=== true` is
   * the only test a reader can write and the absent case cannot be spelled as
   * `false` in one place and omitted in another. An exit priced normally does
   * not carry it.
   */
  unpriced_exit?: true;
  /**
   * #894: this exit is ADR-0014's MANDATORY flat-by-close flatten — the one
   * exit the horizon does not make optional.
   *
   * Set by `buildFlattenExit` (trader/decide.ts) exactly when its
   * `exitReason` is `'flatten'`, which both call paths reach only from inside
   * the flatten window (`withinFlattenWindow`), and never for
   * `signal_decay`/`direction_flip`. Read by `VerdictImpl.decide`, which skips
   * the `staleness` gate (1) for such an intent: a flat-by-close exit is not
   * acting on a stale OPINION, it is acting on the clock, so the age of the
   * signal that opened the lot is not a reason to refuse it. Every other
   * intent — including the two discretionary exits, which ARE acting on an
   * opinion — is bounded by `max_signal_age` exactly as before.
   *
   * A SEPARATE field rather than Verdict re-reading `exit_reason === 'flatten'`
   * at the gate, deliberately. That would put the policy question ("which
   * intents may skip a freshness bound") inside the Trader's exit TAXONOMY,
   * where a fourth `ExitReason` added later could widen a live gate's
   * exemption without anyone editing Verdict. The marker is one field with one
   * writer, and widening it takes an edit to the line that sets it.
   *
   * Optional in the TYPE and literally `true` when present, matching
   * `unpriced_exit` above and for the same reason: `=== true` is the only test
   * a reader can write, and the absent case cannot be spelled `false` in one
   * place and omitted in another.
   */
  mandatory_flatten?: true;
  conviction: number;
  converged: boolean;
  sizing: {
    /** After conviction scaling. */
    base_risk_fraction: number;
    conviction_multiplier: number;
    /**
     * Effect of max(ATR, vol_floor).
     *
     * Still recorded when `frozen_bracket` is present, and then it describes
     * the ATR read only — under the frozen stop it moved neither the geometry
     * nor the size (#739). Read the two fields together: `frozen_bracket`
     * present means this one had no effect on the intent.
     */
    vol_floor_factor: number;
    /** 1.0 if converged. */
    non_converged_haircut: number;
    /** 0.5-1.5, or 0.75 no-precedent default. */
    cosine_multiplier: number;
    /**
     * ADR-0018 D3/D5's frozen bracket, as it was resolved for THIS decision
     * (#739). Present exactly when the per-subclass regime is armed for the
     * instrument, absent on the universes that declare no subclass and still
     * size off ATR.
     *
     * `round_trip_cost_pct` is recorded here and nowhere else in the intent: it
     * enters neither the geometry nor the size (D3's percentages are already
     * frozen; the cost only sets the accuracy bar the debate layer must clear,
     * which the Trader does not compute), so persisting the quote the decision
     * was made under is what keeps a later expectancy accounting from pricing
     * the decision against a spread it was never taken at. The figure
     * (0.18% / 0.41%) is still ADR-0018's single unmeasured quote, unmoved
     * (ADR-0016 Known weakness; delivery owned by #1053).
     */
    frozen_bracket?: {
      take_profit_pct: number;
      stop_pct: number;
      deployment_fraction: number;
      round_trip_cost_pct: number;
      /**
       * #897's scale-in headroom reserve, as it stood for THIS decision. The
       * intent is deployed at `deployment_fraction x (1 -
       * headroom_reserve_fraction) x equity`, not at `deployment_fraction x
       * equity`, so an expectancy accounting that read only
       * `deployment_fraction` would over-state what was committed. Persisted
       * for the same reason `round_trip_cost_pct` is: it is injected config
       * that a later amendment may move.
       *
       * **Optional because its ABSENCE is meaningful, not because it is
       * sometimes unwritten.** `decide.ts` spreads the whole frozen bracket, so
       * every row written after #897 carries it. A row WITHOUT it is a
       * pre-#897 intent, sized at the full `deployment_fraction` with no
       * reserve — which is strictly more than a read-side default of `0` would
       * tell a reader, since `0` is also a legal post-#897 configured value and
       * the two would then be indistinguishable. Declaring it required would
       * make this type claim something untrue of every journaled row predating
       * this change.
       *
       * There is no reader of `frozen_bracket` in the tree today, so this is a
       * latent type-vs-reality mismatch for a FUTURE expectancy accounting, not
       * a live arithmetic bug.
       */
      headroom_reserve_fraction?: number;
    };
    /**
     * The size D5 actually sized, before `whole_share_sizing` floored it to the
     * venue's quantity grid (#941). Present exactly when the flag is on AND the
     * floor moved the number, absent otherwise — so its presence is the signal
     * that this intent is NOT deployed at the sized fraction of equity
     * (`deployment_fraction x (1 - headroom_reserve_fraction)` since #897).
     *
     * Recorded because the quantisation is a deviation from the ADR's declared
     * sizing, and a deviation that leaves no trace is one no later expectancy
     * accounting can correct for. `size` (submitted) against this (intended)
     * gives the realized deployment shortfall directly; without it the
     * shortfall is only recoverable by re-deriving D5 from equity at decision
     * time, which is not persisted.
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
 * The setup vector the Trader embeds for cosine-similarity retrieval. See
 * docs/specs/trader-spec.md ("Key Interfaces", "Module: Cosine Precedent
 * Retrieval"). Combined debate + market-regime features so retrieval
 * matches "this kind of debate in this kind of market."
 */
export interface SetupVector {
  /** conviction, direction, converged, disagreement magnitude. */
  debate_features: number[];
  /** volatility bucket, trend, key indicators at decision time. */
  market_features: number[];
}

/**
 * A past setup returned by the store: its vector plus its realized
 * R-multiple outcome (realized PnL / initial risk) and when the trade
 * closed. `SetupStore` implementations only return neighbors already
 * closed as of the query's `asOf` — a still-open setup has no R label yet
 * (point-in-time, no lookahead; docs/specs/trader-spec.md story 13).
 */
export interface SetupNeighbor {
  vector: SetupVector;
  r_multiple: number;
  closed_at: Date;
}

/**
 * How a debate resolved (#1081) — distinguishes a debate that genuinely
 * completed deliberation from one the latency budget force-stopped, which
 * `DebateLog.converged: false` alone cannot: both land there identically.
 *
 *  - `'converged'`: the mediator signalled agreement before the round cap.
 *  - `'non_converged'`: the round cap was reached without the mediator
 *    agreeing, and the latency budget did NOT fire — real, deliberated
 *    disagreement, the signal the debate-as-edge thesis is built on.
 *  - `'latency_truncated'`: `enforceLatencyBudget` cut the debate off before
 *    it produced a result (`DebateResult.timed_out` is set); the row holds
 *    whatever partial mediator synthesis existed at that instant, not a
 *    completed assessment. Measured dominating a soak's neutral rate — see
 *    `DebateLog.termination`.
 */
export type DebateTermination = 'converged' | 'non_converged' | 'latency_truncated';

/**
 * What actually stopped a `'latency_truncated'` debate (#1380, migration
 * 0051) — `'budget'` when the asset-class timer genuinely fired,
 * `'llm_failure'` when an `LlmClient` call failed outright and arrived before
 * it. NULL for every row where `termination !== 'latency_truncated'`
 * (nothing stopped it early to have a cause) and for every row written before
 * this column existed, same "genuinely indeterminate, never guessed"
 * convention as `termination` itself (#1081).
 */
export type DebateTerminationCause = 'budget' | 'llm_failure';

/**
 * Persisted analytics/audit record (debate-engine-spec.md story 20). Written
 * ONCE per completed debate to the shared store (append-only), AFTER the
 * debate resolves — distinct from the ephemeral round-by-round operational
 * state, which is discarded/re-run on crash (decision #10, unchanged; see
 * debate-engine-spec.md "Module: State Persistence"). This is the Feedback
 * Loop's system-of-record for per-analyst attribution, joined by `debate_id`
 * (cross-spec-contracts.md registry #1).
 */
export interface DebateLog {
  /** Same deterministic hash Trader/Verdict/FL join on. */
  debate_id: string;
  instrument: string;
  bar_timestamp: Date;
  /** influence_score, stance, per analyst — read by FL's weight attribution. */
  contributions: AnalystContribution[];
  direction: Direction;
  rounds: number;
  created_at: Date;
  /**
   * The tick that produced this debate (#426) — what lets the dashboard's lane
   * drawer find the right row instead of guessing from instrument + recency.
   *
   * Optional because it genuinely can be absent: rows written before #426 have
   * none, and `trace_id` is not stable across a retry (a fresh one is minted
   * per instrument per tick, while `debate_id` is a content hash and is
   * identical on a retried tick within the same bar). First-write-wins — the
   * trace that actually ran the debate owns the row.
   */
  trace_id?: string;
  /**
   * What the Trader actually read, so this row can REPLAY the debate rather
   * than merely describe it (#617).
   *
   * All optional together, and absent rather than null on the domain object:
   * rows written before migration 0026 carry none of them. The replay path
   * treats a row without `confidence` as un-replayable and re-runs the debate,
   * so an old row degrades to pre-#617 behaviour instead of a fabricated
   * position — `confidence` is the field position sizing is a function of, and
   * `debate_log` had no column for it at all until 0026.
   */
  confidence?: number;
  synthesis?: string;
  position?: string;
  disagreement_summary?: string;
  open_items?: string[];
  converged?: boolean;
  /**
   * Present from migration 0041 onward; absent (NULL) on every row written
   * before it — NOT "converged" and NOT "non_converged", genuinely
   * indeterminate (#1081). `buildDebateLog` derives it from the resolved
   * `DebateResult` (`timed_out` set ⇒ `'latency_truncated'`, else `converged`
   * mirrors the boolean above), so every row written by this build classifies
   * itself. `server/tools/classify-debate-termination.ts` backfills specific
   * pre-migration rows from run logs where the correlation (a `debate.timeout`
   * line naming the same `debate_id`) is unambiguous; the column itself never
   * guesses a value for a row it cannot derive one for.
   */
  termination?: DebateTermination;
  /**
   * Present only when `termination === 'latency_truncated'` (#1380). Derived
   * from `DebateResult.timed_out.cause` the same way `termination` is derived
   * from `timed_out` being set at all — see `DebateTerminationCause`'s own
   * doc for what the two values mean and why a query needs this column
   * rather than parsing `logger.logTimeout`'s free-text reason.
   */
  termination_cause?: DebateTerminationCause;
}

/**
 * Persisted real-field record of a `VerdictDecision` (verdict-spec.md story
 * 17, shared-sqlite-store-spec.md `verdict_log`). Real-field companion to the
 * generic `audit_log` (digests/hashes only) — mirrors `DebateLog`'s pattern of
 * a stage-specific table alongside `audit_log`. Keyed by `trace_id`, the
 * correlation ID threaded from the Orchestrator's tick (not `idempotency_key`,
 * which is retained as a non-PK column for cross-reference to
 * `open_positions`/`fills`). Append-only: one row per `VerdictDecision`.
 */
export interface VerdictLog {
  trace_id: string;
  idempotency_key: string;
  instrument: string;
  status: 'go' | 'no_go';
  /** The gate that fired; null iff `status === 'go'`. */
  no_go_reason: string | null;
  /**
   * What that gate measured, and the bound it broke (#1111) — signal age for
   * `staleness`, mark age at the read instant for `stale_feed` (negative when
   * the mark was stamped ahead of us, where the bound is the receipt
   * tolerance). Null for every other reason and for a `go`; see
   * `VerdictDecision.no_go_detail`.
   */
  no_go_detail_measured_ms: number | null;
  no_go_detail_bound_ms: number | null;
  /**
   * True whenever a human path was actually taken — live approval/rejection/
   * timeout, or backtest's bypassed-but-recorded HITL gate — i.e.
   * `approval_path !== 'automated'`. NOT `would_require_approval`, which is
   * also true on an automated backtest bypass where no override occurred.
   */
  hitl_override: boolean;
  timestamp: Date;
}

/**
 * Lifecycle of a bracket's entry order. See docs/specs/execution-spec.md
 * ("Module: Order State Machine & Partial Fills"). Every transition is
 * persisted, so the state is always durable and inspectable. Ticket #82
 * only produces `pending` (write-ahead) and `submitted` (post-ack); #83's
 * `ingestFills()` drives `partially_filled` → `filled` → `closed` as fills
 * arrive.
 *
 * Declared in `contracts/primitives.ts` and re-exported here: `PositionRow`
 * carries it to the browser, which renders the state word and must not import
 * the execution registry to learn the union.
 */
export type { OrderState } from '../../../contracts/index.js';

// Also imported, not just re-exported: `export … from` publishes the name
// without binding it locally, and `OpenPosition` below annotates with it.
import type { OrderState } from '../../../contracts/index.js';

/**
 * A live open lot — Trader position-awareness + Risk exposure. Defined here
 * (not in server/pipeline/execution) because it is a cross-spec registry type: Execution
 * is its SOLE writer, but Risk and the Trader read it
 * (docs/specs/cross-spec-contracts.md §4).
 *
 * `Fill` and `ClosedTrade` — the registry's other two Execution records —
 * are defined below: #83 (`ingestFills()`/`ClosedTrade` emission) is their
 * writer.
 *
 * Per-lot by design (v1): each `entry`/`scale_in` is its own record with its
 * own bracket and `debate_id`, which is what keeps the Feedback Loop's
 * single-entry-bracket R assumption true. Blended-average accounting is v2.
 */
export interface OpenPosition {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** Exits close a lot; they never create one — hence no 'exit' here. */
  intent_type: 'entry' | 'scale_in';
  requested_size: number;
  /**
   * Cumulative filled quantity — downstream (Risk exposure, FL's R) reads
   * THIS, never `requested_size` (cross-spec §4). Zero on the write-ahead
   * record: nothing has filled at `pending`, so the lot carries no exposure
   * yet. #83 advances it as fills arrive.
   */
  filled_size: number;
  /** Zero until the first fill lands, for the same reason as `filled_size`. */
  avg_entry_price: number;
  /** Live protective legs; #83 resizes them to filled qty on partial fill. */
  stop: number;
  target: number;
  order_state: OrderState;
  broker_order_ids: string[];
  opened_at: Date;
  /** The bar/decision time, carried from the OrderIntent. */
  decision_timestamp: Date;
  /**
   * Carried from the originating `OrderIntentMetadata` (#74). The Trader's
   * position-aware branching reads these to decide whether a same-direction
   * debate's conviction rose materially enough to warrant a `scale_in`.
   */
  conviction: number;
  converged: boolean;
  /**
   * #1001: the price the Trader's decision was formed at — `OrderIntent.entry`,
   * unchanged through Debate/Risk/Verdict. NOT the post-tick-rounding wire
   * price the adapter actually submits (`broker_brackets.entry_price` carries
   * that, joinable by `(venue, client_order_id)`). Optional because a row
   * written before migration 0037 carries none — omission means "not
   * captured", never a fabricated 0.
   */
  decision_price?: number;
  /**
   * The submit-time quote's own two sides, from `MarketDataService.getQuote`
   * — genuinely observed, never derived from a scalar spread (#1001). Both
   * absent together on any source with no `DataSource.fetchQuote` (e.g.
   * Alpaca's own `AlpacaDataSource`), or on a pre-migration-0037 row.
   */
  quote_bid?: number;
  quote_ask?: number;
  /** (quote_bid + quote_ask) / 2 — a real midpoint of the SAME observed quote. Absent iff the pair is. */
  quote_mid?: number;
  /** The quote's own timestamp — distinct from `decision_timestamp` and `opened_at` (pipeline latency separates all three). */
  quote_observed_at?: Date;
  /**
   * The modelled cost breakdown captured at submit time, via the same
   * `CostModel.fill()` the Simulated adapter calls (#1001) — what
   * `ingest-fills.ts`'s `toFill` copies onto a real-broker entry fill's own
   * `Fill.cost_breakdown` (prorated by that fill's share of `requested_size`)
   * since the venue reports no breakdown of its own. Absent on a
   * pre-migration-0037 row or when the submit-time capture failed
   * (best-effort — see `execute.ts`'s `captureSubmitSnapshot`).
   */
  modelled_cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * #1186, migration 0056 — set only when `order_state === 'abandoned'`: why
   * `wedged-zero-fill-sweep.ts` retired this lot without ever seeing a fill.
   * Absent on every other row, including one abandoned before this column
   * existed (none do — the state and the column shipped together).
   */
  abandon_reason?: string;
}

/**
 * Nominal wrapper on the venue-assigned fill id (#1334): both this and
 * `idempotency_key` are plain `string`, so an object literal built with the
 * two fields swapped still type-checked before this brand existed (#1328's
 * gap). Produce one only via `toBrokerFillId` at the venue boundary; a raw
 * `string` (such as an `idempotency_key`) placed in a `broker_fill_id` field
 * fails to compile instead of silently swapping. Nothing lints a bare
 * `as BrokerFillId`, so the guarantee holds only while that convention does.
 */
export type BrokerFillId = string & { readonly __brand: 'BrokerFillId' };
export function toBrokerFillId(value: string): BrokerFillId {
  return value as BrokerFillId;
}

/**
 * One row per (partial) fill — every fill logged (CONTEXT.md invariant #4),
 * so the accounting view can reconstruct realized PnL from the raw record
 * rather than trusting a running total. Written by #83's `ingestFills()`.
 *
 * `broker_fill_id` is the ingestion dedup key: the adapters' fill feed is
 * inclusive of `since`, so the same fill is re-offered on the next poll and
 * must land at most once.
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
   * On a Simulated-adapter fill: `CostModel.fill`'s own `CostModelResult`,
   * priced against the actual fill. On a real-broker `'entry'` fill (#1001):
   * the MODELLED figure captured at submit time
   * (`OpenPosition.modelled_cost_breakdown`), prorated by this fill's share
   * of the lot's `requested_size` — the venue reports no breakdown of its
   * own, so this is the estimate to diff the realized price against, not a
   * second observation. Absent on a `'stop'`/`'target'` fill (the Simulated
   * adapter never modelled those either — there is no modelled figure to
   * fall back to) and on any fill whose submit-time capture failed or
   * predates migration 0037. FL's live-vs-modeled divergence check
   * (cross-spec §4, GAP-F) reads this the same way regardless of which path
   * populated it; a caller that must tell them apart can check `leg`.
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
  /**
   * #793: WHY this fill closed a position, for a `leg: 'exit'` fill produced
   * by `redistributeOneFlatten` — the flatten's own journalled
   * `flatten_submissions.exit_reason`, copied onto the split fill so
   * `closedTrade()` can read it back on any poll, not only the one that
   * ingested it (migration 0031). Absent on an `'entry'`/`'stop'`/`'target'`
   * fill (those name their own close reason via `leg` directly, with no
   * `OrderIntent` behind them to carry one) and on an `'exit'` fill from
   * before this migration, whose reason was never recorded.
   */
  exit_reason?: ExitReason;
  /**
   * #1001, migration 0037: for a `leg: 'exit'` fill produced by
   * `redistributeOneFlatten`, the FLATTEN's own
   * `flatten_submissions.idempotency_key` (not the lot's — this row's own
   * `idempotency_key` is already the lot's, per `fills`' PK convention).
   * Joins a stored exit fill back to the specific flatten submission that
   * priced it (`decision_price`, `quote_mid`, `modelled_cost_breakdown`)
   * without a timestamp-ordering guess when a lot was partially flattened
   * more than once. Absent on `'entry'`/`'stop'`/`'target'` fills and on an
   * `'exit'` fill from before this migration.
   */
  flatten_idempotency_key?: string;
  /**
   * #1220, migration 0054: the currency the VENUE denominated `fee` in, as
   * the adapter reported it (`NormalizedFill.fee_currency`), recorded
   * verbatim and never converted.
   *
   * `fee` itself is summed into `closed_trades.fees_total` and every PnL
   * figure as BOOK currency. Until this column existed the adapter's value
   * was dropped at `toFill`, so a USD commission was booked as GBP with
   * nothing said. It is persisted rather than converted because David's
   * 2026-09-08 ruling on #1220 makes a non-sterling fee a CONTRADICTION, not
   * an FX term to model: `tradeableUniverse` excludes every non-sterling
   * line, so one arriving means an instrument was traded that selection
   * should have refused. `ingestFills()` raises it (see
   * `FEE_CURRENCY_NOT_BOOK_CURRENCY`) and still writes the row — refusing a
   * fill the venue has already made would strand a real open position
   * outside the append-only fill log (CONTEXT.md invariant 4).
   *
   * Absent where the adapter reports no currency at all (the Simulated and
   * Alpaca adapters both do) and on every row written before this migration.
   * Absence is "not reported", never an assertion that the fee was GBP.
   */
  fee_currency?: string;
}

/**
 * Emitted on round-trip-to-flat — the realized record the Feedback Loop and
 * Risk consume. Defined here rather than in server/pipeline/execution because it is a
 * cross-spec registry type (§4): Execution is its sole writer, FL and Risk
 * read it. feedback-loop-spec references `ClosedTrade` but never defines it;
 * this is that definition (execution-spec.md cross-spec addition #1).
 *
 * Per-lot, like `OpenPosition`: a scale-in closes as its own `ClosedTrade`
 * with its own `debate_id`, which is what keeps FL's single-entry-bracket R
 * assumption true.
 */
export interface ClosedTrade {
  idempotency_key: string;
  /** Attribution + setup-store join key. */
  debate_id: string;
  instrument: string;
  asset_class: AssetClass;
  side: 'buy' | 'sell';
  /** Avg entry, derived from the entry fills. */
  entry: number;
  /**
   * The INITIAL protective stop — the denominator of R, so it must be the
   * risk the trade was opened against, not a later trailed level.
   */
  stop: number;
  /** → initial risk = |entry − stop| × filled_size. */
  filled_size: number;
  /** Net of fees across every leg. */
  realized_pnl_net: number;
  fees_total: number;
  opened_at: Date;
  closed_at: Date;
  /**
   * #793: 'stop'/'target' name a bracket hit (resting at the venue — see
   * `TickStage`'s doc). 'exit' is the LEGACY value for a flatten/early-release
   * row written before migration 0031, when the two were not yet
   * distinguishable here. 'flatten' | 'signal_decay' | 'direction_flip' are
   * the same three `ExitReason` values `trader_log.exit_reason` already
   * carries (#748) — the same in-process exit, named the same way in both
   * tables from migration 0031 forward.
   */
  close_reason: 'stop' | 'target' | 'exit' | ExitReason;
  /**
   * #1121, migration 0049: did every leg of this round trip the modelled-cost
   * mechanism covers actually get charged its modelled commission? Computed
   * from the lot's persisted fills at close time (`closedTrade()` in
   * `ingest-fills.ts`), never asserted as a constant — a live lot whose
   * submit-time snapshot is missing (pre-migration-0037 row, or a failed
   * `captureSubmitSnapshot`) goes through the same code path and is NOT
   * charged by it, so "went through the fix" and "was charged by the fix" are
   * different facts and only the second one belongs in this column.
   *
   * `false` excludes the row from `SqliteArmComparisonSource` unconditionally:
   * an uncharged live row mixed into a window is exactly the asymmetry #1121
   * closes.
   */
  modelled_cost_charged: boolean;
}
