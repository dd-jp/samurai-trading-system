-- David, 2026-10-09 and 2026-10-12 on #2025: splits rescale from EODHD, cross-checked against
-- Alpaca; each read is journalled for the cycle and its replay, each check verdict is dated so
-- a replay rewinds it, and a clear lifts a block until the sources next agree
CREATE TABLE IF NOT EXISTS v2_split_reads (
  read_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date  TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('eodhd', 'alpaca')),
  symbol        TEXT NOT NULL,
  from_date     TEXT NOT NULL,
  to_date       TEXT NOT NULL,
  as_of         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  reason        TEXT NOT NULL,
  splits        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_split_reads_date_symbol
  ON v2_split_reads (trading_date, source, symbol, read_id);

CREATE TRIGGER IF NOT EXISTS v2_split_reads_no_update
BEFORE UPDATE ON v2_split_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_split_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_reads_no_delete
BEFORE DELETE ON v2_split_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_split_reads is append-only');
END;

CREATE TABLE IF NOT EXISTS v2_split_checks (
  check_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date  TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  exchange      TEXT NOT NULL CHECK (exchange IN ('US', 'LSE')),
  after_date    TEXT NOT NULL,
  through_date  TEXT NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('agree', 'block')),
  reason        TEXT NOT NULL,
  ratio         REAL NOT NULL,
  recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_split_checks_instrument
  ON v2_split_checks (instrument, exchange, check_id);

CREATE TRIGGER IF NOT EXISTS v2_split_checks_no_update
BEFORE UPDATE ON v2_split_checks
BEGIN
  SELECT RAISE(ABORT, 'v2_split_checks is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_checks_no_delete
BEFORE DELETE ON v2_split_checks
BEGIN
  SELECT RAISE(ABORT, 'v2_split_checks is append-only');
END;

CREATE TABLE IF NOT EXISTS v2_split_clears (
  clear_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument    TEXT NOT NULL,
  exchange      TEXT NOT NULL CHECK (exchange IN ('US', 'LSE')),
  reason        TEXT NOT NULL,
  cleared_at    TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_split_clears_no_update
BEFORE UPDATE ON v2_split_clears
BEGIN
  SELECT RAISE(ABORT, 'v2_split_clears is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_clears_no_delete
BEFORE DELETE ON v2_split_clears
BEGIN
  SELECT RAISE(ABORT, 'v2_split_clears is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_reads_no_replace
BEFORE INSERT ON v2_split_reads
WHEN NEW.read_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_split_reads WHERE read_id = NEW.read_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_split_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_checks_no_replace
BEFORE INSERT ON v2_split_checks
WHEN NEW.check_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_split_checks WHERE check_id = NEW.check_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_split_checks is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_split_clears_no_replace
BEFORE INSERT ON v2_split_clears
WHEN NEW.clear_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_split_clears WHERE clear_id = NEW.clear_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_split_clears is append-only');
END;
