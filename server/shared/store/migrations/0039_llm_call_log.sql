-- What was actually asked, and what actually came back (#1035).
--
-- THE GAP THIS CLOSES. Every fact ABOUT an LLM call is already persisted:
-- `llm_spend` carries model, input/output/cache tokens, priced `cost_usd`,
-- `latency_ms` and `ttfb_ms`, keyed by `trace_id` and `debate_id`. What is
-- persisted nowhere is the call's CONTENT. `anthropic-client.ts` renders the
-- prompt, sends it, reads `rawText` out of the response, hands the parsed data
-- to the caller — and drops both strings on the floor. `debate_log` keeps the
-- synthesized outcome (`synthesis`, `contributions_json`, `confidence`), which
-- is the debate's conclusion rather than any single call's text, and
-- `audit_log` holds digests "from which no value can be reconstructed"
-- (logger.ts's own module doc).
--
-- So a soak can report that a call cost $0.004 and took 3.2s, and cannot
-- answer "what did it get asked, and what did it say" — which is the question
-- an operator actually has on day six, and the one that makes a 14-day
-- unattended run diagnosable rather than merely measurable.
--
-- WHY A SEPARATE TABLE, NOT COLUMNS ON `llm_spend`. Two hot readers scan that
-- table for numbers and never for text:
--
--   * `SqliteSpendCap` runs an all-time, un-windowed `SELECT SUM(cost_usd)
--     FROM llm_spend` ON THE TRADING PATH, before every debate;
--   * the dashboard's `getLlmSpend` range-scans it on every snapshot refresh.
--
-- Multi-KB TEXT columns inline into the row and balloon the b-tree, so both
-- queries would read far more pages for data neither one selects. Splitting
-- also makes retention separable, which matters in one direction only:
-- `llm_spend` rows must survive forever because the cap's arithmetic sums over
-- all of them, while this table can be pruned on a rolling window. (No pruner
-- ships here — see the size note below for why that is safe for now, and it
-- remains an open question rather than a settled one.)
--
-- SIZE, MEASURED NOT GUESSED. Over the 2026-08-26 → 2026-09-02 paper window:
-- 452 calls in 7.02 days (~64/day), averaging 1,698 input tokens (~6.8 KB
-- rendered prompt) and 259 output tokens (~1.0 KB). That is ~500 KB/day and
-- ~7 MB across a 14-day soak; ~18 MB if every single call hit the caps in
-- `spend-sink.ts`. Both figures are cadence-bound — they assume 15-minute
-- ticks and the current universe, and scale linearly with either.
--
-- NO FOREIGN KEY on `spend_id`, deliberately. The `llm_spend` write swallows
-- its own failures by design (see spend-sink.ts's module doc: metering must
-- never fail a trading call), so a real FK would convert a swallowed metering
-- failure into a cascading failure that ALSO loses the text — turning one
-- best-effort record's absence into two. `spend_id` is a join convenience read
-- from `lastInsertRowid`, and is NULL when the spend row did not land.
--
-- ALL TEXT COLUMNS NULLABLE. Capture is switchable (`SAMURAI_LLM_CAPTURE`) and
-- a row whose text was not captured is a legitimate row, not a broken one.
CREATE TABLE llm_call_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  spend_id   INTEGER,          -- llm_spend.id; NULL when the spend write failed
  trace_id   TEXT    NOT NULL, -- joins to the tick, and to every log line for it
  stage      TEXT    NOT NULL, -- 'debate' | 'risk_critic' | 'sentiment'
  debate_id  TEXT,             -- joins to debate_log; NULL outside a debate
  model      TEXT    NOT NULL, -- the SERVED model, matching llm_spend.model
  prompt     TEXT,
  response   TEXT,
  timestamp  TEXT    NOT NULL
);

-- The two access patterns this table has, and no others. `timestamp` is
-- "show me the last N hours of calls" (the same range-scan shape
-- 0010_llm_spend.sql indexes for); `trace_id` is the one that matters during
-- an incident — pull every call belonging to the tick under investigation.
-- Mirrors 0005_hot_path_indexes.sql's posture: index the reads that are
-- actually issued, nothing else.
CREATE INDEX idx_llm_call_log_timestamp ON llm_call_log(timestamp);
CREATE INDEX idx_llm_call_log_trace ON llm_call_log(trace_id);
