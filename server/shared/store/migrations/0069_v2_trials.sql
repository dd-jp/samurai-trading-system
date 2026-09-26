CREATE TABLE IF NOT EXISTS v2_trials (
  trial        INTEGER PRIMARY KEY CHECK (trial >= 1),
  candidate    TEXT NOT NULL,
  config_hash  TEXT NOT NULL UNIQUE,
  config       TEXT NOT NULL,
  source       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_trials_no_update
BEFORE UPDATE ON v2_trials
BEGIN
  SELECT RAISE(ABORT, 'v2_trials is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_trials_no_delete
BEFORE DELETE ON v2_trials
BEGIN
  SELECT RAISE(ABORT, 'v2_trials is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_trials_contiguous
BEFORE INSERT ON v2_trials
WHEN NEW.trial <> (SELECT COALESCE(MAX(trial), 0) + 1 FROM v2_trials)
BEGIN
  SELECT RAISE(ABORT, 'v2_trials: trial numbers are contiguous from 1');
END;
