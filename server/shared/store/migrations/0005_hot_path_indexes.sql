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

-- DELIBERATELY NOT INDEXED (#305, closing C5's remainder). The review named six
-- tables; these two are the pair left out, and the omission is a decision:
--
--   analyst_weights — one row per analyst the composition root builds. A
--                     handful, and bounded by the analyst roster rather than by
--                     history.
--   current_tick    — the IN-FLIGHT tick only. Rows are DELETED when the tick
--                     completes (sqlite-current-tick-store.ts), so the table
--                     holds at most `max_concurrent_instruments` rows — one,
--                     under ADR-0008.
--
-- Note the reason is CARDINALITY, not the primary key. Both tables ARE queried
-- off-PK: the dashboard range-scans `analyst_weights.updated_at <= ?` and
-- `current_tick.updated_at > ? AND <= ?` (sqlite-query-store.ts) on a 3s poll.
-- An index would serve those lookups — it just cannot beat a scan of a few
-- rows, and it would cost a write on every weight step and every stage
-- transition, which is the hot path here. That is the opposite trade from the
-- four above, whose tables grow with history forever.
--
-- Revisit if either table ever stops being bounded — a per-bar weight history
-- or a retained tick log would both invalidate this.
