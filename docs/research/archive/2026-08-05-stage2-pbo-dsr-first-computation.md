# PBO and DSR, Computed for the First Time (2026-08-05)

> **ARCHIVED — superseded by [`13-stage2-proxy-verdict.md`](../13-stage2-proxy-verdict.md).** First computation of PBO/DSR and the record of the #420 merged-timeline defect.

**Status:** Recorded 2026-08-05, from the first Stage 2 run in which the PBO and DSR kill-line
terms were computable at all ([#406](../../issues/406), improvement I2 in
[11-pitfalls-and-improvements-2026-08-05.md](2026-08-05-pitfalls-and-improvements.md)).

Raw output: [stage2-pbo-dsr-corrected-2026-08-05.txt](raw/2026-08-05-stage2-pbo-dsr-corrected.txt)
(**authoritative** — after the [#420](../../issues/420) timeline fix). The original run is kept as
[stage2-pbo-dsr-2026-08-05.txt](raw/2026-08-05-stage2-pbo-dsr.txt) for comparison.
Code: `cscv` scheme in `src/cost-model-backtest/splits.ts`, DSR inputs on `MetricsSuite`
(`metrics.ts`), both consumed by `stage2-verdict.ts`.

## Headline

> **Two of Stage 2's four kill-line terms had never produced a number. Both now do, and both
> reject.**
>
> PBO is **0.65 for stocks and 0.30 for crypto** against a kill line of 0.05. DSR is **0.26 and
> 0.52** against a 0.95 significance line. The OOS-Sharpe count is **14 of 24**, and MinBTL still
> reports 12 trials against a cap of 7.
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
against a requested 5 — see P4), under `CALIBRATED_COST_CONFIG`.

> **Numbers below are the corrected ones.** The new `observations` field immediately exposed a
> pre-existing defect — both asset classes reported **1,229** observations over the same window,
> which cannot be true of both. Fixed in [#420](../../issues/420) and the gate re-run; the section
> "The defect this run found" records what moved and what did not.

| term | stocks | crypto | kill line | verdict |
|---|---|---|---|---|
| Return observations | 500 | 729 | — | the real trading-day counts |
| Pairs clearing OOS Sharpe | 8 / 12 | 6 / 12 | >= 0.5 | **14 / 24** |
| **PBO** | **0.65** | **0.30** | <= 0.05 | **reject, both** |
| **DSR** | **0.255** | **0.519** | >= 0.95 | **reject, both** |
| MinBTL | 12 trials vs cap 7 | same | N <= cap | **exceeded** |

The DSR row deflates the config each asset class's search would actually have selected — the
highest OOS Sharpe, which is `09adb83…` for stocks and `b9cc5ba…` for crypto. Their whole-window
per-period Sharpes are 0.0463 and 0.0633. Deflated by N = 12 over 500 and 729 observations, those
are the 0.255 and 0.519 above.

## The defect this run found (fixed in #420)

**Found by the new field, on its first run.** `observations` came back as **1,229 for stocks and
1,229 for crypto** — identical, in a run where stocks trade ~504 days over two years and crypto
trades ~730. Both numbers cannot be right, and 1,229 ≈ 504 + 730 is the giveaway.

The cause is one line of wiring in `run-stage2.ts`:

```ts
new ReplayDriver({
  barSource: ctx.store,
  timeline: ctx.store,   // <- the whole store, all six symbols
  universe: symbols.map((symbol) => ({ symbol, asset_class })),   // <- correctly per-class
  ...
})
```

`Stage2HistoricalStore.barTimestamps` is `SELECT DISTINCT close_time FROM stage2_bars` with no
symbol or asset-class filter, so it returns the union of **every ingested instrument's** close
times. The `universe` is correctly scoped per asset class, so only the right instruments are
*traded* — but the replay steps, and the return series is built over, the merged timeline. Stock
daily bars and crypto daily bars close at different UTC times, so the two sets barely overlap and
the union is close to their sum.

**What it distorts.** The return series for each class is padded with structural zeros on every bar
belonging to the other class:

- **Per-period Sharpe is understated.** Padding a series with zeros scales the mean by
  `n_old/n_new` and the standard deviation by roughly `sqrt(n_old/n_new)`, so the ratio scales by
  `sqrt(n_old/n_new)` — about **0.64× for stocks** and 0.78× for crypto.
- **The annualization base no longer matches the series.** `periodsPerYear` is 252 for stocks and
  365 for crypto, but the actual series runs at ~615 observations/year. The direction of the effect
  on the *annualized* Sharpe is not obvious, since the Lo (2002) factor also reads the sample's
  autocorrelation, and the padding changes that too.
- **DSR is flattered, not penalised.** A larger `sampleLen` both raises `sqrt(n−1)` and lowers the
  expected maximum of N Sharpes, so an overstated sample length pushes DSR **up**. The real DSR is
  lower than the 0.254 / 0.519 reported, which only strengthens the reject.
- **PBO is the least affected.** It is a rank statistic across configs, and every config in an
  asset class shares the same timeline, so the distortion is common-mode.

**Fixed, and the gate re-run.** `Stage2HistoricalStore.timelineFor(symbols)` returns a timeline
scoped to one asset class, and both scripts now build one per class. The corrected run is the
authoritative one, and the predicted scaling landed almost exactly:

| | before (#419) | after (#420) | predicted |
|---|---|---|---|
| stocks observations | 1,229 | **500** | ~504 |
| crypto observations | 1,229 | **729** | ~730 |
| stocks per-period Sharpe | 0.0295 | **0.0463** | ×1.56 → 0.0461 |
| crypto per-period Sharpe | 0.0488 | **0.0633** | ×1.28 → 0.0625 |
| OOS Sharpe pass count | 12 / 24 | **14 / 24** | up, stocks most |
| PBO (stocks / crypto) | 0.65 / 0.35 | **0.65 / 0.30** | barely moves |
| DSR (stocks / crypto) | 0.254 / 0.519 | **0.255 / 0.519** | barely moves |

**DSR being unmoved is not a coincidence, and is worth understanding.** The statistic depends on the
Sharpe and the sample length in the combination `SR·√n`. Zero-padding scaled the Sharpe by
`√(n_real/n_union)` while inflating `n` from `n_real` to `n_union` — the two effects are exact
inverses in that product, so DSR was very nearly invariant to the bug. That is why it moved by
0.0006 while the underlying Sharpe moved by 57%. A statistic can be robust to a defect and still be
computed from wrong inputs; the robustness is luck, not validation.

**PBO barely moved** for the reason predicted: it is a rank statistic across configs that all shared
the same timeline, so the distortion was common-mode. Crypto's 0.35 → 0.30 is one partition of 20
changing hands.

**What it does change is the OOS Sharpe count: 12 → 14 of 24**, with stocks going 6 → 8 since their
Sharpes were the more understated. That is the number the earlier write-ups quote, so
[08-…md](2026-08-05-stage2-verdict-first-real-run.md) and
[10-…md](2026-08-05-cost-model-calibration.md) both under-report it; neither has been re-run.

**Why the field earned its place.** This is precisely the P2/P12 pattern — a value nothing in the
output distinguished from a correct one. Two asset classes had been quietly reporting the same
sample length for as long as the report has existed, and the only reason it surfaced now is that
something finally printed the number. The test fixture had masked it perfectly: it returned
identical bars for all six symbols, so every close time coincided and the union was
indistinguishable from either class's own timeline.

## What PBO 0.65 means, in plain terms

Across the symmetric partitions of the six CSCV folds, the config that scored best on the training
half landed **at or below the median** on the held-out half in 65% of them for stocks. Above 0.5,
config selection is worse than a coin flip: picking the in-sample winner actively anti-predicts
out-of-sample rank. Crypto's 0.30 is better and still six times the kill line.

This is the concrete form of the risk P8 flagged in the abstract. Cost calibration took the grid
from 2 of 24 configs passing to 12, and the timeline fix took it to 14 — each step making "just pick
the best one" look more attractive. PBO is the measurement saying that picking the best one is
precisely what does not survive.

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

1. **Do not read 14 of 24 as a signal.** It is the same evidence as before, scored over the right
   timeline, and PBO now prices what selecting from it costs.
2. **Fix the trial budget anyway** (I1 / #405) — MinBTL is still exceeded, and a smaller grid also
   makes the PBO estimate less dependent on a large config set.
3. **Re-run this gate after any change to the grid or the cost model.** All four terms are
   computable now, so there is no longer a reason to report a partial verdict.
4. **Arm the Feedback Loop kill-lines** ([#384](../../issues/384), [#375](../../issues/375)) — they
   were blocked on exactly these two seams, and both are now unblocked.
5. **Done — #420.** Each asset class now has its own replay timeline and this gate has been re-run;
   the numbers above are the corrected ones. The Sharpe magnitudes in
   [08-…md](2026-08-05-stage2-verdict-first-real-run.md) and
   [10-…md](2026-08-05-cost-model-calibration.md) are still the pre-fix ones — understated, and
   not worth a re-run on their own, since both documents' conclusions were about cost attribution
   rather than about a Sharpe level.
