# Audit — the edge-hypothesis critique

**Date:** 2026-08-08
**Subject:** [`docs/research/archive/2026-08-07-edge-hypothesis-evaluation.md`](../research/archive/2026-08-07-edge-hypothesis-evaluation.md) (the critique)
**Also read:** [`11-trend-signal-measurement.md`](../research/11-trend-signal-measurement.md) (the measurement it critiques), [`11-trend-signal-measurement.py`](../research/11-trend-signal-measurement.py) (the code that produced the numbers), `server/pipeline/trader/decide.ts`, `server/pipeline/risk-manager/`

> **Note on numbering.** This audit was written before the 2026-08-08 research consolidation and refers to its subjects by their old numbers throughout. Read them as:
> - **"doc 13"** = [`11-trend-signal-measurement.md`](../research/11-trend-signal-measurement.md) (the measurement)
> - **"doc 15"** = [`archive/2026-08-07-edge-hypothesis-evaluation.md`](../research/archive/2026-08-07-edge-hypothesis-evaluation.md) (the critique). Its corrected successor, which folds in the findings below, is [`12-edge-hypothesis-critique.md`](../research/12-edge-hypothesis-critique.md)
> - **"doc 14"** = [`10-edge-hypothesis.md`](../research/10-edge-hypothesis.md) (the hypothesis)
>
> **On the script line numbers below:** D1 cites `L383`/`L385`, which refer to the script **as of commit `12c00fd`**, the run that produced the measurement's numbers. The file is now `11-trend-signal-measurement.py`, and line numbers in a live script drift — read them at that commit.

## Verdict

Doc 15's central argument — **the stated hypothesis contradicts the mechanisms the system actually runs** — is correct, well-sourced, and worth keeping verbatim. Its gate list is directionally right and its instinct to stop capital is right.

But it inherits a statistical defect from doc 13 and then compounds it, prices a US tax bill for a UK taxpayer, contradicts itself between one gate and one falsifier, and — the largest omission — gates a "capital commitment" to a strategy **that does not exist in this codebase**. Both docs measure a portfolio strategy Samurai does not implement and has no component for.

Treat doc 15 as a strong critique needing four corrections and one addition, not as a gate list to execute as written.

## What survives intact (do not rewrite)

- **§3, the mechanism contradiction.** "We hold what others abandon under stress" is false of this machinery: vol targeting de-levers *as* vol rises, trend exits *after* prices fall. The Fung-Hsieh / Kaminski-Lo long-gamma lookback-straddle framing is the correct characterisation — trend earns by *avoiding* drawdown. Doc 13's own Result 3 (smaller left tail at equal return) is the internal evidence. This is doc 15's best original work.
  **It applies *a fortiori* to the live system**, which is coarser still: `server/pipeline/risk-manager/breakers.ts` runs a binary `volatility_halt:<class>` that flattens/blocks at a multiple of baseline realized vol. That is the most extreme form of "abandon under stress" available.
- **§4, unfalsifiability.** "Every mechanism exists for survivability" survives every outcome. Correct objection.
- **Gate 2, bootstrap the drawdown distribution.** Methodologically the soundest item in the doc. Doc 13 already concedes max DD is one number from one path; a stationary/block bootstrap or purged CPCV is exactly the fix.
- **Gate 1, PBO on the true trial count.** Correct in principle (see G1 caveat below).
- **The §"most profitable algorithm" evidence ranking** and decay figures (McLean-Pontiff, Harvey-Liu, CXO/Wiecki) — no errors found; the "our 0.71 Sharpe is in-band, not exceptional" calibration is the right note to end on.

## Errors and defects, ranked

### D1 — The t = 0.15 arithmetic is invalid, and the real defect is worse than the one doc 15 names

Verified in the script:

- `L383`: `t_stat = mean(diff) / (stdev(diff) / sqrt(n))` — a paired t on **mean daily return differences**, n ≈ 2570.
- `L385`: `se = sqrt((1 + 0.5 * sharpe**2) / years)` — the Lo standard error of a **single arm's Sharpe**.

