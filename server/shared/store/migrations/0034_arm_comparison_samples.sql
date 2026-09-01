-- The Feedback Loop's arm-comparison samples (#971, under #636 and #913).
--
-- #636 put the falsifier-arm-2 comparison in the Feedback Loop: additional
-- columns in FL's existing daily/weekly Metrics & Revalidation suite, on FL's
-- existing cadence. #913 then asked for both an alert on divergence and a
-- dashboard panel showing the ongoing trend. A trend needs a series, and the
-- dashboard runs in a DIFFERENT PROCESS from the orchestrator that computes it
-- (service-api reads, orchestrator writes, one shared store) — so the answer has
-- to be written down rather than held in memory or recomputed on read.
--
-- ## Why not recompute at snapshot time
--
-- `buildArmComparison` is pure and cheap, so `buildSnapshot` COULD derive this
-- per HTTP request from `closed_trades`. That was rejected: it would move the
-- computation out of the Feedback Loop, which is the one thing #636 decided, and
-- the panel would then show a number FL never saw and never alerted on. A
-- persisted sample is FL's own record of what it measured and what it did about
-- it — the alert and the panel read the same row.
--
-- ## Why one flat row per cycle rather than a JSON blob
--
-- Every column here is queried as a number by the panel (both arms' return and
-- drawdown, plotted across cycles). A `comparison_json` column would make the
-- trend a decode-and-hope, and would let a future writer persist a per-arm view
-- with the drawdown missing — which is exactly what `ArmPerformance`'s required
-- `max_drawdown_pct` exists to prevent (`docs/research/12-edge-hypothesis-
-- critique.md` D4: no return-only comparison against a risk-targeted stream).
-- NOT NULL on all eight per-arm columns is that same discipline at the schema
-- layer: there is no row shape here that carries a return without its drawdown.
--
-- ## `computed_at` as the primary key
--
-- One sample per FL cycle, and the cycle instant identifies it. A second write
-- at the same instant is a re-run of the same cycle, not a new measurement, so
-- the PK conflict is the correct outcome rather than a silent duplicate in the
-- trend. `basis` is stored per row rather than assumed: it is the denominator
-- BOTH arms were divided by (`LIVE_BOOK_GBP` today), and a row read back after
-- the book is re-based must still be interpretable against the basis it used.

CREATE TABLE arm_comparison_samples (
  -- The FL cycle instant, ISO-8601 UTC with milliseconds (`toStoredTimestamp`).
  computed_at TEXT PRIMARY KEY,
  -- The ONE window both arms were measured over, half-open at the start
  -- (`closed_at > window_from AND closed_at <= window_to`). Doc 12 gate 4's
  -- exact-window requirement, recorded rather than reconstructed.
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  basis REAL NOT NULL,

  live_trade_count INTEGER NOT NULL,
  live_realized_pnl_net REAL NOT NULL,
  live_return_pct REAL NOT NULL,
  live_max_drawdown_pct REAL NOT NULL,

  control_trade_count INTEGER NOT NULL,
  control_realized_pnl_net REAL NOT NULL,
  control_return_pct REAL NOT NULL,
  control_max_drawdown_pct REAL NOT NULL,

  -- Whether this cycle crossed the divergence line, and the operator-facing
  -- sentence that was alerted. `divergence_reason` is NULL exactly when
  -- `diverged = 0`, which the store asserts on read-back.
  diverged INTEGER NOT NULL CHECK(diverged IN (0, 1)),
  divergence_reason TEXT
);

-- The panel's only read shape: the most recent N samples, newest first.
CREATE INDEX idx_arm_comparison_samples_computed_at ON arm_comparison_samples(computed_at DESC);
