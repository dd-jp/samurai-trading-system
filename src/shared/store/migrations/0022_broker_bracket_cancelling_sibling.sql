-- A 'cancelling_sibling' phase for the emulated-OCO bracket journal (#586).
--
-- THE WINDOW THIS NAMES. Alpaca rejects every advanced order class for crypto
-- (verified live, #550: 422 code 42210000 "crypto orders not allowed for
-- advanced order_class"), so #586 emulates the protective pair as two PLAIN
-- crypto orders and keeps the one-cancels-other promise by hand — the same
-- shape the retired ccxt adapter used this table for. The OCO edge has a
-- venue call in the middle: one leg is observed filled, then the sibling is
-- cancelled. A crash between those two acts leaves a live resting order that
-- WILL fire into a position that no longer exists, and under the previous
-- phase set the journal could only call that moment 'armed' (a lie — the
-- fill was already observed) or 'resolved' (a worse lie — the sibling is
-- still live).
--
-- 'cancelling_sibling' is written BEFORE the cancel call, the same
-- write-ahead rule 'submitting' (migration 0017) applies to the entry: the
-- journal commits to the venue call before making it, so a restart knows a
-- sibling cancel is owed and the fill sweep retries it instead of trusting
-- either lie.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
-- column-for-column, exactly as 0017 did. There are still no indexes,
-- triggers or views on this table and no foreign keys point at it.

CREATE TABLE broker_brackets_new (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  client_order_id  TEXT NOT NULL,
  -- 'cancelling_sibling' is new (#586): one protective leg is observed
  -- filled and the surviving sibling's cancel is owed to the venue.
  phase            TEXT NOT NULL CHECK(phase IN ('submitting', 'pending_entry', 'arming', 'armed', 'cancelling_sibling', 'resolved')),
  entry_order_id   TEXT NULL,
  stop_order_id    TEXT NULL,
  target_order_id  TEXT NULL,
  instrument       TEXT NULL,
  asset_class      TEXT NULL CHECK(asset_class IS NULL OR asset_class IN ('crypto', 'stocks')),
  side             TEXT NULL CHECK(side IS NULL OR side IN ('buy', 'sell')),
  size             REAL NULL,
  entry_price      REAL NULL,
  stop_price       REAL NULL,
  target_price     REAL NULL,
  time_in_force    TEXT NULL,
  armed_qty        REAL NULL,
  arming_qty       REAL NULL,
  arm_attempt      INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (venue, client_order_id)
);

INSERT INTO broker_brackets_new SELECT * FROM broker_brackets;

DROP TABLE broker_brackets;

ALTER TABLE broker_brackets_new RENAME TO broker_brackets;
