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
