-- The FROZEN STAGE 2 SELECTION (#375, #384) — the artifact whose absence made
-- all four kill-lines unevaluable.
--
-- ## What the two issues each concluded, separately
--
-- #375: `live_backtest_divergence_over_max` compares the live Sharpe against
-- "the frozen selected config's backtest Sharpe", and nothing persisted such a
-- record. Stage 2's runner used an in-memory trial log, so nothing survived the
-- process that computed it, and there was no selected-config artifact at all.
--
-- #384: the other three lines (`pbo_over_max`, `oos_sharpe_under_min`,
-- `dsr_insignificant`) are computed only from `DailyMetricsSample.revalidation`,
-- and no component produced one. #384 named the resolution in advance:
-- "`revalidation` is populated from a persisted Stage 2 run, not from live
-- data". PBO, out-of-sample Sharpe and the deflated Sharpe are walk-forward /
-- CSCV statistics; a live paper run cannot compute them about itself.
--
-- One table closes both, because both wanted the same row.
--
-- ## One row per (config, asset class, run)
--
-- Not "the latest selection" as a single mutable row. A Stage 2 re-run is
-- evidence about a different sample, and the previous verdict is the record of
-- what was believed when the capital decision was made — overwriting it would
-- destroy the audit trail the graduation decision rests on. Readers take the
-- most recent row by `selected_at`; history stays.
--
-- PBO and DSR are NULLABLE, and that is load-bearing. `renderStage2Verdict`
-- returns typed refusals ("no CSCV pass was requested", "the DSR variance term
-- is non-positive"), and a refusal is not a zero: a stored 0.0 PBO reads as a
-- perfect result and a stored 0.0 DSR reads as certain insignificance. NULL is
-- the only honest encoding, and the reader treats it as "this line stays
-- inert" rather than as a value.
CREATE TABLE stage2_selected_config (
  config_hash TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stocks')),
  -- ISO-8601 UTC, the convention every other timestamp column here uses:
  -- string comparison is only correct under one canonical, fixed-width format.
  selected_at TEXT NOT NULL,
  -- The sample the backtest ran over. Persisted because staleness is checkable
  -- only against it: a verdict about 2019 says nothing about today's regime,
  -- and the reader refuses a selection older than its freshness bound rather
  -- than driving live risk off it.
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  -- The selected config's whole-sample annualized Sharpe — what
  -- `backtest_reference_sharpe` has always meant.
  backtest_sharpe REAL NOT NULL,
  -- Mean of the walk-forward test-fold Sharpes.
  oos_sharpe REAL NOT NULL,
  -- The fold Sharpes as a JSON array: `RevalidationSnapshot`'s
  -- `walk_forward_sharpe_distribution` verbatim.
  fold_sharpes_json TEXT NOT NULL,
  pbo REAL,
  dsr REAL,
  -- Distinct trials the search spanned — the number DSR was deflated by, kept
  -- so a later reader can tell a deflation over 8 trials from one over 800.
  n_trials INTEGER NOT NULL,
  -- The verdict's own pass/fail. A FAILED selection is still stored and still
  -- read: a strategy that failed Stage 2 has kill-lines that should fire, and
  -- suppressing the row would restore exactly the silence #384 is about.
  overall_pass INTEGER NOT NULL CHECK (overall_pass IN (0, 1)),
  PRIMARY KEY (config_hash, asset_class, selected_at)
);

-- The only read pattern: newest selection for an asset class.
CREATE INDEX idx_stage2_selected_config_lookup
  ON stage2_selected_config (asset_class, selected_at DESC);
