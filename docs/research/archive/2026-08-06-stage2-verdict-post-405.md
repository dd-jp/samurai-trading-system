# Stage 2 verdict — re-run after #405/#375, 2026-08-06

> **ARCHIVED — superseded by [`13-stage2-proxy-verdict.md`](../13-stage2-proxy-verdict.md),** which pulls this doc's one remaining lever (sample length) and finds the verdict unchanged.

**Verdict: KILL/INCOMPLETE.** The proxy strategy does not survive selection accounting on the sample the data provider actually serves.

This is the run [#245](https://github.com/dd-jp/samurai-trading-system/issues/245) was waiting on, executed against live Polygon on the merged `main` (through #459). It supersedes [08-stage2-verdict-first-real-run-2026-08-05.md](2026-08-05-stage2-verdict-first-real-run.md) and [10-cost-model-calibration-2026-08-05.md](2026-08-05-cost-model-calibration.md)'s open question about what the calibrated costs would produce.

## What changed since the last run

Three fixes landed between the runs, and each moved the verdict's basis rather than its direction:

- **#405 — the grid is now sized from the sample before it runs.** Every earlier run reported `{"limit":7,"distinct_configs":12,"exceeded":true}`: 12 configs searched over a sample supporting 7, graded afterwards. This run reports `{"limit":7,"distinct_configs":7,"exceeded":false}`. **MinBTL is no longer a binding kill-line** — the search was constrained to what the sample supports instead of being marked over-budget after the fact.
- **#420 — each asset class is scored over its own bars.** Stocks 499 observations, crypto 728. Previously both were scored over the union, so every reported Sharpe magnitude in runs before #424 is distorted.
- **#375/#384 — the selection is frozen to a store**, so the divergence and revalidation kill-lines are evaluable rather than structurally unreachable.

## The sample

| | |
|---|---|
| Requested window | 2021-08-06 → 2026-08-05 (5 years) |
| **Served** | **2024-08-07 → 2026-08-05 (1.99 years)** |
| Stocks bars | 500 each (SPY, QQQ, AAPL, TSLA) |
| Crypto bars | 729 each (BTC-USD, ETH-USD) |

The observation counts below are one lower than the bar counts — 499 and 728 — because the first bar of a series is consumed producing the first return, so N bars yield N-1 returns. Not a typo and not a dropped bar.
| Cost model | `CALIBRATED_COST_CONFIG` (measured spreads, #403) |

The Polygon plan still serves two years against a five-year request. The run says so explicitly and computes MinBTL on the served window, so the tighter trial cap is a real constraint of the sample rather than a spec change.

## Results

**Kill-line (OOS Sharpe): 9 of 14 pass** — stocks 5/7, crypto 4/7.

That is the strongest this line has ever looked, and it is also the least meaningful of the four, because it says nothing about how many configurations were tried to find those nine.

**PBO — REJECT, both classes.** Kill line is `PBO > 0.05`.

| Asset class | PBO | Verdict |
|---|---|---|
| stocks | **0.85** | reject |
| crypto | **0.55** | reject |

**DSR — fails, both classes.**

| Asset class | Selected config | Per-period Sharpe | Observations | DSR |
|---|---|---|---|---|
| stocks | `09adb837…` | 0.0463 | 499 | **0.356** |
| crypto | `b3465871…` | 0.0418 | 728 | **0.395** |

**MinBTL — passes, and that is the news.** `limit=7, distinct_configs=7, exceeded=false`.

## Reading it

The verdict did not change, but *why* it fails did, and that matters for what to do next.

Before #405, Stage 2 could be dismissed as failing on a technicality: 12 configs against a cap of 7 is an over-budget search, and the obvious response is "search less." That has now been done — the grid is sized to the sample — and the strategy still fails, on two independent selection-accounting measures.

A PBO of 0.85 for stocks says that the configuration which looked best in-sample was, across the combinatorial splits, more often than not *below median* out-of-sample. That is the signature of selecting noise. DSR agrees from the other direction: at ~0.04 per-period Sharpe over 499 observations, deflating for 7 trials leaves nothing that clears the line.

**The honest summary: on the two years of history available, this proxy strategy has no demonstrable edge that survives being chosen.**

## What this does and does not gate

It does **not** gate the paper soak, and deliberately so. Stage 2 validates the *proxy* strategy — a moving-average cross with ATR brackets — which exists to exercise the cost model and the replay harness. It is **not** the LLM debate pipeline the soak measures, and no backtest can host that pipeline (ADR-0001: pybroker "cannot host live LLM debate"). A KILL here says the proxy has no edge; it says nothing about the multi-agent system, whose whole premise is that it is not a moving-average cross.

What it does gate is any claim that the *mechanical* layer has demonstrated edge. It has not, and the soak should be read with that in mind: a profitable soak is evidence about the debate pipeline, not confirmation of anything Stage 2 measured.

## The one lever that would change this

Sample length. MinBTL, PBO and DSR are all functions of it, and two years is thin for a 7-config search. The window is bounded by the Polygon plan, not by the code — the runner already asks for five years and reports what it gets. Buying deeper history is the single change that would make a re-run informative rather than a repeat.

Everything else is now correct: costs are calibrated to measured spreads, the grid is sized to the sample, each class is scored over its own bars, and the selection is frozen for downstream revalidation.

## Reproducing

```
node --env-file=.env.local dist/scripts/run-stage2.js
```

Window pinned by `STAGE2_PINNED_WINDOW`, so this is reproducible to the millisecond rather than shifting with `new Date()`.
