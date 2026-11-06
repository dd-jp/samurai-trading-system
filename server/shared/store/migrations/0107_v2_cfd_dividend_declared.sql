-- #2177: the dividend line as declared, beside the quoted per_share_native, with the rate its
-- currency was converted at. NULL on a row booked before this migration (the append-only trigger
-- forbids a backfill; v2_dividend_reads still holds the line it came from) and on an ex-date whose
-- lines are declared in more than one currency
ALTER TABLE v2_cfd_dividends ADD COLUMN declared_per_share REAL;
ALTER TABLE v2_cfd_dividends ADD COLUMN declared_currency TEXT
  CHECK (declared_currency IS NULL OR declared_currency IN ('GBP', 'USD', 'EUR'));
ALTER TABLE v2_cfd_dividends ADD COLUMN fx_declared_per_gbp REAL
  CHECK (fx_declared_per_gbp IS NULL OR fx_declared_per_gbp > 0);

CREATE TRIGGER IF NOT EXISTS v2_cfd_dividends_declared_together
BEFORE INSERT ON v2_cfd_dividends
WHEN NOT ((NEW.declared_per_share IS NULL AND NEW.declared_currency IS NULL
           AND NEW.fx_declared_per_gbp IS NULL)
       OR (NEW.declared_per_share IS NOT NULL AND NEW.declared_currency IS NOT NULL
           AND NEW.fx_declared_per_gbp IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'v2_cfd_dividends declares the per-share amount, currency and rate together or not at all');
END;
