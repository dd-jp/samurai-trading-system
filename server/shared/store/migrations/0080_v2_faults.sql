CREATE TABLE IF NOT EXISTS v2_faults (
  fault_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN (
    'missed_stop', 'reconcile_mismatch', 'stuck_order', 'refused_cycle', 'stale_bar',
    'failed_broker_call', 'missed_run', 'token_failure'
  )),
  trading_date TEXT NOT NULL,
  code         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  UNIQUE (kind, trading_date, code, detail)
);

CREATE INDEX IF NOT EXISTS idx_v2_faults_trading_date ON v2_faults (trading_date);

CREATE TRIGGER IF NOT EXISTS v2_faults_no_update
BEFORE UPDATE ON v2_faults
BEGIN
  SELECT RAISE(ABORT, 'v2_faults is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_faults_no_delete
BEFORE DELETE ON v2_faults
BEGIN
  SELECT RAISE(ABORT, 'v2_faults is append-only');
END;
