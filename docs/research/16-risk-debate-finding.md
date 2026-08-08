# 05 — TradingAgents 3-Persona Risk Debate: Finding for Risk-Manager Wayfinder

**Status:** Research finding — pending wayfinder grilling (not yet charted)
**Owner:** David (Deepak)
**Date:** 2026-07-25
**Source:** TradingAgents repo reconnaissance — full report at `~/Documents/Obsidian/research/trading-repos-vs-samurai-2026-07-25.md` and deep-dive at `~/Documents/Obsidian/research/tradingagents-deepdive-raw.md`

> **Scope note:** This is a *finding* captured for later wayfinder grilling, not a decision. The risk-manager wayfinder map will be charted separately (Standing Pipeline Rule 1). Do not implement from this doc — it raises a question, it does not answer one.

---

## The Finding

TradingAgents (TauricResearch, 94.4k ⭐, Apache-2.0, arXiv 2412.20138) implements its Risk Management stage as a **second LLM debate** — three personas (aggressive / neutral / conservative debators) deliberate over `n` rounds before the Portfolio Manager makes the final call.

Source: `tradingagents/risk_mgmt/{aggressive,neutral,conservative}_debator.py` + paper §4.2:
> "They deliberate from three perspectives—risk-seeking, neutral, and risk-conservative—to adjust the trading trading plan within risk constraints. They engage in n rounds of natural language discussion, guided by a facilitator agent."

Samurai's current risk-manager-spec does **not** have an analogous risk-debate layer. Stage 4 (Risk Manager) is specified as a deterministic, mechanical stage: vet/modify the Trader's `OrderIntent` against portfolio caps, exposure limits, drawdown circuit breakers — no LLM.

## Why This Is Worth a Grilling Question

This is a genuine architectural choice with a real trade-off:

| Option | Pro | Con |
|---|---|---|
| **A. Skip — keep Risk Manager mechanical (current spec)** | Deterministic, backtestable, no added LLM cost, no nondeterminism in the risk gate. Matches Samurai's LLM-concentrated-in-Debate-Engine discipline. | Loses a potentially richer risk signal. A purely mechanical risk gate can't reason about novel tail scenarios the way a 3-persona debate could. |
| **B. Add 3-persona risk debate as advisory input** | Richer risk signal; the aggressive/neutral/conservative framing is a proven, concrete design (94k stars of validation). Adversarial risk perspective may catch what a formula misses. | Adds LLM cost + nondeterminism to Stage 4. Must be kept *advisory* — the final sizing must stay mechanical fractional-Kelly + ATR stop, not an LLM vote. Adds a debate-round config knob (`max_risk_debate_rounds`). |
| **C. Add a *single* risk-critic LLM (not 3 personas)** | Cheaper than 3-persona; one LLM "red-team" pass over the OrderIntent. | Loses the multi-perspective tension that is TradingAgents' actual insight. |

## The Hard Constraint (Non-Negotiable If Adopted)

If Option B or C is chosen: **the LLM risk debate is an *input* to the mechanical Risk Manager, never the sizing authority.** The final `OrderIntent` size, stop, and exposure caps must be computed deterministically (fractional-Kelly + ATR stop + portfolio caps, per current risk-manager-spec). The LLM debate may modulate conviction or flag a veto for the Verdict gate — it must not emit the position size. This preserves the backtest-determinism invariant (CONTEXT.md; research docs 00/01/02).

TradingAgents itself demonstrates why this matters: its Trader emits **free-text `position_sizing`** (e.g. "5% of portfolio") with no Kelly/ATR/fractional math — the weakest part of its system for live money. Samurai's mechanical sizing is the deliberate improvement; adding an LLM risk debate must not regress that.

## What To Decide at Wayfinder Grilling Time

1. **Is the mechanical risk gate's blind spot real?** Does the current risk-manager-spec miss tail-risk reasoning that a 3-persona debate would catch, or do the portfolio caps + drawdown breakers + asset-class risk multipliers already cover it?
2. **Is the LLM cost justified?** Stage 4 would gain a debate call (or three) per tick. Against the value of the signal — is the edge worth the tokens + latency + nondeterminism?
3. **Advisory vs gate:** if adopted, does the risk debate modulate conviction (advisory) or can it veto (gate)? A veto makes it a second Verdict; a modulation keeps it upstream of the mechanical Risk Manager.
4. **Persona count:** 3 (aggressive/neutral/conservative, TradingAgents' choice) vs 1 red-team critic vs none.
5. **Round count:** if adopted, `max_risk_debate_rounds` as config (TradingAgents defaults to 2).

## Evidence To Read Before Grilling

- `tradingagents/risk_mgmt/` source tree (the actual debate implementation): https://github.com/TauricResearch/TradingAgents/tree/main/tradingagents/risk_mgmt
- arXiv 2412.20138 §4.2 (debate protocol + facilitator): https://arxiv.org/abs/2412.20138
- Samurai current spec: `docs/specs/risk-manager-spec.md`
- Full reconnaissance report: `~/Documents/Obsidian/research/trading-repos-vs-samurai-2026-07-25.md` (§1 + Deep-Dive Addendum C.3 + D)

## Other TradingAgents Findings (for separate wayfinder stages, not this grilling)

These are captured in the Obsidian report and should be considered when charting their respective stages — listed here so they're not lost:

- **Analysts stage:** 4-analyst decomposition (Fundamentals / Sentiment / News / Technical) — TradingAgents' Sentiment Analyst aggregates news + StockTwits + Reddit into a structured `SentimentReport` (band, score 0–10, confidence). Port the 4 Pydantic schemas to Zod. → `docs/specs/analysts-spec.md`
- **Debate Engine stage:** `max_debate_rounds` config knob; 5-tier `PortfolioRating` output (Buy/Overweight/Hold/Underweight/Sell) vs Samurai's structured `DebateResult`. → `docs/specs/debate-engine-spec.md`
- **Feedback Loop stage:** append-only markdown decision log (`~/.tradingagents/memory/trading_memory.md`) + per-market alpha-vs-benchmark resolution (SPY for US, regional benchmarks for HK/JP/LON/IN/CN/AU). Port the regional benchmark map for R-multiple labels. → `docs/specs/feedback-loop-spec.md`
- **Cross-cutting:** two-tier LLM split (`deep_think_llm` / `quick_think_llm`) + 12+ provider config shape. → `docs/techstack.md`

---

*This doc is a finding pointer, not a spec. Resolve via a `wayfinder:grilling` ticket under the risk-manager map issue when that stage is charted.*