Doc 13's Result 1 table prints these side by side as if they belonged to one test. They do not reconcile: 0.17 / 0.36 = 0.47, not 0.15 (and in the `current` row, 0.07 / 0.43 = 0.16, not −1.07).

Doc 15 tried to reconcile them by back-solving 0.17 / 0.15 ≈ 1.1 and calling it "SE ≈ 1.1 Sharpe units." That quantity is a Sharpe difference divided by a t-statistic on daily means — it has no interpretation, and the "+1.2 vs −0.9 overlay" band built on it is not a confidence interval.

**The conclusion survives, for a better reason.** The problem is not that the test is noisy. It is that it is the **wrong moment**. Doc 13's own Results 3 and 5 locate trend's advantage in *lower volatility and a smaller left tail at equal return*. A t-test on mean daily returns has no power against a variance claim. t = 0.15 is a correct answer to a question nobody asked.

Three distinct effects, three states:

| Effect | Tested? | Right tool |
|---|---|---|
| Mean return | Yes — null, honestly reported | paired t on daily returns (done) |
| Sharpe / variance | **No** | paired Sharpe-difference test: Jobson-Korkie-Memmel, or Ledoit-Wolf HAC |
| Tail / drawdown | **No** | block bootstrap (doc 15 gate 2) |

The Sharpe-difference test is a **gate 0** that belongs *ahead* of the PBO run: it uses the same 2570-day series, no new data, and because the two arms are highly correlated its standard error is far tighter than either 0.36 or the spurious 1.1 — so it may well return a conclusive answer either way. Cheap, and it decides whether the PBO run is worth doing.

Knock-on: doc 15's **falsifier 3** cites the `current`-universe t = −1.07 as evidence trend "already fails on Sharpe there." Same error — that t is also a mean-return statistic and establishes nothing about Sharpe.

### D2 — Gate 6 prices the wrong country's tax

Gate 6 quotes "STCG ~40.8% federal, ~194bps/yr at 100% turnover." The owner is UK-resident under HMRC (CLAUDE.md, "Key Constraints"). US federal short-term rates do not apply.

The failure is specific: doc 15's *argument* rests on a **short-vs-long-term rate wedge** — "monthly rebalancing in a taxable account realises short-term gains, and the drag plausibly exceeds the entire trend-vs-control differential." Whether an equivalent turnover penalty exists under HMRC rules is a question about the UK regime that **this audit has not verified**, and the argument cannot be carried over until it is.

The drag does not vanish either way: disposals are taxable events and higher turnover costs deferral regardless of regime. **Conclusion unquantified, not disproven** — re-derive the whole term under current-year UK rules before it is used against the trend-vs-control differential. Neither a rate nor a regime structure is asserted in this document; both need sourcing.

**Neither doc carries an FX term.** A GBP-based owner holding a USD-denominated return stream at a ~10%/yr target is running an uncosted, unhedged GBP/USD exposure whose annual vol is comparable to a large fraction of the entire trend-vs-control differential. That is a bigger uncosted line than the tax one and it appears nowhere in doc 13, doc 15, or the script.

### D3 — Gate 2 and falsifier 2 contradict each other

- **Gate 2:** do not commit to the realised −23.2%; commit to the bootstrapped 90th percentile, "expect −30% to −40% once financing and leverage are live."
- **Falsifier 2:** "realised drawdown > −23% in the next stress event → survivability claim falsified."

Adopting both means committing to an expectation of −30/−40% and simultaneously agreeing to declare failure at −23%. Falsifier 2 fires with near-certainty *if gate 2 is right*. Pick one: falsify against the bootstrapped percentile gate 2 tells you to commit to, not against the single realised path gate 2 tells you to discard.

### D4 — Falsifier 4 and gate 3 abandon doc 13's own benchmark logic

Falsifier 4: "net return below 60/40 over any rolling 3 years → apparatus voided."

