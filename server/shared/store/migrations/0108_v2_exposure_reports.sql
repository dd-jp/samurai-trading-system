-- #2156: one cross-sleeve exposure report per marked trading date, stored with the holdings it was
-- computed from, because v2_positions keeps only the current book and cannot rebuild a past day
CREATE TABLE IF NOT EXISTS v2_exposure_reports (
  trading_date TEXT PRIMARY KEY,
  report       TEXT NOT NULL CHECK (json_valid(report)),
  recorded_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_exposure_reports_no_update
BEFORE UPDATE ON v2_exposure_reports
BEGIN
  SELECT RAISE(ABORT, 'v2_exposure_reports is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_exposure_reports_no_delete
BEFORE DELETE ON v2_exposure_reports
BEGIN
  SELECT RAISE(ABORT, 'v2_exposure_reports is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_exposure_reports_no_replace
BEFORE INSERT ON v2_exposure_reports
WHEN EXISTS (SELECT 1 FROM v2_exposure_reports WHERE trading_date = NEW.trading_date)
BEGIN
  SELECT RAISE(ABORT, 'v2_exposure_reports is append-only');
END;
