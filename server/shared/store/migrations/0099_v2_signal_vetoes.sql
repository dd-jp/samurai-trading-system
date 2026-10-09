-- David, 2026-10-09 on #2024: the veto runs once per signal; a retry reads its verdict here
CREATE TABLE IF NOT EXISTS v2_signal_vetoes (
  signal_id    TEXT PRIMARY KEY REFERENCES v2_signals (signal_id),
  kind         TEXT NOT NULL CHECK (kind IN ('pass', 'veto', 'unavailable')),
  reason       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_signal_vetoes_no_update
BEFORE UPDATE ON v2_signal_vetoes
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_vetoes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_vetoes_no_delete
BEFORE DELETE ON v2_signal_vetoes
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_vetoes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_vetoes_no_replace
BEFORE INSERT ON v2_signal_vetoes
WHEN EXISTS (SELECT 1 FROM v2_signal_vetoes WHERE signal_id = NEW.signal_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_vetoes is append-only');
END;
