# Edge Hypothesis Evaluation — Decision Review (15)

> **ARCHIVED — superseded by [`12-edge-hypothesis-critique.md`](../12-edge-hypothesis-critique.md),** which folds in the audit corrections. Do not execute the gate list below verbatim; see the errata banner already in the body.

**Date:** 2026-08-07
**Supersedes / relates to:** [`../11-trend-signal-measurement.md`](../11-trend-signal-measurement.md)
**Parent report:** `~/Documents/Obsidian/research/most-profitable-trading-algorithm-edge-hypothesis-2026-08-07-report.md` — **local-only, outside this repo**; the path resolves on the owner's machine and nowhere else.

> **⚠ Errata — 2026-08-08. Do not execute the gate list below verbatim.**
>
> This document was audited the day after it was written: [`edge-hypothesis-evaluation-audit-2026-08-08.md`](../../reviews/archive/edge-hypothesis-evaluation-audit-2026-08-08.md). The body is preserved as written, so the passages the audit invalidates are still on the page — five of them, across audit defects **D1-D4**. Named here so no one acts on them by skimming:
>
> - **"What is wrong" item 1 — "SE ≈ 1.1 Sharpe units" and the "+1.2 / −0.9 overlay" band.** Back-solved by dividing a Sharpe difference by a t-statistic on *daily mean returns*; the two are not the same quantity, so the band is not a confidence interval. The "we learned nothing" conclusion survives for a stronger reason the audit supplies — a paired t on mean returns has no power against a *variance* claim, which is where doc 13 locates trend's advantage. Audit **D1**, which adds a paired Sharpe-difference test (Jobson-Korkie-Memmel / Ledoit-Wolf HAC) as a cheap **gate 0** ahead of the PBO run.
> - **Falsifier 3 — "already fails on Sharpe there: t = −1.07".** Same defect: that t is also a mean-return statistic and establishes nothing about Sharpe. Drop the citation. Audit **D1**.
> - **Gate 6 — "STCG ~40.8% federal, ~194bps/yr at 100% turnover".** A US federal rate priced for a UK-resident owner (HMRC). The short-vs-long-term wedge the argument rests on has to be re-derived under UK rules before it can be weighed against the trend-vs-control differential; the audit asserts no UK rate or regime structure, only that this one does not carry over. It also notes neither doc carries a **GBP/USD FX term**, an uncosted exposure larger than the tax one. Audit **D2**.
> - **Falsifier 2 — "realized drawdown > −23% … → survivability claim falsified".** Contradicts gate 2 in this same document, which says to discard the realized −23.2% and commit to a bootstrapped 90th percentile of −30% to −40%. Adopting both means agreeing to declare failure at a level gate 2 expects to be exceeded. Re-anchor to the bootstrapped percentile. Audit **D3**.
> - **Falsifier 4 and gate 3's SPY / 60-40 patch.** Return-only comparisons against a vol-targeted, drawdown-managed stream — the exact comparison doc 13's matched control exists to prevent — and "*any* rolling 3 years" over a decade voids the apparatus with probability near 1. Report risk-adjusted, or return *and* drawdown together. Audit **D4**.
>
> The audit also records the largest omission: the measured trend / vol-target strategy **has no implementation in `src/`** (no vol targeting, no trend signal, no inverse-vol weighting — `src/trader/decide.ts` does ATR-stop fixed-fractional sizing off LLM verdicts). These gates therefore guard a configuration Samurai cannot execute. Use the audit's **replacement gate order**, in which that architecture decision is itself a gate.

## Bottom line

The decision process is **exemplary**; the hypothesis as stated is **not what the system does**, and the capital commitment rests on the one result we ourselves flagged as unvalidated. Do not ship capital until the PBO gate below closes. The reframe to "risk premium paid for bearing drawdown" should be rewritten — it is contradicted by our own machinery.

## What the decision gets right (keep)

- Pre-registered 16-config trial accounting with literature lookbacks — no search
- Always-long-the-same-basket control with matched sizing/vol-target/costs — correct signal-isolation benchmark
- Honest reporting of t = 0.15 (trend vs control) instead of burying it
- Dropping C1/C2/E2 on evidence; self-flagging hindsight contamination in the 6-asset universe
- Result 6 (profit ladders = behavioral-only) — correct negative finding, rare discipline

## What is wrong

