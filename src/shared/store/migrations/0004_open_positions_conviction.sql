-- #74: Trader position-aware branching needs each lot's originating conviction
-- to decide "conviction rose materially" for a same-direction scale_in. Neither
-- column exists on open_positions today — only OrderIntentMetadata carries them
-- at submission time. The real writer (writeAheadPosition) always supplies the
-- entry OrderIntent's actual conviction/converged going forward.
--
-- conviction DEFAULT 1 (not 0): any pre-migration lot still open when this
-- runs backfills to the top of the conviction range, not the bottom. decide()
-- treats a lot's stored conviction as the bar a live debate's confidence must
-- clear (by scale_in_conviction_delta) to scale in — confidence is capped at
-- 1.0, so a DEFAULT of 1 makes that bar unclearable, i.e. legacy lots hold
-- rather than spuriously scale-in on an unknown true conviction. A DEFAULT of
-- 0 would do the opposite: every legacy lot would look like it started from
-- zero conviction, and almost any live debate would clear the delta.
ALTER TABLE open_positions ADD COLUMN conviction REAL NOT NULL DEFAULT 1;
ALTER TABLE open_positions ADD COLUMN converged INTEGER NOT NULL DEFAULT 0;
