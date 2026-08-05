# Stage 2 Verdict — First Real Run Against Live Market Data (2026-08-05)

**Status:** Recorded 2026-08-05. Issue [#245](../../issues/245) ("Stage 2: overfitting verdict +
write-up"), Verdict module of [stage2-validation-execution-spec.md](../specs/stage2-validation-execution-spec.md),
wayfinder map [#154](../../issues/154).

Supersedes the input-availability half of
[06-stage2-overfitting-verdict.md](06-stage2-overfitting-verdict.md) (2026-07-29), which reported
"no verdict — the inputs do not exist yet". They exist now. The two structural gaps that document
identified are **unchanged and still block PBO and DSR**.

Raw run output: [stage2-run-2026-08-05.txt](stage2-run-2026-08-05.txt).

> **Followed up 2026-08-05 by
> [09-stage2-cost-decomposition-2026-08-05.md](09-stage2-cost-decomposition-2026-08-05.md).** The
> "Turnover, not necessarily signal" question below is now answered: gross of modeled costs, 16 of
> 24 pairs clear the kill line instead of 2, and all 24 improve. The kill is dominated by the cost
> fixture. Two claims in this document are corrected there — the hedge in Finding 1 that the 2-year
> cap "may be an account setting, not a purchase" (it is a paid plan limit, confirmed by probe), and
> the recommendation ordering (calibrate the cost model *before* buying history).

## Headline verdict

> **Stage 2 gate: NOT PASSED — `KILL/INCOMPLETE`.**
>
> This is no longer a "no verdict" result. The grid ran against real Polygon market data for the
> first time in this repo's history. **22 of 24 (config, asset class) pairs have a NEGATIVE
> out-of-sample Sharpe**, and MinBTL reports `exceeded: true` — the 12-config grid is more trials
> than the available sample can support. PBO and DSR remain not computable.

Do not read anything below as a green light for Stage 3, and see "Sequencing conflict" — the paper
soak ([#238](../../issues/238)) is queued behind this gate by David's decision of 2026-08-05.

## What actually ran

`node dist/scripts/run-stage2.js` with `POLYGON_API_KEY` from `.env.local` — the script #266 built
and, per its own header, had never executed against live Polygon traffic because the environment it
was written in had no network.

- Ingested: SPY, QQQ, AAPL, TSLA (501 daily bars each), BTC-USD, ETH-USD (730 each).
- 12-config grid × 2 asset classes = 24 evaluations, 5 walk-forward folds each (120 fold Sharpes).
- Verdict rendered by `renderStage2Verdict()`, unchanged.

## Finding 1 — the sample is 2 years, not 5

The spec's window, the MinBTL headroom argument, and `defaultFiveYearWindow()` all assume **5
years**. This Polygon key returns **2**: the earliest bar for a 2021-08-06 request is
**2024-08-06**, for both stocks and crypto.

**Check the tier before paying to fix this.** A cutoff at exactly two years back from today, on
both asset classes, is the shape of an entitlement cap rather than a data gap — and the spec's
5-year assumption cites Polygon's Stocks Starter tier, which documents 5 years. So the key may
simply be on a lower tier than the spec assumed, in which case this is an account setting, not a
purchase. Verified only as far as the observed response: 501 stock bars, 730 crypto bars, earliest
2024-08-06.

The first run did not report this — it aborted inside the first fold with
`toReturnSeries: no bars in the sample`, four layers below the cause. `runStage2` now intersects
per-symbol coverage into an **effective window**, warns loudly when it is narrower than requested,
and runs replay, folds and MinBTL on the window the data actually supports. A symbol with no bars
at all is now a hard, named failure rather than a silent narrowing.

This matters beyond ergonomics: **MinBTL's trial cap is a function of sample length.** Computing it
over a window the data does not cover would overstate how many configs the sample can support —
precisely the overfitting the number exists to prevent.

## Finding 2 — MinBTL is exceeded

```
n_distinct_trials=12 exceeded=true {"limit":7,"distinct_configs":12,"exceeded":true}
```

Over the real 2-year sample the limit is **7 trials**; the grid ran **12**. The earlier analysis
predicted "12 trials against a 45-trial ceiling, leaving headroom" — that ceiling assumed 5 years.
On 2 years, the grid is over budget by 5 trials, so its best result is by construction more likely
to be a selection artifact.

Acceptance criterion 3 anticipated exactly this ("or explains why not, if the real sample computes
a tighter limit"). This is that explanation: the cap is tighter because the sample is shorter, and
the grid was not resized to match.

## Finding 3 — out-of-sample performance is negative almost everywhere

Kill line (`02-staged-deployment-plan.md`): out-of-sample Sharpe < 0.5 → kill/rework.

| | pairs | result |
|---|---|---|
| Passing the OOS Sharpe line | **2 of 24** | both stocks, both marginal |
| Failing | **22 of 24** | all crypto pairs; 10 of 12 stock pairs |

The two that pass, both stocks:

| config | OOS Sharpe | in-sample (window) Sharpe |
|---|---|---|
| `fastWindow=10 slowWindow=30 atrStopMult=3 atrTargetMult=4` | 0.774 | 0.218 |
| `fastWindow=20 slowWindow=30 atrStopMult=3 atrTargetMult=4` | 0.536 | 0.324 |

Crypto is not marginal — it is decisively negative, ranging to **-9.00** OOS Sharpe. Every one of
the 12 crypto configs fails.

Two cautions against reading the passing pair as a result:

1. **MinBTL says the grid is over budget** (Finding 2). Picking the best 2 of 24 from a grid the
   sample cannot support is the selection effect MinBTL is designed to flag.
2. **OOS Sharpe exceeds in-sample Sharpe in both cases.** A strategy that does better out of sample
   than in it is more often a small-sample artifact than a discovery.

### Turnover, not necessarily signal

Worth separating before anyone concludes "the strategy does not work". Across the 24 evaluations,
**turnover runs 115 to 556** and **exposure 0.87 to 0.95** — a near-permanently-invested,
very-high-churn configuration — while **no config's profit factor exceeds 1.14**. The costs
applied are `PESSIMISTIC_COST_CONFIG`, the deliberately harsh fixture (spread, commission,
slippage and impact all set high), and the sample window (2024-08 to 2026-08) is one in which the
four equity names generally rose.

A gross edge that thin, churned that hard, under costs that pessimistic, is consistent with **cost
drag** rather than with a signal that has no information in it. That is a different diagnosis from
"the strategy is dead", and it points at a different fix: turnover and cost assumptions before
strategy replacement. Neither reading is established here — the run does not decompose gross vs
net — but the verdict should not be read as having ruled the signal out.

## Finding 4 — PBO and DSR are still not computable (unchanged from 2026-07-29)

Both are structural, both survive the arrival of real data, and both block
[#384](../../issues/384) from ever arming three of the four Feedback Loop kill-lines:

- **PBO** — `pbo()` needs an even fold count ≥ 4 and a symmetric CSCV partition. The spec's
  walk-forward split produces **5 anchored, growing-train folds**. Not an off-by-one: anchored
  walk-forward is not a CSCV partition at all. Resolving it means changing the trial design or
  adding a second, CSCV-shaped partitioning pass.
- **DSR** — `deflatedSharpe()` needs the non-annualized per-period Sharpe. `MetricsSuite.sharpe` is
  Lo (2002)-adjusted **annualized** Sharpe, and neither the raw return series nor the Lo
  annualization factor is exposed, so it cannot be inverted. Needs a new seam on
  `MetricsSuite`/`EvalReport`.

## What this says, and does not say

**Says:** the mechanical trend/ATR config grid that Stage 2 is defined over does not survive
contact with two years of real market data, and the sample is too short to support a 12-trial
search in the first place.

**Does not say:** that the LLM debate pipeline fails. Stage 2 evaluates the cost-model backtest's
config grid — [ADR-0001](../adr/0001-technical-foundation-hybrid.md) is explicit that the backtest
substrate cannot host the live LLM debate. What the gate does establish is that the *baseline*
this system is meant to beat is not itself profitable on this sample, and that
`backtest_reference_sharpe` ([#375](../../issues/375)) has no positive value to freeze — the
divergence kill-line's baseline would be a negative number for 22 of 24 configs.

## Sequencing conflict (#245's fifth acceptance criterion)

Stated explicitly, as the ticket requires: **the production composition root work (ADR-0004,
map #224, tickets #234–#238) has proceeded to a working paper pipeline without a passing Stage 2
gate.** As of 2026-08-05 the orchestrator boots, transacts end to end (`yarn smoke` GATE: PASS) and
runs against live Alpaca paper.

The conflict is currently resolved in the gate's favour: David decided on 2026-08-05 to land the
full Stage 2 chain **before** starting the 14-day soak (#238), rather than run them in parallel.
This verdict is the first output of that decision, and it is a kill.

## Recommended next decisions (not taken here)

1. **Sample depth — check the tier first.** Five years of history raises the MinBTL cap from 7
   toward ~45 and makes the 12-config grid legitimate. Confirm what tier this key is on before
   treating that as a purchase.
2. **Grid size.** Alternatively, cut the grid to ≤ 7 distinct configs so it fits the sample the
   key currently serves.
3. **Costs and turnover before strategy replacement.** 22 of 24 negative is not a tuning result,
   but turnover of 115–556 at ~0.9 exposure under `PESSIMISTIC_COST_CONFIG` is not obviously a
   dead signal either (see "Turnover, not necessarily signal"). A gross-vs-net decomposition
   distinguishes the two, and is cheaper than a rework.
4. **PBO / DSR seams.** Needed regardless, and needed before #384 can arm the kill-lines or #375
   can freeze a reference Sharpe.
