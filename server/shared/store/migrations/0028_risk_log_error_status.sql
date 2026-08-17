-- Adds 'error' to risk_log.status (#726).
--
-- ADR-0018 D5's `perSubclassDeploymentCap` (risk-manager/index.ts) is the one
-- entry gate that throws instead of returning a decision, when the intent's
-- instrument reaches the gate with no subclass, or a subclass with no cap
-- declared for it — either is a hole in the pool file the gate refuses to
-- size around. Because the throw happens INSIDE `RiskManagerImpl.evaluate()`,
-- the row `buildRiskStep` (direct-bind.ts) writes after `evaluate()` RETURNS
-- never runs: the refused instrument left no `risk_log` row at all, only a
-- `TickOutcome.error` and an `audit_log` row from the per-instrument catch
-- (#507) one level up in `tick-loop.ts`.
--
-- The fix keeps the throw (deliberately: a returned rejection is quiet, and a
-- half-populated pool file that merely declines entries can run for days
-- looking like a market with no setups) and instead writes the `risk_log` row
-- from the CATCH around `riskManager.evaluate()` in `buildRiskStep`, so the
-- refusal lands in the same table as every other Risk outcome. That row's
-- `status` needs a third value distinguishable from a normal 'rejected' —
-- 'rejected' means the gates ran and declined the intent; this means a gate
-- could not even be evaluated.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
-- column-for-column, exactly as 0017 and 0022 did.

CREATE TABLE risk_log_new (
  trace_id            TEXT    NOT NULL,
  instrument          TEXT    NOT NULL,
  -- 'approved' | 'rejected' | 'error'. 'error' is new: the gate pipeline
  -- threw before a decision could be reached.
  status              TEXT    NOT NULL CHECK(status IN ('approved', 'rejected', 'error')),
  binding_constraint  TEXT    NULL,
  reasons_json        TEXT    NOT NULL,
  original_size       REAL    NULL,
  final_size          REAL    NULL,
  stop_tightened      INTEGER NOT NULL CHECK(stop_tightened IN (0, 1)),
  portfolio_tripped   INTEGER NOT NULL CHECK(portfolio_tripped IN (0, 1)),
  crypto_tripped      INTEGER NOT NULL CHECK(crypto_tripped IN (0, 1)),
  stocks_tripped      INTEGER NOT NULL CHECK(stocks_tripped IN (0, 1)),
  armed_breakers_json TEXT    NOT NULL,
  equity              REAL    NOT NULL,
  drawdown_pct        REAL    NOT NULL,
  gross_exposure      REAL    NOT NULL,
  consecutive_losses  INTEGER NOT NULL,
  daily_pnl_portfolio_pct REAL NULL,
  daily_pnl_crypto_pct    REAL NULL,
  daily_pnl_stocks_pct    REAL NULL,
  daily_pnl_unknown_reason TEXT NULL,
  created_at          TEXT    NOT NULL,
  PRIMARY KEY (trace_id, instrument)
);

INSERT INTO risk_log_new SELECT * FROM risk_log;

DROP TABLE risk_log;

ALTER TABLE risk_log_new RENAME TO risk_log;

CREATE INDEX idx_risk_log_created_at ON risk_log(created_at);
