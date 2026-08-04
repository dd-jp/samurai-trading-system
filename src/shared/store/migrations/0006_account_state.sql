-- Durable account scalars that no external API supplies (#276).
--
-- Today that is `peak_equity` alone: an all-time high-water mark of equity.
-- Alpaca's `GET /v2/account` has no such field, and it cannot be reconstructed
-- from `closed_trades` either — it is a function of *equity* (which includes
-- open, unrealized positions), not of realized trades.
--
-- Deliberately NOT part of `current_tick`: that table is documented as
-- "disposable, best-effort progress state — NOT a system-of-record", deleted
-- on tick completion. A monotonic high-water mark stored there would be wiped
-- every tick, silently disabling the hard portfolio-drawdown circuit breaker
-- that `peak_equity` is the denominator of — the breaker would read a
-- drawdown of ~0 forever and never trip.
--
-- Single durable row (key = 'default'), upserted once per tick, never
-- deleted. DDL matches shared-sqlite-store-spec.md's "Consolidated Schema"
-- verbatim (added there by the 2026-07-31 cross-verify pass, GAP-7).
--
-- If the open GAP-8 decision on `daily_pnl_pct` lands on the local-snapshot
-- option, this same table gains a `daily_open_equity`/`daily_open_at` pair
-- rather than a second table. Not added pre-emptively: the columns are
-- unspecced until that decision is made, and adding them now would be the
-- same spec/code drift GAP-7 existed to correct.
CREATE TABLE account_state (
  key           TEXT PRIMARY KEY,
  peak_equity   REAL NOT NULL,
  updated_at    TEXT NOT NULL
);
