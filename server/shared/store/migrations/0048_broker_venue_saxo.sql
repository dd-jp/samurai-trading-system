-- 'saxo' joins the broker venue set (#1032 item 1): `SaxoBrokerAdapter`
-- journals its brackets and observed fills under it. The live equity leg is
-- Saxo Capital Markets UK over OpenAPI (ADR-0015, 2026-08-30 amendment).
--
-- SQLite cannot alter a CHECK constraint in place, so each table is rebuilt
-- column-for-column from its newest shape — broker_brackets from 0022,
-- broker_observed_fills from 0007, broker_unpriced_fills from 0008 — exactly
-- as 0017 and 0022 did. No indexes, triggers, views or foreign keys touch any
-- of the three.

CREATE TABLE broker_brackets_new (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
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

CREATE TABLE broker_observed_fills_new (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
  client_order_id  TEXT NOT NULL,
  broker_fill_id   TEXT NOT NULL,
  leg              TEXT NOT NULL CHECK(leg IN ('entry', 'stop', 'target', 'exit')),
  price            REAL NOT NULL,
  qty              REAL NOT NULL,
  fee              REAL NOT NULL,
  timestamp        TEXT NOT NULL,
  PRIMARY KEY (venue, client_order_id, broker_fill_id)
);

INSERT INTO broker_observed_fills_new SELECT * FROM broker_observed_fills;

DROP TABLE broker_observed_fills;

ALTER TABLE broker_observed_fills_new RENAME TO broker_observed_fills;

CREATE TABLE broker_unpriced_fills_new (
  venue            TEXT NOT NULL CHECK(venue IN ('ccxt', 'ibkr', 'alpaca', 'saxo')),
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
