-- The refusal counter the gate-refusal-rate signal reads (#1533, follow-up to
-- #1080).
--
-- WHY THIS EXISTS. `gateRefusedDebateResult` (debate-adapter.ts) writes NO
-- `debate_log` row at all when the in-flight gate refuses a debate a permit —
-- `debate_id` is a content hash of (instrument, bar, views), and a refusal
-- occupying that key would permanently block a real retry from ever writing
-- the row it deserves. That correctly-absent row also leaves a gate-refused
-- debate invisible to every `debate_log` aggregate: a soak where every debate
-- is refused reads as an empty, perfectly healthy window rather than the
-- outage it is.
--
-- WHAT READS IT, AND WHAT DOES NOT. `getGateRefusalWindowCounts`, feeding
-- `GateRefusalRateMonitor` (production/gate-refusal-rate-guard.ts) — a signal
-- with its own window, floor, threshold and alert. NOT
-- `getTerminationCauseWindowCounts`, and not `LlmFailureRateGuard`: refusing
-- four of every six concurrent debates is the SHIPPED DESIGN
-- (production/defaults.ts), so adding this count to a truncation rate whose
-- healthy numerator is near zero would pin that rate at ~1.0 forever.
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
-- `GateRefusalRateGuardDeps.gateRefusalSink` (debate-adapter.ts).
--
-- WHAT IT DELIBERATELY DOES NOT CARRY. No instrument, no reason
-- (admission/queue_deadline), no trace_id — the guard's window read only ever
-- needs a COUNT over a time range (`getGateRefusalWindowCounts`'s
-- `gate_refused` field). Richer detail already exists on the
-- `debate_refused_gate` log line the call site writes right before recording
-- here; this table exists only so the RATE guard has something to sum, not to
-- duplicate that log.
--
-- NO RETENTION JOB, unlike llm_call_log's `prune-llm-call-log.ts`. At the
-- shipped cadence this grows ~384 rows/day of two small columns; a pruner is a
-- tracked follow-up, not part of #1533.
CREATE TABLE llm_gate_refusals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT    NOT NULL
);

-- The one access pattern: a COUNT over a trailing window
-- (`getGateRefusalWindowCounts`'s `(from, to]` range scan), the same shape
-- debate_log's own created_at index serves the sibling query with.
CREATE INDEX idx_llm_gate_refusals_occurred_at ON llm_gate_refusals(occurred_at);
