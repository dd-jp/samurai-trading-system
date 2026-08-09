# Stock Selection: Manipulation Guardrails

**Date:** 2026-08-02
**Status:** Research complete. Feeds future Stage 0 wayfinder map.
**Author:** Hermes (Phantom) for Samurai project
**Source conversation:** Share volatility thread — individual-caused stock crashes (Sarao, Left, Musk, Trump Coin)

---

## Purpose

When Samurai moves beyond MVP (fixed universe: SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) to autonomous stock selection, it needs a **Universe Selector (Stage 0)** that filters candidates before Analysts spend compute on them. This document codifies manipulation-vulnerability guardrails drawn from documented cases of single-individual stock crashes.

These rules must be machine-checkable via data APIs. No LLM judgment calls.

---

## Threat Model: Four Manipulation Archetypes

Samurai must defend against four documented patterns where a single person moved an asset 10%+.

| Archetype | Real case | Mechanism | Samurai defense |
|---|---|---|---|
| **Spoofing** | Navinder Sarao, 2010 Flash Crash | Fake order book tricks HFT algos into selling, real order executes at artificial low | Avoid thin-order-book assets |
| **Short-and-distort** | Andrew Left, convicted 2026 | False report tanks stock, short position profits | Avoid assets followed by activist short sellers |
| **Celebrity pump** | Elon Musk "funding secured" 2018, Twitter 2022 | False/harmful tweet moves stock 11-40% | Avoid cult-CEO assets; peril-score adjusts sizing |
| **Insider asset launch** | Donald Trump $TRUMP coin, Jan 2025 | Creator launches token, holds 80% supply, promotes, sells into pump. 988,905 wallets lost $3.81B | Hard-reject tokens with majority insider supply + pending unlocks |

---

## Rules — Universal Pre-Buy Checklist

### Hard Reject (disqualified immediately, no scoring)

| Rule | Check method |
|---|---|
| "Not an investment" in ToS/disclaimer | String match against token/project documentation |
| ToS bans class-action lawsuits | String match |
| Creator/insiders hold >80% supply with pending unlock | On-chain data for tokens; SEC filings for stocks |
| No utility — pure memecoin with zero function | Requires one manual flag per token; rare |

### Scored Rules

Each rule maps to a numerical score. Negative = more vulnerable. Positive = more resilient.

#### Negative signals (vulnerability)

| Rule | Score | Data source |
|---|---|---|
| Market cap < $5B | -2 | Yahoo Finance, Alpha Vantage |
| Free float < $1B | -2 | SEC filings, exchange data |
| Insider ownership > 50% | -2 | SEC Form 4, EDGAR |
| Short interest > 20% of float | -2 | Exchange short-interest reports, FINRA |
| Retail ownership > 60% | -1 | SEC 13F (institutional), derive retail as remainder |
| Cult-CEO with proven tweet-to-price history | -2 | Requires curated list + volatility correlation check |
| Narrative-driven valuation (not P/E or DCF anchored) | -1 | Requires analyst classification; P/E=N/A or >100 = flag |
| Single-product or pre-revenue (revenue < $100M) | -1 | SEC filings, Yahoo Finance |
| Actively followed by known short-seller activists | -1 | Curated list: Hindenburg, Citron, Muddy Waters, Grizzly, Spruce Point |
| Thin order book (avg spread > 1% or daily volume < $10M) | -2 | Exchange data, L2 order book |
| High options gamma exposure (gamma/vega squeeze risk) | -1 | Options chain analysis |
| Meme stock / high social sentiment ratio | -1 | Social sentiment APIs (StockTwits, Reddit) |
| No earnings (pre-profit) | -1 | SEC filings |

#### Positive signals (resilience)

| Rule | Score | Data source |
|---|---|---|
| Institutional ownership > 70% | +1 | SEC 13F filings |
| Diversified revenue (3+ business segments) | +1 | SEC 10-K, company filings |
| Consistent earnings growth (5-year CAGR > 10%) | +2 | Financial data APIs |
| Market cap > $50B | +2 | Yahoo Finance, Alpha Vantage |
| Beta < 0.8 (low market sensitivity) | +1 | Calculated from historical prices |
| Dividend-paying (signals cash flow discipline) | +1 | Dividend history data |

---

## Scoring Model

```
PERIL_SCORE = MAX(-10, SUM(all scored rules))

Final classification:
  score >= +3   → PERIL=LOW     (full Kelly, normal stops)
  score -2..+2  → PERIL=MEDIUM  (0.75x Kelly, 1.25x stop)
  score -5..-3  → PERIL=HIGH    (0.50x Kelly, 1.50x stop)
  score <= -6   → PERIL=REJECT  (does not enter pipeline)
```

Rejected assets never reach Analysts. No LLM tokens spent.

---

## Samurai Pipeline Integration

