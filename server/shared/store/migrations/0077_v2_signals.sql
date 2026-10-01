CREATE TABLE IF NOT EXISTS v2_signals (
  signal_id       TEXT PRIMARY KEY,
  payload_digest  TEXT NOT NULL UNIQUE,
  symbol          TEXT NOT NULL,
  entry_low       REAL NOT NULL,
  entry_high      REAL NOT NULL,
  entry_is_zone   INTEGER NOT NULL CHECK (entry_is_zone IN (0, 1)),
  targets         TEXT NOT NULL,
  stop            REAL NOT NULL,
  size            REAL,
  trail_after     REAL,
  source          TEXT,
  sent_at         TEXT,
  received_at     TEXT NOT NULL,
  session         TEXT NOT NULL CHECK (session IN ('in_session', 'out_of_session')),
  process_after   TEXT NOT NULL,
  payload         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_signals_received ON v2_signals (received_at, signal_id);

CREATE TABLE IF NOT EXISTS v2_signal_events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id    TEXT NOT NULL REFERENCES v2_signals (signal_id),
  status       TEXT NOT NULL CHECK (status IN ('queued', 'processed', 'refused', 'failed')),
  detail       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_v2_signal_events_signal ON v2_signal_events (signal_id, event_id);

CREATE TRIGGER IF NOT EXISTS v2_signals_no_update
BEFORE UPDATE ON v2_signals
BEGIN
  SELECT RAISE(ABORT, 'v2_signals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signals_no_delete
BEFORE DELETE ON v2_signals
BEGIN
  SELECT RAISE(ABORT, 'v2_signals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_events_no_update
BEFORE UPDATE ON v2_signal_events
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_events_no_delete
BEFORE DELETE ON v2_signal_events
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_events is append-only');
END;
