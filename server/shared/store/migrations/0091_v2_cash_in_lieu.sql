-- The broker's own cash-in-lieu payments (#2001). A row never changes a v2_fills estimate: the
-- tax log reads it beside the estimate and uses the broker's amount where the two pair. amount is
-- signed in the venue's currency as the venue reported it; fx_quote_per_gbp and fx_source are the
-- booking rate of the run that read it, as v2_fills records for a fill. A re-read of the same
-- activity is ignored, so the first read is the record
CREATE TABLE IF NOT EXISTS v2_cash_in_lieu (
  venue             TEXT NOT NULL,
  activity_id       TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  activity_date     TEXT NOT NULL,
  qty               REAL CHECK (qty IS NULL OR qty > 0),
  amount_native     REAL NOT NULL,
  currency          TEXT NOT NULL,
  fx_quote_per_gbp  REAL NOT NULL CHECK (fx_quote_per_gbp > 0),
  fx_source         TEXT NOT NULL,
  trading_date      TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (venue, activity_id)
);

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_no_update
BEFORE UPDATE ON v2_cash_in_lieu
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_in_lieu is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_no_delete
BEFORE DELETE ON v2_cash_in_lieu
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_in_lieu is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_in_lieu_replay_ignored
BEFORE INSERT ON v2_cash_in_lieu
WHEN EXISTS (
  SELECT 1 FROM v2_cash_in_lieu WHERE venue = NEW.venue AND activity_id = NEW.activity_id)
BEGIN
  SELECT RAISE(IGNORE);
END;
