CREATE TABLE IF NOT EXISTS v2_commands (
  command_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id   INTEGER NOT NULL UNIQUE,
  chat_id     TEXT NOT NULL,
  command     TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN (
    'applied', 'noop', 'answered', 'confirmation_requested', 'confirmation_refused',
    'refused_unauthorized', 'refused_stale', 'refused_too_soon', 'refused_invalid', 'failed'
  )),
  detail      TEXT NOT NULL,
  control_id  INTEGER REFERENCES v2_controls (control_id),
  sent_at     TEXT NOT NULL,
  handled_at  TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS v2_commands_no_update
BEFORE UPDATE ON v2_commands
BEGIN
  SELECT RAISE(ABORT, 'v2_commands is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_commands_no_delete
BEFORE DELETE ON v2_commands
BEGIN
  SELECT RAISE(ABORT, 'v2_commands is append-only');
END;
