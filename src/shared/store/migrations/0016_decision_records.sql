-- Trader and Risk decision records (#328).
--
-- WHY THESE EXIST. `audit_log` is digest-only — `trace_id, stage, decision,
-- input_digest, output_digest, timestamp`. That proves a stage ran and that
-- its I/O hashed to X, which is a real tamper-evidence property, and it cannot
-- reconstruct a single value. `shared/types.ts` states the intent plainly: the
-- real-field record is the STAGE-SPECIFIC table alongside `audit_log`, which is
-- why `debate_log` and `verdict_log` exist.
--
-- Trader and Risk had no such table. So for the two stages that decide WHAT to
-- trade and HOW BIG, post-hoc reconstruction had only a digest, whatever the
-- Logger wrote to stdout, and the downstream `OrderIntent` if the tick got that
-- far. Unanswerable after the fact: which precedents moved conviction, what
-- portfolio state Risk sized against, why a size came out at N rather than 2N,
-- and why a tick stopped at `risk` instead of reaching Verdict.
--
-- SHAPE: per-stage tables, resolved on #328 over the alternatives. Widening
-- `audit_log` would break the documented digest/real-field split and make a
-- generic table carry stage-shaped payloads. A JSON blob per stage is cheapest
-- to write and worst to query. Relying on the structured log alone is
-- defensible on cost but not joinable: reconstructing one tick would mean
-- grepping a rotating file and correlating by timestamp, when `debate_log`
-- already holds the other half of the same tick under `debate_id`.
--
-- WRITE PATH: synchronous, inside the tick, same as `debate_log`/`verdict_log`.
-- One INSERT against a path that has just made several LLM calls costing whole
-- seconds. Buffering would open a loss window on exactly the rows that explain
-- a crash.
--
-- RETENTION: append-forever, deliberately. At ADR-0008's 15-minute cadence the
-- system runs ~296 instrument-passes/day, so both tables together hold roughly
-- 8,300 rows across a 14-day soak. Revisit if the tick interval drops toward
-- 60s, where the same design is ~124,000 rows a fortnight — that number, not a
-- vague "if it gets big", is the trigger.
--
-- NOT A FROZEN CROSS-SPEC CONTRACT (yet). The Feedback Loop does not read these
-- in v1; it joins `debate_log` by `debate_id` for attribution and needs nothing
-- here. The only consumer is the dashboard drill-down (#417). They enter
-- `cross-spec-contracts.md` the moment a second consumer appears.

-- One row per Trader decision, INCLUDING a decision not to trade (#328 Q4).
-- `TickOutcome.final_stage` records where a tick stopped and never why, and
-- "why did nothing trade for six hours" is the likeliest question a soak
-- produces. A skip is a decision.
CREATE TABLE trader_log (
  trace_id            TEXT    NOT NULL,
  instrument          TEXT    NOT NULL,
  -- Joins `debate_log`. The debate's own content is NOT duplicated here: two
  -- records of the same thing can disagree, and that one already exists.
  debate_id           TEXT    NOT NULL,
  -- 'entry' | 'scale_in' | 'exit', or NULL when `decide()` returned null.
  intent_type         TEXT    NULL,
  -- Populated only on a skip. The reason no order was produced.
  skip_reason         TEXT    NULL,
  -- The five factors whose PRODUCT is the answer to "why N and not 2N".
  base_risk_fraction  REAL    NULL,
  conviction_multiplier REAL  NULL,
  vol_floor_factor    REAL    NULL,
  non_converged_haircut REAL  NULL,
  cosine_multiplier   REAL    NULL,
  -- What the cosine retrieval returned, which is what moved `cosine_multiplier`.
  neighbor_count      INTEGER NULL,
  weighted_mean_r     REAL    NULL,
  no_precedent        INTEGER NULL CHECK(no_precedent IN (0, 1)),
  -- The priced inputs and the result.
  atr                 REAL    NULL,
  entry               REAL    NULL,
  stop                REAL    NULL,
  size                REAL    NULL,
  created_at          TEXT    NOT NULL,
  PRIMARY KEY (trace_id, instrument)
);

-- One row per Risk evaluation, including a rejection.
CREATE TABLE risk_log (
  trace_id            TEXT    NOT NULL,
  instrument          TEXT    NOT NULL,
  -- 'approved' | 'rejected'.
  status              TEXT    NOT NULL CHECK(status IN ('approved', 'rejected')),
  -- The gate that decided it, and the ordered human-readable reasons.
  binding_constraint  TEXT    NULL,
  reasons_json        TEXT    NOT NULL,
  -- The trim chain: what the Trader asked for versus what Risk allowed.
  original_size       REAL    NULL,
  final_size          REAL    NULL,
  stop_tightened      INTEGER NOT NULL CHECK(stop_tightened IN (0, 1)),
  -- Breaker state AS EVALUATED, not as it is now.
  portfolio_tripped   INTEGER NOT NULL CHECK(portfolio_tripped IN (0, 1)),
  crypto_tripped      INTEGER NOT NULL CHECK(crypto_tripped IN (0, 1)),
  stocks_tripped      INTEGER NOT NULL CHECK(stocks_tripped IN (0, 1)),
  armed_breakers_json TEXT    NOT NULL,
  -- The portfolio SCALARS the checks actually read. Deliberately not the whole
  -- `PortfolioView`: `exposure_by_instrument` is a map with no bound, and under
  -- a rotating shortlist (#397) it is the field that grows without limit.
  equity              REAL    NOT NULL,
  drawdown_pct        REAL    NOT NULL,
  gross_exposure      REAL    NOT NULL,
  consecutive_losses  INTEGER NOT NULL,
  -- The three daily-PnL tiers. NULL pct with a reason is the `known: false`
  -- case (#333) — an absent figure must stay distinguishable from a flat one
  -- here for the same reason it does in the breaker.
  daily_pnl_portfolio_pct REAL NULL,
  daily_pnl_crypto_pct    REAL NULL,
  daily_pnl_stocks_pct    REAL NULL,
  daily_pnl_unknown_reason TEXT NULL,
  created_at          TEXT    NOT NULL,
  PRIMARY KEY (trace_id, instrument)
);

-- Both tables are queried by the dashboard drill-down for the CURRENT trace
-- (#422 scoped the drawer to the live trace, not history), which the primary
-- key's leading column already serves. `created_at` gets an index because the
-- pipeline view's 15-minute window (#413) is a time range, and that is the one
-- query whose cost grows with the length of a soak.
CREATE INDEX idx_trader_log_created_at ON trader_log(created_at);
CREATE INDEX idx_risk_log_created_at ON risk_log(created_at);
