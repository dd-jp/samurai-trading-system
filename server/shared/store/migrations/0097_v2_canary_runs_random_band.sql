-- David, 2026-10-08 on #1747: the random half logs each seeded run and then its band verdict, a
-- row with no seed of its own. SQLite cannot alter a CHECK, so v2_canary_runs is rebuilt and
-- every row keeps its run_id
CREATE TABLE v2_canary_runs_rebuilt (
  run_id          INTEGER PRIMARY KEY,
  candidate       TEXT NOT NULL,
  candidate_hash  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('shift', 'random', 'random_band')),
  seed            INTEGER CHECK ((kind = 'random') = (seed IS NOT NULL)),
  result          TEXT NOT NULL,
  recorded_at     TEXT NOT NULL
);

INSERT INTO v2_canary_runs_rebuilt (run_id, candidate, candidate_hash, kind, seed, result, recorded_at)
SELECT run_id, candidate, candidate_hash, kind, seed, result, recorded_at FROM v2_canary_runs ORDER BY run_id;

DROP TABLE v2_canary_runs;

ALTER TABLE v2_canary_runs_rebuilt RENAME TO v2_canary_runs;

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
