-- The risk critic's persisted verdict, keyed by `debate_id` (#957, ADR-0003 §2).
--
-- Check-pipeline step 7 (`risk-manager-spec.md`, "Module: Risk Critic") is a
-- single LLM pass that argues why a gated entry should be trimmed or rejected.
-- ADR-0003 §2 makes its determinism shape replay-from-log rather than
-- observational: in `live`/`paper` the producer calls the model once per viable
-- entry intent and writes the verdict here; in `backtest` it READS this table
-- instead of calling anything, so a replay of the same history reaches the same
-- decision and Stage 2's PBO/DSR/MinBTL statistics stay meaningful.
--
-- `debate_id` is the PK because it is the join key `debate_log` and
-- `cosine_setups` already carry (#162) — one debate produces at most one gated
-- intent, so one verdict per debate is the natural grain, and the PK is what
-- makes a re-run idempotent rather than accumulating duplicate verdicts for one
-- decision.
--
-- `verdict = 'unavailable'` is a REAL row, not an absent one: it records that
-- the critic was consulted and could not answer (provider failure, spend-cap
-- refusal, unreadable response). The producer still hands `evaluate()` NOTHING
-- in that case, so the decision keeps its explicit `risk_critic: skipped`
-- reason — the row exists for the operator and so a backtest replays the same
-- "no verdict" input the live run had.
--
-- `max_notional` is meaningful only for `verdict = 'trim'`; it is the notional
-- the critic argues the intent should be capped at, and the check pipeline can
-- only ever use it to REDUCE size (risk-manager/index.ts `applyCritic`).

CREATE TABLE risk_critic_log (
  debate_id    TEXT NOT NULL PRIMARY KEY,
  verdict      TEXT NOT NULL CHECK(verdict IN ('pass', 'trim', 'reject', 'unavailable')),
  max_notional REAL NULL,
  reasoning    TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_risk_critic_log_created_at ON risk_critic_log(created_at);
