-- Per-asset-class session-open equity snapshots (#332), the denominator of
-- risk-manager-spec.md's session-scoped `daily_pnl_pct`.
--
-- Resolves GAP-8 (cross-verify 2026-07-31) on the local-snapshot side: Alpaca's
-- single blended `last_equity` carries one reset boundary for a portfolio that
-- has two, and its actual boundary was never verified against a live account.
-- The figure is now derived locally instead, against a boundary this system
-- owns (`TradingCalendar.sessionStart`, #331).
--
-- One row per class, plus a `portfolio` row for the UTC portfolio-level figure.
-- Deliberately a SECOND table rather than columns on `account_state`: that
-- table is keyed one-row-per-account with `peak_equity NOT NULL`, and widening
-- it would force either a dummy `peak_equity` on every per-class row or a
-- nullable one — eroding the invariant that makes the hard drawdown breaker
-- crash-safe (a NULL denominator reads as no drawdown, forever).
--
-- `open_at` is the SESSION START INSTANT, never the write time. The snapshot is
-- written at the first tick *after* a boundary — exact reconstruction is
-- impossible, since historical `cash` is stored nowhere — so recording the
-- boundary keeps the drift between boundary and observation visible in the data
-- rather than baking it in silently.
--
-- ISO-8601 UTC (`toISOString()`), matching `closed_trades.closed_at`: the
-- realized-PnL filter is a TEXT `closed_at > open_at` comparison, which is only
-- correct because both sides are written fixed-width, zero-padded, and Z-suffixed.
CREATE TABLE session_equity (
  asset_class  TEXT PRIMARY KEY CHECK(asset_class IN ('crypto', 'stocks', 'portfolio')),
  open_equity  REAL NOT NULL,
  open_at      TEXT NOT NULL
);
