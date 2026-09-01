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
  -- sentence that was alerted.
  diverged INTEGER NOT NULL CHECK(diverged IN (0, 1)),
  divergence_reason TEXT,

  -- `divergence_reason` is non-NULL if and ONLY if `diverged = 1`, enforced
  -- here rather than asserted by the readers.
  --
  -- The two halves fail differently and both matter. A row saying it diverged
  -- with no reason would put an UNEXPLAINED escalation on the operator's panel
  -- — the alert text and the panel line are the same sentence, so a missing
  -- reason is a divergence nobody can act on. A row carrying a reason while
  -- `diverged = 0` is the opposite lie: a sentence asserting the control won,
  -- attached to a verdict that says it did not. Neither is representable now.
  --
  -- This is the schema layer of the same invariant `ArmDivergenceVerdict`
  -- documents and `evaluateArmDivergence` constructs. It belongs here rather
  -- than in the store's row mapper because the mapper only sees rows on the way
  -- OUT: a hand-written INSERT, a repair script or a future second writer never
  -- passes through it, and the table is the one place all of them meet.
  CHECK (
    (diverged = 0 AND divergence_reason IS NULL) OR
    (diverged = 1 AND divergence_reason IS NOT NULL)
  )
);

-- The panel's only read shape: the most recent N samples, newest first.
CREATE INDEX idx_arm_comparison_samples_computed_at ON arm_comparison_samples(computed_at DESC);
