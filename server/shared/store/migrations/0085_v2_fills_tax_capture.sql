-- A row journalled before this migration keeps NULLs here; the tax log (#1947) holds out every
-- instrument with such a row rather than convert its GBP price back
ALTER TABLE v2_fills ADD COLUMN currency TEXT;
ALTER TABLE v2_fills ADD COLUMN price_native REAL;
ALTER TABLE v2_fills ADD COLUMN fee_native REAL;
ALTER TABLE v2_fills ADD COLUMN fx_quote_per_gbp REAL;
ALTER TABLE v2_fills ADD COLUMN fx_source TEXT;
ALTER TABLE v2_fills ADD COLUMN fill_date TEXT;

CREATE TABLE IF NOT EXISTS v2_splits (
  instrument    TEXT NOT NULL,
  venue         TEXT NOT NULL,
  split_date    TEXT NOT NULL,
  ratio         REAL NOT NULL CHECK (ratio > 0),
  trading_date  TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  PRIMARY KEY (instrument, venue, split_date)
);

CREATE TRIGGER IF NOT EXISTS v2_splits_no_update
BEFORE UPDATE ON v2_splits
BEGIN
  SELECT RAISE(ABORT, 'v2_splits is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_splits_no_delete
BEFORE DELETE ON v2_splits
BEGIN
  SELECT RAISE(ABORT, 'v2_splits is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_splits_replay_ignored
BEFORE INSERT ON v2_splits
WHEN EXISTS (
  SELECT 1 FROM v2_splits
  WHERE instrument = NEW.instrument AND venue = NEW.venue AND split_date = NEW.split_date)
BEGIN
  SELECT RAISE(IGNORE);
END;
