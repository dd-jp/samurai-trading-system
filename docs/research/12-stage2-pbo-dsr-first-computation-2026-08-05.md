# PBO and DSR, Computed for the First Time (2026-08-05)

**Status:** Recorded 2026-08-05, from the first Stage 2 run in which the PBO and DSR kill-line
terms were computable at all ([#406](../../issues/406), improvement I2 in
[11-pitfalls-and-improvements-2026-08-05.md](11-pitfalls-and-improvements-2026-08-05.md)).

Raw output: [stage2-pbo-dsr-2026-08-05.txt](stage2-pbo-dsr-2026-08-05.txt).
Code: `cscv` scheme in `src/cost-model-backtest/splits.ts`, DSR inputs on `MetricsSuite`
(`metrics.ts`), both consumed by `stage2-verdict.ts`.

## Headline

> **Two of Stage 2's four kill-line terms had never produced a number. Both now do, and both
> reject.**
>
> PBO is **0.65 for stocks and 0.35 for crypto** against a kill line of 0.05. DSR is **0.25 and
> 0.52** against a 0.95 significance line. The OOS-Sharpe count is unchanged at 12 of 24, and
> MinBTL still reports 12 trials against a cap of 7.
>
> The gate returns `KILL/INCOMPLETE` — but for the first time the "INCOMPLETE" half is gone. Every
> term of the kill line has now been evaluated, and the strategy fails three of the four.

## What changed

Neither statistic was blocked by missing data. Both were blocked by a mismatch between the trial
design and what the statistic is defined over — pitfall P7, "seams designed without their consumer":

- **DSR** needs the non-annualized per-period Sharpe. `MetricsSuite.sharpe` is Lo (2002)-adjusted
  *annualized* Sharpe, which folds in sample autocorrelation and so cannot be inverted back. The
  suite now carries `per_period_sharpe`, `annualization_factor` and `observations` beside it.
- **PBO** needs a symmetric CSCV partition. The spec's walk-forward split produces 5 anchored folds
  with a growing train side — an odd count, and not a symmetric partition at any count.
  `generateSplits` gained a `cscv` scheme: purged 6-fold, one contiguous group held out at a time.

## The numbers

Run over the effective window **2024-08-06 .. 2026-08-05** (the 2 years the Polygon plan serves
against a requested 5 — see P4), 1,229 return observations, under `CALIBRATED_COST_CONFIG`.

| term | stocks | crypto | kill line | verdict |
|---|---|---|---|---|
| Pairs clearing OOS Sharpe | 6 / 12 | 6 / 12 | >= 0.5 | unchanged from the calibrated run |
| **PBO** | **0.65** | **0.35** | <= 0.05 | **reject, both** |
| **DSR** | **0.254** | **0.519** | >= 0.95 | **reject, both** |
| MinBTL | 12 trials vs cap 7 | same | N <= cap | **exceeded** |

The DSR row deflates the config each asset class's search would actually have selected — the
highest OOS Sharpe, which is `09adb83…` at 1.282 for stocks and `b9cc5ba…` at 2.304 for crypto. Their
whole-window per-period Sharpes are 0.0295 and 0.0488. Deflated by N = 12 over 1,229 observations,
those are the 0.254 and 0.519 above.

## What PBO 0.65 means, in plain terms

Across the symmetric partitions of the six CSCV folds, the config that scored best on the training
half landed **at or below the median** on the held-out half in 65% of them for stocks. Above 0.5,
config selection is worse than a coin flip: picking the in-sample winner actively anti-predicts
out-of-sample rank. Crypto's 0.35 is better and still seven times the kill line.

This is the concrete form of the risk P8 flagged in the abstract. The cost calibration took the
grid from 2 of 24 configs passing to 12, which made "just pick the best one" look far more
attractive — and PBO is the measurement saying that picking the best one is precisely what does not
survive.

### Two honest limitations on the PBO figure

- **20 partitions gives a coarse estimate.** Six folds yield C(6,3) = 20 symmetric splits, so PBO
  can only take values in steps of 0.05. The kill line *is* 0.05, so an "accept" requires at most
  one partition to underperform. The verdict here is not close to that boundary, but a marginal
  result at this resolution would not be trustworthy, and a future PBO near the line should be read
  as "needs more folds", not as a pass.
- **The fold count is fixed at 6, not derived.** It matches the existing `CPCV_GROUPS`, which was
  itself chosen to give 15 paths. A 2-year window over 6 folds is ~4 months per fold; the first
  fold carries the indicator warm-up (`slowWindow` up to 50 bars plus `atrWindow` 14), so it is the
  thinnest sample of the six. Every one of the 24 pairs did produce a complete 6-fold matrix in
  this run — no fold was degenerate — but that is an observation about this window, not a guarantee.

## What this does and does not change

**Does not change the verdict direction.** Stage 2 was already `KILL` on MinBTL, and it still is.
Nothing here graduates anything, and the paper soak remains gated.

**Does change what the KILL rests on.** Before this run, three of the four kill-line terms were
either failing (MinBTL) or unevaluable (PBO, DSR), and the one clean signal — OOS Sharpe — had just
improved sharply under the calibrated cost model. It was reasonable to wonder whether the trial
budget was the only thing standing in the way. It is not. Two independent overfitting statistics now
say the 12-of-24 pass rate does not survive honest selection accounting.

**Sharpens the priority order.** Fixing the trial budget (I1 / [#405](../../issues/405)) is still
the cheapest remaining move and is still worth doing — but it should now be understood as necessary
rather than sufficient. Cutting the grid to 7 configs raises the MinBTL cap above N; it does not by
itself move PBO, which is measured over whatever configs remain.

## What to do next

1. **Do not read 12 of 24 as a signal.** It is the same evidence as before, and PBO now prices what
   selecting from it costs.
2. **Fix the trial budget anyway** (I1 / #405) — MinBTL is still exceeded, and a smaller grid also
   makes the PBO estimate less dependent on a large config set.
3. **Re-run this gate after any change to the grid or the cost model.** All four terms are
   computable now, so there is no longer a reason to report a partial verdict.
4. **Arm the Feedback Loop kill-lines** ([#384](../../issues/384), [#375](../../issues/375)) — they
   were blocked on exactly these two seams, and both are now unblocked.
