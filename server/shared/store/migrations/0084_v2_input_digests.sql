CREATE TABLE IF NOT EXISTS v2_input_digests (
  digest_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date   TEXT NOT NULL,
  input          TEXT NOT NULL CHECK (input IN ('bars', 'cfd_catalogue')),
  name           TEXT NOT NULL,
  sha256         TEXT,
  first_bar_date TEXT,
  last_bar_date  TEXT,
  row_count      INTEGER,
  as_of          TEXT,
  recorded_at    TEXT NOT NULL,
  UNIQUE (trading_date, input, name)
);

CREATE TRIGGER IF NOT EXISTS v2_input_digests_no_update
BEFORE UPDATE ON v2_input_digests
BEGIN
  SELECT RAISE(ABORT, 'v2_input_digests is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_input_digests_no_delete
BEFORE DELETE ON v2_input_digests
BEGIN
  SELECT RAISE(ABORT, 'v2_input_digests is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_input_digests_no_replace
BEFORE INSERT ON v2_input_digests
WHEN NEW.digest_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_input_digests WHERE digest_id = NEW.digest_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_input_digests is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_input_digests_first_cycle_kept
BEFORE INSERT ON v2_input_digests
WHEN EXISTS (
  SELECT 1 FROM v2_input_digests
   WHERE trading_date = NEW.trading_date AND input = NEW.input AND name = NEW.name
)
BEGIN
  SELECT RAISE(IGNORE);
END;
