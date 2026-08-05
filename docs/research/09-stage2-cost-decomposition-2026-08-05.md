# Stage 2 Cost Decomposition — Gross vs Net (2026-08-05)

**Status:** Recorded 2026-08-05. Follows
[08-stage2-verdict-first-real-run-2026-08-05.md](08-stage2-verdict-first-real-run-2026-08-05.md),
whose "Turnover, not necessarily signal" section flagged this as an open question and recommended it
as the cheapest next decision. Commissioned by David on 2026-08-05: *"c and then a based on c
findings"* — decompose gross vs net first, then decide the Polygon-history question in light of it.

Raw run output: [stage2-cost-decomposition-2026-08-05.txt](stage2-cost-decomposition-2026-08-05.txt).
Runner: `src/scripts/run-stage2-cost-decomposition.ts`. Attribution: `src/cost-model-backtest/cost-attribution.ts`.

## Headline

> **The Stage 2 kill is a cost-model artifact, not a dead signal.**
>
> Net of `PESSIMISTIC_COST_CONFIG`, **2 of 24** (config, asset class) pairs clear the 0.5 OOS Sharpe
> kill line. Gross of the same modeled costs, **16 of 24** do — and **all 24 improve**, with 22 of 24
> gross out-of-sample Sharpes positive. Crypto moves from a range of −1.2 … −9.0 to +0.22 … +3.10.
>
> The cost fixture charges crypto **211bps per round trip** — an adverse price move of **0.45 ATR on
> every single fill**, against a strategy whose targets sit at 3–4 ATR.
>
> **This does not mean the strategy works.** It means the number that killed it is the cost model,
> and that cost model is a unit-test fixture, not a calibrated one. The Stage 2 gate still does not
> pass — see "What this does not license".

## Why the decomposition is exact

The replay's trade path does not depend on costs **at all**. `ReplayDriver` takes its entry from
`proxySignal(bars, config)`, its stop and target from that same signal, its exit from
`exitOf(lot, bar, signal)` — which reads only the bar's OHLC against those levels — and its size
from `capitalPerTrade / bar.close`. Every one is a pure function of bars and strategy config.
`CostModel.fill` is called only to *price* the two legs; nothing reads a fill price back into a
decision, so not even the √-law impact term can feed back through size.

So adding the modeled costs back reconstructs a genuinely frictionless run **exactly**, not
approximately. That claim is proved rather than argued: `cost-attribution.test.ts` replays one
config twice — once against `CostModelImpl`, once against a test-only zero-cost model — and asserts
the reconstruction matches the frictionless run trade-for-trade, with a falsification test that an
add-back omitting commission fails.

Both sides are scored by the **same** `EvalExecutorImpl` (same walk-forward boundaries, same 50-bar
embargo, same Lo annualization) and the gross OOS Sharpe is built by the same `killLineChecks` as
the net one, so it is comparable to the 0.5 line the gate is actually defined on.

## Finding 1 — every pair improves; the crypto reversal is total

| | net | gross |
|---|---|---|
| Pairs clearing the 0.5 OOS Sharpe line | **2 / 24** | **16 / 24** |
| Pairs with a positive OOS Sharpe | 2 / 24 | **22 / 24** |
| Crypto OOS Sharpe range | −1.21 … **−9.00** | **+0.22 … +3.10** |
| Stocks OOS Sharpe range | −1.56 … +0.77 | −0.03 … +1.32 |

Every one of the 12 crypto configs is negative net and positive gross. The worst pair in the
committed verdict (`fast=10 slow=30 stop=1.5 target=2`, crypto, OOS **−9.001**) is **+0.266** gross.

## Finding 2 — the cost fixture charges 0.45 ATR per fill on crypto

| asset class | cost per round trip | adverse move per fill |
|---|---|---|
| crypto | **210.9 bps** | **0.450 ATR** |
| stocks | 31.3 bps | 0.100 ATR |

This follows directly from the fixture. `MarketState.spread` is null on historical Polygon bars, so
the cost model's fallback fires: `spread = volatility × spreadVolatilityCoefficient`, halved to a
half-spread. With `spreadVolatilityCoefficient: 0.5` that is **0.25 ATR of half-spread**, plus
`slippageCoefficient: 0.2` — 0.45 ATR of adverse move on every fill, ~0.9 ATR round trip, against
targets of 3–4 ATR. The strategy is charged roughly a quarter of its own target as friction before
it starts.

Composition of the crypto cost (worst-case config, 146 trades): spread 33,013, slippage 26,411,
commission 2,915, market impact 54. **Spread and slippage are 95% of it** — commission is nearly
irrelevant, and the √-law impact term is negligible at this size. So this is entirely about the
ATR-coefficient spread/slippage model, not about fees.

