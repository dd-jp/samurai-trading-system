-- Durable journal for `execute()`'s flatten submissions (#508 review, PR #516
-- comments 2+4).
--
-- THE GAP THIS CLOSES. An exit intent never wrote anything to
-- `open_positions` -- `OpenPosition.intent_type` deliberately excludes
-- 'exit' (shared/types/records.ts: "exits close a lot; they never create
-- one") -- so `findByKey`'s dedup gate could never fire for a replayed exit,
-- and a `submitFlatten` call that timed out after the venue accepted it left
-- no durable trace for #86's reconcile to resolve against. Same class of
-- defect #312 fixed for the ccxt bracket journal
-- (0017_broker_bracket_submitting.sql): write ahead BEFORE the broker call,
-- so a crash (or a lost response) in the gap leaves a row naming the order
-- that MAY exist at the venue, instead of nothing at all.
--
-- 'submitting' -> 'submitted' | 'error', mirroring `broker_brackets`' phase
-- column and `execute()`'s own pending -> submitted transition for the
-- bracket path. No bracket-shaped columns (no stop/target/entry price): a
-- flatten is a plain market order with none of those, and writing a
-- half-formed bracket row here is exactly the shape PR #516 review flagged
-- as wrong.
CREATE TABLE flatten_submissions (
  idempotency_key   TEXT PRIMARY KEY,
  instrument        TEXT NOT NULL,
  asset_class       TEXT NOT NULL CHECK(asset_class IN ('crypto', 'stocks')),
  side              TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  size              REAL NOT NULL,
  -- 'submitting': written ahead, before `submitFlatten` is called -- the
  -- broker may or may not have seen it. 'submitted': the broker acked;
  -- order_state/broker_order_ids carry what it said. 'error': the flatten
  -- provably never reached the broker (e.g. the pre-flatten bracket cancel
  -- failed) -- distinct from a `submitFlatten` call that itself threw, which
  -- is genuine ambiguity and is left as 'submitting' for reconcile.
  status            TEXT NOT NULL CHECK(status IN ('submitting', 'submitted', 'error')),
  order_state       TEXT NULL,        -- set once the broker acks; NULL while 'submitting'
  broker_order_ids  TEXT NULL,        -- JSON string[]; NULL while 'submitting'
  reason            TEXT NULL,        -- set on 'error'
  submitted_at      TEXT NOT NULL,    -- write-ahead time
  resolved_at       TEXT NULL         -- set on transition to 'submitted' or 'error'
);
CREATE INDEX idx_flatten_submissions_instrument ON flatten_submissions(instrument);
