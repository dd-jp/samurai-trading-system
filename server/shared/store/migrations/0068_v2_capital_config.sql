CREATE TABLE IF NOT EXISTS v2_capital_config (
  year               INTEGER NOT NULL,
  effective_from     TEXT NOT NULL,
  start_capital_gbp  REAL NOT NULL CHECK (start_capital_gbp > 0),
  loss_cap_gbp       REAL NOT NULL CHECK (loss_cap_gbp > 0),
  recorded_at        TEXT NOT NULL,
  PRIMARY KEY (year, effective_from),
  CHECK (substr(effective_from, 1, 4) = printf('%04d', year))
);

CREATE TRIGGER IF NOT EXISTS v2_capital_config_no_update
BEFORE UPDATE ON v2_capital_config
BEGIN
  SELECT RAISE(ABORT, 'v2_capital_config is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_capital_config_no_delete
BEFORE DELETE ON v2_capital_config
BEGIN
  SELECT RAISE(ABORT, 'v2_capital_config is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_capital_config_first_row_from_january
BEFORE INSERT ON v2_capital_config
WHEN NOT EXISTS (SELECT 1 FROM v2_capital_config WHERE year = NEW.year)
  AND NEW.effective_from <> printf('%04d-01-01', NEW.year)
BEGIN
  SELECT RAISE(ABORT, 'v2_capital_config: a year is set from 1 January');
END;

CREATE TRIGGER IF NOT EXISTS v2_capital_config_tighten_only
BEFORE INSERT ON v2_capital_config
WHEN EXISTS (
  SELECT 1 FROM (
    SELECT effective_from, start_capital_gbp, loss_cap_gbp FROM v2_capital_config
    WHERE year = NEW.year ORDER BY effective_from DESC LIMIT 1
  ) AS latest
  WHERE NEW.effective_from <= latest.effective_from
     OR NEW.loss_cap_gbp >= latest.loss_cap_gbp
     OR NEW.start_capital_gbp <> latest.start_capital_gbp
)
BEGIN
  SELECT RAISE(ABORT, 'v2_capital_config: mid-year the cap may only be tightened');
END;
