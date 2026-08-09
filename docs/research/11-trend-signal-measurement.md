# Trend signal measured over 10 years of free history — 2026-08-07

**Verdict: on unlevered return the trend signal is not distinguishable from simply holding the same basket** — the best pre-registered configuration beats an always-long control by 0.17 Sharpe over 10.0 years, paired t-statistic **0.15**. That is nothing.

**But the target changes the question.** 0.05%/day is unreachable unlevered on this basket, and under leverage the arms separate sharply: trend reaches 12.6%/yr, and always-long **cannot reach it at any leverage** — it plateaus near 8.7% while its drawdown deepens past −79%. Trend's value here is leverage efficiency and left-tail control, not return generation.

This supersedes the trend-following recommendation made in conversation on 2026-08-07, which assumed the literature's diversified-futures result would carry over to a 12-instrument spot basket. It does not carry over cleanly, and the control arm is why we know.

Companion script: [`11-trend-signal-measurement.py`](11-trend-signal-measurement.py). Dependency-free, re-runnable.

## What was tested

| | |
|---|---|
| Signal | Time-series momentum: long if trailing return > 0, sized inverse-volatility |
| Lookbacks | 21 / 63 / 126 / 252 trading days — **pre-registered** from the literature, not searched |
| Sizing | 10% annualized vol target per instrument, then portfolio-level vol targeting off the strategy's own trailing 60d vol |
| Rebalance | Monthly, executed at the next close (`EXECUTION_LAG = 1`) — no same-bar information |
| Costs | Crypto 25bp/side (Alpaca taker); equities 2 / 5 / 10bp/side sensitivity, commission-free |
| Leverage | Gross capped at 1.0 (cash account) for the headline runs |
| Sample | 2016-05-18 .. 2026-08-07, 2570 bars, bounded by ETH's first Coinbase candle |
| Universes | **wide** (SPY IWM EFA EEM TLT IEF GLD DBC VNQ XLE BTC ETH) and **current** `DEFAULT_UNIVERSE` |
| Crypto direction | Long/flat only in every arm — Alpaca spot cannot short |

**The control arm is the point.** `always-long` runs the identical basket, identical inverse-vol sizing, identical vol target, identical monthly rebalance, identical costs — and ignores the signal. It isolates trend from diversification. Without it, any trend portfolio would appear to beat SPY purely for holding bonds and gold at a lower vol target.

## Result 1 — trend does not beat the control on return

At 2bp equity cost, best config per universe against its own control:

| Universe | Best trend | Sharpe | Control Sharpe | ΔSharpe | SE | **t(paired diff)** |
|---|---|---|---|---|---|---|
| wide | 63d long-only | 0.77 | 0.60 | +0.17 | 0.36 | **0.15** |
| current | 21d long-only | 1.27 | 1.34 | −0.07 | 0.43 | **−1.07** |

No lookback, in either universe, at any cost level, produces a return advantage that survives being compared against holding the same basket. In the current universe the control wins outright.

## Result 2 — everything is front-loaded

Sharpe by sample half (~5 years each):

| Config | 1st half | 2nd half |
|---|---|---|
| wide / trend 63d | 1.35 | **0.24** |
| wide / always-long | 0.80 | **0.41** |
| current / trend 21d | 2.14 | **0.42** |
| current / always-long | 2.03 | **0.65** |

Every arm degrades by roughly half or worse. This is not a trend-specific failure — the whole opportunity set was better in 2016–2021 than in 2021–2026. With a Sharpe standard error of ~0.45 over five years the halves are not statistically distinguishable from each other, but the direction is uniform and it should temper any figure quoted from the full sample.

## Result 3 — where trend does earn its place: under leverage

Unlevered, trend's benefit is a smaller left tail: **max drawdown −10.7% versus the control's −19.4%**, for the same return.

That matters more than it first appears, because 0.05%/day (12.6%/yr) is not reachable on this basket unlevered — both arms return 4–5%. So the target forces leverage, and leverage is where the two arms separate. Paths below are **generated at leverage** (the backtest re-run at each volatility target), not produced by scaling a return stream, and are charged 6% annual financing on gross exposure above 1.0:

| wide basket, levered | Return | Vol | Sharpe | Max DD | Gross |
|---|---|---|---|---|---|
| Trend 63d @ 176% vol target | **12.6%** | 27.4% | 0.46 | **−45.5%** | 2.44 |
| Control @ 64% vol target | 7.8% | 21.1% | 0.37 | −50.5% | 2.26 |
| Control @ 150% vol target | 9.0% | — | 0.28 | −69.8% | 3.45 |
| Control @ 250% vol target | 8.5% | — | 0.21 | −79.4% | 4.27 |