1. **Inference inversion at t = 0.15.** SE ≈ 1.1 Sharpe units — the sample cannot distinguish "+1.2 Sharpe overlay" from "−0.9 Sharpe overlay." Correct inference: *we learned nothing*, not *the overlay adds nothing, therefore it must be doing something else*. The rewritten rationale may be true; this test did not show it.
2. **The committed numbers (10.2%/yr, −23.2%, gross 1.22) come only from Result 5** — the 80% vol-target / 1.5 gross-cap configuration selected *after* seeing results, explicitly outside the 16 pre-registered trials, self-flagged "not validated." DSR 0.989 does not cover universe selection (our own Result 4: universe choice moved headline Sharpe >2x — the largest effect in the whole measurement).
3. **The hypothesis contradicts the mechanisms.** "We hold what others abandon under stress" is false of this system: vol targeting de-levers as vol rises; trend exits after prices fall. Fung-Hsieh/Kaminski-Lo characterize trend payoffs as long-gamma lookback-straddles — trend earns by *avoiding* drawdown, not bearing it. Our own Result 3 shows trend's advantage is a *smaller* left tail at equal return. Drawdown is a path statistic, not a priced risk; liquidity/crash premia are earned by *staying exposed into stress* — the one thing this machinery never does.
4. **The reframe is unfalsifiable as written** — "every mechanism exists for survivability" survives every outcome. Supply falsifiers or drop the framing.

## Gates before capital (do these first)

1. **PBO on the Result 5 configuration** with the *true* trial count (2 universes × 4 lookbacks × vol-target grid × gross-cap grid × 3 cost levels × ladder variants × breaker thresholds ≈ high tens-to-hundreds, not 16). Gate: **PBO ≤ 0.05**.
2. **Bootstrap the drawdown distribution** (stationary/block bootstrap or purged CPCV). Commit to the 90th percentile, not the realized −23.2%. Expect −30% to −40% once financing and leverage are live.
3. **Add SPY and 60/40 as capital-decision benchmarks**, net of financing and short-term tax, over the exact 2016-05-18 → 2026-08-07 sample. Keep the always-long control for signal attribution; report both. **Patch 2026-08-08 finding (published figures, Medium confidence): SPY total return 15.35%/yr (SSGA, 10yr as of 06/30/2026); 60/40 ~9.6% (VBIAX, 10yr as of 08/06/2026). Against Samurai's committed 10.2%/yr, that decade: Samurai lags SPY by ~5pts/yr and roughly matches 60/40.** Exact-window recomputation on our own bars still required — this bounds the comparison but does not close it.
4. **Ablate the LLM/debate layer** — it is currently an unmeasured, non-pre-registered trial generator on top of a carefully measured system. Run the identical backtest with and without it, or remove it until measurable.
5. **Fix the crypto 1x modeling error** — backtest allocated risk across 12 assets under one gross constraint; live account cannot lever BTC/ETH (Alpaca 1x). This changes realized weights, not merely achievable leverage.
6. **Model the 2-5%/yr combined tax+financing drag** (patch 2026-08-08 bound: STCG ~40.8% federal, ~194bps/yr at 100% turnover; margin 4.1-10%; crypto perp funding ~11% baseline). Monthly rebalancing in a taxable account realizes short-term gains — at this scale the drag plausibly exceeds the entire trend-vs-control differential.

## Falsifiers (adopt or drop the hypothesis)

1. PBO > 50% on Result 5 config → 10%/yr commitment void
2. Realized drawdown > −23% at ≤ 1.22 gross in next stress event → survivability claim falsified
3. Trend drawdown advantage fails to replicate in the 6-asset universe (already fails on Sharpe there: t = −1.07)
4. Net-of-financing-and-tax return below 60/40 over any rolling 3 years → apparatus voided regardless of gross Sharpe

## Suggested rewritten hypothesis (testable version)

> "A diversified multi-asset beta-and-risk-premium harvest, with a volatility-targeted trend overlay whose measured contribution is left-tail reduction that makes modest leverage survivable; the ~10%/yr return target is contingent on the Result 5 configuration surviving out-of-sample (PBO) validation."

## What the evidence says about "most profitable algorithm" (for context)

### Trading algorithm families — evidence ranking (from parent report §1 + §10 patch)

Ranked by realistic, capacity-adjusted, decay-aware Sharpe for weeks-to-months horizon, accessible below institutional scale:

