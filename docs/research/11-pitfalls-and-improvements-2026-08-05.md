# Pitfalls and Improvements — What the Runs So Far Actually Taught (2026-08-05)

**Status:** Recorded 2026-08-05, commissioned by David: *"caliberate cost and based on runs so far
identify pitfalls and improvements"*. The calibration half is
[10-cost-model-calibration-2026-08-05.md](10-cost-model-calibration-2026-08-05.md).

Every item below is tied to a **specific observed symptom** from a real run, not to general
engineering advice. Where a symptom has already been fixed, it says so — the pattern still matters
because it recurs.

---

## Pitfalls

### P1 — A test fixture became the basis of a live verdict

**Symptom:** the first real Stage 2 run returned KILL with 22 of 24 pairs negative. The cause was
`PESSIMISTIC_COST_CONFIG`, whose own comment concedes it "mirrors `cost-model.test.ts`'s
`PESSIMISTIC_CONFIG` fixture, the only asset-class cost values this repo has settled on so far".
Measured against 36,617 real quotes it overstated spread by **27× (equities) and 18× (crypto)**.

**Why it slipped through:** the fixture was honestly labelled and still got used, because there was
nothing else to use and no gate that distinguishes "a placeholder" from "a calibrated input". A
comment is not a control.

**Generalises to:** any input whose provenance is "the only value we've settled on so far". Grep for
that shape before the next gate.

### P2 — A "fallback" path that is actually the only path

**Symptom:** `ReplayDriver.marketState()` hardcodes `spread: null`, so `CostModelImpl`'s
null-spread fallback (`spread = volatility × coefficient`) fires on **100% of fills** in every
backtest ever run. It is documented as a fallback for when the market data service has no bid/ask
(cross-spec OPEN-GAP-A) — but in the replay path there is no other case.

That is how one un-calibrated coefficient came to control 95% of modeled cost.

**Generalises to:** any branch labelled "fallback", "default", or "degraded" that no telemetry
distinguishes from the primary path.

### P3 — Errors surfacing many layers below their cause

**Symptom:** the first Stage 2 run aborted with `toReturnSeries: no bars in the sample`. The actual
cause was that the Polygon plan serves 2 years and the script asked for 5 — four layers up. Fixed by
`effectiveWindow()` plus a named per-symbol error, but the run was lost first.

**Related, same run:** requesting a 5-year window and receiving 2 years produced **no error at
all** at ingest, because every individual page request succeeded. A provider silently serving less
than asked is indistinguishable from a provider having no more to give.

### P4 — Entitlement caps that look like data gaps

**Symptom:** exactly 2 years of history on both asset classes. Initially written up as possibly "an
account setting, not a purchase". A direct probe settled it:
`NOT_AUTHORIZED: "Your plan doesn't include this data timeframe."` It is a **paid** cap.

**Lesson:** probe the boundary rather than inferring the cause from the shape of the data. It took
one `curl`, and it changed a purchase recommendation.

### P5 — Measuring at the wrong instant

**Symptom:** the first live quote snapshot for calibration, taken just after the close, returned
**SPY at 752.40 / 799.00 — a 6% spread**, and AAPL at 293.64 / 324.64. Those are closing-auction
artifacts. Calibrating on them would have produced a cost model an order of magnitude *worse* than
the one being replaced.

The replay fills at the bar close, so the measurement has to be at the close — but *before* the
bell, not spanning it. Midday would have understated it in the other direction.

### P6 — Results that cannot be reproduced because the window moves

**Symptom:** `defaultFiveYearWindow()` reads `new Date()`. A re-run on any later day shifts the
effective window and the walk-forward fold boundaries, so a committed verdict stops being
comparable to its own re-run. Fixed by pinning the decomposition's window to the millisecond — and
the ×1 rung then reproduced the committed verdict per-pair, which is the only reason that
reproduction is evidence of anything.

### P7 — Seams designed without their consumer

**Symptom:** `deflatedSharpe()` needs a non-annualized per-period Sharpe. `MetricsSuite.sharpe` is
Lo(2002)-adjusted **annualized** Sharpe, and neither the raw return series nor the annualization
factor is exposed, so it cannot be inverted. DSR has therefore never been computable, on any run.

**Same shape:** `pbo()` requires an even CSCV fold count; the spec's walk-forward split produces 5
anchored, growing-train folds. Not an off-by-one — anchored walk-forward is not a CSCV partition at
all. Two independent statistical gates, both blocked by a design mismatch rather than a bug.

### P8 — The trial budget was fixed before the sample size was known

