# Algorithmic Trading Strategy Evaluation — Summary

*Condensed from the full research report. See `01-full-report-with-sources.md` for details and citations, and `02-staged-deployment-plan.md` for the action plan.*

## 1. Uptime ≠ profit

Running a bot 24/7 doesn't create returns — it just multiplies whatever expectancy already exists. If

```
E[trade] = (win rate × avg win) − (loss rate × avg loss) − costs
```

is negative, trading more often just loses money faster through fees, spread, slippage, and market impact. Frequency amplifies the sign of your edge; it never creates one.

## 2. Real edges are specific and explainable — and they decay

- **Momentum** (buy recent winners): ~1%/month, robust across 40+ countries and 200+ years of data, but suffers rare, violent crashes when beaten-down stocks rebound.
- **Mean-reversion / stat arb:** works on genuinely cointegrated pairs, but returns have shrunk since 2002 from competition; easy to fake with data-mined "cointegration" (595 candidate pairs from just 35 FX instruments, ~30 will look "cointegrated" by pure chance).
- **Market-making:** earns the spread but bears adverse-selection risk against informed traders.
- **Carry:** compensation for crash risk — the classic "picking up nickels in front of a steamroller."
- **Factor investing:** the "factor zoo" problem — of 316 published factors, most are likely false discoveries; a credible new one needs a t-stat above 3, not the traditional 2.
- Published edges fade an average of **26% out-of-sample and 58% after publication** as others learn about them and arbitrage them away.

## 3. Metrics describe the past — they don't predict, and they can be gamed

- **Sharpe ratio** is the standard, but annualizing it incorrectly (ignoring serial correlation) can overstate it by **up to 65%**, and it can be manipulated with option-like payoffs that hide tail risk.
- **Sortino, Calmar, max drawdown, win rate, profit factor, expectancy** each show a different angle — no single number is sufficient.
- A credible live system typically looks like: Sharpe ~1.5, max drawdown ~20%, win rate ~50%, profit factor ~1.8, Calmar ~1.2 — not the inflated numbers backtests often produce.

## 4. Backtest overfitting is the central danger

With enough trials, you can manufacture any Sharpe ratio from pure noise. With only 5 years of data, testing more than ~45 independent configurations all but guarantees finding a strategy with a great backtest and a worthless (or actively *negative*) live result. Real evaluation requires:

- Out-of-sample / walk-forward testing (ideally Combinatorial Purged Cross-Validation)
- Correction for how many configurations you tried (Deflated Sharpe Ratio, Probability of Backtest Overfitting)
- Awareness of look-ahead bias, survivorship bias, and data-snooping

## 5. Practitioner reality check

- Legitimate systematic strategies realistically run **Sharpe ~1–2** in live trading. Anything above 3–4 for a non-high-frequency strategy is a red flag for leverage, hidden tail risk, or overfitting — not a win.
- Size positions with **fractional (half or quarter) Kelly**, never full Kelly — full Kelly implies expected drawdowns of 50–80%.
- **Paper-trade before going live**, across at least one volatility regime change.
- Guaranteed returns, blocked withdrawals, crypto-only payment demands, and vague "proprietary AI" claims are the classic signature of a scam bot, not a strategy.

## Kill / proceed thresholds

| Signal | Action |
|---|---|
| Out-of-sample or paper Sharpe < 0.5, PBO > 0.05, deflated Sharpe insignificant | **Kill or rework** |
| Live/paper Sharpe 1–2, drawdown < ~20–25%, profit factor > 1.5, clear economic rationale | **Proceed cautiously** |
| Backtest Sharpe > 3 on a non-HFT strategy, suspiciously smooth equity curve, guaranteed-return promises | **Be suspicious, not excited** |
