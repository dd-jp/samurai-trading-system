# Stage 2 Overfitting Verdict — DSR / PBO / MinBTL over the 12-Config Trial Grid

> **ARCHIVED — superseded by [`13-stage2-proxy-verdict.md`](../13-stage2-proxy-verdict.md).** Note beyond the in-body banner: this doc's MinBTL `exceeded: false` was wrong on real data (12 configs against a limit of 7).

**Status:** Recorded 2026-07-29. **Issue [#245](../../issues/245)** ("Stage 2: overfitting
verdict + write-up"), Verdict module of
[stage2-validation-execution-spec.md](../../specs/stage2-validation-execution-spec.md), wayfinder
map [#154](../../issues/154).

> **Superseded on the two structural gaps (2026-08-05, [#406](../../issues/406)).** This document
> reports DSR and PBO as blocked by design mismatches — `MetricsSuite` exposing only the annualized
> Sharpe, and walk-forward folds not being a CSCV partition. Both seams have since been built, and
> both statistics now compute against real data. See
> [12-stage2-pbo-dsr-first-computation-2026-08-05.md](2026-08-05-stage2-pbo-dsr-first-computation.md).
> The reasoning below for *why* they were blocked is still accurate and worth reading; the
> conclusion that they cannot be computed is not.

## Headline verdict

> **Stage 2 gate: NOT PASSED. Verdict cannot be rendered.** This is a "no verdict" result, not a
> "pass" result — treat it as equivalent to a kill for sequencing purposes (see "Sequencing
> conflict" below). Do not read anything below as a green light for Stage 3.

This is **not** a computed "kill" (a bad Sharpe/PBO/DSR number). It is a report that the inputs
the kill line needs do not exist yet, plus two structural gaps that would block a full
computation even once they do. Full reasoning below, per config where a number exists at all —
nothing here is a single cherry-picked figure.

## Why there is no verdict to render

**#244 (PR #254, "12-config trial grid execution") shipped orchestration and tests — it never
executed a real run.** Confirmed by direct inspection of this repo, not inference:

- `Stage2HistoricalStore.ingest()` (`src/cost-model-backtest/stage2-historical-store.ts`) requires
  an injected `PolygonClient`. No real Polygon/Massive HTTP client exists in this repo, no API key
  is provisioned (`docs/specs/stage2-validation-execution-spec.md` itself calls this "an ops/setup
  task"), and there is no ingestion entrypoint/script/CLI anywhere in the repo (`scripts/` doesn't
  exist; `package.json`'s only runnable scripts are `build`, `test`, `lint`, `orchestrator`,
  `dashboard`).
- No scratch SQLite/Parquet file with real bars exists on disk or in `.gitignore`'d state — there
  is nothing to have ingested into.
- `runTrialGrid()` (`src/cost-model-backtest/trial-execution.ts`) has never been invoked outside
  its own unit tests, which run against synthetic in-memory fixtures, not real market history.
  `ConfigTrialLog` is in-memory only (`InMemoryConfigTrialLog`) and process-lifetime; nothing
  persists a real trial log between runs, so there is no artifact anywhere recording 12 *real*
  logged trials.

So "the 12 logged trials produced by #244" describes the **grid definition and wiring** (real,
tested, correct), not 12 real evaluated configs over real history. `renderStage2Verdict()`
(new in this ticket, `src/cost-model-backtest/stage2-verdict.ts`) was invoked with `results: []`
— the honest input, given the above — and reports accordingly rather than fabricating numbers
against fixture data dressed up as a real run.

## What the module *can* and does compute for real today

`renderStage2Verdict()` still renders what depends only on the window and N, no market data
required:

- **MinBTL — the one real number.** `minbtlGuard(fiveYearWindow, 12)` against a real 5-year
  `DateRange` (2021-01-01 to 2026-01-01, matching the spec's Polygon Stocks Starter ingestion
  window) returns:
  - `limit`: computed by `overfitting.ts`'s `minbtl()`, which counts upward until
    `minimumBacktestLengthYears(N+1) > years`. For a 5-year window this lands at the spec's
    documented ~45-trial cap (verified in `stage2-verdict.test.ts`: the limit falls in [40, 50]
    for this exact window).
  - `distinct_configs`: 12.
  - `exceeded`: **false**. N=12 sits well under the ~45-trial cap, exactly as the spec predicted
    ("12 trials against a 45-trial ceiling ... leaving headroom"). **This satisfies acceptance
    criterion 3 as stated** — it is computed from the real window and real N, independent of
    whether any replay ever ran.
- **The OOS-Sharpe kill-line check is fully wired** (`killLineChecks()` in `stage2-verdict.ts`):
  per (config, asset class), it takes the mean Sharpe across the 5 walk-forward test folds as the
  out-of-sample estimate, reports it *alongside* the whole-window (in-sample) Sharpe — never
  instead of it, per the spec's "no single number in isolation" discipline — and checks it against
  the 0.5 kill line. This machinery is ready and unit-tested; it produces nothing today only
  because `results` is empty.

## Two structural gaps, independent of the missing data

Wiring the consumer up surfaced two conflicts between the trial design and `overfitting.ts`'s
actual preconditions. Neither is new math — both are pre-existing facts about the already-built,
already-tested machinery that this ticket's "just consume it" scope made visible for the first
time. Recording them here rather than glossing over them:

1. **PBO cannot accept the spec's own trial design.** `pbo()` (`overfitting.ts`) requires an even
   fold count ≥ 4 — its CSCV combinatorics partition the folds into symmetric train/test halves.
   The spec fixes **5** walk-forward folds (`WALK_FORWARD_FOLDS = 5` in `splits.ts`). 5 is odd, so
   `pbo()` throws on this shape outright — this is not a rounding inconvenience. Worse, even a
   padded-to-6 walk-forward set would not give `pbo()` the partition structure its formula assumes:
   each walk-forward fold's train side is anchored and growing from the window start, not a
   held-out symmetric half. `eval-executor.ts` already documents CPCV scoring as deferred (the
   exposure denominator can't handle disjoint test ranges); PBO as implemented needs exactly that
   deferred capability. **This is a spec/implementation conflict that exists regardless of
   whether real data is ever ingested** — it must be resolved (extend `eval-executor.ts` for CPCV,
   or find another route to a config-ranking distribution) before PBO can ever be computed for
   this trial design, not just before this ticket's numbers can be filled in.
2. **DSR cannot be derived from what `EvalReport` exposes.** `deflatedSharpe()` requires the
   non-annualized per-period Sharpe (mean/stdev of the raw periodic returns). `MetricsSuite.sharpe`
   is Lo (2002)-adjusted **annualized** Sharpe (`metrics.ts`: `sharpe: (mean / stdev) *
   annualization`, where `annualization` folds in the sample's estimated autocorrelation structure)
   — explicitly *not* a naive `× √periodsPerYear` away from the raw statistic. `EvalReport` /
   `MetricsSuite` expose neither the raw return series nor the Lo annualization factor needed to
   invert this correctly. A future ticket needs to add a seam (e.g. a raw per-period Sharpe field,
   or the annualization factor itself, on `MetricsSuite`/`EvalReport`) before DSR can be computed
   without either fabricating an approximation or reaching past the interface boundary this ticket
   was scoped not to touch.

`stage2-verdict.ts` surfaces both as typed `NotComputableReason`s (`pbo_requires_even_fold_count`,
`dsr_requires_per_period_sharpe_not_exposed_by_metrics_suite`) rather than throwing uncaught or
silently omitting the field — a caller reading `Stage2Verdict` cannot mistake "not computed" for
"computed and passing".

## Full per-config metrics — structure, not fabrication

The acceptance criteria ask for "the full metrics suite per config (not a single cherry-picked
number)". Per config × asset class, `renderStage2Verdict()` reports:

| Field | Status |
|---|---|
| `window_sharpe` (in-sample, whole window) | Not available — no real run |
| `oos_sharpe` (mean of 5 walk-forward test folds) | Not available — no real run |
| `fold_sharpes` (all 5, not just the mean) | Not available — no real run |
| `passes_oos_sharpe_line` (< 0.5 kill line) | Not available — no real run |
| Sortino, Calmar, max drawdown, profit factor, expectancy, skew, kurtosis, turnover, exposure | All present on `MetricsSuite` and would populate identically to `sharpe` above once a real `EvalReport` exists — no additional gap beyond "no real run" |
| DSR | Not computable even with real data — gap #2 above |
| PBO | Not computable even with real data, for this trial design — gap #1 above |
| MinBTL | **Computed for real**: limit ≈ 45 (5-yr window), distinct_configs = 12, exceeded = **false** |

No number in this document is a placeholder dressed as a result. Every cell above is either a real
computed value (MinBTL) or an explicit "not available" — never an interpolated or fixture-derived
figure presented as if it came from a market run.

## Sequencing conflict — mandatory to state plainly

**The Production Composition Root work (ADR-0004, wayfinder map [#224](../../issues/224), tickets
#234–#238) is proceeding toward a live paper run without a passing Stage 2 gate — right now, not
hypothetically.** This is worse than a computed kill: a computed kill at least means the gate
fired and produced a real answer. Here, the gate has never fired at all — no Polygon key, no
ingestion run, no real trial data — while #234–#238 continue independently toward Stage 3
(paper trading), exactly the silent-parallel scenario
`stage2-validation-execution-spec.md`'s own "Sequencing note" warned about:

> "the staged-deployment plan's own discipline says Stage 2's gate should pass *before* Stage 3
> (paper trading) starts. This spec does not re-sequence that work; it surfaces the gap so
> `/to-tickets` and prioritization can account for it explicitly."

That gap has not been closed by #244/#245 — it has been made concrete and worse: not "the gate
hasn't run yet" in the abstract, but "the gate cannot run at all yet" (no ingestion path exists)
and "the gate as specified cannot fully compute PBO even once it can run" (fold-parity conflict).
**Recommendation: treat the Production Composition Root's live-paper-tick milestone as blocked on
a real Stage 2 verdict, not merely racing it.** Concretely, before #234–#238 reach a live paper
tick:

1. Provision a Polygon/Massive API key and build the ingestion entrypoint `Stage2HistoricalStore`
   needs a real `PolygonClient` for (no such client or CLI exists in the repo today).
2. Run `runTrialGrid()` for real against the ingested 5-year history, persisting the result (the
   in-memory `ConfigTrialLog` alone will not survive a process boundary — use
   `SqliteConfigTrialLog`, which already exists).
3. Resolve the PBO fold-parity conflict (gap #1) — this blocks PBO regardless of data.
4. Add the seam DSR needs (gap #2) — this blocks DSR regardless of data.
5. Re-run `renderStage2Verdict()` against the real, persisted `TrialGridResult[]` and record an
   actual pass/kill verdict here, superseding this document.

## What was built to make this checkable

- `src/cost-model-backtest/stage2-verdict.ts` — `renderStage2Verdict()`, `killLineChecks()`,
  `KILL_LINE`. Pure consumer of `overfitting.ts`'s `minbtlGuard`/`pbo` (no new math), assembling
  `TrialGridResult[]` (#244) into the shapes those functions need.
- `src/cost-model-backtest/stage2-verdict.test.ts` — TDD coverage: MinBTL computed for a real
  5-year window, PBO's even-fold-count refusal for the spec's actual 5-fold shape, PBO computed
  correctly when handed a shape it can accept, the DSR refusal always present, and
  `overall_pass` never `true` unless every section is both present and passing (never true on
  empty input, never true when PBO could not be computed).
- Exported from `src/cost-model-backtest/index.ts` alongside the rest of the module's public
  surface.
