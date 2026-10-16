-- #2001, David 2026-10-15/16: amounts are signed positive for cash to the account; amount_gbp
-- converts the broker's amount at the reading row's rate, not the native delta. An estimate may
-- take several rows under one activity_key, since every re-share is booked
CREATE TABLE IF NOT EXISTS v2_cash_in_lieu_adjustments (
  adjustment_id     INTEGER PRIMARY KEY,
  book_id           TEXT NOT NULL,
  estimate_fill_id  TEXT NOT NULL,
  venue             TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  activity_id       TEXT NOT NULL,
  activity_key      TEXT NOT NULL,
  amount_native     REAL NOT NULL,
  amount_gbp        REAL NOT NULL,
  fx_quote_per_gbp  REAL NOT NULL CHECK (fx_quote_per_gbp > 0),
  fx_source         TEXT NOT NULL,
  estimate_fill_seq INTEGER NOT NULL,
  broker_mode       TEXT NOT NULL CHECK (broker_mode IN ('paper', 'live')),
  fills_before      INTEGER NOT NULL,
  trading_date      TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_adjustments_no_update
BEFORE UPDATE ON v2_cash_in_lieu_adjustments
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_in_lieu_adjustments is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_adjustments_no_delete
BEFORE DELETE ON v2_cash_in_lieu_adjustments
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_in_lieu_adjustments is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_adjustments_no_replace
BEFORE INSERT ON v2_cash_in_lieu_adjustments
WHEN NEW.adjustment_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM v2_cash_in_lieu_adjustments WHERE adjustment_id = NEW.adjustment_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_in_lieu_adjustments is append-only');
END;
