/**
 * Domain records — the shapes that travel between stages and land in the store
 * (#308). See `primitives.ts` for the vocabulary and `ports.ts` for the
 * interfaces that read and write these.
 */
import type { AnalystContribution, Direction } from '../../pipeline/debate-engine/index.js';
import type { AssetClass } from './primitives.js';

/**
 * The bracket handed from the Trader to the Risk Manager. See
 * docs/specs/trader-spec.md ("Key Interfaces"). Defined here (not in
 * src/trader) because `metadata.debate_id` is the join key three other
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
   * The bar/decision time (retained from the idempotency-key hash input).
   * Downstream (Verdict) needs it for the signal-staleness gate; the hash
   * alone doesn't expose it.
   */
  decision_timestamp: Date;
  metadata: OrderIntentMetadata;
}

/**
 * Non-optional: must be present on OrderIntent.metadata -> VerdictDecision ->
 * every Execution record (OpenPosition/Fill/ClosedTrade) -> setup store
 * (cross-spec-contracts.md registry #1). `debate_id` is the Debate Engine's
 * deterministic hash(instrument + bar + AnalystView set).
 */
export interface OrderIntentMetadata {
  debate_id: string;
  conviction: number;
  converged: boolean;
  sizing: {
    /** After conviction scaling. */
    base_risk_fraction: number;
    conviction_multiplier: number;
    /** Effect of max(ATR, vol_floor). */
    vol_floor_factor: number;
    /** 1.0 if converged. */
    non_converged_haircut: number;
    /** 0.5-1.5, or 0.75 no-precedent default. */
    cosine_multiplier: number;
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
export type { OrderState } from '../../../contracts/primitives.js';

// Also imported, not just re-exported: `export … from` publishes the name
// without binding it locally, and `OpenPosition` below annotates with it.
import type { OrderState } from '../../../contracts/primitives.js';

/**
 * A live open lot — Trader position-awareness + Risk exposure. Defined here
 * (not in src/execution) because it is a cross-spec registry type: Execution
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
  broker_fill_id: string;
  leg: 'entry' | 'stop' | 'target' | 'exit';
  price: number;
  qty: number;
  fee: number;
  timestamp: Date;
  /**
   * Populated only for fills produced by the Simulated adapter, mapped from
   * `CostModel.fill`'s `CostModelResult`. Absent on real broker fills, where
   * no modeled breakdown exists — which is what powers FL's live-vs-modeled
   * cost divergence check (cross-spec §4, GAP-F).
   */
  cost_breakdown?: {
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;
  };
}

/**
 * Emitted on round-trip-to-flat — the realized record the Feedback Loop and
 * Risk consume. Defined here rather than in src/execution because it is a
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
  close_reason: 'stop' | 'target' | 'exit';
}
