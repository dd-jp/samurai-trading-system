-- v2_book_days sums a book's CFD carry; the CFD tax log (#1867) needs it per position, keyed by
-- the position's opening order. A mark before this migration has no rows here, so the log holds
-- out any CFD position its book carried on such a mark
CREATE TABLE IF NOT EXISTS v2_cfd_carry (
  book_id          TEXT NOT NULL REFERENCES v2_books(book_id),
  trading_date     TEXT NOT NULL,
  instrument       TEXT NOT NULL,
  venue            TEXT NOT NULL,
  client_order_id  TEXT NOT NULL,
  financing_gbp    REAL NOT NULL,
  borrow_gbp       REAL NOT NULL,
  recorded_at      TEXT NOT NULL,
  PRIMARY KEY (book_id, trading_date, instrument)
);
