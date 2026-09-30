CREATE TRIGGER IF NOT EXISTS v2_decisions_no_update
BEFORE UPDATE ON v2_decisions
BEGIN
  SELECT RAISE(ABORT, 'v2_decisions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_decisions_no_delete
BEFORE DELETE ON v2_decisions
BEGIN
  SELECT RAISE(ABORT, 'v2_decisions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_no_update
BEFORE UPDATE ON v2_fills
BEGIN
  SELECT RAISE(ABORT, 'v2_fills is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_no_delete
BEFORE DELETE ON v2_fills
BEGIN
  SELECT RAISE(ABORT, 'v2_fills is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_decisions_no_replace
BEFORE INSERT ON v2_decisions
WHEN EXISTS (SELECT 1 FROM v2_decisions WHERE decision_id = NEW.decision_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_decisions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_replay_ignored
BEFORE INSERT ON v2_fills
WHEN EXISTS (SELECT 1 FROM v2_fills WHERE fill_id = NEW.fill_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