For orientation against the venues actually in the plan (CLAUDE.md "Broker Plan"): Alpaca charges no
commission on US equities and SPY/QQQ/AAPL quote at roughly a basis point, so a realistic equity
round trip is low single-digit bps against the fixture's 31.3. Published base-tier taker fees at
Kraken / Coinbase Advanced put a realistic crypto round trip in the tens of bps against the
fixture's 211. **These are orientation figures from published schedules, not a calibration** — no
crypto venue or fee tier has been chosen yet (the same reason `venue-pacing.ts` declines to invent a
ccxt ceiling), so the real numbers must come from the chosen venue's schedule and from observed
quoted spreads, not from this document.

## Finding 3 — the sensitivity ladder

Each rung re-runs the full grid against the real cost model with every coefficient scaled, so the
reported rates are what the model actually charged (the structural 1bp floors bind at the bottom
rungs, which is why the fall is not proportional):

| cost scale | pairs passing | stocks | crypto |
|---|---|---|---|
| ×1 (committed verdict) | 2 / 24 | 31.3 bps | 210.9 bps |
| ×0.5 | 4 / 24 | 15.7 bps | 105.4 bps |
| ×0.25 | **11 / 24** | 7.8 bps | 52.7 bps |
| ×0.1 | 12 / 24 | 3.8 bps | 21.1 bps |
| ×0.05 | 14 / 24 | 2.7 bps | 11.0 bps |
| ×0 (gross) | 16 / 24 | — | — |

The grid's fate is decided between ×0.5 and ×0.25 — that is, the cost fixture is roughly **2–4×**
away from the level at which the verdict flips. Given the orientation figures above, plausible
venue-calibrated costs land at or below that threshold for both asset classes.

## Finding 4 — the Polygon cap is a paid plan limit, confirmed

The previous write-up hedged that the exact-2-year cutoff "may simply be on a lower tier than the
spec assumed, in which case this is an account setting, not a purchase". That is now resolved, by
direct probe. A 3-year-back aggregates request returns:

```
{"status":"NOT_AUTHORIZED","message":"Your plan doesn't include this data timeframe.
 Please upgrade your plan at https://polygon.io/pricing"}
```

while the same request inside 2 years returns data normally. So it is a hard entitlement, and
lifting it is a **purchase**, not a toggle. Correcting the earlier hedge.

## What this does not license

The gate still does not pass, and nothing here changes that:

1. **MinBTL gets WORSE, not better.** The sample supports 7 trials; the grid runs 12. Going from 2
   passing configs to 11–16 passing configs makes the "pick the best of the grid" selection effect
   *more* dangerous, not less. A larger set of survivors on an over-budget grid is precisely what
   MinBTL exists to flag.
2. **PBO and DSR are still structurally uncomputable** — 5 anchored walk-forward folds are not a
   CSCV partition, and `MetricsSuite` exposes no per-period Sharpe. Unchanged, and still blocking
   [#384](../../issues/384) and [#375](../../issues/375).
3. **Gross OOS Sharpe still exceeds in-sample Sharpe** for many pairs, the small-sample warning sign
   the previous write-up raised. A frictionless view does not repair it.
4. **A gross number is not a tradeable number.** Real costs are not zero. The finding is that the
   *modeled* costs are implausible, not that costs do not matter — at turnover of 115–556, this
   strategy is acutely cost-sensitive whatever the true rate is, which is itself a strategy-design
   finding worth keeping.

## Recommended sequencing (decision is David's)

The (a)/(c) ordering David set resolves cleanly, and it inverts the earlier recommendation:

1. **Calibrate the cost model before buying history.** It is free, it is the single largest lever on
   the verdict (2/24 → plausibly 11–14/24), and re-running a 12-config grid against a fixture that
   is 2–4× too pessimistic would waste whatever the history costs. `PESSIMISTIC_COST_CONFIG`'s own
   comment concedes it "mirrors `cost-model.test.ts`'s `PESSIMISTIC_CONFIG` fixture, the only
   asset-class cost values this repo has settled on so far" — it was never a calibration. The
   specific defect is the null-spread fallback `spread = volatility × coefficient`, which is what
   produces 0.25 ATR of half-spread; a real quoted-spread input, or a coefficient fit to observed
   spreads, replaces it.
2. **Then buy the history — it is still needed, for a different reason than before.** Not to rescue
   the Sharpes (calibration does that) but to make N=12 legitimate: 5 years raises the MinBTL cap
   from 7 toward ~45. With a calibrated cost model and 2 years of data the grid would show more
   survivors *and* remain over-budget, which is not a pass. The purchase buys statistical
   legitimacy, and is worth making only after step 1, so the re-run is scored against a defensible
   cost model.
3. **Cutting the grid to ≤ 7 configs remains the free alternative to step 2**, and is worth doing
   first if the upgrade is declined — it fits the sample the current plan serves.
4. **PBO / DSR seams** — unchanged, needed regardless, and still the blocker on arming any Feedback
   Loop kill-line.
