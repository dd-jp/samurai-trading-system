-- What the venue answered during a run, so a replay serves the same answers (#1990). A fill read
-- is the filled qty the cycle read for an entry before cancelling it (NULL qty: the venue knew no
-- such order); a fill sweep is the last v2_fills rowid booked when that sweep ended
CREATE TABLE IF NOT EXISTS v2_fill_reads (
  read_id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
  trading_date     TEXT NOT NULL,
  last_fill_rowid  INTEGER NOT NULL,
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
