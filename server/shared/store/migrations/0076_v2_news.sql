CREATE TABLE IF NOT EXISTS v2_news (
  news_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_date  TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'no_news', 'error', 'budget_stop', 'no_key')),
  reason        TEXT NOT NULL,
  requested     INTEGER NOT NULL CHECK (requested IN (0, 1)),
  found         INTEGER,
  headlines     TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_news_date_symbol ON v2_news (trading_date, symbol, news_id);
CREATE INDEX IF NOT EXISTS idx_v2_news_requests ON v2_news (provider, fetched_at) WHERE requested = 1;

CREATE TRIGGER IF NOT EXISTS v2_news_no_update
BEFORE UPDATE ON v2_news
BEGIN
  SELECT RAISE(ABORT, 'v2_news is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_news_no_delete
BEFORE DELETE ON v2_news
BEGIN
  SELECT RAISE(ABORT, 'v2_news is append-only');
END;
