CREATE TABLE IF NOT EXISTS v2_run_lease (
  lease_id     INTEGER PRIMARY KEY CHECK (lease_id = 1),
  holder       TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  purpose      TEXT NOT NULL,
  acquired_at  TEXT NOT NULL
);
