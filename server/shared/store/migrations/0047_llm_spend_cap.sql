-- #1140: the LLM spend ceiling the composition root armed, so the dashboard
-- measures spend against the cap the enforcer applied. One row, rewritten at
-- every boot; `budget_usd` NULL records an UNCAPPED run.
-- Rationale: server/shared/store/sqlite-llm-spend-cap-store.ts
CREATE TABLE IF NOT EXISTS llm_spend_cap (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  budget_usd  REAL,
  armed_at    TEXT NOT NULL
);
