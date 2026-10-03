-- Persists a curated MI row's consecutive-refusal streak across process
-- restarts (#1120).
--
-- `PolymarketAgent#refusals` counted this in memory only, so a soak that
-- bounces more than once a day never accumulates the 24 consecutive hourly
-- passes `REFUSAL_WARN_STREAK` needs to escalate a dead row's log line from
-- `info` to `warn` — a row refused on EVERY poll since it was curated read as
-- merely occasional. Reading this table's persisted count before the first
-- refusal of a fresh process is what makes the escalation continue past a
-- restart instead of restarting the count at 1.
--
-- Keyed (source, row_id), not row_id alone: `MiSourceId` scopes the streak to
-- the writer that owns it, the same key `mi_archive_raw`/`mi_items` already
-- use, so a future second curated-table source cannot collide with
-- Polymarket's row ids.
--
-- One row per row CURRENTLY mid-streak, deleted (not zeroed) the moment it
-- answers again — so a non-empty table already tells an operator which rows
-- are dead, independent of reading `warn` lines out of the log.
CREATE TABLE mi_refusal_streaks (
  source       TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  streak       INTEGER NOT NULL,
  last_reason  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (source, row_id)
);
