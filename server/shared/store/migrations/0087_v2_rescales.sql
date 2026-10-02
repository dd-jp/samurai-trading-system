-- A row journalled before this migration keeps NULL; the replay then serves that fill at its
-- recorded_at, the sweep time, as it did before #1983
ALTER TABLE v2_fills ADD COLUMN filled_at TEXT;

-- fills_before counts the v2_fills rows of the same trading date when the rescale was written:
-- the replay applies the rescale after that many of the day's fills, so it lands between the same
-- fills it did live. Day-local, because the replay cuts whole days off the journal, never part of one
CREATE TABLE IF NOT EXISTS v2_rescales (
  rescale_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date   TEXT NOT NULL,
  book_id        TEXT NOT NULL,
  instrument     TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('detector', 'broker', 'entry', 'anchor')),
  ratio          REAL NOT NULL CHECK (ratio > 0),
  anchor_date    TEXT NOT NULL,
  fills_before   INTEGER NOT NULL,
  qty_before     REAL NOT NULL,
  qty_after      REAL NOT NULL,
  entry_before   REAL NOT NULL,
  entry_after    REAL NOT NULL,
  stop_before    REAL,
  stop_after     REAL,
  target_before  REAL,
  target_after   REAL,
  recorded_at    TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_rescales_no_update
BEFORE UPDATE ON v2_rescales
BEGIN
  SELECT RAISE(ABORT, 'v2_rescales is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_rescales_no_delete
BEFORE DELETE ON v2_rescales
BEGIN
  SELECT RAISE(ABORT, 'v2_rescales is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_rescales_no_replace
BEFORE INSERT ON v2_rescales
WHEN NEW.rescale_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_rescales WHERE rescale_id = NEW.rescale_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_rescales is append-only');
END;
