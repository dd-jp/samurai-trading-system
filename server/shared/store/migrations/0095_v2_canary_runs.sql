-- David, 2026-10-05 and 2026-10-07 on #1747: canary runs are not counted trials, so they are
-- logged here and never in v2_trials
CREATE TABLE IF NOT EXISTS v2_canary_runs (
  run_id          INTEGER PRIMARY KEY,
  candidate       TEXT NOT NULL,
  candidate_hash  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('shift', 'random')),
  seed            INTEGER CHECK ((kind = 'shift') = (seed IS NULL)),
  result          TEXT NOT NULL,
  recorded_at     TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_canary_runs_no_update
BEFORE UPDATE ON v2_canary_runs
BEGIN
  SELECT RAISE(ABORT, 'v2_canary_runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_canary_runs_no_delete
BEFORE DELETE ON v2_canary_runs
BEGIN
  SELECT RAISE(ABORT, 'v2_canary_runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_canary_runs_no_replace
BEFORE INSERT ON v2_canary_runs
WHEN NEW.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_canary_runs WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_canary_runs is append-only');
END;
