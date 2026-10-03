-- #2035 item 5 (David 2026-10-03): the broker's non-trade cash (dividends, interest, fees) is read
-- before the live cash check and journalled as an 'activity' move, so the gap holds only
-- trade-related drift. One row per (activity_id, status): a re-read in the same status is ignored,
-- and a later status adds a row whose amount brings the activity's sum to what that status holds
-- (zero once canceled). broker_mode is the account the activity was read from; the anchor sums
-- only its own account's activities. The CHECK on kind needs the rebuild; every row keeps its id
CREATE TABLE v2_cash_anchors_rebuilt (
  anchor_row_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  venue          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('anchor', 'deposit', 'withdrawal', 'activity')),
  currency       TEXT NOT NULL,
  amount_quote   REAL NOT NULL,
  fill_seq       INTEGER,
  reference      TEXT NOT NULL,
  trading_date   TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  broker_mode    TEXT CHECK (broker_mode IN ('paper', 'live')),
  activity_id    TEXT,
  activity_type  TEXT,
  activity_date  TEXT,
  status         TEXT CHECK (status IN ('executed', 'correct', 'canceled')),
  UNIQUE (venue, reference),
  UNIQUE (venue, activity_id, status),
  CHECK ((kind = 'anchor') = (fill_seq IS NOT NULL)),
  CHECK (kind <> 'deposit' OR amount_quote > 0),
  CHECK (kind <> 'withdrawal' OR amount_quote < 0),
  CHECK ((kind = 'activity') = (activity_id IS NOT NULL)),
  CHECK (kind <> 'activity'
         OR (activity_type IS NOT NULL AND activity_date IS NOT NULL AND status IS NOT NULL))
);

INSERT INTO v2_cash_anchors_rebuilt (anchor_row_id, venue, kind, currency, amount_quote, fill_seq,
  reference, trading_date, recorded_at, broker_mode)
SELECT anchor_row_id, venue, kind, currency, amount_quote, fill_seq, reference, trading_date,
  recorded_at, broker_mode
FROM v2_cash_anchors ORDER BY anchor_row_id;

DROP TABLE v2_cash_anchors;

ALTER TABLE v2_cash_anchors_rebuilt RENAME TO v2_cash_anchors;

CREATE UNIQUE INDEX IF NOT EXISTS v2_cash_anchors_one_per_venue
  ON v2_cash_anchors (venue) WHERE kind = 'anchor';

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_no_update
BEFORE UPDATE ON v2_cash_anchors
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_anchors is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_no_delete
BEFORE DELETE ON v2_cash_anchors
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_anchors is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_no_replace
BEFORE INSERT ON v2_cash_anchors
WHEN (NEW.anchor_row_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM v2_cash_anchors WHERE anchor_row_id = NEW.anchor_row_id))
   OR EXISTS (SELECT 1 FROM v2_cash_anchors WHERE venue = NEW.venue AND reference = NEW.reference)
   OR (NEW.kind = 'anchor'
       AND EXISTS (SELECT 1 FROM v2_cash_anchors WHERE venue = NEW.venue AND kind = 'anchor'))
BEGIN
  SELECT RAISE(ABORT, 'v2_cash_anchors is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_cash_anchors_mode_on_anchor
BEFORE INSERT ON v2_cash_anchors
WHEN (NEW.kind IN ('anchor', 'activity')) <> (NEW.broker_mode IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a cash anchor or broker activity records its broker mode, and a manual move does not');
END;
