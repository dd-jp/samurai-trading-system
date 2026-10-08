-- #2024: SQLite cannot alter a CHECK, so v2_faults is rebuilt to admit the veto_rate kind; every
-- row keeps its fault_id
CREATE TABLE v2_faults_rebuilt (
  fault_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL CHECK (kind IN (
    'missed_stop', 'reconcile_mismatch', 'stuck_order', 'refused_cycle', 'stale_bar',
    'failed_broker_call', 'missed_run', 'token_failure', 'veto_rate'
  )),
  trading_date TEXT NOT NULL,
  code         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  UNIQUE (kind, trading_date, code, detail)
);

INSERT INTO v2_faults_rebuilt (fault_id, kind, trading_date, code, detail, recorded_at)
SELECT fault_id, kind, trading_date, code, detail, recorded_at FROM v2_faults ORDER BY fault_id;

DROP TABLE v2_faults;

ALTER TABLE v2_faults_rebuilt RENAME TO v2_faults;

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

CREATE TRIGGER IF NOT EXISTS v2_faults_no_replace
BEFORE INSERT ON v2_faults
WHEN NEW.fault_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_faults WHERE fault_id = NEW.fault_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_faults is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_faults_replay_ignored
BEFORE INSERT ON v2_faults
WHEN EXISTS (
  SELECT 1 FROM v2_faults
  WHERE kind = NEW.kind AND trading_date = NEW.trading_date AND code = NEW.code AND detail = NEW.detail
)
BEGIN
  SELECT RAISE(IGNORE);
END;
