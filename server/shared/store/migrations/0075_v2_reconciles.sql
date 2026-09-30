CREATE TABLE IF NOT EXISTS v2_reconciles (
  reconcile_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date TEXT NOT NULL,
  venue        TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('broker', 'simulated')),
  status       TEXT NOT NULL CHECK (status IN ('clean', 'mismatch', 'unverified', 'read_failed')),
  book_ids     TEXT NOT NULL,
  diffs        TEXT NOT NULL,
  detail       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_reconciles_trading_date ON v2_reconciles (trading_date);

CREATE TRIGGER IF NOT EXISTS v2_reconciles_no_update
BEFORE UPDATE ON v2_reconciles
BEGIN
  SELECT RAISE(ABORT, 'v2_reconciles is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_reconciles_no_delete
BEFORE DELETE ON v2_reconciles
BEGIN
  SELECT RAISE(ABORT, 'v2_reconciles is append-only');
END;
