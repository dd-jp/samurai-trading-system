# Stage 2 verdict on ten years of free history — 2026-08-07

> **ARCHIVED — folded into [`13-stage2-proxy-verdict.md`](../13-stage2-proxy-verdict.md).** This is the terminal run: the numbers here are the ones doc 13 reports as final.

**Verdict: KILL/INCOMPLETE, and the sample-length explanation is now closed.**

[11-stage2-verdict-post-405-2026-08-06.md](2026-08-06-stage2-verdict-post-405.md) named sample length as "the one lever that would change this" and concluded that "buying deeper history is the single change that would make a re-run informative rather than a repeat". The history turned out to be free rather than purchasable, the run has now been done over **10.2 years instead of 1.99**, and **the verdict did not change**. The proxy strategy's failure was not an artifact of a short sample.

Written before the numbers were read, and stated here so a favourable result could not be reinterpreted after the fact: a KILL would mean the earlier verdict was not a sample-length artifact; a PASS would mean only that the moving-average-cross **proxy** survives selection accounting on a longer sample, and would say nothing about the Stage 0 hypothesis recorded in [14-stage0-edge-hypothesis-2026-08-07.md](../10-edge-hypothesis.md), which is a premium harvest and not this strategy.

## What changed mechanically

`run-stage2.ts` had exactly one aggregates source, `HttpPolygonClient`, whose free plan serves two years against a five-year request — the constraint behind every prior verdict. ADR-0001 had already demoted Polygon to fallback-only and designated Alpaca (equities) and Coinbase (crypto) as primary, and [#514](https://github.com/dd-jp/samurai-trading-system/issues/514) recorded that "Stage 2 still runs one `HttpPolygonClient`". `FreeStackAggregatesClient` closes that for the Stage 2 path.

Polygon remains the **default**. The free stack is opt-in via `STAGE2_SOURCE=free-stack`, so the prior verdict stays reproducible with no environment change.

## The sample

| | Polygon, 2026-08-06 | **Free stack, 2026-08-07** |
|---|---|---|
| Served window | 2024-08-07 .. 2026-08-05 (1.99y) | **2016-05-19 .. 2026-08-06 (10.2y)** |
| Stock observations | 499 | **2566** |
| Crypto observations | 728 | **3731** |
| Cost | $0 (2y ceiling) | **$0** |

Ingested coverage, measured from the scratch store after the run:

| Symbol | Bars | First | Last | Source |
|---|---|---|---|---|
| SPY / QQQ / AAPL / TSLA | 2662 each | 2016-01-05 | 2026-08-06 | Alpaca |
| BTC-USD | 3870 | 2016-01-02 | 2026-08-06 | Coinbase |
| ETH-USD | 3730 | 2016-05-19 | 2026-08-06 | Coinbase |

`effectiveWindow` narrows the requested range to the intersection every symbol covers, which lands on ETH's first bar — a measured property of the data, not a hardcoded date.

## Results

| Check | Polygon (1.99y) | **Free stack (10.2y)** | Line |
|---|---|---|---|
| MinBTL | limit 7, 7 configs, not exceeded | **limit 812, 12 configs, not exceeded** | — |
| PBO stocks | 0.85 | **0.35** | ≤ 0.05 |
| PBO crypto | 0.55 | **0.40** | ≤ 0.05 |
| DSR stocks | 0.356 | **0.153** | significant |
| DSR crypto | 0.395 | **0.805** | significant |
| OOS Sharpe kill-line | 9 of 14 pass | **3 of 24 pass** | > 0.5 |

**MinBTL stops being a constraint at all.** The cap moves from 7 configurations to **812**.

Read that carefully, because the config counts are easy to misread as a widened search. **The grid is fixed at 12 and always has been.** `sizeTrialGridToSample` (#405) *downsamples* it when the sample cannot support 12 — `if (requested <= limit) return { selected: entries }` returns the grid untouched otherwise. So the prior run's 7 was the 12-config grid thinned to what 1.99 years supported; this run's 12 is that same grid, unthinned. The search did not grow. The constraint stopped binding, and PBO/DSR are now computed over the whole designed grid rather than an evenly-sampled subset of it.

That is table stakes rather than a result — but it is the first time this project's Stage 2 has had headroom it is nowhere near spending.

**PBO improves substantially and still rejects.** Stocks more than halve, 0.85 to 0.35, but the line is 0.05 and 0.35 is seven times it. The selection still does not generalise.

**DSR splits.** Stocks fall to 0.153. Crypto rises to 0.805 — the closest any Stage 2 measurement has come to significance, on 3731 observations, and still short of the line.

**The OOS kill-line gets worse, and that is expected.** 9 of 14 became 3 of 24 (all three crypto). A two-year window covering one regime flattered a trend-shaped rule; ten years contains the regimes where a moving-average cross does not work. PBO improving while the OOS pass rate falls is not a contradiction — PBO measures whether in-sample ranking predicts out-of-sample ranking, not the level of either.

## Reading it

The honest summary: **on ten years of history the proxy strategy has no edge that survives being chosen, and now we know that is a property of the strategy rather than of the sample.**

That is a more useful KILL than the last one. Every prior verdict carried an open question — would this survive on a longer sample? — that could be used to defer the conclusion. It cannot be any more. Doc 11's "one lever" has been pulled, at zero cost, and the verdict is unchanged.

What it still does not gate: the paper soak, and the Stage 0 hypothesis. Stage 2 validates the *proxy* — a moving-average cross with ATR brackets that exists to exercise the cost model and the replay harness. It is not the LLM debate pipeline the soak measures, and it is not the premium harvest doc 14 records.

## The consequence worth acting on

The proxy has now been measured to destruction. The productive next step is not another run of it but **replacing it with the strategy actually intended for capital** — the vol-targeted diversified premium harvest of doc 14 — so that a Stage 2 verdict says something about the thing that would trade. The harness is now demonstrably capable of supporting that: 10 years of bars, 812 configurations of MinBTL headroom, PBO/DSR/CSCV all computing.

Two known gaps that a premium-harvest Stage 2 would have to close first: the universe is 6 symbols (2.58 effective bets, measured in doc 13) against the 12 the strategy needs, and the equity legs are hindsight-selected.

## Provenance of these numbers

The run was executed at commit `211f425`. Two follow-up commits touched the
client afterwards, and neither changes the series it returns:

- `7024072` — **imports and test stubs only**: routing `stage2-source.ts`
  through the `cost-model-backtest` barrel and replacing cast-based test
  fixtures with real `Response` objects.
- review fixes for [#598](https://github.com/dd-jp/samurai-trading-system/pull/598)
  — de-duplicating Alpaca bars by open time and sorting them, matching what
  the Coinbase leg already did.

The de-duplication is the one that could in principle move a number, so it was
checked rather than assumed: re-ingesting after it returns **SPY 2662 bars
(2016-01-04 → 2026-08-05)** and **ETH-USD 3730 (2016-05-18 → 2026-08-05)**,
strictly ascending — identical to the counts this verdict was computed on.
Alpaca does not in fact serve overlapping pages; the dedup is a guard, not a
correction.

Verified additionally by the full suite (2795 passing) and by re-checking
`resolveStage2Source` against the built output for both sources. The numbers
below are therefore reproducible at `HEAD`, not only at the commit that
produced them.

## Reproducing

```
# ten-year free stack (this run)
STAGE2_SOURCE=free-stack node --env-file=.env.local dist/scripts/run-stage2.js

# the prior two-year Polygon verdict, unchanged and still the default
node --env-file=.env.local dist/scripts/run-stage2.js
```
