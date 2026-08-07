# Trend signal measured over 10 years of free history — 2026-08-07

**Verdict: the trend signal is not distinguishable from simply holding the same basket.** Over 10.0 years, the best pre-registered trend configuration beats an always-long control by 0.17 Sharpe with a paired t-statistic of **0.15**. That is nothing. The case for trend rests entirely on drawdown reduction, which is real in this sample but is a single-path statistic.

This supersedes the trend-following recommendation made in conversation on 2026-08-07, which assumed the literature's diversified-futures result would carry over to a 12-instrument spot basket. It does not carry over cleanly, and the control arm is why we know.

Companion script: [`trend-signal-measurement-2026-08-07.py`](trend-signal-measurement-2026-08-07.py). Dependency-free, re-runnable.

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

## Result 3 — where trend does earn its place

| | Trend (wide, 63d) | Control (wide) |
|---|---|---|
| Max drawdown, unlevered | **−10.7%** | −19.4% |
| Max drawdown, levered to 0.05%/day | **−24.8%** | −43.9% |
| Leverage multiple required | 2.46x | 2.58x |
| Gross exposure at that leverage | 1.48 | 1.55 |

This is the documented benefit of trend following — it cuts the left tail, it does not add return. At the leverage required to reach the accepted 0.05%/day target, that is the difference between a 25% drawdown and a 44% one. Caveat that matters: max drawdown is **one number from one path**, not a distribution. It cannot be significance-tested the way the return difference can, and it should not be treated as equally established.

**The leverage is a real constraint, not a footnote.** Gross 1.48 exceeds a cash account. Reg T margin covers the equity sleeve; Alpaca crypto is 1x, so the crypto leg cannot be levered at all.

## Result 4 — the current universe's flattering number is hindsight

`DEFAULT_UNIVERSE`'s control posts Sharpe 1.34, well above the wide basket's 0.60. Do not bank it. SPY, QQQ, AAPL, TSLA, BTC and ETH are six assets *selected in 2026 knowing they won* — that is textbook survivorship/selection bias, and it is precisely Stage 1's unticked box ("point-in-time, survivorship-free data"). A basket picked for having gone up will backtest as having gone up.

The measured diversification figures stand on their own and are not affected by this:

| Universe | Avg pairwise correlation | Effective bets |
|---|---|---|
| current (6) | 0.47 | 2.58 |
| wide (12) | 0.28 | 4.60 |

## Trial accounting

- **16 configurations**, pre-registered (4 lookbacks × 2 universes × 2 directions). No search, no tuning.
- **MinBTL for 16 trials: 3.2 years. Sample: 10.0 years.** First time in this project that the trial count sits comfortably inside the sample — the direct payoff of the free-stack history.
- **DSR on the best config: 0.989** — but the best config is the hindsight-contaminated basket, so read this as "the arithmetic finally has room to work," not as edge confirmed.
- **PBO not computed.** It needs combinatorial purged splits, which belong in `src/cost-model-backtest/`, not in a standalone script. **This is not a Stage 2 pass and must not be cited as one.**

## Disclosures

- The wide ETF set was chosen for low measured correlation **on the same sample it is then tested on**. Mild contamination of the universe choice; the correlation figures themselves are descriptive and unaffected.
- Instruments have different start dates; the panel starts at the latest common date (2016-05-18) so composition is constant throughout.
- All instruments in both universes exist today. Broad-index ETFs rarely delist, but this is still not a survivorship-free universe construction.
- Equity spread is modelled as a flat per-side cost, not per-instrument. The sensitivity grid (2/5/10bp) exists because the thin diversifiers — DBC, VNQ, XLE, EEM — are wider than SPY. Results are stable across the grid: the wide 63d config moves 0.77 → 0.72 from 2bp to 10bp.

## What this means for Samurai

1. **Trend as implemented does not justify its complexity on return.** Its case is left-tail reduction at leverage, which is a genuine reason to run it but a narrower one than "it is the best-documented strategy."
2. **The control is the benchmark to beat, not SPY.** Any future claim — trend, LLM debate, anything — has to clear always-long-the-same-basket. Nothing has yet.
3. **The veto-only debate design becomes more valuable, not less.** It is the cheapest way to get a measured answer on whether the LLM layer adds anything, against a control that is now defined and computed.
4. **0.05%/day needs ~2.5x leverage on this basket** and brings a 25–44% drawdown. The target is reachable but not at the risk level the unlevered numbers imply.
5. **Stage 1's survivorship box is not cosmetic.** It changes the headline Sharpe by a factor of two in this very measurement.

## Reproducing

```
# equities (Alpaca, free, 2016+) — one file per symbol into <data_dir>
curl -H "APCA-API-KEY-ID: $ALPACA_API_KEY" -H "APCA-API-SECRET-KEY: $ALPACA_API_SECRET" \
  "https://data.alpaca.markets/v2/stocks/bars?symbols=SPY&timeframe=1Day&start=2016-01-01&limit=10000&sort=asc"

# crypto (Coinbase, free, 300 candles/request — needs a paging loop)
curl "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=...&end=..."

python3 docs/research/trend-signal-measurement-2026-08-07.py <data_dir>
```
