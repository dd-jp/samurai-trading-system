-- Initial schema — transcribed from docs/specs/shared-sqlite-store-spec.md
-- "Module: Consolidated Schema". All fourteen tables; each owned by exactly one spec.

-- Market Data Service — owner: docs/specs/market-data-service-spec.md

-- Append-only bar history; the survivorship-free history AND the bulk cache tier.
CREATE TABLE bars (
  instrument   TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  open_time    TEXT NOT NULL,
  close_time   TEXT NOT NULL,
  open         REAL NOT NULL,
  high         REAL NOT NULL,
  low          REAL NOT NULL,
  close        REAL NOT NULL,
  volume       REAL NOT NULL,
  source       TEXT NOT NULL,          -- 'kraken' | 'ibkr' | 'alpaca' ... (audit only)
  PRIMARY KEY (instrument, timeframe, open_time)
);
CREATE INDEX idx_bars_close_time ON bars(instrument, timeframe, close_time);

-- One upserted row per instrument; read synchronously by Risk/Verdict. Never read in backtest.
CREATE TABLE latest_mark (
  instrument   TEXT PRIMARY KEY,
  price        REAL NOT NULL,
  observed_at  TEXT NOT NULL,
  asset_class  TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  source       TEXT NOT NULL
);

-- Execution — owner: docs/specs/execution-spec.md, sole writer of all three tables below

-- Live open state — Trader position-awareness + Risk exposure. Mutable.
CREATE TABLE open_positions (
  idempotency_key     TEXT PRIMARY KEY,
  debate_id           TEXT NOT NULL,
  instrument          TEXT NOT NULL,
  asset_class         TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side                TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  intent_type         TEXT NOT NULL CHECK(intent_type IN ('entry', 'scale_in')),
  requested_size      REAL NOT NULL,
  filled_size         REAL NOT NULL,   -- cumulative; downstream reads THIS, never requested_size
  avg_entry_price     REAL NOT NULL,
  stop                REAL NOT NULL,   -- live protective leg (resized on partial fill)
  target              REAL NOT NULL,
  order_state         TEXT NOT NULL,
  broker_order_ids    TEXT NOT NULL,   -- JSON string[]
  opened_at           TEXT NOT NULL,
  decision_timestamp  TEXT NOT NULL    -- the bar/decision time (from OrderIntent)
);
CREATE INDEX idx_open_positions_instrument ON open_positions(instrument, asset_class);