**Symptom:** the 12-config grid was sized on an assumed 5-year sample (MinBTL cap ~45). The real
sample supports **7**. The grid has been over budget on every run, and no run can fix that by
scoring better — calibration took passing configs from 2 to 12 and left `exceeded: true` untouched.

Worse, it cuts the wrong way: with 12 of 24 now passing, "pick the best config" is a live selection
risk in a way it was not when nearly everything failed.

### P9 — Mechanisms that exist, are tested, and are never called

The repo's dominant defect class, and it keeps recurring: #327, #364, #366, #374, #388, #370. The
current instance is visible in test output on every run:

> `ProductionConfig.feedback is not set — the daily feedback cycle will NEVER run. No analyst weight
> is attributed, no dial is tuned, and no kill-line is ever evaluated. The run will look healthy and
> learn nothing.`

The warning is excellent. It is also still true.

### P10 — Artifacts silently discarded by tooling

**Symptom:** the raw Stage 2 log was committed and simply did not appear — `.gitignore:59` is
`*.log`. Caught only by reading `git status` rather than trusting the commit. Renaming to `.txt`
fixed it.

**Also:** the worktree has no `.env.local` (it lives in the main checkout), and a background shell
had no `node` on `PATH`, producing a bare `EXIT=127`. Both cost a run.

### P11 — Turnover is load-bearing but is not a gate

**Symptom:** turnover runs **115–556** at ~0.9 exposure, unchanged by calibration. Every cost-model
error is multiplied by that number — it is precisely why an 18× spread overstatement became a KILL
rather than a rounding difference. `trade-derivation.ts` already anticipates this in a comment:
*"a trade worth revisiting if turnover ever becomes a kill criterion"*. It should be one.

---

## Improvements, in priority order

### I1 — Size the grid from the sample, not from an assumption *(blocking the gate)*

Compute the MinBTL cap **first**, then generate at most that many configs — or fail loudly before
running 12 trials the sample cannot support. Today the cap is computed at the end and reported as a
verdict field, after the work is done. This is the single binding constraint on Stage 2 and the
cheapest thing left to fix.

### I2 — Build the PBO and DSR seams *(blocking three kill-lines)*

Expose the raw per-period Sharpe (or the Lo annualization factor) on `MetricsSuite`/`EvalReport`,
and add a CSCV-shaped partitioning pass alongside walk-forward. Blocks #384 and #375. Needed
regardless of any strategy decision.

### I3 — Feed real spread into `MarketState.spread` and retire the fallback

The calibration fits a coefficient because that keeps the model's shape. The deeper fix is to supply
a real per-bar spread so the fallback stops being the only path (P2). The measurement path now
exists — `run-spread-calibration.ts` pulls real quotes — so this is wiring plus a quote cache, not
research. Would also make the coefficient's continued existence a genuine fallback.

### I4 — Give every cost term explicit provenance, and make it ops config

`CALIBRATED_COST_CONFIG` documents each term as measured / published / assumption. Make that
machine-readable and move the values to environment config the way `venue-pacing.ts` did for rate
limits (#299: "a rate limit is a property of the account, not of the code" — a fee schedule is
exactly the same). Then a fee-tier change is an env edit, and an unlabelled term is a build failure.

### I5 — Add a turnover / cost-sensitivity gate

Report, per config, the OOS Sharpe's sensitivity to a ±50% cost perturbation, and treat a config
whose verdict flips as failing regardless of its central estimate. The machinery already exists —
`scaleCostConfig` and the sensitivity ladder in `run-stage2-cost-decomposition.ts`. This converts
P11 from a footnote into a control.

### I6 — Fail loudly when a provider serves less than requested

`effectiveWindow()` now warns. Make it an explicit, structured outcome on the verdict — "requested
5y, served 2y, MinBTL computed on 2y" — so no future reader has to notice a log line to know what
the verdict is a verdict *about*. Probe entitlement boundaries directly (P4) rather than inferring.

### I7 — Close the no-caller class with a composition-root test

The pattern (P9) has recurred six times. A test that asserts every declared kill-line, feedback
cycle and scheduled loop has a live caller in `buildProductionComponents` would catch the whole
class at once, instead of one ticket at a time. The `feedback is not set` warning proves the
information is already available at boot — it just isn't asserted on.

### I8 — Replace the slippage assumption with measurement

The one calibrated term still without a measured basis. The paper soak (#238) produces live fills;
comparing modeled to realized cost is also the Feedback Loop's own divergence check (cross-spec
GAP-F), so building it serves two purposes.

### I9 — Pin windows and archive raw output for every gate run

Both now done for Stage 2 (P6, P10) and worth making the standing convention: a gate run that cannot
be reproduced, or whose raw output was eaten by `.gitignore`, is not evidence.
