# The edge hypothesis, critiqued and corrected

**Status:** Consolidated 2026-08-08. Merges the critique ([archived](archive/2026-08-07-edge-hypothesis-evaluation.md)) with the code-verified audit that corrected it ([`../reviews/archive/edge-hypothesis-evaluation-audit-2026-08-08.md`](../reviews/archive/edge-hypothesis-evaluation-audit-2026-08-08.md)).
**Use the gate order in this document.** The archived critique's gate list must not be executed verbatim — four of its items were wrong and the largest problem was one it never raised.

> **Gate 2 resolved 2026-08-09 — answer: "neither".** [#632](https://github.com/dd-jp/samurai-trading-system/issues/632), under [map #631](https://github.com/dd-jp/samurai-trading-system/issues/631), ruled that the measured portfolio neither replaces nor wraps the LLM pipeline: David requires an **intraday** horizon and [doc 10](10-edge-hypothesis.md) commits to weeks-to-months, so doc 10 is **superseded on horizon**. `CONTEXT.md`'s debate-as-edge thesis is the recorded one.
>
> **Consequence for this document.** The **doc-10-vs-long-gamma characterisation dispute is moot** — it distinguishes two economic stories over identical mechanics that are no longer being built, so it is not adjudicated here and does not need to be. Gates keyed to validating the doc-10 portfolio (0, 1, 3, 4, 6) are **not scheduled**.
>
> **What transfers to the intraday horizon and stays live:** the "largest problem" finding (the measured strategy has no implementation in `src/`); the unfalsifiability objection, which is *why* the recorded thesis carries an explicit two-arm falsification test; **D1**'s wrong-moment critique; **D2**'s UK tax and missing FX term; **D4**'s ban on return-only comparisons against a risk-targeted stream, which now governs [#636](https://github.com/dd-jp/samurai-trading-system/issues/636); and **D6**, which the restated falsifier arm 2 in `CONTEXT.md` now answers by making the LLM ablation runnable as a live-system experiment.

Reads against [`10-edge-hypothesis.md`](10-edge-hypothesis.md) (the claim) and [`11-trend-signal-measurement.md`](11-trend-signal-measurement.md) (the evidence).

## What survives the audit intact

- **The mechanism contradiction.** "We hold what others abandon under stress" is false of this machinery: vol targeting de-levers *as* vol rises, and trend exits *after* prices fall. The correct characterisation is Fung-Hsieh / Kaminski-Lo long-gamma — trend earns by *avoiding* drawdown, not by enduring it. Doc 11's own smaller left tail at equal return is the internal evidence. It applies *a fortiori* to the live system, whose `breakers.ts` runs a binary volatility halt — the most extreme form of "abandon under stress" available.
- **The unfalsifiability objection.** "Every mechanism exists for survivability" survives every outcome, and so explains nothing.
- **Bootstrapping the drawdown distribution.** Max drawdown is one number from one path; a stationary/block bootstrap or purged CPCV is the right fix.
- **The calibration.** A 0.71 Sharpe is in-band for this literature, not exceptional. Edge decay figures (McLean-Pontiff, Harvey-Liu) check out.

## The largest problem — neither doc raised it

**The measured strategy has no implementation in `src/`.** There is no vol targeting, no trend signal, and no inverse-vol weighting anywhere in the codebase. `decide.ts:248` is ATR-stop fixed-fractional sizing driven off LLM verdicts; `risk-thresholds.ts:65` is a hard gross cap; `breakers.ts` is a binary halt. Both doc 10 and doc 11 describe a portfolio strategy Samurai does not implement and has no component for.

Every gate below guards a capital commitment to a configuration that exists only in a measurement script. **The real decision is an architecture ADR — is the measured portfolio the thing we build, replacing or wrapping the LLM pipeline? — and it is upstream of all validation spend.**

## Corrections to the critique (D1–D7)

- **D1 — the t = 0.15 is invalid, and the real defect is worse.** The script computes a paired t on *mean daily return differences*; the critique's "SE ≈ 1.1" back-solve has no interpretation, and 0.17/0.36 = 0.47 ≠ 0.15. But the deeper error is testing the **wrong moment**: trend's claimed advantage lives in variance and the left tail, and a mean-return t has no power against a variance claim. Hence gate 0 below.
- **D2 — the tax gate prices the wrong country.** It applies US short-term capital gains (40.8% incl. NIIT) to a UK-resident HMRC taxpayer. The short-vs-long-horizon wedge must be re-derived under UK rules. Separately, **neither doc carries a GBP/USD FX term** — an uncosted exposure comparable to a large fraction of the trend-vs-control differential.
- **D3 — internal contradiction.** One gate commits to a bootstrapped −30/−40% 90th-percentile drawdown while a falsifier fires at −23%. Pick one; falsify against the bootstrapped percentile.
- **D4 — return-only comparisons against a risk-targeted stream.** This is the exact comparison doc 11's control arm exists to prevent. "Underperforms over any rolling 3 years" voids with probability near 1. Report risk-adjusted, or return *and* drawdown together.
- **D5 — the crypto 1x constraint does not bind at the committed config.** Inverse-vol weights put the crypto sleeve at ~7–8% of NAV at gross 1.22 — cash-fundable. It binds at the gross-2.44 arm, which doc 11 already declares not executable.
- **D6 — the LLM ablation is unrunnable in both directions.** The measurement script has no LLM; the live system has no trend overlay. Restate it as a live-system experiment against the always-long control.
- **D7 — several "findings" are confirmations.** Doc 11 already disclosed the post-hoc Result 5 selection and the universe contamination.

**Economic point worth testing:** inverse-vol sizing hands IEF/TLT most of the gross budget, so the 1.5 cap binds *because of bonds*, and ~6% financing is paid to hold duration. That is a plausible mechanical explanation for the Sharpe halving across sample halves. Testable by re-running the wide basket minus the duration sleeve.

> **Script line numbers.** D1's evidence is `L383`/`L385` of the measurement script **as of commit `12c00fd`**, which produced doc 11's numbers — verified: `L383` is `t_stat = mean(diff) / (stdev(diff) / math.sqrt(n))` and `L385` is `se = math.sqrt((1 + 0.5 * sharpe ** 2) / years)`. The file is now [`11-trend-signal-measurement.py`](11-trend-signal-measurement.py); line numbers in a live script drift, so read them at that commit.

## Gate order — use this one

0. **Paired Sharpe-difference test** (Jobson-Korkie-Memmel / Ledoit-Wolf HAC) on the existing 2570-day series. Cheap, and the arms are highly correlated so the SE is tight.
1. **Bootstrap the drawdown distribution**; commit to the 90th percentile.
2. **Architecture ADR — is the measured strategy the thing we build?** Wayfinder map → ADR, per Standing Pipeline Rule 7. Upstream of all validation spend.
3. **PBO on the Result 5 config** through `server/tools/backtest/`. Note PBO is computed from all trials over CSCV splits; it is not parameterised by a trial count.
4. **Outside benchmarks, risk-adjusted** (SPY, 60/40), reporting return *and* drawdown; keep the matched control for attribution.
5. **UK tax + financing + FX drag**, re-derived at current HMRC rates.
6. **Crypto 1x** verified against the committed config (binds at gross 2.44, not 1.22).
7. **LLM layer vs the control**, as a live-system experiment.

Falsifiers: re-anchor the drawdown falsifier to the bootstrapped percentile; risk-adjust or drop the rolling-3-year one; drop the t = −1.07 citation.

## Open frontier

1. **PBO on the Result 5 configuration** — the binding gate.
2. **Replace the Stage 2 proxy with the doc-10 strategy** so a verdict finally says something about what would trade. Harness is ready: 10.2y of bars, 812-config MinBTL headroom ([`13-stage2-proxy-verdict.md`](13-stage2-proxy-verdict.md)).
3. **Universe widening 6 → 12**, and fixing the hindsight-selected equity legs.
4. **Paired Sharpe-difference test** (gate 0).
5. **Bootstrap the drawdown distribution**; SPY / 60-40 exact-window benchmarks.
6. **LLM shadow-mode logging** — start the clock now, the veto log needs months ([`15-crypto-premia-and-llm-layer.md`](15-crypto-premia-and-llm-layer.md)).
7. **Cost and tax reduction** — the only certain-EV item, roughly $500–1,000/yr at $100k.
