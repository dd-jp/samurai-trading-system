-- David, 2026-10-09 on #2024: a call-failure veto gets one retry. A claim row is written before
-- every LLM call, so a restart that finds a claim without its verdict counts that attempt as a
-- failed call and never makes a third
CREATE TABLE IF NOT EXISTS v2_signal_veto_claims (
  signal_id   TEXT NOT NULL REFERENCES v2_signals (signal_id),
  attempt     INTEGER NOT NULL CHECK (attempt IN (1, 2)),
  claimed_at  TEXT NOT NULL,
  PRIMARY KEY (signal_id, attempt)
);

CREATE TABLE IF NOT EXISTS v2_signal_veto_retry_verdicts (
  signal_id    TEXT PRIMARY KEY,
  attempt      INTEGER NOT NULL DEFAULT 2 CHECK (attempt = 2),
  kind         TEXT NOT NULL CHECK (kind IN ('pass', 'veto', 'unavailable')),
  reason       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  FOREIGN KEY (signal_id, attempt) REFERENCES v2_signal_veto_claims (signal_id, attempt)
);

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_claims_retry_needs_first_verdict
BEFORE INSERT ON v2_signal_veto_claims
WHEN NEW.attempt = 2
  AND NOT EXISTS (SELECT 1 FROM v2_signal_vetoes WHERE signal_id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_claims: a retry claim needs a first verdict');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_claims_no_update
BEFORE UPDATE ON v2_signal_veto_claims
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_claims is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_claims_no_delete
BEFORE DELETE ON v2_signal_veto_claims
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_claims is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_veto_claims_no_replace
BEFORE INSERT ON v2_signal_veto_claims
WHEN EXISTS (
  SELECT 1 FROM v2_signal_veto_claims WHERE signal_id = NEW.signal_id AND attempt = NEW.attempt
)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_veto_claims is append-only');
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