-- One row per (partial) fill — every fill logged (CONTEXT.md invariant #4). Append-only.
CREATE TABLE fills (
  idempotency_key      TEXT NOT NULL,
  broker_fill_id       TEXT NOT NULL,
  leg                  TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price                REAL NOT NULL,
  qty                  REAL NOT NULL,
  fee                  REAL NOT NULL,
  timestamp            TEXT NOT NULL,
  cost_breakdown_json  TEXT NULL,      -- JSON {spread_cost, commission, slippage, market_impact}; Simulated-adapter fills only
  PRIMARY KEY (idempotency_key, broker_fill_id)
);

-- Emitted on round-trip-to-flat — the Feedback Loop / Risk realized record. Append-only.
CREATE TABLE closed_trades (
  idempotency_key    TEXT PRIMARY KEY,   -- per-lot
  debate_id          TEXT NOT NULL,      -- attribution + setup-store join key
  instrument         TEXT NOT NULL,
  asset_class        TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side               TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  entry              REAL NOT NULL,      -- avg entry, from fills
  stop               REAL NOT NULL,      -- initial protective stop → initial risk
  filled_size        REAL NOT NULL,      -- initial risk = |entry - stop| x filled_size
  realized_pnl_net   REAL NOT NULL,      -- net of fees
  fees_total         REAL NOT NULL,
  opened_at          TEXT NOT NULL,
  closed_at          TEXT NOT NULL,
  close_reason       TEXT NOT NULL CHECK(close_reason IN ('stop', 'target', 'exit'))
);

-- Cost-Model / Backtest Harness — owner: docs/specs/cost-model-backtest-spec.md

-- The trial-count discipline (load-bearing): N = COUNT(*), distinct by construction via PK.
CREATE TABLE config_trials (
  config_hash  TEXT PRIMARY KEY,
  seed         INTEGER NOT NULL,
  config_json  TEXT NOT NULL,      -- full BacktestConfig, verbatim
  result_json  TEXT NOT NULL,      -- full BacktestReport, verbatim
  recorded_at  TEXT NOT NULL
);

-- Feedback Loop — owner: docs/specs/feedback-loop-spec.md

-- Current dial values — one table per dial, keyed to match each dial's own consumer.
CREATE TABLE analyst_weights (
  analyst_id  TEXT PRIMARY KEY,
  weight      REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE strategy_params (
  param_name  TEXT PRIMARY KEY,
  value       REAL NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE risk_thresholds (
  threshold_name  TEXT PRIMARY KEY,
  value           REAL NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Shared adjustment-history log across all three dial types. "Reversible" = another logged
-- adjustment, not a distinct undo mechanism. pending_approval rows are mutated in place on
-- approval/rejection (the one exception to append-only) -- this is the same row, not a new one.
CREATE TABLE dial_adjustments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  dial_type   TEXT NOT NULL CHECK(dial_type IN ('analyst_weight', 'strategy_param', 'risk_threshold')),
  dial_name   TEXT NOT NULL,   -- analyst_id / param_name / threshold_name, depending on dial_type
  from_value  REAL NOT NULL,
  to_value    REAL NOT NULL,
  direction   TEXT CHECK(direction IN ('tighten', 'loosen') OR direction IS NULL),  -- NULL for weight adjustments
  status      TEXT NOT NULL CHECK(status IN ('applied', 'pending_approval', 'rejected', 'reverted')),
  cycle_date  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_dial_adjustments_dial ON dial_adjustments(dial_type, dial_name, created_at);
CREATE INDEX idx_dial_adjustments_status ON dial_adjustments(status);

-- The cosine setup store -- Trader writes at decision time, FL labels on trade close.
-- PK is debate_id (not idempotency_key): one setup vector per debate, matching how the
-- Trader derives a SetupVector from a single DebateResult before sizing produces an order.
-- idempotency_key is kept as a required, non-unique indexed column purely for FL's
-- trade-close join (ClosedTrade carries idempotency_key, not debate_id alone, as its PK).
CREATE TABLE cosine_setups (
  debate_id             TEXT PRIMARY KEY,  -- one row per debate; Trader's setup-vector key
  idempotency_key       TEXT NOT NULL,     -- FL's trade-close join column (non-unique: see note below)
  instrument            TEXT NOT NULL,     -- retrieval scoping
  asset_class           TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),  -- retrieval scoping
  debate_features_json  TEXT NOT NULL,     -- serialized number[] (SetupVector.debate_features)
  market_features_json  TEXT NOT NULL,     -- serialized number[] (SetupVector.market_features)
  r_multiple            REAL NULL,         -- NULL = open/unlabelled; set once by FL's onTradeClose
  closed_at             TEXT NULL,         -- nullable; set together with r_multiple, for point-in-time correctness
  created_at            TEXT NOT NULL      -- decision time
);
CREATE INDEX idx_cosine_setups_idempotency_key ON cosine_setups(idempotency_key);
CREATE INDEX idx_cosine_setups_r_multiple ON cosine_setups(r_multiple);

-- Debate Engine — owner: docs/specs/debate-engine-spec.md

-- Append-only. FL's system-of-record for per-analyst attribution, joined by debate_id.
CREATE TABLE debate_log (
  debate_id           TEXT PRIMARY KEY,
  instrument          TEXT NOT NULL,
  bar_timestamp       TEXT NOT NULL,
  contributions_json  TEXT NOT NULL,   -- JSON AnalystContribution[] (influence_score, stance, per analyst)
  direction           TEXT NOT NULL CHECK(direction IN ('bullish', 'bearish', 'neutral')),
  rounds              INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);

-- Verdict — owner: docs/specs/verdict-spec.md

-- One row per VerdictDecision, keyed by trace_id. Real-field companion to the
-- generic audit_log (which only holds digests/hashes).
CREATE TABLE verdict_log (
  trace_id        TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('go', 'no_go')),
  no_go_reason    TEXT,
  hitl_override   INTEGER NOT NULL,
  timestamp       TEXT NOT NULL
);

-- Orchestrator — owner: docs/specs/orchestrator-spec.md

-- One row per stage-decision per trace_id. Append-only. Powers the dashboard read-only.
CREATE TABLE audit_log (
  trace_id       TEXT NOT NULL,
  stage          TEXT NOT NULL,
  decision       TEXT NOT NULL,
  input_digest   TEXT NOT NULL,
  output_digest  TEXT NOT NULL,
  timestamp      TEXT NOT NULL
);
CREATE INDEX idx_audit_log_trace_id ON audit_log(trace_id);

-- Disposable, best-effort progress state -- NOT a system-of-record. Upserted per-instrument
-- before each stage call, deleted on tick completion.
CREATE TABLE current_tick (
  instrument    TEXT PRIMARY KEY,
  asset_class   TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  stage         TEXT NOT NULL CHECK(stage IN ('analysts', 'debate', 'trader', 'risk', 'verdict', 'execution')),
  trace_id      TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
