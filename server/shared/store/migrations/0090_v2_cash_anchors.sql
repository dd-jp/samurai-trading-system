-- The live cash reconcile's anchor (#1927 item 5, David 2026-10-02). One 'anchor' row per venue
-- holds the broker's cash at the first clean live reconcile; each deposit or withdrawal after it
-- is a signed move. Amounts are in the venue's currency. fill_rowid is the last v2_fills rowid the
-- anchor already holds: only fills after it are the store's change since the anchor
CREATE TABLE IF NOT EXISTS v2_cash_anchors (
  anchor_row_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  venue          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('anchor', 'deposit', 'withdrawal')),
  currency       TEXT NOT NULL,
  amount_quote   REAL NOT NULL,
  fill_rowid     INTEGER,
  reference      TEXT NOT NULL,
  trading_date   TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  UNIQUE (venue, reference),
  CHECK ((kind = 'anchor') = (fill_rowid IS NOT NULL)),
  CHECK (kind <> 'deposit' OR amount_quote > 0),
  CHECK (kind <> 'withdrawal' OR amount_quote < 0)
);

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
