# Algorithmic Trading Strategy Evaluation: An Analyst-Grade Guide

## TL;DR

- **A bot running 24/7 has no bearing on profitability. Uptime is a delivery mechanism, not a source of edge.** Continuous trading without a genuine, measurable statistical edge simply converts more of your capital into transaction costs (fees, bid-ask spread, slippage, market impact) faster — a bot that trades more often loses money *faster* if its per-trade expectancy is negative. Frequency amplifies whatever edge (or anti-edge) already exists; it never creates one.
- **Real edges are scarce, economically explainable, and decay.** The documented sources of return (momentum, mean-reversion, statistical arbitrage, market-making, carry, factor premia) each work for a specific behavioral or risk-based reason, and each weakens through crowding, arbitrage, and regime change — McLean & Pontiff (2016) found published stock-return predictors are 26% lower out-of-sample and 58% lower post-publication. Legitimate systematic strategies realistically target Sharpe ratios of roughly 1–2 in live trading, not the 3+ often seen in over-optimized backtests.
- **The hard part is telling real edge from luck or hidden risk.** With enough backtest trials you can manufacture any Sharpe ratio you want from pure noise (Bailey & López de Prado). Serious evaluation demands out-of-sample/walk-forward testing, correction for multiple testing (deflated Sharpe ratio, probability of backtest overfitting), realistic cost modeling, awareness of negative-skew "pick up pennies in front of a steamroller" payoffs, and disciplined position sizing (fractional Kelly, not full Kelly).

---

## Key Findings

1. **Uptime ≠ profit.** A trading strategy's expected return per trade is `(win rate × average win) − (loss rate × average loss) − costs`. If that number is not reliably positive *after* costs, running the bot more often (24/7) just realizes the negative expectancy more times. Each round trip pays the bid-ask spread, commissions, slippage, and — at size — market impact. Overtrading is one of the most reliable ways to destroy an otherwise break-even edge.

2. **Costs are structural and non-linear.** The bid-ask spread is the "price of immediacy" (Demsetz); market impact grows roughly with the square root of order size relative to available liquidity, so scaling up erodes edge super-linearly. For S&P 500 stocks, Ernie Chan estimates average transaction cost around 5 basis points excluding commissions; in crypto, API latency, funding rates, and widening spreads during volatility compound the drag.

3. **Edges exist but are explainable and perishable.** Momentum (buy recent winners) earned about one percent per month with a t-statistic of 3.07 in the original Jegadeesh–Titman (1993) study and persists across 40+ countries and 200+ years of data — but suffers rare, violent "momentum crashes." Mean-reversion/pairs trading works when a spread is genuinely cointegrated, but the classic Gatev–Goetzmann–Rouwenhorst pairs returns declined substantially after 2002 due to competition. Carry harvests interest-rate differentials but is compensation for crash risk. Market-making earns the spread but bears adverse-selection risk.

4. **Metrics describe, they don't predict — and they can be gamed.** Sharpe ratio is the workhorse, but Andrew Lo (2002) showed that annualizing a monthly Sharpe by √12 can overstate a hedge fund's annual Sharpe by as much as 65 percent when returns are serially correlated. Goetzmann et al. showed Sharpe can be deliberately manipulated with option-like payoffs. Sortino, Calmar, max drawdown, profit factor, and expectancy each capture a different facet; no single number is sufficient.

5. **Backtest overfitting is the central danger.** Bailey and López de Prado proved that with only N=10 independent strategy configurations tried, you should expect to find an in-sample Sharpe near 1.5–1.6 even when the true out-of-sample Sharpe is exactly zero. Their "Minimum Backtest Length" rule shows that with just five years of data, no more than 45 independent model configurations should be tried, or you are almost guaranteed to produce strategies with a strong in-sample Sharpe but an expected out-of-sample Sharpe of zero. Worse, when returns have memory, overfit strategies don't just fail to outperform — they systematically underperform out of sample.

