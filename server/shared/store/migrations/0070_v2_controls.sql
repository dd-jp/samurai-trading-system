CREATE TABLE IF NOT EXISTS v2_controls (
  control_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  action           TEXT NOT NULL CHECK (action IN ('pause', 'halt', 'resume')),
  reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  source           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  set_at           TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_controls_no_update
BEFORE UPDATE ON v2_controls
BEGIN
  SELECT RAISE(ABORT, 'v2_controls is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_controls_no_delete
BEFORE DELETE ON v2_controls
BEGIN
  SELECT RAISE(ABORT, 'v2_controls is append-only');
END;
