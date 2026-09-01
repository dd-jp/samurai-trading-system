-- The Feedback Loop's outside-benchmark samples (#981, under #636).
--
-- #636 asked one question with two halves and answered both with
-- `feedback-loop-spec.md`: "the control arm AND outside benchmarks become
-- additional columns in a suite that already runs on this cadence." Migration
-- 0034 built the first half (`arm_comparison_samples`). This is the second.
--
-- ## Why a NEW table rather than columns on `arm_comparison_samples`
--
-- An outside benchmark is not a third arm, and the row shapes disagree in ways
-- that would make shared columns lie:
--
--   * It has no `trade_count` — SPY is held, not traded.
--   * It has no `realized_pnl_net` — no fills, no fees, no account. A currency
--     figure here would be money nobody made.
--   * It has no `diverged` / `divergence_reason` — the matched control can wake
--     a human, a benchmark cannot. It is SECONDARY and never the thing to beat
--     (CLAUDE.md Key Constraints; ADR-0014 amendment 2; ADR-0017 §Consequences).
--   * It has no idempotency arm tag and no per-arm floor.
--
-- Widening 0034 with four nullable benchmark columns would have made every one
-- of those absences representable as NULL on a row that also carries an arm's,
-- which is precisely the "one column per arm" table #636 names as the failure
-- mode. A separate table makes the two record types separately typed.
--
-- ## Why the return column is NOT called `return_pct`
--
-- `arm_comparison_samples.live_return_pct` is realized PnL over the window as a
-- fraction of the declared book — a book that is FLAT OVERNIGHT and holds risk
-- only while a trade is on (ADR-0014's flat-by-close horizon).
-- `buy_and_hold_return_pct` is the return of a position fully invested for the
-- whole window, every day, including the nights the live book is deliberately
-- flat. Same units, different quantities. #636 warns that this is "easy to lose
-- in a per-arm metrics table with one column per arm", so the column carries a
-- different NAME rather than a footnote: a query that wants to UNION these into
-- one column has to alias something first, in SQL that reads as the mistake it
-- is.
--
-- ## Return and drawdown, both NOT NULL
--
-- `docs/research/12-edge-hypothesis-critique.md` D4 rules out return-only
-- comparison against a risk-targeted stream, and CLAUDE.md applies it to the
-- outside benchmarks explicitly: they "report return AND drawdown together".
-- NOT NULL on both is that rule at the schema layer — there is no row shape
-- here that carries a return without its drawdown, matching the discipline
-- 0034 applies to the arms.
--
-- ## (computed_at, benchmark) as the primary key
--
-- One row per benchmark per FL cycle. A composite key rather than four
-- benchmark-prefixed column groups so that adding a benchmark is a DATA change
-- rather than a migration — and `benchmark`'s CHECK is what stops that
-- flexibility becoming a liability: an unconstrained TEXT key is how a typo
-- becomes a silent third series in the panel's trend.
--
-- What a composite key gives up is "both benchmarks are present for a cycle",
-- and that is deliberately NOT enforced here. A cycle where SPY resolved and
-- AGG's vendor did not is a real and honest state; the reader renders SPY and
-- says "not measured" for the other. Forcing both to be present would mean
-- either dropping a good SPY reading or fabricating an AGG one.
--
-- ## An absent row means NOT MEASURED, and that is the design
--
-- `runOutsideBenchmarkCycle` persists nothing for a benchmark it could not
-- measure — no zero-valued placeholder — because a fabricated benchmark on the
-- operator's panel is worse than an absent one. The reason is logged instead
-- (`OutsideBenchmarkCycleResult.unmeasured`), so "the vendor 429'd" and "FL
-- never ran" are distinguishable in the log even though both leave no row.

CREATE TABLE outside_benchmark_samples (
  -- The FL cycle instant, ISO-8601 UTC with milliseconds (`toStoredTimestamp`).
  computed_at TEXT NOT NULL,

  -- Which benchmark. #636 settled the set (SPY and 60/40) and #981's non-goals
  -- rule out reopening it, so the CHECK mirrors `OUTSIDE_BENCHMARKS` exactly.
  -- Widen both together if a benchmark is ever added by decision.
  benchmark TEXT NOT NULL CHECK(benchmark IN ('spy', 'sixty_forty')),

  -- The window, COPIED from the `arm_comparison_samples` row computed in the
  -- same cycle — never chosen independently. #636: "Outside benchmarks computed
  -- on approximate windows are not risk-adjusted comparisons, they are noise."
  -- Recorded here rather than joined for the reason 0034 records it there: a row
  -- must stay interpretable on its own after the fact.
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,

  -- Return AND drawdown, both required. See the D4 note above.
  --
  -- `buy_and_hold_return_pct` is a signed fraction of a FULLY-INVESTED notional.
  -- `max_drawdown_pct` is a POSITIVE fraction, taken on the BLENDED index series
  -- rather than as a blend of the legs' separate drawdowns (those are different
  -- numbers and the second overstates, because the sleeves diversify each other).
  buy_and_hold_return_pct REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,

  -- Daily observations the figures were computed over, after intersecting the
  -- legs' calendars. Carried for the reason the arms carry `trade_count`: a
  -- return over three observations and one over three hundred look identical
  -- without it.
  observation_count INTEGER NOT NULL,

  -- A second write at the same instant for the same benchmark is a re-run of
  -- the same cycle re-measuring the same window, not a new measurement — so the
  -- conflict is correct rather than a silent duplicate point in the trend.
  PRIMARY KEY (computed_at, benchmark)
);

-- The panel's only read shape: the most recent N samples, newest first.
CREATE INDEX idx_outside_benchmark_samples_computed_at
  ON outside_benchmark_samples(computed_at DESC);
