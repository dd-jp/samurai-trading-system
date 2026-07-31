-- #74: Trader position-aware branching needs each lot's originating conviction
-- to decide "conviction rose materially" for a same-direction scale_in. Neither
-- column exists on open_positions today — only OrderIntentMetadata carries them
-- at submission time. DEFAULT 0 / 0 only satisfies NOT NULL for SQLite's ADD
-- COLUMN requirement; the real writer (writeAheadPosition) always supplies the
-- entry OrderIntent's actual conviction/converged.
ALTER TABLE open_positions ADD COLUMN conviction REAL NOT NULL DEFAULT 0;
ALTER TABLE open_positions ADD COLUMN converged INTEGER NOT NULL DEFAULT 0;