6. **Practitioners are skeptical by default.** Legitimate quant funds look for Sharpe > 2 in research (and some won't consider < 3), but retail-achievable live Sharpe > 2 is "doing very well." A Sharpe that is too high (>3–4) for a low-frequency strategy is a red flag for leverage, hidden tail risk, or data manipulation. Guaranteed returns, blocked withdrawals, crypto-only payments, and unverifiable track records are hallmarks of scam bots.

---

## 1. Why 24/7 Uptime Does Not Equal Profit

The intuition "if a bot runs all the time, it should make money" conflates *availability* with *edge*. These are orthogonal. A market participant makes money only if it systematically buys below and sells above fair value by more than its costs, or is compensated for bearing a risk others avoid. Continuous operation does neither; it merely lets you act on your signal whenever it fires.

**The expectancy identity.** Every strategy's long-run profit is governed by expectancy per trade:

```
E[trade] = (P_win × Avg_win) − (P_loss × Avg_loss) − Costs_per_trade
```

Total profit ≈ `E[trade] × number_of_trades`. If `E[trade]` is positive, more trades increase profit *and* reduce the variance of the outcome (law of large numbers works for you). If `E[trade]` is zero or negative, more trades drive you toward ruin faster and with more certainty.

**Where the costs come from:**

- **Commissions/fees:** Explicit per-trade charges. In crypto, taker fees and perpetual-swap funding rates recur constantly.
- **Bid-ask spread:** You buy at the ask and sell at the bid; the round-trip spread is a guaranteed cost paid to liquidity providers — the "price of immediacy" (Demsetz).
- **Slippage:** The difference between expected and actual fill price, from latency and price movement between signal and execution. Crypto API latency is typically 100–200ms.
- **Market impact:** Your own order moves the price against you, growing roughly with the square root of order size relative to available volume — a structural capacity limit.

**Overtrading as edge erosion.** Because each trade pays these costs, increasing trade frequency without a proportionally strong signal steadily bleeds capital. The market does not offer an unlimited supply of high-probability opportunities; forcing trades to keep a bot "busy" means taking progressively worse setups whose expectancy is negative after costs.

**Empirical reality check.** Catastrophic software/operational risk is also real: per the SEC's 2013 order, in roughly 45 minutes on August 1, 2012, Knight Capital's malfunctioning order router sent more than 4 million orders (397 million shares across 154 stocks) while attempting to fill just 212 customer orders, resulting in a realized pre-tax loss of approximately $440 million. A bot amplifies whatever strategy it runs — including a losing one, and including a bug.

## 2. What Actually Drives Returns / Sources of Edge

An "edge" is a repeatable reason your expected return exceeds costs — from compensation for bearing a risk others shun, or from exploiting a behavioral/structural inefficiency. Both decay: risk premia shrink as capital floods in (crowding), and inefficiencies get arbitraged away once known. McLean & Pontiff ("Does Academic Research Destroy Stock Return Predictability?", *Journal of Finance* 71(1), 2016) studied 97 published cross-sectional stock-return predictors and found portfolio returns are 26% lower out-of-sample and 58% lower post-publication — investors learn from research and trade the anomaly away.

**Momentum / trend-following.** Buy recent winners, sell recent losers (cross-sectional), or go long assets in uptrends (time-series). *Rationale:* behavioral underreaction to news and delayed overreaction; momentum has no clean risk explanation (its CAPM beta is roughly zero/negative). *Evidence:* Jegadeesh & Titman (1993), using CRSP data from January 1965 to December 1989, found the six-month relative-strength strategy earned abnormal returns of about one percent per month with a t-statistic of 3.07 (a compounded ~12% per year), robust across 40+ countries and 200+ years of data. *Why it fails:* rare but devastating "momentum crashes" when beaten-down losers rebound violently (e.g., 2009); the return distribution is negatively skewed.

**Mean-reversion.** Bet that prices/spreads revert to a mean. *Rationale:* liquidity provision and overreaction correction. *Why it fails:* high win rate but negative skew — works until a regime break turns "temporary" dislocation into a permanent trend. Prone to crowding: many funds holding the same reversion signal become a systemic risk (the August 2007 "quant quake").

**Statistical arbitrage / pairs trading.** Trade the spread between cointegrated instruments. *Why it fails:* the classic Gatev-Goetzmann-Rouwenhorst method's returns declined substantially after 2002 from quant competition. The biggest live-vs-backtest failure is data-mining for cointegration: with 35 FX pairs there are 595 candidate combinations, and at p<0.05 roughly 30 will test as "cointegrated" by pure chance.

**Market-making / liquidity provision.** Post bids and offers, earn the spread and rebates. *The core constraint (Treynor):* the market maker's gains from liquidity-motivated transactors must exceed losses to information-motivated transactions. *Why it fails:* adverse selection — informed traders pick off your quotes; requires low-latency infrastructure most retail traders lack.

**Carry.** Hold high-yielding assets funded by low-yielding ones. *Rationale:* systematic violation of uncovered interest parity — compensation for crash risk, not arbitrage. Brunnermeier-Nagel-Pedersen showed carry returns are negatively skewed and crash when funding liquidity dries up. This is the canonical "picking up nickels in front of a steamroller."

**Factor-based strategies.** Systematic tilts toward value, size, quality, low-volatility, etc. *Why they fail:* the "factor zoo" problem — Harvey, Liu & Zhu ("…and the Cross-Section of Expected Returns," *Review of Financial Studies* 29(1), 2016) catalogued 316 published factors and argued a genuinely new factor needs a t-statistic greater than 3.0, not the traditional 2.0.

## 3. Evaluation Metrics — The Analyst Toolkit

**Sharpe ratio** = (annualized return − risk-free rate) / annualized volatility. *Good values:* S&P 500 long-term ≈ 0.5–0.7; a good hedge fund 1–2; excellent >2. *Limitations:*
- **Annualization error:** Lo (2002) proved you cannot annualize a monthly Sharpe by √12 unless returns are IID; with serial correlation, annual Sharpe can be overstated by more than 65%.
- **Non-normality:** treats upside and downside volatility identically, ignoring skew/kurtosis.
- **Gaming:** Goetzmann, Ingersoll, Spiegel & Welch showed Sharpe can be manipulated with option-like strategies, importing hidden tail risk.
- **Estimation noise:** short samples produce wildly unreliable estimates.

**Sortino ratio** = excess return / downside deviation only. Better for asymmetric strategies since it doesn't penalize upside volatility.

**Calmar ratio** = annualized return / |maximum drawdown| (typically over 36 months). Target >1.0; elite systems exceed 2.0.

**Maximum drawdown** = worst peak-to-trough decline. Arguably the single most important risk number, since it represents the maximum pain point where investors capitulate.

**CAGR / annualized return:** meaningful only alongside the risk taken to earn it.

**Win rate vs. payoff ratio / expectancy:** Win rate alone is meaningless. A 90%-win strategy with occasional catastrophic losses has negative expectancy (the steamroller profile).

**Profit factor** = gross profit / gross loss. >1 is profitable; ~1.5–1.8 is a credible, robust system.

**Exposure / time-in-market and turnover:** high turnover magnifies transaction-cost sensitivity, requiring a larger gross edge to survive costs.

**A realistic "credible system" fingerprint** (multi-year sample): Sharpe ~1.5, max drawdown ~20%, win rate ~50%, profit factor ~1.8, Calmar ~1.2 — with losing months and drawdowns, not a smooth equity curve.

## 4. Distinguishing Real Edge from Luck or Hidden Risk

**Overfitting / curve-fitting.** Bailey, Borwein, López de Prado & Zhu ("Pseudo-Mathematics and Financial Charlatanism," *Notices of the AMS* 61(5), 2014) proved this is nearly unavoidable: any persistent researcher can find a backtest with a desired Sharpe ratio regardless of sample length. With N=10 independent configurations tried on data with zero true edge, you should expect a spuriously high best in-sample Sharpe.

**Minimum Backtest Length (MinBTL).** Their practical rule: if only 5 years of data are available, no more than 45 independent model configurations should be tried, or you are almost guaranteed to produce strategies with a strong in-sample Sharpe but zero expected out-of-sample Sharpe. Report how many configurations you tried — a Sharpe with no trial count is uninterpretable.

**Overfit strategies actively underperform.** When returns have memory (serial correlation, present in most hedge fund strategies), overfitting produces a *negative*-edge strategy, not just a zero-edge one — the model is so fit to past noise it is unfit for future signal.

**In-sample vs. out-of-sample; walk-forward; cross-validation.**
- **Walk-forward analysis** (Pardo): repeatedly optimize on a rolling in-sample window and test on the subsequent out-of-sample window. The "gold standard," but tests only a single historical path.
- **Combinatorial Purged Cross-Validation (CPCV)** (López de Prado, 2018): generates many train/test paths, purges overlapping observations, and adds an embargo to prevent leakage, yielding a *distribution* of out-of-sample Sharpe ratios.

**Multiple-testing / backtest-overfitting metrics:**
- **Deflated Sharpe Ratio (DSR)** (Bailey & López de Prado, 2014): corrects Sharpe for the number of trials tried, non-normal returns, and sample length.
- **Probability of Backtest Overfitting (PBO):** the probability the strategy selected as best in-sample will underperform the median strategy out-of-sample. Authors suggest rejecting strategies with PBO > 0.05. In their overfit random-walk example, the selected strategy showed a PBO of 74%.
- **Harvey-Liu haircut:** the correct multiple-testing haircut on Sharpe is non-linear (marginal Sharpes penalized far more than high ones).

**Named biases to eliminate:**
- **Look-ahead bias:** using data not available at decision time.
- **Survivorship bias:** testing only on assets that still exist today, ignoring delisted/bankrupt names. Fix with point-in-time, survivorship-free data.
- **Data-snooping bias:** re-using the same test set to refine a strategy until it passes.

**Negative skew / tail risk.** Nassim Taleb's warning: many strategies exhibit a "Taleb distribution" — high probability of small gains, small probability of catastrophic loss. Short-volatility and option-selling strategies posted steady annualized returns for years, then drew down over 50% in 2008. A high Sharpe with negative skew is often *more* dangerous than a lower Sharpe with positive skew.

## 5. Practical Due-Diligence Advice from Quants

**Set realistic return/Sharpe expectations.** Legitimate systematic strategies live at Sharpe ~1–2 in real trading over multi-year horizons. As a retail algorithmic trader, achieving Sharpe > 2 live is doing very well.

**Treat a too-good Sharpe as a warning.** A Sharpe above 3–4 for anything but genuine high-frequency trading suggests excessive leverage, hidden tail risk, or manipulated/overfit data.

**Require statistical significance, not just a pretty curve.** Rule of thumb: confidence that the true Sharpe > 0 needs a backtest Sharpe of ~1 over roughly 2.7 years of daily data (~681 points).

**Beware selection bias in track records.** Among many simulated equity curves over a short window, the best will show an impressive Sharpe by luck alone — time-stamp "day zero" and evaluate forward.

**Live paper trading is mandatory.** Backtest → paper trade → small live capital → scale, across different volatility regimes.

**Respect capacity constraints.** Because market impact grows with the square root of size, every edge has a capacity ceiling. A strategy that works at $50k may be dead at $50M.

**Risk management:**
- **Position sizing / Kelly criterion:** full Kelly is almost universally considered too aggressive — it implies expected drawdowns of 50–80%. Practitioners use half- or quarter-Kelly. Fat-tailed markets (crypto) warrant quarter-Kelly or less.
- **Stop losses** contain per-trade loss; pair with cooldown periods to avoid "revenge trading."
- **Circuit breakers:** daily loss limits, volatility halts, latency triggers.
- **Diversification across uncorrelated strategies** is the most reliable way to raise portfolio Sharpe.

**Red flags of scam bots:**
- Promises of "guaranteed returns" or fixed daily percentages.
- Blocked or delayed withdrawals while deposits flow freely.
- Crypto-only or wire-only payment demands.
- No verifiable team, registration, or third-party-audited track record.
- Vague "proprietary AI" claims with no methodology ("AI-washing").
- Attractive ads → social proof → fake interface → withdrawal problems → platform vanishes.

## Caveats

- **Metrics are descriptive, not predictive.** Every number here summarizes the past; regime change can invalidate any of them overnight.
- **"Good value" thresholds are conventions, not laws** — they vary by asset class, frequency, and strategy type.
- **Much online "bot profitability" content is marketing.** Vendor/education sites have a commercial interest in optimism; academic and named-practitioner sources were weighted more heavily.
- **This is educational analysis, not investment advice.** It does not account for jurisdiction-specific tax/regulatory rules, and past performance — backtested or live — does not guarantee future results.
- **The frontier is contested**, including whether ML approaches durably beat classical statistical methods, and whether factor premia are risk vs. mispricing.

---

## Sources

**Academic / primary research**

- McLean, R. David and Pontiff, Jeffrey (2016). "Does Academic Research Destroy Stock Return Predictability?" *Journal of Finance* 71(1), 5–32. https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12365
- Jegadeesh, Narasimhan and Titman, Sheridan (1993). "Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency." *Journal of Finance* 48(1), 65–91. (Replication/summary: https://www.researchgate.net/profile/Narasimhan-Jegadeesh/publication/287013063)
- Lo, Andrew W. (2002). "The Statistics of Sharpe Ratios." *Financial Analysts Journal* 58(4), 36–52. https://rpc.cfainstitute.org/research/financial-analysts-journal/2002/the-statistics-of-sharpe-ratios
- Goetzmann, William, Ingersoll, Jonathan, Spiegel, Matthew, and Welch, Ivo (2002). "Sharpening Sharpe Ratios." NBER Working Paper 9116. https://www.nber.org/papers/w9116
- Bailey, David H., Borwein, Jonathan M., López de Prado, Marcos, and Zhu, Qiji Jim (2014). "Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance." *Notices of the AMS* 61(5), 458–471. https://www.davidhbailey.com/dhbpapers/backtest-pseudo.pdf
- Bailey, David H. and López de Prado, Marcos (2014). "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality." *Journal of Portfolio Management* 40(5), 94–107.
- Bailey, David H., Borwein, Jonathan M., López de Prado, Marcos, and Zhu, Qiji Jim. "The Probability of Backtest Overfitting." *Journal of Computational Finance* 20(4). https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf
- Harvey, Campbell R., Liu, Yan, and Zhu, Heqing (2016). "…and the Cross-Section of Expected Returns." *Review of Financial Studies* 29(1), 5–68. https://academic.oup.com/rfs/article/29/1/5/1843824
- Harvey, Campbell R. and Liu, Yan (2015). "Backtesting." https://people.duke.edu/~charvey/Research/Published_Papers/P120_Backtesting.PDF
- Brunnermeier, Markus K., Nagel, Stefan, and Pedersen, Lasse H. "Carry Trades and Currency Crashes." https://www.fmg.ac.uk/sites/default/files/2020-08/M-Brunnermeier.pdf
- Elton, Edwin J., Gruber, Martin J., and Blake, Christopher R. (1996). "Survivorship Bias and Mutual Fund Performance." *Review of Financial Studies* 9(4).

**Regulatory / documented case studies**

- U.S. Securities and Exchange Commission (2013). "SEC Charges Knight Capital With Violations of Market Access Rule." Order details reproduced via: https://en.wikipedia.org/wiki/Knight_Capital_Group and PRMIA case study: https://prmia.org/common/Uploaded%20files/eAI/PRMIA%20Case%20study%20-%20Knight%20Trading.pdf

**Practitioner / industry commentary** *(useful for rules of thumb and current market color; weighted less heavily than peer-reviewed sources above)*

- Chan, Ernest P. *Quantitative Trading* and *Algorithmic Trading* (Wiley). Blog: http://epchan.blogspot.com/2015/04/beware-of-low-frequency-data.html and https://epchan.com/img/links/Backtesting-and-its-Pitfalls.pdf
- QuantStart, "Sharpe Ratio for Algorithmic Trading Performance Measurement." https://www.quantstart.com/articles/Sharpe-Ratio-for-Algorithmic-Trading-Performance-Measurement/
- Various vendor/education sources on Sortino, Calmar, profit factor conventions and crypto-bot scam patterns (QuantifiedStrategies.com, Gunbot FAQ, ScamWatch) — used for practitioner-level color, not as authoritative statistics.
