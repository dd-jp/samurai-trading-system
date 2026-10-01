CREATE TABLE IF NOT EXISTS v2_heartbeat_pings (
  ping_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  outcome   TEXT NOT NULL CHECK (outcome IN ('success', 'fail')),
  pinged_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_heartbeat_pings_no_update
BEFORE UPDATE ON v2_heartbeat_pings
BEGIN
  SELECT RAISE(ABORT, 'v2_heartbeat_pings is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_heartbeat_pings_no_delete
BEFORE DELETE ON v2_heartbeat_pings
BEGIN
  SELECT RAISE(ABORT, 'v2_heartbeat_pings is append-only');
END;
