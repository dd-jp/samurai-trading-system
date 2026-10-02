-- One 'started' row before a flatten acts and one 'finished' row after it (#1894). A started row
-- with no finished row is a flatten a crash interrupted: the poller resumes it on its own
-- trading_date, so the exits keep their client order ids and are never sent twice
CREATE TABLE IF NOT EXISTS v2_flattens (
  flatten_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  control_id    INTEGER NOT NULL REFERENCES v2_controls (control_id),
  event         TEXT NOT NULL CHECK (event IN ('started', 'finished')),
  trading_date  TEXT NOT NULL,
  outcome       TEXT CHECK (outcome IN ('closed', 'failed')),
  detail        TEXT,
  recorded_at   TEXT NOT NULL,
  UNIQUE (control_id, event),
  CHECK ((event = 'finished') = (outcome IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS v2_flattens_no_update
BEFORE UPDATE ON v2_flattens
BEGIN
  SELECT RAISE(ABORT, 'v2_flattens is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_flattens_no_delete
BEFORE DELETE ON v2_flattens
BEGIN
  SELECT RAISE(ABORT, 'v2_flattens is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_flattens_no_replace
BEFORE INSERT ON v2_flattens
WHEN (NEW.flatten_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_flattens WHERE flatten_id = NEW.flatten_id))
   OR EXISTS (SELECT 1 FROM v2_flattens WHERE control_id = NEW.control_id AND event = NEW.event)
BEGIN
  SELECT RAISE(ABORT, 'v2_flattens is append-only');
END;
