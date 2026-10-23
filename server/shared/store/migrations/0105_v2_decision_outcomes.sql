-- #2146: one row per closed trade, keyed like evidence.ts counts closed trades (a book's close
-- fills grouped by client_order_id). Written only once the close is final, so no column carries a
-- wall-clock time: rebuilding from the same journal and bars writes identical rows
CREATE TABLE IF NOT EXISTS v2_decision_outcomes (
  outcome_id             INTEGER PRIMARY KEY,
  decision_id            TEXT NOT NULL REFERENCES v2_decisions(decision_id),
  book_id                TEXT NOT NULL,
  sleeve_id              TEXT NOT NULL,
  instrument             TEXT NOT NULL,
  venue                  TEXT NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  decision_date          TEXT NOT NULL,
  entry_client_order_id  TEXT NOT NULL,
  exit_client_order_id   TEXT NOT NULL,
  exit_leg               TEXT NOT NULL,
  exit_reason            TEXT NOT NULL,
  entry_date             TEXT NOT NULL,
  exit_date              TEXT NOT NULL,
  entry_filled_at        TEXT,
  exit_filled_at         TEXT,
  holding_days           INTEGER NOT NULL,
  entry_qty              REAL NOT NULL,
  exit_qty               REAL NOT NULL,
  entry_price_gbp        REAL NOT NULL,
  exit_price_gbp         REAL NOT NULL,
  entry_price_native     REAL,
  exit_price_native      REAL,
  fees_gbp               REAL NOT NULL,
  carry_gbp              REAL NOT NULL,
  realised_pnl_gbp       REAL NOT NULL,
  trade_return           REAL NOT NULL,
  r_multiple             REAL,
  benchmark_symbol       TEXT NOT NULL,
  benchmark_return       REAL NOT NULL,
  excess_return          REAL NOT NULL,
  pin_digest             TEXT,
  entry_offset_bps       REAL,
  settled_at             TEXT NOT NULL,
  schema_version         INTEGER NOT NULL,
  UNIQUE (book_id, exit_client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_v2_decision_outcomes_settled ON v2_decision_outcomes (settled_at);

CREATE TRIGGER IF NOT EXISTS v2_decision_outcomes_no_update
BEFORE UPDATE ON v2_decision_outcomes
BEGIN
  SELECT RAISE(ABORT, 'v2_decision_outcomes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_decision_outcomes_no_delete
BEFORE DELETE ON v2_decision_outcomes
BEGIN
  SELECT RAISE(ABORT, 'v2_decision_outcomes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_decision_outcomes_no_replace
BEFORE INSERT ON v2_decision_outcomes
WHEN EXISTS (
  SELECT 1 FROM v2_decision_outcomes
   WHERE outcome_id = NEW.outcome_id
      OR (book_id = NEW.book_id AND exit_client_order_id = NEW.exit_client_order_id))
BEGIN
  SELECT RAISE(ABORT, 'v2_decision_outcomes is append-only');
END;