| Family | Documented Sharpe (net) | Capacity | Robustness / decay | Confidence |
|---|---|---|---|---|
| Market-making / HFT | 3–10+ | Very low ($100M–1B); latency/colocation-gated | Persistent but inaccessible outside infrastructure | Medium (practitioner-reported) |
| Stat-arb (equity mean-reversion) | Historically high | Low–medium; needs shorting/financing | Heavily decayed since 2002 | Medium |
| Cross-sectional momentum + value ("everywhere") | ~0.5–0.7 combined | High — 8 markets, 4 asset classes | 215-year evidence; momentum alone carries crash risk | High |
| Time-series trend-following | 0.77 net century avg (AQR); 0.5–0.6 live (SG Trend) | High | Every decade positive, but post-2009 Sharpes lower; fails in fast crashes (Apr 2025) | High |
| Carry | ~0.7 | Medium-high | Compensation for crash risk — same tail as short-vol | Medium |
| Volatility-managed portfolios (overlay) | Adds Sharpe on equities/credit; negligible on bonds/FX/commodities | High | Benefit concentrated in one leverage-effect mechanism; weaker OOS once implementation honest (Cederburg et al. 2020) | High |
| Alternative risk premia (blended) | 0.5–0.6 realistic target | High | Cambridge Associates: live vehicles disappoint vs bull benchmarks | High |
| ML / cross-sectional short-horizon | No established retail-accessible edge | Low at scale that matters | Largely arbitraged in liquid names | Low |

**Direct answer:** no single "most profitable" algorithm in the abstract. For our constraints (≈$100k, weeks-to-months, crypto 1x + US equities, retail execution), the honest order is: **(1) blended multi-premia harvesting (momentum + carry + value + trend, weakly correlated) > (2) time-series trend-following alone > (3) single-factor cross-sectional momentum/carry > (4) vol-targeted risk-asset overlays as a return source.** Stat-arb and HFT post higher raw Sharpes but are excluded by capacity. Our measured 0.71 Sharpe is in-band for an honest harvest, not exceptional.

**What genuinely adds value within our constraints** (parent §10): more *independent* premia — crypto cross-sectional momentum; perpetual-futures funding/basis carry (documented Sharpe 1–2 in 2017–2023, real capacity headroom at $100k, requires perp/futures venue given Alpaca 1x/no-short) — and **cost/tax reduction** (certain, unlike estimated edges). Not more de-risking layers on a 12-ticker basket that reduces to ~4 effective bets (equity beta, duration, real assets, crypto) under stress.

**Decay reality check:** McLean-Pontiff: 26% lower OOS, 58% post-publication; CXO 888-strategies study: in-sample explains only 1–2% of OOS (vol/DD transfer, Sharpe does not); Harvey-Liu: haircut backtest Sharpe ~50%.

## Source index (full citations in parent report)

- AQR Century of Trend-Following (Hurst, Ooi, Pedersen 2014) — base-rate trend Sharpe 0.77 net, 1880–2013
- Harvey et al. 2018, "The Impact of Volatility Targeting," JPM — vol-target Sharpe benefit concentrated in equities/credit, negligible for bonds/FX/commodities (~60% of our basket)
- Moreira-Muir 2017 (JF) vs Cederburg-O'Doherty-Wang-Yan rebuttal — OOS vol-target gains weaker with honest implementation
- Bailey & López de Prado 2014, DSR/PBO — the gate methodology
- Harvey-Liu 2015 backtesting haircut; Wiecki et al. 2016 (888 strategies, IS→OOS R² 0.01–0.02); McLean-Pontiff 2015 (26%/58% decay)
- Cambridge Associates 2019 — ARP live Sharpe target 0.5–0.6
- Alpha Architect/Kaminski 2026 — trend fails in fast crashes (Apr 2025), trend mean-reverts post-drawdown
- Kaminski & Lo 2014 — stop rules conditionally effective

*Handoff for the implementing agent — read the errata banner at the top first. Parent report (full synthesis, confidence scoring, knowledge gaps) at `~/Documents/Obsidian/research/most-profitable-trading-algorithm-edge-hypothesis-2026-08-07-report.md`, with raw streams `-web-raw.md` and `-opus-raw.md` in the same directory. **Local-only — that directory is outside this repo and resolves on the owner's machine only; nothing in this document depends on reading it.***
