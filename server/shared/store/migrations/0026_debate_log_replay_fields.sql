-- Make `debate_log` sufficient to REPLAY a debate instead of merely describing
-- one (#617).
--
-- WHY. The orchestrator ticks every 15 minutes while debates are keyed to 1h
-- bars, and every debate input is bar-keyed: `computeDebateId(instrument, bar,
-- views)`, where the analysts are deterministic functions of closed bars. So
-- 3 of every 4 ticks recompute the SAME `debate_id`, re-run a full LLM debate,
-- and discard the result at the write — 29 of 40 debates in the soak's first
-- five hours logged the duplicate-write warn. The discarded run's synthesis is
-- still what the Trader acted on, so `debate_log` held tick 1's row while the
-- Trader sized on tick N's confidence. That is corrupted attribution in a soak
-- whose entire purpose is measurement.
--
-- The fix short-circuits on an existing row BEFORE spending the LLM calls, and
-- returns the persisted debate so the Trader sees exactly what `debate_log`
-- holds. That is only possible if the row carries what the Trader reads.
-- Pre-#617 it did not: `debate_log` had `direction` and `rounds` but no
-- `confidence`, which is the field position sizing is a function of.
--
-- This also closes a gap debate-engine-spec.md already flagged against itself
-- ("`debate_log` has NO confidence or conviction column at all... so the
-- weighted confidence is not recoverable from it"), and makes ADR-0003 §2's
-- replay-from-log real for debates rather than aspirational.
--
-- ALL COLUMNS NULLABLE, deliberately. Rows written before this migration have
-- none of them, and a NOT NULL column would require inventing values for
-- debates that already happened. The replay path treats a row with a null
-- `confidence` as un-replayable and falls through to running the debate, so an
-- old row degrades to pre-#617 behaviour rather than to a fabricated trade.
--
-- `open_items_json` is JSON rather than a delimited string for the same reason
-- `contributions_json` is: the items are free model prose and can contain any
-- delimiter chosen.
ALTER TABLE debate_log ADD COLUMN confidence REAL;
ALTER TABLE debate_log ADD COLUMN synthesis TEXT;
ALTER TABLE debate_log ADD COLUMN position TEXT;
ALTER TABLE debate_log ADD COLUMN disagreement_summary TEXT;
ALTER TABLE debate_log ADD COLUMN open_items_json TEXT;
ALTER TABLE debate_log ADD COLUMN converged INTEGER;
