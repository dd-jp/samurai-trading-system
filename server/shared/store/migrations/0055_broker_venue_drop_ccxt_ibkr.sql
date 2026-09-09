-- Narrows `broker_brackets`/`broker_unpriced_fills`'s `venue` CHECK to the two venues the
-- tree can construct (#1459). `ccxt` and `ibkr` left with crypto (2026-08-16, ADR-0015's
-- amendment) and the IBKR disqualification (#906); no adapter for either was ever built
-- (`server/pipeline/execution/adapters/` holds only alpaca-* and saxo-*), so the CHECK was
-- wider than anything that could ever satisfy it.
--
-- Unlike 0048's widening, this narrows the CHECK, so the `INSERT ... SELECT *` below is only
-- safe because no live row can violate it: `samurai-paper.sqlite`'s broker_brackets held 3
-- rows, all venue='alpaca', broker_unpriced_fills 0 rows (measured 2026-09-09, same census
-- 0053 did before its own drop).
--
-- SQLite cannot alter a CHECK constraint in place, so each table is rebuilt column-for-column
-- from its 0048 shape, as 0017/0022/0048 all did. No indexes, triggers, views or foreign keys
-- touch either table.

CREATE TABLE broker_brackets_new (
  venue            TEXT NOT NULL CHECK(venue IN ('alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,
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

CREATE TABLE broker_unpriced_fills_new (
  venue            TEXT NOT NULL CHECK(venue IN ('alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  instrument       TEXT NOT NULL,
  qty              REAL NOT NULL,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  alerted_at       TEXT NULL,
  PRIMARY KEY (venue, client_order_id, broker_fill_id)
);

INSERT INTO broker_unpriced_fills_new SELECT * FROM broker_unpriced_fills;

DROP TABLE broker_unpriced_fills;

ALTER TABLE broker_unpriced_fills_new RENAME TO broker_unpriced_fills;