**The control cannot reach 12.6%/yr at any leverage.** It plateaus around 8.7–9.0% while the drawdown deepens to −79% — financing consumes the added exposure faster than return accrues. Trend reaches the target; always-long does not. That is a real and specific advantage, and it appears exactly at the risk level David's accepted number requires.

Caveats that belong next to those figures:
- Max drawdown is **one number from one path**, not a distribution. It cannot be significance-tested the way the return difference can.
- **−45% is the honest price of 0.05%/day on this basket.** Not −25%; that earlier figure came from post-multiplying a return stream, which is the linear approximation and understates a levered path.
- Gross 2.44 exceeds a cash account and most of Reg T. Alpaca crypto is 1x, so the crypto sleeve cannot be levered at all — the equity sleeve would have to carry more than 2.44 for the portfolio to average it. **On the accounts actually available, this configuration is not executable as specified.**

## Result 4 — the current universe's flattering number is hindsight

`DEFAULT_UNIVERSE`'s control posts Sharpe 1.34, well above the wide basket's 0.60, and reaches 12.6%/yr at gross 0.46 with only a −14.4% drawdown. Do not bank it. SPY, QQQ, AAPL, TSLA, BTC and ETH are six assets *chosen in 2026 knowing they won* — **selection bias**, distinct from survivorship bias (which concerns assets that died and were dropped; broad ETFs rarely delist, so that box is comparatively clean here). A basket picked for having gone up will backtest as having gone up.

This is the single largest effect in the measurement: universe choice moves the headline Sharpe by more than a factor of two, dwarfing every signal decision tested.

The measured diversification figures stand on their own and are not affected by this:

| Universe | Avg pairwise correlation | Effective bets |
|---|---|---|
| current (6) | 0.47 | 2.58 |
| wide (12) | 0.28 | 4.60 |

## Result 5 — under an *executable* gross cap, trend dominates the control

The comparisons above ran either at gross cap 1.0 (unlevered headline) or uncapped (levered). Neither is what would actually be deployed. Re-run with a **gross cap of 1.5** — reachable with Reg T on the equity sleeve while Alpaca crypto stays 1x — and 6% financing:

| vol target | Trend 63d | | | Control | | |
|---|---|---|---|---|---|---|
| | ret | Sharpe | maxDD | ret | Sharpe | maxDD |
| 20% | 6.87% | 0.73 | −15.6% | 5.77% | 0.50 | −26.1% |
| 30% | 7.12% | 0.64 | −20.6% | 5.91% | 0.44 | −32.9% |
| 50% | 8.07% | 0.62 | −22.7% | 5.99% | 0.42 | −32.9% |
| **80%** | **10.20%** | **0.71** | **−23.2%** | 6.18% | 0.41 | −34.0% |

Trend wins on **both** return and drawdown at every setting, which it did not do uncapped. The mechanism is visible in the gross figures: trend goes flat in bad regimes and averages 1.22 gross at the 80% target, while the control must hold everything always, pins against the cap at 1.44, and absorbs the full drawdown.

**Best executable configuration found: 10.20%/yr = 0.040%/day, Sharpe 0.71, max drawdown −23.2%, average gross 1.22.**

**Caveat, and it is not small.** The vol-target and gross-cap settings in this section were explored *after* seeing the pre-registered results. They are **not** part of the 16-trial accounting below and are exposed to exactly the selection problem this report warns about elsewhere. They indicate where to look; they are not validated. Re-running them under PBO in `server/tools/backtest/` is required before any of these numbers is treated as an expectation.

Note also that the −10.7% unlevered drawdown in Result 3 depends on the gross cap of 1.0 binding during the vol-targeter's over-levering episodes. Uncapped at the same vol target the figure is −24.6%. The cap is doing real risk work and is part of the strategy, not a formality.

## Result 6 — profit-taking ladders are risk-neutral, not free money

Tested on the best executable configuration (wide, trend 63d, gross cap 1.5, 80% vol target): trim to 50% of target size once an instrument is X above its entry, to 25% at Y. The ladder persists until the position goes flat, so the monthly rebalance cannot silently restore full size.

| Ladder | Return | Daily | Sharpe | Max DD |
|---|---|---|---|---|
| **none** | **10.20%** | 0.040% | **0.71** | −23.2% |
| +10% / +20% | 5.61% | 0.022% | 0.50 | −18.0% |
| +20% / +40% | 7.14% | 0.028% | 0.57 | −19.5% |
| +30% / +60% | 8.34% | 0.033% | 0.64 | −19.7% |
| +10% only | 7.03% | 0.028% | 0.60 | −19.8% |
| +25% only | 8.19% | 0.033% | 0.63 | −20.5% |

At matched settings **every ladder cuts return and Sharpe**, and the tighter the ladder the worse: trimming at +10% nearly halves the return. The reason is structural — a trend-following return stream is carried by its right tail, and a profit ladder is a rule that systematically truncates exactly the positions that pay for all the others.

