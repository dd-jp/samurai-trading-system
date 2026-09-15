-- Per-round mediator verdicts (#1517) — does the debate's verdict ever flip
-- between rounds, or does round N just re-confirm round N-1?
--
-- WHY THIS DID NOT ALREADY EXIST. `debate_log` stores ONE row per debate_id,
-- carrying only the FINAL round's direction/confidence/rounds. Multi-round
-- LLM debate is core to Samurai's edge thesis (CONTEXT.md's debate-as-edge),
-- but known failure modes — sycophancy, anchoring on whichever side speaks
-- first, correlated errors from a shared base model — can make later rounds
-- pure cost with no information gain. Answering that needs the verdict AT
-- THE END OF EACH ROUND, which nothing persisted before this migration.
--
-- WHY A SEPARATE TABLE, NOT A JSON COLUMN ON debate_log. Mirrors
-- llm_call_log's reasoning (0039): debate_log is write-once per debate_id
-- (SqliteDebateLogStore.writeLog raises on a repeat write, by design), so a
-- round-by-round JSON column would need either a rewrite per round (breaking
-- that invariant) or building the whole array up front (defeating the point
-- of recording a TRUNCATED debate's partial rounds). A separate append-only
-- table, one row per round, keeps debate_log's write-once contract untouched
-- and makes the flip-rate query a plain GROUP BY debate_id comparing the
-- MIN(round) and MAX(round) directions.
--
-- WHY A FOREIGN KEY, UNLIKE llm_call_log's debate_id. That table's FK is
-- deliberately absent because its write is best-effort and independent of
-- debate_log's (see its own migration's header). This write is neither:
-- `persistDebateLog` (debate-adapter.ts) calls store.writeLogWithRounds,
-- which writes debate_log and this table's rows in one transaction, only in
-- the SAME branch that just wrote the owning debate_log row, after the
-- first-write-wins duplicate guard returns — so the debate_log row always
-- exists first, in the same synchronous call, and an orphaned round row
-- would only mean this table's own writer has a bug worth catching loudly
-- rather than swallowing.
--
-- UNIQUE(debate_id, round): a debate cannot log the same round twice: the
-- round-orchestrator loop advances `round` monotonically and
-- `persistDebateLog`'s own duplicate guard already prevents re-persisting a
-- debate_id, so a collision here would mean either guard broke.
CREATE TABLE debate_round_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  debate_id  TEXT    NOT NULL REFERENCES debate_log(debate_id),
  round      INTEGER NOT NULL,
  direction  TEXT    NOT NULL CHECK(direction IN ('bullish', 'bearish', 'neutral')),
  confidence REAL    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE(debate_id, round)
);

-- The one access pattern this table has: given a debate_id, its rounds in
-- order — both the write path (nothing, single-row-at-a-time inserts inside
-- one debate_id's transaction) and the flip-rate report's per-debate
-- MIN/MAX(round) comparison. Mirrors llm_call_log's idx_llm_call_log_trace:
-- index the join key actually queried.
CREATE INDEX idx_debate_round_log_debate_id ON debate_round_log(debate_id);
