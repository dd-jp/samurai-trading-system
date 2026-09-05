-- #1140: the LLM spend ceiling the orchestrator's composition root armed, so
-- the dashboard measures spend against the cap the enforcer applied rather
-- than a second copy of the number in the client.
--
-- One row (`id = 1`), rewritten at every boot: the cap is a fact about the
-- RUNNING configuration, not a history. `budget_usd` NULL is the honest
-- record of `ProductionConfig.llmBudgetUsd` being unset — the run is UNCAPPED
-- (production.ts warns about exactly that) — and is distinct from a missing
-- row, which means no orchestrator has armed a cap against this database at
-- all. Both mean "nothing bounds this spend" to a reader.
CREATE TABLE IF NOT EXISTS llm_spend_cap (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  budget_usd  REAL,
  armed_at    TEXT NOT NULL
);
