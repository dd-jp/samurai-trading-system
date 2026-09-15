-- A refusal counter the `LlmFailureRateGuard` can read (#1533, follow-up to
-- #1080/#1396's LlmFailureRateGuard).
--
-- WHY THIS EXISTS. `gateRefusedDebateResult` (debate-adapter.ts) writes NO
-- `debate_log` row at all when the in-flight gate refuses a debate a permit —
-- `debate_id` is a content hash of (instrument, bar, views), and a refusal
-- occupying that key would permanently block a real retry from ever writing
-- the row it deserves. That correctly-absent row also makes a gate-refused
-- debate invisible to `getTerminationCauseWindowCounts`'s window read: a
-- soak where every debate is refused reads as an empty, perfectly healthy
-- window (0 truncations) rather than the outage it is.
--
-- WHY A SEPARATE TABLE, NOT A WIDENED debate_log.termination_cause. The issue
-- this migration closes says so explicitly: "do not widen
-- debate_log.termination_cause; a row would occupy the content-hashed
-- debate_id" — exactly the write-once invariant above. A gate refusal has no
-- debate_id to key a debate_log row on in the first place (no debate ran), so
-- there is nothing to widen onto.
--
-- WHY APPEND-ONLY WITH NO FOREIGN KEY, mirroring llm_call_log (migration
-- 0039) rather than debate_round_log (migration 0064): this write is
-- independent of any debate_log row (there usually isn't one) and
-- best-effort from the guard's perspective — see
-- `LlmFailureRateGuardDeps.gateRefusalSink` (llm-failure-rate-guard.ts).
--
-- WHAT IT DELIBERATELY DOES NOT CARRY. No instrument, no reason
-- (admission/queue_deadline), no trace_id — the guard's window read only ever
-- needs a COUNT over a time range (`getTerminationCauseWindowCounts`'s
-- `gate_refused` field). Richer detail already exists on the
-- `debate_refused_gate` log line the call site writes right before recording
-- here; this table exists only so the RATE guard has something to sum, not to
-- duplicate that log.
CREATE TABLE llm_gate_refusals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT    NOT NULL
);

-- The one access pattern: a COUNT over a trailing window
-- (`getTerminationCauseWindowCounts`'s `(from, to]` range scan), the same
-- shape debate_log's own created_at index serves the sibling query with.
CREATE INDEX idx_llm_gate_refusals_occurred_at ON llm_gate_refusals(occurred_at);