Two problems. It is **return-only against a risk-targeted strategy** — the exact comparison doc 13 Result 1 exists to prevent ("the control is the benchmark to beat, not SPY"). And "**any** rolling 3 years" over a decade is dozens of overlapping windows; a ~10%/yr, ~14%-vol strategy will underperform 60/40 in some of them with probability close to 1. As written it voids the apparatus unconditionally.

The same flaw sits under **gate 3**'s patch: "Samurai lags SPY by ~5pts/yr" compares a de-levered, vol-targeted, drawdown-managed stream to 100% equity beta on return alone, over a decade containing one of the strongest equity runs on record. SPY carries full equity-beta drawdown across a window containing both 2020 and 2022 — a cost gate 3's comparison does not report at all. Report risk-adjusted, or report return *and* drawdown together — otherwise the comparison argues for abandoning risk management, which is not what doc 15 means.

Keep gate 3's *intent* (an outside benchmark is a fair sanity check on absolute attractiveness), fix the metric, and keep the matched control as the attribution benchmark exactly as doc 13 insists.

### D5 — Gate 5 (crypto 1x) is right in general, misapplied to the committed numbers

The mechanism is real: a per-instrument leverage cap changes realised weights across the whole basket, not just achievable gross.

But it does not bind at the committed configuration. From `L213`, per-instrument weight is `(0.10 / vol_s) / len(symbols)` — inverse-vol, divided by 12. With crypto annualised vol in the 50-70% range, BTC and ETH raw weights are ~1.2-1.7% each before the portfolio scaler; at avg gross 1.22 the crypto sleeve lands around 7-8% of NAV. Fully cash-fundable. The ~0.22 NAV of borrowing sits against ~1.1 NAV of marginable equities, comfortably inside Reg T.

So gate 5 is a genuine defect in **Result 3's gross-2.44 configuration** (as doc 13 already states at its Result 3 caveats), not in the 10.20% / −23.2% / gross 1.22 figures doc 15 attacks. Rank it accordingly. *(Weights derived from the sizing line, not re-run — the script needs a downloaded data dir.)*

### D6 — Gate 4 (ablate the LLM layer) is not runnable in either direction

"Run the identical backtest with and without it." There is no *with*. The measurement is a standalone dependency-free Python script with no LLM anywhere in it; the TypeScript system has no trend overlay to backtest. The ablation cannot be run today in either direction.

The *concern* is valid and is doc 13's point 3: the veto-only debate design is the cheapest way to get a measured answer, against a control that is now defined. Restate gate 4 as "the LLM layer must clear the always-long control before it is credited with anything" — which is a live-system experiment, not a backtest re-run.

### D7 — Much of §2 restates disclosures doc 13 already made

Doc 13 self-flags the Result 5 configuration as post-hoc and unvalidated (its line 100, verbatim: "they are **not** part of the 16-trial accounting … not validated"), and self-flags the universe hindsight contamination as "the single largest effect in the measurement" (Result 4). Doc 15's §2 presents both as findings. They are confirmations. Worth saying plainly so the exchange reads as an audit that agrees, rather than a takedown — the disagreements are D1-D6, and they are narrower than §2's framing suggests.

## The largest omission — the strategy is not built

Doc 15 opens "do not ship capital until the PBO gate closes," which presumes a configuration awaiting deployment. Checked against `src/`:

- **No vol targeting.** No `volTarget`, `volatilityTarget`, `inverseVol`, or `trendLookback` anywhere in `src/`. `server/pipeline/risk-manager/breakers.ts` has a binary `volatility_halt` circuit breaker — a halt, not a continuous scaler.
- **No trend signal, no monthly rebalance, no inverse-vol weighting.** No component computes trailing-return sign or vol-scaled target weights.
- **Sizing is a different animal entirely.** `server/pipeline/trader/decide.ts:248` — `const size = (equity * riskFraction) / stopDistance` — ATR-stop fixed-fractional risk sizing, per trade, event-driven from LLM verdicts.
- **What does exist:** a `portfolio_gross_cap` risk threshold (`server/pipeline/risk-manager/risk-thresholds.ts:65`) — a hard cap, not a targeter.

