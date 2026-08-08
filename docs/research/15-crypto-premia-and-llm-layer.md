# Crypto Premia & LLM Layer — Opportunity and Measurement (16)

**Date:** 2026-08-08
**Relates to:** [`archive/2026-08-07-edge-hypothesis-evaluation.md`](archive/2026-08-07-edge-hypothesis-evaluation.md), [`11-trend-signal-measurement.md`](11-trend-signal-measurement.md)
**Parent report (Obsidian):** `~/Documents/Obsidian/research/crypto-premia-llm-layer-2026-08-08-report.md`

## Bottom line

**Do not pursue either crypto premium.** Funding carry is closed to this account twice over (FCA gate + compressed funding). Crypto cross-sectional momentum is structurally unavailable at N=2, monthly rebalance. The LLM layer is the only one of the three ideas that is measurable at $100k — as shadow-mode logging, not as a Sharpe experiment.

**This reverses the parent report's (15-) characterization of crypto momentum/carry as "more upside within constraints." They have more headline upside. They are not within the constraints.**

## Ranked next moves (from parent §8, High confidence on ranking)

| Rank | Option | EV at ~$100k | Sign |
|---|---|---|---|
| — | **Close the PBO gate** | Prerequisite — determines whether ~10%/yr, −23% survive at all | Prerequisite |
| 1 | **Cost/tax reduction** | Halving 1-2%/yr drag recovers ~$500-1,000/yr risk-free, no new degrees of freedom | Positive, known |
| 2 | **LLM shadow-mode ablation** | $0 capital cost; converts unmeasured component into scored one; prior P(positive alpha) 25-35% | Zero cost, info value |
| 3 | **Crypto funding carry** | Zero-to-negative net EV even optimistic; FCA gate closes protected routes | Negative / inaccessible |
| 4 | **Crypto cross-sectional momentum** | Not implementable at N=2; requires 20-50 coins + weekly rebalance + crash profile ≥ equity's −73%/−92% | Unknown, likely negative |

**Sequencing:** PBO first. Cost/tax reduction + shadow-mode LLM logging in parallel (both independent of PBO, both start now — the veto log needs months of decisions before its stats say anything). Revisit funding carry only if FCA derivatives ban lifts AND annualized funding durably exceeds risk-free net of tax (neither true Aug 2026).

## Why each crypto premium fails (for the implementing agent)

1. **Funding carry** — mechanism is real (long spot + short perp, delta-neutral, collects funding from leveraged-long-dominated flow; BIS: ~7%/yr avg, near-zero correlation with traditional carry) but: (a) **FCA PS20/10 / COBS 22.6 bars UK retail from crypto derivatives — still in force 2026** (ETN portion lifted 2 Oct 2025 only; Kraken/Coinbase enforce on UK retail; elective-professional opt-up needs ~£500k — $100k fails); (b) funding compressed toward 3-5% gross post-ETF-arbitrage crowding (basis below 2y Treasury since Feb 2026 per secondary sources — **live pricing unverified, pull primary data before believing any number**); (c) tail risk is short-vol/liquidity-provision — inverts exactly when the basket's left tail hits (Mar 2020, May 2021, Oct 2025 $19bn cascade); (d) HMRC treatment of funding receipts unresolved (possibly 40-45% income tax — paid opinion needed before capital); (e) counterparty = dominant term (FTX precedent: "delta-neutral" became naked long when the short leg was seized).
2. **Crypto cross-sectional momentum** — premium is real in literature (Han-Kang-Ryu: TSMOM Sharpe 1.51 net 15bps, 2017-2023; but CSMOM weaker — 5/21 configs liquidated, only 6 beat market; profit comes from long leg, short leg loses + jump risk; Grobys 2025: single −255% event = 37% of compounded return; large-cap-only ~2% of coins) — but lives at 1-4 week horizons on 20-50 coin universes. Samurai: N=2 (BTC/ETH), monthly. At N=2 it's a coin flip, not a factor. Expanding = illiquid venues + turnover + CGT disposal count + at-least-as-violent crashes.

## LLM layer — what the evidence says + how to measure

- **No credible study shows an LLM debate/veto layer beating a mechanical baseline out-of-sample.** TradingAgents headline Sharpes 5.6-8.2 independently unreproducible (Koviazin et al., ACM 10.1145/3800973.3801029); FINSABER (arXiv 2505.07078, 20 yrs, 100+ symbols) finds LLM agents systematically fail vs mechanical baselines; backtest windows sit inside pretraining weights (weight-level leakage — date-aware retrieval doesn't fix it).
- **Veto-only is the right architecture** (bounded: worst case = flat; auditable: every veto is a discrete loggable event) — but it's the *least-bad* way to include an LLM, not evidence to include it. Override literature (Meehl 1954; Dawes-Faust-Meehl; Grove-Meehl 1996/2000; Dietvorst 2015 algorithm aversion; NBER WP 31747: 90% of overrides underperform) — override authority over a valid model destroys accuracy on average. Real risk: discretion creep.
- **Measurement = shadow mode**: run the LLM layer on every decision, emit veto/no-veto + reason, log it, **act on none**. Mechanical system trades unaffected. Per-decision metrics only (Sharpe ablation is statistically unanswerable — trend vs control gave t=0.15 at full power; a subset has less):
  - veto rate (near 0% = no info; 30%+ = second strategy in disguise)
  - veto precision (of vetoed decisions, fraction that would have lost) + recall vs base rate
  - opportunity cost (P&L of winners vetoes would have cut) — stated in currency next to losses avoided; these two numbers are the whole answer
  - stability across model versions
- Pre-register before switching on: veto criteria, "bad outcome" definition, minimum veto count, promotion rule.

## Crypto sleeve note (not a strategy change)

Retail cETN ban lifted 2 Oct 2025 — a spot BTC/ETH wrapper may be cheaper/tax-simpler than Alpaca spot for the existing basket sleeve. Belongs to the cost/tax workstream, worth pricing.

## What the implementing agent must verify independently (from parent §9)

1. **Live funding levels** — pull trailing 12-month annualized funding from a primary exchange API; free dashboards render in JS only (regulatory kill doesn't depend on this; pricing kill does)
2. **Crypto momentum crash magnitudes** for a specified spec over 2018, Nov 2022, Oct 2025 — computed on own bars
3. **Paid UK tax opinion** on perp funding receipts before any derivatives capital (HMRC has no guidance)
4. **Elective-professional opt-up availability** — assume unavailable at $100k unless tested against a specific firm
5. **PBO on Result 5 config** (carried from 15-) — still the binding gate

*Handoff for the implementing agent. Parent report (full synthesis, cross-stream contradiction analysis, confidence scoring) at `~/Documents/Obsidian/research/crypto-premia-llm-layer-2026-08-08-report.md`. Raw streams: `-web-raw.md`, `-opus-raw.md` in the same directory.*
