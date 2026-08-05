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
-- GAP-8 on `daily_pnl_pct` has since been resolved (#332) on the local-snapshot
-- side — but NOT as the `daily_open_equity`/`daily_open_at` column pair this
-- comment used to reserve. That shape presumed a single account-wide daily
-- boundary; the resolved design is one snapshot per asset class (crypto on
-- 00:00 UTC, stocks on the prior 16:00 ET close) plus a portfolio-level row.
-- Those rows live in `session_equity` (migration 0009), not here: this table is
-- keyed one-row-per-account around a NOT NULL `peak_equity`, so three per-class
-- rows would each need a dummy high-water mark or a nullable one — and a NULL
-- denominator reads as zero drawdown forever, eroding the very crash-safety
-- invariant this table exists to hold.
CREATE TABLE account_state (
  key           TEXT PRIMARY KEY,
  peak_equity   REAL NOT NULL,
  updated_at    TEXT NOT NULL
);
