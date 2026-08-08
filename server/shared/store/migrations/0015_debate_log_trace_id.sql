-- `trace_id` on `debate_log` (#426).
--
-- The Pipeline view's lane drawer shows a completed debate's per-analyst
-- contributions, and had no way to find WHICH debate belongs to the trace in
-- the lane: `debate_log` carried no trace. It joined on instrument plus
-- `created_at >= started_at`, most recent wins — necessary and not sufficient.
-- Two ticks on the same instrument inside the view's 15-minute window select
-- the wrong debate, and the drawer attributes one tick's argument to another
-- tick's lane. Silently: both rows are real, both are recent, nothing looks
-- wrong.
--
-- NULLABLE, and that is the correct encoding rather than a convenience.
-- Migration 0012 already documents the wrinkle: `trace_id` is NOT stable
-- across a retry — `tick-loop.ts` mints a fresh one per instrument per tick,
-- while `debate_id` is a content hash and is deliberately IDENTICAL on a
-- retried tick within the same bar. So a row can legitimately be written by
-- one trace and re-attempted under another, and the pre-#426 rows have no
-- trace at all.
--
-- First-write-wins is therefore the rule, matching the existing persist logic:
-- the trace that actually produced the row is the one that owns it, and a
-- retry must not rewrite the attribution of a debate it did not run.
ALTER TABLE debate_log ADD COLUMN trace_id TEXT;

-- The drawer's join: "the debate for THIS trace".
CREATE INDEX idx_debate_log_trace ON debate_log (trace_id);
