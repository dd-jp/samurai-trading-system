/**
 * Canonical cross-spec types shared across >=2 components.
 * Source of truth: docs/specs/cross-spec-contracts.md — this file is the
 * TypeScript realization of that registry. Populated ticket-by-ticket
 * (starting with #24 Domain Types & Contracts); do not hand-roll competing
 * shapes in individual component files once a type is defined here.
 */

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
  asset_class: 'crypto' | 'stocks';
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
 * Owned by the Feedback Loop (Stage 6, `docs/wayfinder/feedback-loop-map.md`
 * "Setup store & outcome labelling"); the Trader reads neighbors and writes
 * new setups but does not build or label the store. Part of the shared
 * SQLite store family (docs/specs/trader-spec.md "Module: Cosine Precedent
 * Retrieval").
 */
export interface SetupStore {
  /** Only setups closed with a known outcome as of `asOf` are returned. */
  findNeighbors(vector: SetupVector, asOf: Date): SetupNeighbor[];
  /** Persists the new setup for later outcome labelling by the Feedback Loop. */
  writeSetup(debateId: string, vector: SetupVector, decidedAt: Date): void;
}

/**
 * Lifecycle of a bracket's entry order. See docs/specs/execution-spec.md
 * ("Module: Order State Machine & Partial Fills"). Every transition is
 * persisted, so the state is always durable and inspectable. Ticket #82
 * only produces `pending` (write-ahead) and `submitted` (post-ack); the
 * fill/close transitions are driven by #83's `ingestFills()`.
 */
export type OrderState =
  | 'pending'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'closed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

/**
 * A live open lot — Trader position-awareness + Risk exposure. Defined here
 * (not in src/execution) because it is a cross-spec registry type: Execution
 * is its SOLE writer, but Risk and the Trader read it
 * (docs/specs/cross-spec-contracts.md §4).
 *
 * `Fill` and `ClosedTrade` — the registry's other two Execution records —
 * are deliberately NOT defined yet: #83 (`ingestFills()`/`ClosedTrade`
 * emission) is their writer, and #82 neither writes nor reads them.
 *
 * Per-lot by design (v1): each `entry`/`scale_in` is its own record with its
 * own bracket and `debate_id`, which is what keeps the Feedback Loop's
 * single-entry-bracket R assumption true. Blended-average accounting is v2.
 */
export interface OpenPosition {
  idempotency_key: string;
  debate_id: string;
  instrument: string;
  asset_class: 'crypto' | 'stocks';
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
}