### MVP (current — no change)

```
FIXED UNIVERSE: SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD
```

### Post-MVP (with Stage 0)

```
CANDIDATE UNIVERSE  →  STAGE 0: UNIVERSE SELECTOR  →  APPROVED LIST  →  Stage 1-6 pipeline
  (S&P 500, Nas,          ↑                                   ↓
   crypto top-100)    Rules applied                    Peril scores attached
```

### Peril scores flow through all stages

| Stage | Use of peril score |
|---|---|
| **Stage 0** | Gate: score assets, reject those <= -6 |
| **Stage 1: Analysts** | High-peril assets get deeper sentiment/manipulation scrutiny |
| **Stage 2: Debate** | Peril feeds into bull/bear framing. Bear agent explicitly considers manipulation risk |
| **Stage 3: Trader** | Kelly multiplier and ATR stop width scaled by peril |
| **Stage 4: Risk** | Peril determines max position size ceiling |
| **Stage 5: Verdict** | High-peril assets require stronger debate consensus to pass |
| **Stage 6: Feedback Loop** | Losses tagged by peril + external-event classification. If drop was Musk tweet or short report, flag as EXOGENOUS. Do not adjust strategy parameters. |

---

## MVP Universe — Retroactive Classification

Applying rules to current fixed universe for reference:

| Asset | Peril score | Classification | Notable flags |
|---|---|---|---|
| SPY | +5 | LOW | Broad index, no single-stock risk |
| QQQ | +4 | LOW | Broad index |
| AAPL | +7 | LOW | Megacap, diversified, institutional, dividend |
| TSLA | -3 | HIGH | Cult-CEO, meme stock, high gamma, narrative-driven |
| BTC-USD | -2 | MEDIUM | Whale risk, no intrinsic floor, exchange manipulation |
| ETH-USD | -1 | MEDIUM | Similar to BTC, slightly less concentrated |

**Finding:** TSLA is the only MVP asset flagged HIGH. Samurai's current mechanical Trader (fractional-Kelly) already handles position sizing, but TSLA-specific peril awareness should feed into the Debate Engine even during MVP phase.

---

## Implementation Notes (for future wayfinder map)

### Data APIs needed

- Market cap, float, revenue, P/E: Yahoo Finance, Alpha Vantage, Polygon.io
- Insider ownership: SEC EDGAR (Form 4, open data)
- Short interest: FINRA, exchange reports (bi-monthly, lag acceptable)
- Institutional ownership: SEC 13F (quarterly, lag acceptable)
- Options gamma: Exchange options chain APIs
- Social sentiment: StockTwits API, Reddit API
- On-chain token data: Solscan, Etherscan (for crypto universe)
- Curated lists: known short-seller activists, known cult-CEOs (manual maintenance)

### Scoring engine design

- Runs daily or weekly as cron
- Output: JSON with asset, scores per rule, final peril classification
- Cached per run. Analysts read from cache.
- Manual override possible via admin flag (e.g., "trade this despite HIGH — operator accepts risk")

### Peril score backtest

Before going live with peril-adjusted sizing, backtest:
1. Run historical data through scoring model
2. Compare Sharpe/max-drawdown of filtered (REJECT excluded) vs unfiltered universe
3. Compare HIGH-peril assets sized at 0.5x Kelly vs 1.0x Kelly

### Graduation path

1. MVP: no Stage 0. Fixed universe only.
2. Build scoring engine as standalone service. Run against S&P 500 as dry-run.
3. Verify peril scores match intuition (AAPL HIGH → bug; TSLA MEDIUM → bug).
4. Add Stage 0 to pipeline as gate. Only LOW/MEDIUM assets pass initially.
5. Open HIGH assets with reduced sizing once confidence builds.
6. Full autonomous universe scanning.

---

## References

- Sarao / 2010 Flash Crash: CFTC Release 7156-15, DOJ plea (Nov 2016)
- Andrew Left conviction: DOJ Press Release 26-578 (June 2, 2026)
- Musk "funding secured": SEC settlement Sept 2018, $40M fine
- Musk Twitter manipulation: Jury liability finding (2026)
- $TRUMP coin: Wikipedia, NYT July 2026 ($3.81B losses, 988,905 wallets)
- MIT Sloan circuit breaker "magnet effect" research (Chen, 2024)

---

## Confidence

| Claim | Confidence |
|---|---|
| Four manipulation archetypes cover documented single-person crash cases | High — primary source citations for all four |
| Rules are machine-checkable via data APIs | Medium-High — most have API sources; curated lists need manual maintenance |
| Peril scoring model produces correct classification for MVP universe | Medium-High — TSLA/AAPL classification directionally correct; weights may need tuning |
| Peril-adjusted Kelly improves risk-adjusted returns | Medium — logical but unbacktested; needs empirical validation |