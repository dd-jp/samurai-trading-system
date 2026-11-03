-- #2143 ruling (e), Saxo sourcing and David 2026-10-23: a held CFD books dividend cash on the
-- ex-date from EODHD. Each read is journalled: 'cycle' reads for the day's run and its replay,
-- 'history' reads for a backtest's window. A booking is one row per book, instrument and ex-date,
-- signed positive for cash to the book, placed among the day's fills by fills_before
CREATE TABLE IF NOT EXISTS v2_dividend_reads (
  read_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose       TEXT NOT NULL CHECK (purpose IN ('cycle', 'history')),
  trading_date  TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  from_date     TEXT NOT NULL,
  to_date       TEXT NOT NULL,
  as_of         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  reason        TEXT NOT NULL,
  dividends     TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_dividend_reads_symbol
  ON v2_dividend_reads (purpose, symbol, trading_date, read_id);

CREATE TRIGGER IF NOT EXISTS v2_dividend_reads_no_update
BEFORE UPDATE ON v2_dividend_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_dividend_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_dividend_reads_no_delete
BEFORE DELETE ON v2_dividend_reads
BEGIN
  SELECT RAISE(ABORT, 'v2_dividend_reads is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_dividend_reads_no_replace
BEFORE INSERT ON v2_dividend_reads
WHEN NEW.read_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_dividend_reads WHERE read_id = NEW.read_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_dividend_reads is append-only');
END;

CREATE TABLE IF NOT EXISTS v2_cfd_dividends (
  dividend_id       INTEGER PRIMARY KEY,
  book_id           TEXT NOT NULL,
  trading_date      TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  venue             TEXT NOT NULL,
  client_order_id   TEXT NOT NULL,
  ex_date           TEXT NOT NULL,
  qty               REAL NOT NULL,
  per_share_native  REAL NOT NULL,
  withholding       REAL NOT NULL CHECK (withholding >= 0 AND withholding < 1),
  fx_quote_per_gbp  REAL NOT NULL CHECK (fx_quote_per_gbp > 0),
  amount_gbp        REAL NOT NULL,
  fills_before      INTEGER NOT NULL,
  recorded_at       TEXT NOT NULL,
  UNIQUE (book_id, instrument, ex_date)
);

CREATE TRIGGER IF NOT EXISTS v2_cfd_dividends_no_update
BEFORE UPDATE ON v2_cfd_dividends
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_dividends is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cfd_dividends_no_delete
BEFORE DELETE ON v2_cfd_dividends
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_dividends is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cfd_dividends_no_replace
BEFORE INSERT ON v2_cfd_dividends
WHEN (NEW.dividend_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM v2_cfd_dividends WHERE dividend_id = NEW.dividend_id))
  OR EXISTS (
  SELECT 1 FROM v2_cfd_dividends
   WHERE book_id = NEW.book_id AND instrument = NEW.instrument AND ex_date = NEW.ex_date)
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_dividends is append-only');
END;