**Consequence:** doc 15's gates guard a capital commitment to a configuration that exists only in `docs/research/11-trend-signal-measurement.py`. Closing all six gates would validate a strategy Samurai cannot currently execute. The real decision in front of the project is not "PBO then ship" — it is **"is the measured trend/vol-target portfolio the thing we build, replacing or wrapping the LLM pipeline?"** That is an ADR, and it is upstream of every gate in doc 15.

## One economic point neither doc makes

Inverse-vol sizing (`L213`) allocates *notional* in proportion to 1/vol, so low-vol instruments consume the majority of gross exposure while contributing the same risk as any other sleeve. In the wide basket, IEF and TLT therefore eat most of the gross budget.

Two consequences for the levered configurations:

1. The 1.5 gross cap binds largely because of **bonds**, not because of the assets carrying the thesis.
2. Financing is charged on **notional above 1.0** (`L269`, 6%/yr), so the levered runs are paying 6% to hold duration.

Whether that is a good trade is exactly what a levered-bond position is: it worked spectacularly through 2016-2021 and inverted in 2022. This is a plausible mechanical explanation for doc 13's Result 2 (every arm's Sharpe roughly halving in the second sample half), which doc 13 attributes to "the whole opportunity set." Testable cheaply by re-running the wide basket with the duration sleeve removed.

## Recommended gate order (replacing doc 15's list)

0. **Paired Sharpe-difference test (JKM / Ledoit-Wolf HAC)** on the existing 2570-day series. Decides whether trend's variance advantage is real before anything expensive runs. *(New — D1.)*
1. **Bootstrap the drawdown distribution.** Doc 15 gate 2, unchanged. Commit to the 90th percentile.
2. **Unresolved architecture decision: is this strategy the thing we build?** Doc 15's gates presume a deployment that has no implementation. Per Standing Pipeline Rule 7 this is a wayfinder map issue that resolves into an ADR, not an ADR written directly. Resolve before spending on validation. *(New — see omission above.)*
3. **PBO on the Result 5 configuration** with the full grid. Note: PBO is not parameterised by a trial count — it is computed from the matrix of *all* trials over CSCV splits, so this means re-running the grid through `server/tools/backtest/`, not passing a number. Doc 15 gate 1, mechanism corrected.
4. **Outside benchmarks, risk-adjusted** (SPY, 60/40), over the exact sample, reporting return *and* drawdown. Matched control retained for attribution. Doc 15 gate 3, metric corrected — D4.
5. **UK tax + financing + FX drag**, re-derived at current HMRC rates, with the GBP/USD term added. Doc 15 gate 6, jurisdiction corrected — D2.
6. **Crypto 1x** — applies to the gross-2.44 configuration; verify against the committed config rather than assuming. Doc 15 gate 5, scope corrected — D5.
7. **LLM layer vs the control** as a live-system experiment (veto-only design), not a backtest ablation. Doc 15 gate 4, restated — D6.

Falsifiers: fix falsifier 2 against the bootstrapped percentile (D3), drop or risk-adjust falsifier 4 (D4), drop falsifier 3's t = −1.07 citation (D1).

## What was not checked

- The script was **not re-run** — it needs a downloaded Alpaca/Coinbase data directory. Every number quoted from docs 13/15 is taken as reported; only the *code paths that produce them* were read.
- The external figures in doc 15's gate 3 patch (SPY 15.35%/yr, 60/40 9.6%) were **not independently verified**; doc 15 already labels them Medium confidence and pending exact-window recomputation.
- The parent Obsidian report was not read (outside the repo).
- **No UK tax fact is asserted here** — neither a current-year rate nor the structure of the regime. D2 states that doc 15's US-based argument must be re-derived, not what the UK answer is.
- SPY's max drawdown over the sample is referenced qualitatively, not as a figure.
