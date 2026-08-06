-- A `submitting` phase for the ccxt bracket journal (#312).
--
-- THE WINDOW THIS CLOSES. `CcxtBrokerAdapter.submitBracket` journalled the
-- emulated bracket AFTER calling `createOrder`, so a crash between the two
-- left a live venue order with no local bracket. Introduced knowingly in #287
-- and recorded rather than fixed; this is the fix.
--
-- WHY A NEW PHASE RATHER THAN A NULL `entry_order_id`. Writing ahead as
-- `pending_entry` with a null id would make the crash case indistinguishable
-- from an ordinary bracket whose id had simply not been recorded yet — and
-- `recordBracketOrderIds` COALESCEs, so a null there already means "no news",
-- not "never submitted". `submitting` says the thing that matters on
-- rehydration: an order MAY exist at the venue under this `client_order_id`,
-- and the adapter must ask before doing anything else.
--
-- WHY THE PATTERN IS BORROWED, NOT INVENTED. `execute.ts` already does this
-- one level up: `writeAheadPosition` persists intent, then reconciles the
-- broker's answer into it. Same shape, same reason.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
-- column-for-column. There are no indexes, triggers or views on this table and
-- no foreign keys point at it, so the remainder of the 12-step ALTER TABLE
-- procedure does not apply.

CREATE TABLE broker_brackets_new (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca')),
  client_order_id  TEXT NOT NULL,
  -- 'submitting' is new (#312): journalled BEFORE the venue call, so a crash
  -- in that window leaves a row that names the order which may exist.
  phase            TEXT NOT NULL CHECK(phase IN ('submitting', 'pending_entry', 'arming', 'armed', 'resolved')),
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
