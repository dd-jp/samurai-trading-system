-- David, 2026-10-09 on #2024: a call-failure veto gets one retry. The claim row is written before
-- the second LLM call, so a crash during it never earns a third
CREATE TABLE IF NOT EXISTS v2_signal_veto_retries (
  signal_id   TEXT PRIMARY KEY REFERENCES v2_signal_vetoes (signal_id),
  claimed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_signal_veto_retry_verdicts (
  signal_id    TEXT PRIMARY KEY REFERENCES v2_signal_veto_retries (signal_id),
  kind         TEXT NOT NULL CHECK (kind IN ('pass', 'veto', 'unavailable')),
  reason       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retries_no_update
BEFORE UPDATE ON v2_signal_veto_retries
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retries_no_delete
BEFORE DELETE ON v2_signal_veto_retries
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retries_no_replace
BEFORE INSERT ON v2_signal_veto_retries
WHEN EXISTS (SELECT 1 FROM v2_signal_veto_retries WHERE signal_id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retry_verdicts_no_update
BEFORE UPDATE ON v2_signal_veto_retry_verdicts
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retry_verdicts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retry_verdicts_no_delete
BEFORE DELETE ON v2_signal_veto_retry_verdicts
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retry_verdicts is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_retry_verdicts_no_replace
BEFORE INSERT ON v2_signal_veto_retry_verdicts
WHEN EXISTS (SELECT 1 FROM v2_signal_veto_retry_verdicts WHERE signal_id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_retry_verdicts is append-only');
END;
