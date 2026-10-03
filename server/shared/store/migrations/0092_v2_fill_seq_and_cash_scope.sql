-- #2035, before live. fill_seq is v2_fills' INTEGER PRIMARY KEY, so it is the rowid itself and no
-- VACUUM can renumber it; the rebuild keeps every row's rowid as its fill_seq. A new row takes
-- MAX(fill_seq) + 1, as the implicit rowid did, so a replay that rewinds a day's fills re-books
-- them under the same keys. broker_mode is the account a fill was booked from; every fill before
-- this migration is paper, as the v2 root has refused live since it was built (doc 66 Q10)
CREATE TABLE v2_fills_rebuilt (
  fill_seq          INTEGER PRIMARY KEY,
  fill_id           TEXT NOT NULL UNIQUE,
  client_order_id   TEXT NOT NULL REFERENCES v2_orders(client_order_id),
  book_id           TEXT NOT NULL,
  trading_date      TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  venue             TEXT NOT NULL,
  leg               TEXT NOT NULL,
  side              TEXT NOT NULL,
  qty               REAL NOT NULL,
  price_gbp         REAL NOT NULL,
  fee_gbp           REAL NOT NULL,
  recorded_at       TEXT NOT NULL,
  currency          TEXT,
  price_native      REAL,
  fee_native        REAL,
  fx_quote_per_gbp  REAL,
  fx_source         TEXT,
  fill_date         TEXT,
  filled_at         TEXT,
  broker_mode       TEXT NOT NULL CHECK (broker_mode IN ('paper', 'live'))
);

INSERT INTO v2_fills_rebuilt (fill_seq, fill_id, client_order_id, book_id, trading_date,
  instrument, venue, leg, side, qty, price_gbp, fee_gbp, recorded_at, currency, price_native,
  fee_native, fx_quote_per_gbp, fx_source, fill_date, filled_at, broker_mode)
SELECT rowid, fill_id, client_order_id, book_id, trading_date, instrument, venue, leg, side, qty,
  price_gbp, fee_gbp, recorded_at, currency, price_native, fee_native, fx_quote_per_gbp, fx_source,
  fill_date, filled_at, 'paper'
FROM v2_fills ORDER BY rowid;

DROP TABLE v2_fills;

ALTER TABLE v2_fills_rebuilt RENAME TO v2_fills;

CREATE INDEX IF NOT EXISTS idx_v2_fills_client_order_id ON v2_fills (client_order_id);

CREATE TRIGGER IF NOT EXISTS v2_fills_no_update
BEFORE UPDATE ON v2_fills
BEGIN
  SELECT RAISE(ABORT, 'v2_fills is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_no_delete
BEFORE DELETE ON v2_fills
BEGIN
  SELECT RAISE(ABORT, 'v2_fills is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_replay_ignored
BEFORE INSERT ON v2_fills
WHEN EXISTS (SELECT 1 FROM v2_fills WHERE fill_id = NEW.fill_id)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS v2_fills_no_replace
BEFORE INSERT ON v2_fills
WHEN EXISTS (SELECT 1 FROM v2_fills WHERE fill_seq = NEW.fill_seq AND fill_id <> NEW.fill_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_fills is append-only');
END;

ALTER TABLE v2_fill_sweeps RENAME COLUMN first_fill_rowid TO first_fill_seq;
ALTER TABLE v2_fill_sweeps RENAME COLUMN last_fill_rowid TO last_fill_seq;

-- What a run reconciled against, so a replay serves the same broker cash under the same mode.
-- NULL on a row journalled before this migration: a paper run's
ALTER TABLE v2_reconciles ADD COLUMN broker_mode TEXT CHECK (broker_mode IN ('paper', 'live'));
ALTER TABLE v2_reconciles ADD COLUMN cash_quote REAL;

-- Only a live run records an anchor, so an anchor from before this migration is live's
ALTER TABLE v2_cash_anchors RENAME COLUMN fill_rowid TO fill_seq;
ALTER TABLE v2_cash_anchors ADD COLUMN broker_mode TEXT CHECK (broker_mode IN ('paper', 'live'));

DROP TRIGGER v2_cash_anchors_no_update;

UPDATE v2_cash_anchors SET broker_mode = 'live' WHERE kind = 'anchor';

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_no_update
BEFORE UPDATE ON v2_cash_anchors
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_anchors is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_mode_on_anchor
BEFORE INSERT ON v2_cash_anchors
WHEN (NEW.kind = 'anchor') <> (NEW.broker_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a cash anchor, and only an anchor, records its broker mode');
END;
