-- Hot-path secondary indexes (code-review 2026-08-01, C5). Every query below
-- was a full-table scan whose cost grows with history forever:
--   fills(broker_fill_id)      — hasFill() dedup gate, hit once per offered fill
--                                per poll; the PK leads with idempotency_key so
--                                it cannot serve this lookup.
--   closed_trades(closed_at)   — Feedback Loop's daily window + dashboard PnL.
--   debate_log(created_at)     — dashboard recent-debates view (3s poll).
--   verdict_log(timestamp)     — dashboard verdict-history view (3s poll).

CREATE INDEX idx_fills_broker_fill_id ON fills(broker_fill_id);
CREATE INDEX idx_closed_trades_closed_at ON closed_trades(closed_at);
CREATE INDEX idx_debate_log_created_at ON debate_log(created_at);
CREATE INDEX idx_verdict_log_timestamp ON verdict_log(timestamp);
