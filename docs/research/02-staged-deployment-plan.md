# Staged Deployment Plan: From Idea to Live Capital

A practical, stage-gated process for taking a trading strategy from concept to (cautious) live deployment. Each stage has a clear exit condition — don't advance until you've met it.

---

## Stage 0 — Reset the mental model

**Goal:** Replace "run it 24/7" thinking with an expectancy-first mindset before writing any code.

- [ ] Write down, in one sentence, the *economic reason* your strategy should have an edge (behavioral inefficiency, risk premium, or structural/liquidity advantage). If you can't name it, you don't have a strategy — you have a curve fit.
- [ ] Accept the expectancy identity as your north star:
  ```
  E[trade] = (P_win × Avg_win) − (P_loss × Avg_loss) − Costs
  ```
- [ ] Decide up front what market/asset class, time horizon, and strategy family (momentum, mean-reversion, stat arb, market-making, carry, factor) you're targeting, and why that family's edge should apply to your market.

**Exit condition:** You can explain your strategy's expected edge to someone else in under a minute, without referencing "the bot runs all the time."

---

## Stage 1 — Build the measurement harness

**Goal:** Build honest infrastructure before touching strategy logic. This is the part most people skip, and it's where most self-deception happens.

- [ ] Implement realistic transaction-cost modeling: spread + commissions + a market-impact term that scales with √(order size / available liquidity). Use pessimistic assumptions, not best-case ones.
- [ ] Source point-in-time, survivorship-free data (don't test only on assets that still exist today).
- [ ] Build a metrics dashboard reporting, together, not in isolation: Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, and exposure.
- [ ] Audit for look-ahead bias like a security vulnerability — check every feature and signal for information that wouldn't have been available at decision time (lagged fields, no whole-dataset statistics used in preprocessing).

**Exit condition:** You can run any candidate strategy through the harness and get a full metrics report with realistic costs baked in — before you've tuned a single parameter.

---

## Stage 2 — Validate against overfitting

**Goal:** Prove the edge survives scrutiny designed to destroy false positives.

- [ ] Split data into strict in-sample / out-of-sample sets.
- [ ] Run walk-forward analysis (rolling re-optimization + subsequent out-of-sample test).
- [ ] If feasible, run Combinatorial Purged Cross-Validation (CPCV) to get a *distribution* of out-of-sample Sharpe ratios, not a single number.
- [ ] **Log every configuration you test** — parameter sets, feature variants, everything. This number is required for the next two checks.
- [ ] Compute the Deflated Sharpe Ratio (DSR) given your trial count.
- [ ] Compute (or estimate) the Probability of Backtest Overfitting (PBO). Reject if PBO > 0.05.
- [ ] Apply the Minimum Backtest Length (MinBTL) check: with N years of data, cap your independent trials accordingly (e.g., 5 years of data → no more than ~45 independent configurations before you should expect a spurious high in-sample Sharpe).

**Exit condition:** Out-of-sample / CPCV Sharpe is not meaningfully lower than in-sample; DSR is significant; PBO ≤ 0.05.

**Kill criteria:** Out-of-sample Sharpe < 0.5, PBO > 0.05, or DSR insignificant → rework the strategy or abandon it. Do not proceed to Stage 3.

---

## Stage 3 — Forward / paper trade

**Goal:** Test against reality, not history.

- [ ] Run the strategy live on paper for a meaningful window — aim for enough observations for statistical significance (roughly 2.7 years of daily data / ~681 points is a reasonable floor for confirming Sharpe ≈ 1 is genuinely > 0; shorter windows are noisier).
- [ ] Ensure the paper-trading window spans at least one volatility regime change, not just calm markets.
- [ ] Compare live fills to backtest cost assumptions. If real slippage/costs exceed your model, revise expectations downward before proceeding.
- [ ] Track live KPIs (Sharpe, drawdown, win rate, expectancy) against backtest expectations weekly. Investigate any material divergence before it compounds.

**Exit condition:** Paper Sharpe holds in the 1–2 range with controlled drawdown, and live fills roughly match modeled costs.

**Kill criteria:** Live/paper results diverge materially from backtest, or paper Sharpe falls below ~0.5 → back to Stage 2.

---

## Stage 4 — Deploy small, size conservatively, monitor continuously

**Goal:** Put real capital at risk only in amounts and under controls you can survive being wrong about.

- [ ] Start with capital you can genuinely afford to lose — this is not a formality, it's a risk control.
- [ ] Size positions using **half- or quarter-Kelly**, never full Kelly (full Kelly implies expected drawdowns of 50–80% and is unforgiving of overestimated edge). Use quarter-Kelly or less in fat-tailed markets (e.g., crypto).
- [ ] Set hard stop losses per trade/position.
- [ ] Implement circuit breakers: daily loss limits, volatility halts, latency/error triggers that pause trading automatically.
- [ ] Diversify across uncorrelated strategies rather than levering up a single one — this is the most reliable way to raise portfolio-level Sharpe.
- [ ] Re-run the Stage 2 validation checks periodically as new data accumulates (edges decay; what passed six months ago may not still hold).

**Ongoing monitoring — recompute monthly:**
- Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy
- Live vs. backtested cost assumptions
- Any structural change in the market that could invalidate the original economic rationale (Stage 0)

---

## Decision thresholds at a glance

| Signal | Action |
|---|---|
| Out-of-sample or paper Sharpe < 0.5 | Kill or rework |
| PBO > 0.05 | Kill or rework |
| Deflated Sharpe Ratio insignificant | Kill or rework |
| Live results diverge materially from backtest | Return to Stage 2/3 |
| Strongly negative-skewed, fat-tailed returns with no compensating premium | Kill or rework |
| Live/paper Sharpe 1–2, drawdown < ~20–25%, profit factor > 1.5, clear economic rationale | Proceed cautiously |
| Backtest Sharpe > 3 on a non-HFT strategy | Treat as a red flag, not a green light — investigate before trusting |
| Suspiciously smooth equity curve | Investigate before trusting |
| Any third party promising guaranteed returns | Do not deploy capital — this is a scam pattern, not a strategy |

---

*This plan assumes you are building and evaluating your own strategy. It is not investment advice. See `01-full-report-with-sources.md` for the underlying research and citations.*
