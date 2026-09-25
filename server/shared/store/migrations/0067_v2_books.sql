CREATE TABLE IF NOT EXISTS v2_books (
  book_id            TEXT PRIMARY KEY,
  sleeve_id          TEXT NOT NULL,
  variant            TEXT NOT NULL,
  start_capital_gbp  REAL NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_book_days (
  book_id             TEXT NOT NULL REFERENCES v2_books(book_id),
  trading_date        TEXT NOT NULL,
  equity_gbp          REAL NOT NULL,
  ytd_loss_gbp        REAL NOT NULL,
  size_multiplier     REAL NOT NULL,
  entries_blocked     INTEGER NOT NULL,
  custody_accrual_gbp REAL NOT NULL,
  recorded_at         TEXT NOT NULL,
  PRIMARY KEY (book_id, trading_date)
);

CREATE TABLE IF NOT EXISTS v2_decisions (
  decision_id   TEXT PRIMARY KEY,
  book_id       TEXT NOT NULL REFERENCES v2_books(book_id),
  trading_date  TEXT NOT NULL,
  instrument    TEXT NOT NULL,
  venue         TEXT NOT NULL,
  inputs_hash   TEXT NOT NULL,
  direction     TEXT NOT NULL,
  confidence    REAL NOT NULL,
  action        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  size_shares   INTEGER NOT NULL,
  stop_price    REAL,
  payload       TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_decisions_book_date ON v2_decisions (book_id, trading_date);

CREATE TABLE IF NOT EXISTS v2_orders (
  client_order_id  TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL REFERENCES v2_decisions(decision_id),
  book_id          TEXT NOT NULL,
  venue            TEXT NOT NULL,
  dry_run          INTEGER NOT NULL,
  outcome          TEXT NOT NULL,
  payload          TEXT NOT NULL,
  recorded_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_refusals (
  refusal_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date  TEXT NOT NULL,
  scope         TEXT NOT NULL,
  parameter     TEXT NOT NULL,
  ticket        TEXT NOT NULL,
  message       TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);