Drawdown does improve, by 3–5 points. So the fair test is at **matched risk**: re-lever the laddered variants until their drawdown matches the −23.2% baseline.

| At matched risk | vol target | Return | Sharpe | Max DD |
|---|---|---|---|---|
| none | 80% | 10.20% | 0.71 | −23.2% |
| +30% / +60% | 300% (search boundary) | 11.78% | 0.78 | −20.8% |
| +20% / +40% | 300% (search boundary) | 9.90% | 0.69 | −20.4% |

The laddered variants cannot be levered back to the baseline's risk within the gross cap — they saturate. At saturation the differences (0.78 and 0.69 against 0.71) sit well inside the ~0.36 Sharpe standard error for this sample.

**Conclusion: a profit ladder neither creates nor destroys edge.** It moves position along the same risk/return line, giving up return roughly in proportion to the risk it removes. Adopt it for behavioural reasons if it makes the plan easier to stick to — that benefit is real and this measurement says it is close to free. Do not adopt it expecting more money.

**Two practical notes.**
- **Monthly rebalancing already does a better version of this.** Selling what has grown and buying what has lagged is systematic profit-taking, triggered by *risk contribution* rather than by an arbitrary gain threshold. It is already in the strategy and it does not truncate the tail.
- **A ladder lands on the buggiest path in the codebase.** Partial exits are the subject of the open exit-path defects — #525 (partial flatten leaves a naked residual), #526 (in-memory sweep map), #519 (nothing sweeps `flatten_submissions`), #527 (over-filled flatten drops quantity silently). A profit ladder multiplies the number of partial exits, so it should not ship before those close.

These ladder settings are exploratory and post-hoc, like Result 5 — outside the trial accounting below.

## Trial accounting

- **16 configurations**, pre-registered (4 lookbacks × 2 universes × 2 directions). No search, no tuning.
- **MinBTL for 16 trials: 3.2 years. Sample: 10.0 years.** First time in this project that the trial count sits comfortably inside the sample — the direct payoff of the free-stack history.
- **DSR on the best config: 0.989** — but the best config is the hindsight-contaminated basket, so read this as "the arithmetic finally has room to work," not as edge confirmed.
- **PBO not computed.** It needs combinatorial purged splits, which belong in `server/tools/backtest/`, not in a standalone script. **This is not a Stage 2 pass and must not be cited as one.**

## Disclosures

- The wide ETF set was chosen for low measured correlation **on the same sample it is then tested on**. Mild contamination of the universe choice; the correlation figures themselves are descriptive and unaffected.
- Instruments have different start dates; the panel starts at the latest common date (2016-05-18) so composition is constant throughout.
- All instruments in both universes exist today. Broad-index ETFs rarely delist, but this is still not a survivorship-free universe construction.
- Equity spread is modelled as a flat per-side cost, not per-instrument. The sensitivity grid (2/5/10bp) exists because the thin diversifiers — DBC, VNQ, XLE, EEM — are wider than SPY. Results are stable across the grid: the wide 63d config moves 0.77 → 0.72 from 2bp to 10bp.

## What this means for Samurai

1. **Trend as implemented does not justify itself on unlevered return** — t = 0.15 against the control. Its case is leverage efficiency: it reaches the target return where always-long cannot, with a shallower left tail at every exposure level.
2. **The control is the benchmark to beat, not SPY.** Any future claim — trend, LLM debate, anything — has to clear always-long-the-same-basket at the same vol target. Nothing has yet.
3. **The veto-only debate design becomes more valuable, not less.** It is the cheapest way to get a measured answer on whether the LLM layer adds anything, against a control that is now defined and computed.
4. **0.05%/day costs a ~45% drawdown and gross 2.44 on the wide basket** — and gross 2.44 is not executable on the available accounts, since Alpaca crypto is 1x. The target is reachable in arithmetic, not on these venues, in this configuration.
5. **Universe selection dominates signal selection.** Choice of basket moved the headline Sharpe by more than 2x; no lookback or direction choice moved it by more than 0.2. If effort is going anywhere, it goes there — and the hindsight problem in the current universe is Stage 1's unticked data box, not a cosmetic concern.

## Reproducing

```
# equities (Alpaca, free, 2016+) — one file per symbol into <data_dir>
curl -H "APCA-API-KEY-ID: $ALPACA_API_KEY" -H "APCA-API-SECRET-KEY: $ALPACA_API_SECRET" \
  "https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=1Day&start=2016-01-01&limit=10000&sort=asc"

# crypto (Coinbase, free, 300 candles/request — needs a paging loop)
curl "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=...&end=..."

python3 docs/research/11-trend-signal-measurement.py <data_dir>
```
