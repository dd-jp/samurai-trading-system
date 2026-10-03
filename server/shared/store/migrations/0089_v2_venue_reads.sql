-- What the venue answered during a run, so a replay serves the same answers (#1990). A fill read
-- is the filled qty the cycle read for an entry before cancelling it (NULL qty: the venue knew no
-- such order). A fill sweep holds the journal's position by rowid, never by clock: the last
-- v2_fills rowid when it began and when it ended, and the last v2_orders and v2_book_days rowids
-- when it ended. run_id names the cycle or flatten pass that wrote the row, so a date that ran
-- twice is told apart run by run
CREATE TABLE IF NOT EXISTS v2_fill_reads (
  read_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL,
  trading_date     TEXT NOT NULL,
  client_order_id  TEXT NOT NULL,
  filled_qty       REAL,
  error            TEXT,
  recorded_at      TEXT NOT NULL,
  CHECK (filled_qty IS NULL OR error IS NULL)
);

CREATE INDEX IF NOT EXISTS v2_fill_reads_by_order ON v2_fill_reads (trading_date, client_order_id);

CREATE TABLE IF NOT EXISTS v2_fill_sweeps (
  sweep_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL,
  trading_date     TEXT NOT NULL,
  first_fill_rowid INTEGER NOT NULL,
  last_fill_rowid  INTEGER NOT NULL,
  order_rowid      INTEGER NOT NULL,
  book_day_rowid   INTEGER NOT NULL,
  recorded_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS v2_fill_sweeps_by_date ON v2_fill_sweeps (trading_date);

CREATE TRIGGER IF NOT EXISTS v2_fill_reads_no_update
BEFORE UPDATE ON v2_fill_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fill_reads_no_delete
BEFORE DELETE ON v2_fill_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fill_sweeps_no_update
BEFORE UPDATE ON v2_fill_sweeps
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_sweeps is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fill_sweeps_no_delete
BEFORE DELETE ON v2_fill_sweeps
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_sweeps is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fill_reads_no_replace
BEFORE INSERT ON v2_fill_reads
WHEN NEW.read_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_fill_reads WHERE read_id = NEW.read_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fill_sweeps_no_replace
BEFORE INSERT ON v2_fill_sweeps
WHEN NEW.sweep_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_fill_sweeps WHERE sweep_id = NEW.sweep_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_fill_sweeps is append-only');
END;
