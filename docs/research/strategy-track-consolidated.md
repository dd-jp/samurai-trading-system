# Strategy Track — Consolidated History & Verdict Chain

**Created:** 2026-08-08 (consolidation). **Purpose:** one place to read the Stage 2 verdict chain and the strategy decision arc without opening ten files. Individual docs remain the authoritative audit trail (see `README.md` index); this is a navigation + summary layer.

## The decision arc in one paragraph

The proxy strategy (moving-average cross with ATR brackets) was measured to destruction across five Stage 2 runs and is **KILLED** on 10.2 years of free history — PBO 0.35 stocks / 0.40 crypto against a 0.05 line, OOS Sharpe 3/24 pass, and the KILL no longer has a sample-length escape hatch (`15-stage2-verdict-free-stack-2026-08-07.md`). That KILL says nothing about the actual intended strategy: the Stage 0 hypothesis (`14-stage0-edge-hypothesis-2026-08-07.md`) is a vol-targeted multi-asset premium harvest with a trend overlay, recorded 2026-08-07 with E1 adopted and C1/C2/E2 dropped on evidence. Its measurement (`13-trend-signal-measurement`) shows the trend overlay adds no unlevered return (t = 0.15 vs always-long control) but earns its keep as leverage efficiency under an executable gross cap (10.2%/yr, Sharpe 0.71, −23.2% DD at gross 1.5/1.22). The hypothesis review (`15-edge-hypothesis-evaluation`) holds: gates are PBO on the Result 5 config (uncomputed), bootstrap DD distribution, SPY/60-40 benchmarks, LLM ablation (shadow-mode), crypto-1x correction, tax/financing drag. Six defects + one omission were found and corrected in the round-2 code audit (see that doc's corrections section).

## Stage 2 verdict chain (proxy strategy)

| Run | Sample | PBO (S/C) | DSR (S/C) | OOS pass | Verdict |
|---|---|---|---|---|---|
| `06-stage2-overfitting-verdict` (07-29) | — | — | — | — | NO VERDICT — inputs didn't exist |
| `08-stage2-verdict-first-real-run` (08-05) | 1.99y | — | — | 2/24 net | cost-attribution focus |
| `09-stage2-cost-decomposition` (08-05) | 1.99y | — | — | 2/24 net, 16/24 gross | kill = cost-model artifact, not dead signal |
| `10-cost-model-calibration` (08-05) | 1.99y | — | — | 14/24 (corrected) | calibrated costs |
| `12-stage2-pbo-dsr-first-computation` (08-05) | 1.99y | 0.65 / 0.30 | 0.26 / 0.52 | 14/24 | PBO+DSR reject |
| `11-stage2-verdict-post-405` (08-06) | 1.99y | — | — | — | KILL/INCOMPLETE — sample length = open lever |
| `15-stage2-verdict-free-stack` (08-07) | **10.2y** | **0.35 / 0.40** | **0.153 / 0.805** | **3/24** | **KILL (terminal)** — strategy, not sample |

**Key readings from the chain:**
- The early KILLs were cost-model artifacts (`09-`: PESSIMISTIC_COST_CONFIG came from a test fixture — pitfall P1 in `11-`).
- #405 fixed MinBTL (grid sized from sample), #420 fixed the zero-padding Sharpe distortion (~0.64× stocks, 0.78× crypto), #375/#384 froze selection to a store.
- On 10.2y the PBO halves but still rejects (0.35 = 7× the 0.05 line); DSR crypto (0.805) is the closest any measurement has come to significance and still misses.
- MinBTL is now 812-config headroom against a fixed 12-config grid — the harness can support the real strategy's search.

## Measurement (doc 13) — what the trend overlay does and doesn't do

- **Design:** time-series momentum (long if trailing return > 0), inverse-vol sized, monthly rebalance, execution lag 1, pre-registered lookbacks 21/63/126/252, 16 configs, always-long-same-basket control with identical sizing/vol-target/costs.
- **Unlevered:** best trend config beats control by +0.17 Sharpe, paired t = 0.15 — "that is nothing." (Note: the t tests daily mean-return difference; a paired Sharpe-difference test is a pending gate — see `15-edge-hypothesis-evaluation` defect D1.)
- **Everything front-loaded:** Sharpe roughly halves in every arm across sample halves.
- **Levered (post-hoc, not validated):** at gross cap 1.5, 80% vol target → 10.20%/yr, Sharpe 0.71, max DD −23.2%, avg gross 1.22; control plateaus ~6.2%/yr with deeper DD. Trend wins on return AND drawdown because it goes flat in bad regimes and stays off the cap.
- **Result 6:** profit-taking ladders are risk-neutral (move along the same risk/return line) — behavioral-only value.
- **Universe selection dominates:** headline Sharpe moved >2x by basket choice — the largest effect in the whole measurement; the 6-symbol current universe (Sharpe 1.34) is hindsight-contaminated.
- **Not a Stage 2 pass.** PBO uncomputed for Result 5 config; the committed numbers are post-hoc-selected.

## Hypothesis (doc 14) — what Samurai actually claims

- **E1 adopted (conditional equity risk premium)** with rationale rewritten: the overlay is not a return generator, it is what lets a financed, capped account carry the premium at size instead of abandoning it at the bottom.
- **C1 (crypto liquidity provision)** dropped — 0.5% round-trip cost against hours-horizon moves.
- **C2 (perp funding carry)** dropped — needs derivatives venue + FCA prohibition. (Confirmed terminal by `16-crypto-premia-llm-layer`.)
- **E2 (overnight gap premium)** dropped — day TIF leaves overnight unprotected; premium contested.
- **Commits to:** ~0.04%/day (~10%/yr), −23% drawdown accepted, always-long-same-basket benchmark, universe widening 6 → 12 symbols.
- **The debate is not the edge** — either operational (survivability machinery) or experimental (measured veto test); veto-only design keeps it cheap and backtestable.

## Evaluation (doc 15) — gates, falsifiers, defects

Full detail in `15-edge-hypothesis-evaluation-2026-08-07.md` — **read the errata banner first**; the body is preserved as written and the authoritative corrections live in **`../reviews/edge-hypothesis-evaluation-audit-2026-08-08.md`** (code-verified audit, defects **D1-D7** + the largest omission + one economic point). Do not execute doc 15's gate list verbatim; use the audit's replacement gate order.

Audit findings in brief:
- **D1** — the t=0.15 arithmetic is invalid (script L383 = paired t on daily mean returns; L385 = Lo SE of a single arm's Sharpe; they don't reconcile: 0.17/0.36 = 0.47 ≠ 0.15). Doc 15's "SE ≈ 1.1" back-solve has no interpretation. Real defect: **wrong moment** — trend's advantage is in variance/left tail, and a mean-return t has no power against a variance claim. **New gate 0: paired Sharpe-difference test (Jobson-Korkie-Memmel / Ledoit-Wolf HAC)** ahead of the PBO run — cheap, same 2570-day series, tighter SE (arms are highly correlated).
- **D2** — gate 6 prices US STCG (40.8%/NIIT) for a UK-resident HMRC owner; the short-vs-long-term wedge argument must be re-derived under UK rules; **neither doc carries a GBP/USD FX term** — an uncosted exposure comparable to a large fraction of the trend-vs-control differential.
- **D3** — gate 2 (commit to bootstrapped −30/−40% 90th pct) contradicts falsifier 2 (falsify at −23%). Pick one; falsify against the bootstrapped percentile.
- **D4** — falsifier 4 and gate 3 are return-only against a risk-targeted stream, the exact comparison doc 13's control exists to prevent; "any rolling 3 years" voids with probability near 1. Report risk-adjusted, or return *and* drawdown.
- **D5** — crypto 1x is real in general but **does not bind at the committed config**: L213 inverse-vol weights put the crypto sleeve at ~7-8% NAV at gross 1.22 — cash-fundable, Reg T-comfortable. It binds at Result 3's gross 2.44 (doc 13 already says so).
- **D6** — gate 4 ablation unrunnable both directions: the measurement script has no LLM; the TS system has no trend overlay. Restate as: LLM layer must clear the always-long control as a live-system experiment.
- **D7** — much of doc 15 §2 restates disclosures doc 13 already made (post-hoc Result 5, universe contamination). Confirmations, not findings.
- **Omission (largest)** — the measured trend/vol-target strategy has **no implementation in `src/`**: no vol targeting, no trend signal, no inverse-vol weighting; `decide.ts:248` is ATR-stop fixed-fractional sizing off LLM verdicts; `breakers.ts` is a binary halt, `risk-thresholds.ts:65` a hard gross cap. Gates guard a configuration that exists only in the measurement script. **The real decision is an architecture ADR: is the measured portfolio the thing we build (replacing/wrapping the LLM pipeline)?** — upstream of every gate.
- **Economic point** — inverse-vol sizing gives IEF/TLT most of the gross budget; the 1.5 gross cap binds because of bonds, and 6% financing is paid to hold duration; plausible mechanical explanation for Result 2's Sharpe halving. Testable: re-run wide basket minus duration sleeve.
- **Provenance resolved:** C1/C2/E2/E1 defined in `14-stage0-edge-hypothesis` (C1 crypto liquidity provision, C2 perp funding carry, E2 overnight gap, E1 conditional equity risk premium — adopted).

### Replacement gate order (audit §"Recommended gate order")

0. Paired Sharpe-difference test (JKM / Ledoit-Wolf HAC) on the existing series
1. Bootstrap the drawdown distribution; commit to 90th percentile
2. **Architecture ADR: is the measured strategy the thing we build?** (wayfinder map → ADR, per Pipeline Rule 7) — upstream of all validation spend
3. PBO on the Result 5 config via the full grid through `src/cost-model-backtest/` (PBO is computed from all trials over CSCV splits, not parameterised by a count)
4. Outside benchmarks risk-adjusted (SPY, 60/40), return + drawdown; matched control retained for attribution
5. UK tax + financing + **FX** drag, re-derived at current HMRC rates
6. Crypto 1x — verify against the committed config (binds at gross 2.44, not 1.22)
7. LLM layer vs the control as a live-system experiment

Falsifiers: re-anchor #2 to the bootstrapped percentile; risk-adjust or drop #4; drop the t=−1.07 citation.

## Open items (actionable frontier)

1. **PBO on the Result 5 configuration** with true trial count — the binding gate.
2. **Replace the Stage 2 proxy with the doc-14 strategy** (vol-targeted premium harvest) so a future verdict says something about what would actually trade. Harness is ready: 10.2y bars, 812-config MinBTL headroom.
3. **Universe widening 6 → 12** + fixing hindsight-selected equity legs (Stage 1 data box).
4. **Paired Sharpe-difference test** (gate 0 from defect D1).
5. **Bootstrap DD distribution**, SPY/60-40 exact-window benchmarks.
6. **LLM shadow-mode logging** (start clock now; veto log needs months).
7. **Cost/tax reduction** — the only certain-EV item ($500-1,000/yr at $100k).
