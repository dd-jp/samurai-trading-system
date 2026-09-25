# 70 — Momentum backtest: proposal (Session B, Step 1)

> **Build phase run 2026-09-24 — US sub-book FAILS the kill line on all four passes; LSE not run. See §9.** The banner below is the state as of 2026-09-23 and stands as the record of that day.
>
> **PROPOSAL, RULED 2026-09-23 — STOP branch entered, nothing built.** David answered all twelve questions in §4 on 2026-09-23 (each carries its "Ruled" line). Ruling (a) chose a paid vendor for the two lines Saxo cannot supply, which is doc 68's STOP branch: §8 is the vendor cost-and-depth report it requires, ending in options David has not yet chosen between. No backtest has been executed, no code has been changed, no data has been stored beyond the read-only probes recorded in §6. The build phase (doc 68 Session B, second paragraph) starts only after David picks from §8.4.

**Date:** 2026-09-22 (proposal); probes and amendments 2026-09-23. **Map:** [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706). **Ticket:** Step 1 (#1742). **Authority:** [doc 66](66-v2-grill-decisions.md) (Q2, Q6, Q7, Q8, Q14, Q15, Q19, G5, G6, G9, G10, "Still open") over [doc 67](67-v2-plan-and-handoff.md) Step 1 and §5a over [doc 68](68-fable-handoff.md) Session B. Facts from [doc 69](69-v2-facts.md) (R3, R7, R8, R12–R15). Priors from [doc 64](64-paperswithbacktest-replication-prior-and-orb.md) and [doc 11](11-trend-signal-measurement.md).

**Rulings since doc 68 was written (David, 2026-09-22, recorded in a docs PR in flight):** Q15 re-ruled for the LSE half — "Saxo chart/v3 first, paid vendor if too shallow": probe Saxo's chart history depth on David's account; if it holds 10 years for the ETF list use it at £0, otherwise stop and report vendor cost and depth. The US half is Alpaca daily bars (permitted). Yahoo and Stooq: never. Q17/Step 2: the debate sleeve calls long and short, each side a separate counted trial against arm 2 (not this sleeve; nothing here contradicts it). G18: sentiment and social enter the debate sleeve only.

## 0. Status of the two probes this proposal had to run

| Probe | Result |
|---|---|
| **Saxo `chart/v3` depth on David's live account** (mandatory per the 2026-09-22 Q15 ruling) | **Run 2026-09-23, read-only, after a fresh `npm run saxo:login`** (the 2026-09-22 attempt found every stored token expired — 401 on file, env and refresh grant — and was recorded as a STOP; superseded by this run). **22 of the 24 proposed lines hold ≥ 10 years of daily bars at Saxo; 2 do not** (IHCU 2021-10-21, CMFP 2019-02-20), and what replaces them is David's call (§4a): the only probed commodity substitute, WCOG, holds 10.4 calendar years but only **73% bar density**, thin to 2020 (§6.1), and the US health role has no probed substitute. Depth is per-instrument inception as doc 44 found, reaching back to 2000 for ISF. Every line probed is `IsTradable: true`; SGLN, SSLN, PHGP, PHSP and CMFP are `IsComplex: true` (§4l, saved responses in §6.1). One 429 hit at the chart endpoint's 120-calls-per-minute limit, cleared by waiting a minute. Full table in §6.1. |
| **Alpaca daily-bar depth** (US half) | **Run, read-only.** SIP feed serves daily bars from **2016-01-04** for every symbol probed, including five delisted names with their full life to delisting; IEX feed starts 2018-11-01 (SPY) or 2020-07-27 (others). Data-API rate limit header `X-Ratelimit-Limit: 200` per minute. Details in §6.2. |
| **Point-in-time S&P 500 membership coverage on Alpaca** | **Run, read-only.** 741 of 745 member tickers since 2016-01-04 have SIP bars inside their membership window; the 4 missing are 0.15% of member-days and none is a current member (§6.3). |

## 1. What this step must produce (restated from the authority)

- A walk-forward momentum backtest, 10y+ of history (Q7, Q17), every configuration counted as a trial from #1, run with and without the resting stop (R4, doc 67 Step 1), with the loss-budget rules inside it (G10: −£500 half size, −£1,000 quarter, −£1,500 halt; daily cap exactly 1.0% of start capital; reset each 1 January per G6).
- Costs: Saxo 0.08%/side, no minimum (Q3); Alpaca spread-only, measured; plus whatever David rules on the custody fee (§4c).
- Benchmark: risk-matched buy-and-hold of the same universe (Q1, Q4).
- **Kill line, verbatim from doc 68 Session B:** *"fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10 (G9). Report pass/fail with numbers and the max drawdown. No LLM calls, no paid data."*
- The strategy is written once, as the module the v2 root imports (doc 66 Language row; doc 67 Step 1 "one implementation everywhere").

## 2. Proposed decisions

Each is a proposal with its reason and source. None is taken.

### 2.1 Strategy family: two sub-books, one per venue

| Sub-book | Family | Why this family here |
|---|---|---|
| **LSE ETF/ETC (Saxo)** | **Time-series trend, long/flat per instrument**, inverse-volatility sized, gross capped at 1.0 | Q4/Q8 rule the momentum sleeve long/flat; a fixed basket of ~24 asset-class lines is the natural TSMOM universe (Moskowitz, Ooi and Pedersen 2012, <https://doi.org/10.1016/j.jfineco.2011.11.003>); doc 11 measured exactly this design over 10y with a matched always-long control, so the control construction is already settled. |
| **US S&P 500 members (Alpaca)** | **Cross-sectional momentum, long-only top-K**, equal-weight, whole shares | Q15 defines the US universe as point-in-time S&P 500 membership; a 500-name universe is cross-sectional by construction (Jegadeesh and Titman 1993, <https://doi.org/10.1111/j.1540-6261.1993.tb04702.x>); long-only keeps Q8. |

Sleeve verdict: each sub-book is judged against its own risk-matched buy-and-hold; a sub-book that fails its kill line is dropped and its capital stays in cash. Whether the sleeve as a whole must pass on the *combined* book as well is **question §4e**.

Not proposed: a single combined cross-sectional book across both venues (mixes an ETF basket with single stocks and a currency), or time-series trend on 500 single names (turnover far above what 0.08%/side and whole shares can carry at £700).

### 2.2 The LSE ETF/ETC list (not `server/providers/universe-pool/lse-etp-pool.ts`, which is the v1 3× pool)

Built from the LSE instrument list as at 2026-07-31 (<https://docs.londonstockexchange.com/sites/default/files/reports/Instrument%20list_82.xlsx>, sheets "1.3 ETFs" and "2.2 ETCs") joined by ISIN to HMRC's reporting-fund list dated 2026-09-04 (<https://assets.publishing.service.gov.uk/media/6a9fea9392e72b8ac437eeea/20260904_Master-Weblist.ods>) — the R12/R14 sources, re-downloaded and re-parsed on 2026-09-22.

Screen (pre-declared, applied in this order): trading currency GBP or GBX; LSE admission on or before 2016-09-22 (ten years before today); name carries no leverage/short/inverse token; ISIN present in the HMRC list with an effective date and no cessation date. Result: **437 ETF lines and 20 ETC lines pass; every one of them is an active reporting fund** (matches doc 69 R14 q1 to the number). From those, one line per asset-class role, choosing the **oldest admitted** line of that role, never a past-performance criterion — this is the survivorship posture of §2.5. Roles follow Q2's mandate (regional/sector equity, gilts, gold, commodities).

| # | Role | TIDM | ISIN | LSE admission | HMRC RF from | Class | Alternate line (same exposure, different price/class) |
|---|---|---|---|---|---|---|---|
| 1 | UK large cap | ISF | IE0005042456 | 2004-09-27 | 2010-06-12 | Dist | CUKX (acc, 2010-09-15) |
| 2 | UK mid cap | VMID | IE00BKX55Q28 | 2014-10-01 | 2014-10-01 | Dist | — |
| 3 | UK small cap | CUKS | IE00B3VWLG82 | 2010-09-15 | 2010-03-22 | Acc | — |
| 4 | US large cap | IUSA | IE0031442068 | 2004-09-27 | 2010-06-12 | Dist | CSP1 (acc, 2010-09-15); VUSA (GBP, 2012-05-23) |
| 5 | US small cap | CUS1 | IE00B3VWM098 | 2010-09-15 | 2010-03-22 | Acc | — |
| 6 | Europe ex-UK | IEUX | IE00B14X4N27 | 2006-06-05 | 2010-06-12 | Dist | VERX (GBP, 2014-10-01) |
| 7 | Japan | IJPN | IE00B02KXH56 | 2004-10-04 | 2010-06-12 | Dist | CSJP (acc, 2010-09-15) |
| 8 | Pacific ex-Japan | CPJ1 | IE00B52MJY50 | 2010-09-15 | 2010-03-22 | Acc | VAPX (GBP, 2013-05-22) |
| 9 | Emerging markets | IEEM | IE00B0M63177 | 2005-11-21 | 2010-06-12 | Dist | SEMA (acc, 2009-09-28); VFEM (GBP, 2012-05-23) |
| 10 | US tech sector | IITU | IE00B3WJKG14 | 2015-11-23 | 2015-11-23 | Acc | — |
| 11 | US health sector | IHCU ⚠ **fails 10y at Saxo** (2021-10-21), see §4a | IE00B43HR379 | 2015-11-23 | 2015-11-23 | Acc | XSDR (Europe health, 2011-08-02 at Saxo) — different exposure |
| 12 | US energy sector | IESU | IE00B42NKQ00 | 2015-11-23 | 2015-11-23 | Acc | — |
| 13 | US financials sector | UIFS | IE00B4JNQZ49 | 2015-11-23 | 2015-11-23 | Acc | — |
| 14 | US consumer-discretionary sector | ICDU | IE00B4MCHD36 | 2015-11-23 | 2015-11-23 | Acc | — |
| 15 | Gold producers | SPGP | IE00B6R52036 | 2011-09-19 | 2011-09-19 | Acc | — |
| 16 | Oil and gas producers | SPOG | IE00B6R51Z18 | 2011-09-19 | 2011-09-19 | Acc | — |
| 17 | UK property | IUKP | IE00B1TXLS18 | 2007-03-20 | 2010-07-10 | Dist | — |
| 18 | Gilts, all maturities | IGLT | IE00B1FZSB30 | 2006-12-04 | 2010-07-10 | Dist | VGOV (GBP, 2012-05-23) |
| 19 | Index-linked gilts | INXG | IE00B1FZSD53 | 2006-12-04 | 2010-07-10 | Dist | — |
| 20 | Sterling corporate bonds | SLXX | IE00B00FV011 | 2004-09-27 | 2010-06-12 | Dist | — |
| 21 | US Treasuries | VUTY | IE00BZ163M45 | 2016-02-25 | 2016-02-24 | Dist | — |
| 22 | Gold (ETC) | SGLN | IE00B4ND3602 | 2011-04-11 | 2011-04-11 | — | PHGP (2007-10-29) |
| 23 | Silver (ETC) | SSLN | IE00B4NCWG09 | 2011-04-11 | 2011-04-11 | — | PHSP (2007-10-29) |
| 24 | Broad commodities | CMFP ⚠ **fails 10y at Saxo** (2019-02-20), see §4a | IE00B4WPHX27 | 2010-03-18 | 2010-03-15 | Acc | XDBG (ex-agriculture, GBP-hedged; fails too, 2021-01-12); WCOG (passes on dates, 73% bar density) |

Notes. (i) All 24 primary lines and all alternates are active HMRC reporting funds by ISIN (§4b). (ii) By LSE admission, row 21 is the youngest line at 10.57 years and rows 10–14 are 10.83 years — but **Saxo's bar history is what binds, and it starts later than admission for several lines (§6.1)**: the US sector lines begin at Saxo between 2015-12-03 and 2016-06-21 (10.3–10.8 years), and two proposed lines fail the ten-year test outright — **IHCU** (Saxo history from 2021-10-21 despite a 2015 admission; the Uic Saxo returns for the ticker is a newer line) and **CMFP** (from 2019-02-20; the fund was re-registered under L&G after the ETF Securities sale, so the ISIN's Saxo history is short). Both alternates listed for the commodity role also fail (XDBG 2021-01-12; WCOB 2021-03-22). The only commodity line found that passes on dates is **WCOG** (WisdomTree Enhanced Commodity, distributing class, IE00BZ1GHD37, Saxo from 2016-05-05, 10.4 years, `IsComplex: false`) — but at 73% bar density, thin until 2021 (§6.1), so it is a caveated option, not a clean replacement; for row 11 the choices are drop the role or take **XSDR** (Xtrackers MSCI Europe Health Care, LU0292103222, Saxo from 2011-08-02) as a Europe-sector substitute. §4a puts both choices to David with options and recommendations. (iii) Excluded on purpose: world/ACWI trackers (double the US weight), Euro-area trackers (overlap row 6), 0–5-year gilts (near-zero volatility breaks inverse-vol sizing), every USD-quoted line (Saxo's 0.60% FX charge, doc 69 R13 q5), every ETN (R13 q6 classification). (iv) Dist vs Acc: R8 rules signals run on total-return series so the classes rank identically; where an Acc alternate exists the live choice prefers Acc so the Saxo side has no ex-date gap (R8 proposal). (v) The alternate column exists for §4d: the same index is listed at prices an order of magnitude apart, and the whole-share rule may force the cheaper class. **Last closes at Saxo as of the 2026-09-23 probe — last bar 2026-09-23 for most lines, 2026-09-22 for CUKS, VGOV, VUTY, CMFP, XDBG and WCOB (§6.1):** IUSA £58.08 against CSP1 £629.60; ISF £10.45 against CUKX £221.70; IEEM £51.13 against SEMA £49.57 / VFEM £62.59; IJPN £19.30 against CSJP £228.56; SGLN £63.10 against PHGP £301.57; IGLT £9.62; INXG £11.06; VUTY £15.56; the US sector lines £9.81–£40.47; CUKS £287.10, CUS1 £512.40, CPJ1 £185.55 and SPGP £33.65 have no cheaper alternate.

Sanity of the ten-year claim, now measured: Saxo depth is **per-instrument inception** (`ChartInfo.FirstSampleTime`), not a rolling window — ISF from 2000-04-28, IUSA from 2002-03-19, SLXX from 2004-03-30 — and admission date over-states it for some lines (CUKX admitted 2010-09-15, Saxo from 2011-02-04; IEUX admitted 2006, Saxo from 2011-08-02). Only Saxo's own `FirstSampleTime` counts for the ten-year test.

### 2.3 US universe: point-in-time S&P 500 membership

- **Dataset:** `fja05680/sp500` on GitHub, file `S&P 500 Historical Components & Changes (Updated).csv` — <https://raw.githubusercontent.com/fja05680/sp500/master/S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv>. **Licence: MIT** (repository metadata, read via the GitHub API 2026-09-22; 946 stars; last push 2026-09-07). Format: one row per change date, `date,tickers`; 2,721 rows from 1996-01-02 to 2026-08-18; 489 rows and **745 distinct tickers** on or after 2016-01-04. The README states its provenance (Clenow's list to 2019, then Wikipedia-sourced changes maintained by hand) and warns that the first five years may be incomplete — irrelevant here, the window starts 2016.
- **Use:** on each rebalance date the eligible set is the membership row in force on that date (last row ≤ date). A ticker is eligible only inside its own membership window; on removal the position is sold at the next rebalance (README note 2). A ticker symbol that reappears after a gap is a *new* instrument — §6.2 shows why (MON continues 4.5 years past Monsanto's delisting with no gap in the bar series, so ticker-level bars cannot be trusted outside the membership window).
- **Not proposed:** `hanshof/sp500_constituents` (also MIT, 29 stars, last push 2025-08-24 — staler); Norgate (paid; Q15 permits it only if the US part passes first).

### 2.4 Delisted-name haircut

Q15 asks for "an explicit extra haircut for missing delisted names". The probe changes what that means: Alpaca's SIP feed carries delisted names to their last day (TWTR to 2022-10-27, CELG to 2019-11-20, YHOO to 2017-06-16, XLNX to 2022-02-11 — §6.2), so most "missing delisted names" are not missing. Proposal, pre-declared:

1. A member with no SIP bars inside its membership window is excluded from selection on those dates and counted in the **missing member-day fraction** `m` (§6.3 gives the measured value).
2. A member whose bar series ends inside its membership window (delisted, acquired, bankrupt) is **sold at its last available close** — the last print before delisting, no 0% and no −100% assumption.
3. The extra haircut is a flat **0.05 subtracted from the US sub-book's annualised Sharpe before the 40% haircut**, applied only if `m ≤ 2%`; if `m > 2%` the US sub-book stops and reports instead of running. The size is a judgment, not a measurement — it is there so that the coverage gap cannot be silently zero; **David may set a different number (§4h)**.

### 2.5 LSE survivorship handling

The 24 lines are alive today by construction (the instrument list is a list of current listings), so the basket is a survivor set. Handling:

1. Selection is by **role and age**, never by past return (§2.2). A basket picked for having gone up backtests as having gone up (doc 11 Result 4); one picked for being the oldest line in its asset class does not carry that bias.
2. ETF closures are liquidations or mergers at NAV, not −100% events, so the bias is that a role whose *first* line closed is now represented by a later survivor — small for broad-index roles, larger for sector and commodity roles. A count of closed GBP/GBX ETF lines admitted before 2016 is **not available from the current instrument list** (delisted lines are not on it); LSE's historical delisting record was not retrieved — **unverified**.
3. No numeric survivorship haircut is proposed for the LSE side beyond the 40%; the caveat is reported with the verdict. If David wants one, §4h.

### 2.6 Data sources and the ten-year requirement

| Half | Source | Measured depth | Ten years? |
|---|---|---|---|
| LSE | Saxo `chart/v3/charts`, `Horizon=1440`, `Count` 1200 per page, paged with `Mode=UpTo&Time=<earliest>` (doc 44 §2.2; doc 69 R7) | **Measured 2026-09-23 (§6.1): 22 of 24 lines ≥ 10 years; earliest bars 2000-04-28 (ISF) to 2016-06-21 (IITU); IHCU and CMFP fail; the one commodity substitute that passes on dates (WCOG) is 73% dense** | Yes for the 22 passing lines; for the two failing roles it depends on David's §4a choice (drop, WCOG with its caveat, or vendor = STOP branch). The binding line is then IITU at 10.3 years (2016-06-21), so with a 252-day lookback the LSE sub-book's evaluated window is ~9.3 years — §4g. |
| US | Alpaca `GET /v2/stocks/bars`, `feed=sip`, `timeframe=1Day`, `adjustment=all` (doc 69 R8 q3; <https://docs.alpaca.markets/reference/stockbars>) | **2016-01-04 for every symbol probed, including delisted names** (§6.2) | 10.7 years of bars to 2026-09-22. With a 252-day lookback warm-up the *evaluated* window is ~9.7 years; with 126 days, ~10.2. **Whether Q7's "10y+" counts bars or evaluated returns is §4g.** |

Saxo bars carry a 15-minute delay (doc 44 §2.9a); irrelevant to an end-of-day read after the close. Whether Saxo bars are split- or dividend-adjusted is unknown (R8 q3) — the build phase measures it across one known distribution before trusting the series, and the ETC lines (no distributions) need no adjustment. Retention of Saxo history locally is an open legal point (R7) that the ruling accepts for own-use backtesting at £0; nothing is redistributed.

**Neither Yahoo nor Stooq was contacted.**

### 2.7 DSR: on excess or absolute returns — the arithmetic David should see first

The kill line has two Sharpe clauses: "beats the benchmark after a 40% Sharpe haircut" and "DSR ≥ 0.95". Q19 says DSR is "deflated over every variant tried". Doc 67 asks this step to propose whether the DSR is computed on the strategy's absolute returns or on its excess over the benchmark. The proposal is **absolute** (the benchmark test is the haircut clause; the DSR clause guards against the *selected* variant being a selection artefact), but the reason to put it to David is what the deflation does to the bar at ten years.

Using the repo's own `deflatedSharpe` (`server/tools/backtest/overfitting.ts`, Bailey and López de Prado 2014), the annualised Sharpe the *best* trial must show for DSR ≥ 0.95 over 2016-01-04 to 2026-09-22, as a function of the number of trials it is deflated over:

| Trials N | Monthly returns (128 obs), skew 0 | Daily returns (2,695 obs), skew 0 | Daily, skew −0.5, excess kurtosis 3 | Monthly, 9.7y evaluated (116 obs) |
|---|---|---|---|---|
| 1 | 0.51 | 0.50 | 0.51 | 0.53 |
| 2 | 0.67 | 0.66 | 0.67 | 0.70 |
| 4 | 0.84 | 0.83 | 0.83 | 0.88 |
| 8 | 0.96 | 0.95 | 0.96 | 1.01 |
| 12 | 1.03 | 1.01 | 1.02 | 1.08 |
| 16 | 1.07 | 1.05 | 1.06 | 1.12 |
| 24 | 1.12 | 1.11 | 1.12 | 1.18 |
| 32 | 1.16 | 1.15 | 1.16 | 1.22 |
| 48 | 1.21 | 1.20 | 1.21 | 1.28 |
| 96 | 1.29 | 1.27 | 1.28 | 1.36 |

Read against the priors: the replication prior is Sharpe **0.4–0.8** for a genuine strategy (doc 64 §1); doc 11 measured the best pre-registered trend configuration at **0.77** absolute and its always-long control at 0.60 over 2016–2026, with an *excess* Sharpe of +0.17 (t = 0.15). So:

- On **absolute** returns, DSR ≥ 0.95 is reachable only if the observed Sharpe clears roughly 0.84 at four trials and 1.07 at sixteen. That is at or above the top of the prior.
- On **excess-over-benchmark** returns, the Sharpe being deflated is the active return's (doc 11: ~0.17), and the table says no trial count ≥ 1 can pass. Choosing "excess" makes the gate unpassable by any momentum strategy in the literature; it should be chosen only if that is the intent.
- Either way, **the trial count is the lever**: the difference between a 4-trial and a 32-trial grid is a 0.32 Sharpe higher bar. §2.9 is sized accordingly and asks David to pick.

The related MinBTL guard (`minbtl` in the same file) defaults to an expected Sharpe of 1.0 (`MINBTL_TARGET_ANNUAL_SHARPE`), at which 10.7 years admits 1,067 trials; at the prior's 0.6 it admits **23**, and at 0.5, **11**. Proposal: run the guard at 0.6, not the default (§4i).

### 2.8 Execution timing and slippage (R15)

- **Decision bar:** the daily close of day *t*, read after the close (Saxo's delayed bar and Alpaca's daily bar are both complete by then).
- **Fill:** the **next session's closing auction**, *t*+1 — LSE ATC (MIT201, doc 69 R15) and Alpaca `time_in_force=cls` (doc 69 R15). One-bar execution lag, the doc 11 convention (`EXECUTION_LAG = 1`), so no same-bar information is used. Same rule for the benchmark's rebalances.
- **Modelled cost per fill, deliberately more conservative than R15's zero-spread auction proposal:** LSE = 0.08% commission + half the measured closing spread of that line (source: Saxo `infoprices` snapshot at the close, the repo's first lawful spread source, doc 44 §2.3 — measured in the build phase when the token works; until then the doc 58 method); US = $0 commission + half the measured closing spread from Alpaca `GET /v2/stocks/quotes` at 15:59 ET over 20 sessions per name (build phase) + the SEC/FINRA TAF pass-through on sells at the rates in Alpaca's fee schedule (<https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf>, doc 69 R13 q3). R15's auction-at-print assumption is then a paper-phase check (Q19's ±25% band), not something the verdict leans on.
- **Saxo at-the-close duration** on David's account is unknown (R15); the fallback is R15's limit-at-mid converting to market after a fixed wait, which the paper phase measures.

### 2.9 Parameter grid and trial count (pre-declared)

Two grids are offered; David picks one (§4f). Every cell is a counted trial from #1, both stop variants included (R4). The global counter covers both sub-books (Q19 "every variant tried").

**Grid A — minimal (8 trials).** Bar for DSR ≥ 0.95 at N = 8: observed Sharpe ≈ 0.96.

| Axis | LSE time-series trend | US cross-sectional |
|---|---|---|
| Lookback | 252d trailing return, skip last 21d (12−1) | 252d, skip 21d (12−1) |
| Signal | long if trailing return > 0, else flat | rank; hold top K = 10 |
| Sizing | inverse 60d vol, 10%/yr target per line, gross ≤ 1.0 | equal weight, whole shares |
| Rebalance | monthly, last session | monthly, last session |
| Stop (R4) | none / resting stop at entry − 2 × ATR(20) | none / same |
| Trials | 2 | 2 |

Plus a second lookback (126d) on each side → 8 total. Lookbacks are the two the literature pre-registers (12−1 and 6−1), not searched.

**Grid B — doc 11-shaped (32 trials).** Bar at N = 32: observed Sharpe ≈ 1.16. Adds lookback 63d, weekly rebalance, and for US K ∈ {5, 10}: LSE 3 lookbacks × 2 cadences × 2 stops = 12; US 3 × 2 × 2 × 2 = 24 — capped by dropping K = 5 at 63d to keep 32 (exact cell list written into the trial log before the first run).

**Fixed, not searched (stated so they cannot become hidden trials):** vol-target 10%, ATR multiple 2, ATR window 20, vol window 60, gross cap 1.0, K = 10 in grid A, the execution lag, the cost model, the budget rules, the universe. Any later change to one of these is a new trial under Q5.

### 2.10 Costs

| Item | Value | Source |
|---|---|---|
| Saxo commission | 0.08% per side, no minimum | Q3 (doc 66); measured on David's live account (memory `saxo-live-commission-measured`) |
| Saxo custody fee | 0.12%/yr on ETF/ETC positions, calculated daily, charged monthly, "varies based on country of residence" | <https://www.home.saxo/en-gb/rates-and-conditions/commissions-charges-and-margin-schedule>, re-read 2026-09-22 — **§4c, David's call whether to model it** |
| Saxo FX | none (all lines GBP/GBX) | doc 69 R13 q5 |
| Alpaca commission | $0 | fee schedule, doc 69 R3 |
| Alpaca spread | half the measured closing spread per name | §2.8 |
| US regulatory fees on sells | SEC + FINRA TAF at the schedule's rates | doc 69 R13 q3 |
| Fund TER | not charged separately — it is inside the price series | — |
| GBP/USD | the US sub-book is kept in USD; its P&L enters the GBP budget at a **fixed rate for the year** (the 1 January rate) — an assumption, because G6 excludes FX moves but left the conversion convention to the loss-budget spec (doc 66 "Still open") | §4j |

### 2.11 Loss-budget rules inside the backtest (G10, G6)

Simulated exactly as the live machinery will apply them, on the sleeve's own book:

1. **Reference capital** = the book's equity at 00:00 on 1 January of each backtest year (first year: the start capital). Deposits are not simulated, so "no rebase" is trivially true. *Assumption* — G6 left the reset's reference capital to the loss-budget spec (doc 66 "Still open"); §4j.
2. **Year-to-date net trading loss** = reference capital − current equity (marked at the daily close), FX moves excluded by construction of item 8 in §2.10.
3. Size multiplier: 1 until −£500, then ½; ¼ from −£1,000; **0 from −£1,500** (no new entries, open positions exited at the next rebalance — *assumption*: "halt for the year" is read as flat, §4j). Reset to 1 on 1 January.
4. **Daily cap:** if the day's close-to-close loss ≥ 1.0% of **start capital** (G6(4), doc 66: "exactly 1.0% of start capital" — not the reset reference of §4j), no new entries at the next fill; exits still run.
5. The **benchmark runs under the same rules** at the same capital, so the comparison is like for like (§4e asks David to confirm).
6. **Capital:** the budget is in pounds, so results depend on the start capital. Proposal: run the verdict at **£1,000 total, 70% to momentum (£700), split fixed 50/50 between the two sub-books (£350 each)** — the current book, Q14's split, and a pre-declared sub-book split (Q14's "fixed, pre-declared, never chasing the recent winner" applied one level down) — and report a second pass at £5,000 (G10's ceiling example) for the band; the capital ceiling £1,500 / (max DD × 1.5) is then computed from the £1,000 run's max drawdown. The budget steps apply to the sleeve's book as a whole, not per sub-book. §4f.

### 2.12 Stops (R4)

One stop design, counted as a trial against no stop: a resting stop at entry − 2 × ATR(20), evaluated on raw (unadjusted) prices, moved down by the distribution amount on an ex-date (R8's tighten-neutral rule), never moved up. Filled at the stop price minus half the measured spread (a resting stop is a market order once triggered). Re-entry after a stop only at the next rebalance and only if the signal is still on.

### 2.13 Benchmark: risk-matched buy-and-hold of the same universe

Doc 11's control construction: the identical basket, identical sizing rule (inverse-vol at the same vol target for LSE; equal-weight all members for US), identical rebalance calendar, identical execution lag, identical costs, identical budget rules — and the signal ignored (always long). Risk match is **ex ante** (same vol target and gross cap), with both books' realised vol reported; the kill-line comparison is on Sharpe, which is unit-free, so the ex-post vol difference affects only the drawdown reading. Operationalisation of the haircut: **strategy Sharpe × 0.6 > benchmark Sharpe** (the benchmark has no selection to deflate). *Assumption*, §4e.

### 2.14 Walk-forward and PBO

- **Walk-forward:** anchored is not proposed. Rolling folds: 16 contiguous, non-overlapping folds over the evaluated window (about 8 months each at 10.7 years). Selection inside each training half uses only training returns; the out-of-sample path is the concatenation of test folds. **No fold overlaps**, no purging needed at monthly cadence beyond dropping the first lookback of each test fold's signals (signals are computed from full history, so no test fold's signal uses data after its own decision bar — the look-ahead test in the eval line).
- **PBO:** `pbo()` in `server/tools/backtest/overfitting.ts` over the trial × fold matrix (combinatorially symmetric cross-validation, 12,870 partitions at 16 folds). Pass ≤ 0.10 per G9.
- **Code changes in the build phase (recorded here so the eval can check them):** `KILL_LINE.maxPbo` in `server/tools/backtest/stage2-verdict.ts` (0.05 → 0.10), `max_pbo.max` in `server/shared/threshold-bounds.ts` (0.05 → 0.10), **and** `PBO_REJECT_THRESHOLD` in `server/tools/backtest/overfitting.ts` (0.05 → 0.10) — a third site doc 67 Step 1 does not list, found on reading the file — with their tests.

### 2.15 The strategy is written as the module live code imports

Proposal:

- New directory `server/pipeline/momentum/` holding a pure signal module (`bars in → target weights out`, no I/O, no clock), a sizing module (inverse-vol / equal-weight, whole-share rounding given a price and a capital), the budget-rule state machine, and the stop rule.
- The backtest runner under `server/tools/backtest/` and the Step 3 v2 root both import the same functions; the runner adds only data loading, the fold loop and reporting.
- The eval's "the strategy module is the one live code will import" is checked by grep at the build PR and again at Step 3. This is the postmortem's "backtest = live code" line (doc 66 Language row).

### 2.16 What the run reports

Per trial: annualised return, vol, Sharpe, deflated Sharpe, max drawdown, turnover, cost drag, trades, stop hits, budget-step days, fold table. Per sub-book: the selected trial, PBO, the benchmark's same numbers, the haircut comparison, **pass/fail against the kill line verbatim**, and the capital ceiling £1,500 / (max DD × 1.5). A FAIL is a valid result.

## 3. Rulings this proposal does not touch

Q17's Step 2 verdict (debate sleeve long and short, each a counted trial vs arm 2) and G18 (sentiment/social in the debate sleeve) concern the other sleeve; nothing above depends on or contradicts them. G5's veto shadow book is Step 3. Doc 67's G9 row also names `server/apps/orchestrator/production.ts`, `server/pipeline/feedback-loop/sqlite-tuning-store.ts` and `server/pipeline/risk-manager/risk-thresholds.ts` as 0.05 enforcement points; they read the bound from `server/shared/threshold-bounds.ts`, so the §2.14 change there carries through, and the build phase confirms each with a test rather than assuming it.

## 4. Questions for David (nothing below is decided)

**(a) LSE price-history source — re-ruled 2026-09-22; probe run 2026-09-23.** Saxo holds ten or more years for **22 of the 24 proposed lines** (§6.1). The two that fail are CMFP (broad commodities, 7.6y) and IHCU (US health, 4.9y); neither has a clean substitute, so **whether the ruling's "10 years at £0" branch holds for the whole list is your call**, per role:

- *Broad commodities (row 24).* Option 1: **WCOG** — passes on dates (2016-05-05, 10.4y) but its Saxo series has bars on only 73% of trading days overall and far fewer early on (30 of 167 ISF days in 2016, 84 of 252 in 2017, ~100 of 253 in 2018–19, 185 in 2020, 226 in 2021, then 250 of 250 in 2022 — §6.1); the gaps are spread evenly through every month and the bars that exist carry non-zero volume, which fits a thinly traded line that Saxo prints only on days it trades rather than a hole in the history, but that is inference — a second source would settle it and none is proposed. A momentum signal on a series with ~4 missing days a week in its first five years is a signal on a different, gappier instrument than the one you would trade today. Option 2: drop the role (no commodity line; SGLN/SSLN keep precious metals, subject to §4l). Option 3: keep CMFP and buy its missing history from a vendor — that is doc 68's STOP branch ("report and STOP, do not shorten it") for one line, and no vendor has been priced (**unverified**). Recommendation: **option 2**, with option 1 as a documented fallback only if you want the role and accept the thin early years as-is.
- *US health sector (row 11).* No probed US substitute passes. Option 1: drop the role (22 lines with option 2 above, 23 with option 1). Option 2: XSDR (Europe health care, 15.1y, 100% density) — a different exposure. Option 3: vendor for IHCU's missing years — STOP branch again. Recommendation: **option 1**; a Europe sector is not the US health role and the list does not need it.

With both recommendations the list is 22 lines, every one ≥ 10.3 years at 90%+ bar density except the density notes in §6.1 (CPJ1 81%, ICDU 82%, CUS1 86%). The vendor branch is entered only if you choose option 3 in either role; LSEG Delayed Market Data and paid EOD vendors were not priced and no paid data is proposed. Two things you should know before saying yes: the shortest survivor is IITU at 10.3 years, which with a 12−1 lookback leaves ~9.3 evaluated years (§4g); and the bars carry Saxo's 15-minute delay flag but are end-of-day complete, which does not matter for a close-to-close read.

**Ruled 2026-09-23: "Paid vendor for those lines (STOP)"** — for both the commodities role (CMFP) and the US-health role (IHCU). Doc 68's STOP branch is entered: §8 reports vendor cost and depth before any build, and the LSE sub-book does not start until David picks from §8's options.

**(b) The R12 reporting-fund gate.** Evidence: all 24 proposed LSE lines and all alternates are active HMRC reporting funds by ISIN (§2.2). The momentum sleeve's US half holds *single stocks*, to which the offshore-fund rules do not apply, and it holds **no US ETF**, so SPY's non-reporting status (doc 69 R12) does not touch this sleeve as proposed. Recommendation: adopt doc 69's hard gate (ISIN present, effective date ≤ today, no cessation date, refreshed monthly, failing closed) as a pre-declared universe rule for every fund line in either sleeve; SPY is then excluded wherever it might otherwise appear (debate sleeve, US-ETF extension). Your call whether the gate is universe-wide or momentum-only.

**Ruled 2026-09-23: momentum sleeve only.** SPY may still appear in the debate sleeve.

**(c) Saxo's 0.12%/yr custody fee.** Evidence: the rates page states it for Classic/Platinum accounts on stocks and ETFs/ETCs, daily accrual, monthly charge, varying by country of residence (§2.10); whether it is charged on your GIA is account-shaped and unknown (doc 69 "What only David's accounts can answer"). Recommendation: **model it** at 0.12%/yr on the LSE sub-book's average invested notional (it is at most ~£0.84/yr at £700 fully invested — immaterial to the verdict, but its omission would fail Q19's "costs within ±25%" check for the wrong reason), and confirm on the first live statement.

**Ruled 2026-09-23: model the 0.12%/yr custody fee; confirm against the first live statement.**

**(d) R3's whole-share rule `price ≤ C/(5N)`.** Evidence: doc 69 R3 derives the rule at £700 to momentum (N = 5 admits lines ≤ £28). With §2.11's 50/50 sub-book split the LSE sub-book has **£350**, so N = 5 admits only lines priced ≤ **£14** and N = 3 ≤ £23 — and a 24-line time-series book holding, say, 12 lines at once is nowhere near that. Measured last closes at Saxo, 2026-09-23 (§6.1), for the list of §4a (23 lines shown, including WCOG): **seven lines are ≤ £14** (IUKP £4.39, IGLT £9.62, IESU £9.81, ISF £10.45, INXG £11.06, ICDU £12.21, UIFS £12.23), two just over (WCOG £14.88, VUTY £15.56), ten between £19 and £64 (IJPN £19.30, SPOG £25.72, SPGP £33.65, VMID £37.42, IITU £40.47, SSLN £47.20, IEUX £47.45, IEEM £51.13, IUSA £58.08, SGLN £63.10) and four between £118 and £513 (SLXX £118.26, CPJ1 £185.55, CUKS £287.10, CUS1 £512.40). At £350 an inverse-vol-weighted 23-line book is not holdable in whole shares at all, and even N = 5 admits only the first group. Options: (1) apply the rule as a pre-declared screen and let it pick the cheaper share class in the alternate column, accepting that most roles drop out at £350; (2) run the verdict at a capital where whole-share error is ≤ 10% for the full list (the £5,000 pass in §2.11) and treat £350 as a paper-phase fidelity question; (3) relax the tolerance (rounding error ≤ 25%, `C ≥ 2N·P`); (4) give the whole 70% to one sub-book at £1,000 and add the other only above a capital threshold. Recommendation: **(1) for the verdict run at £1,000 plus (2) as the second pass**, both reported, so you see the executable-at-£350 answer and the signal answer side by side; and an honest note that at £1,000 total the momentum sleeve may not be executable at all with whole shares, which the paper phase would show as a fidelity failure, not the backtest. The US side has the same problem: whole shares at Alpaca (R2's proposal) with K = 10 at £350 is £35 per name — one share of some S&P names and zero of many.

**Ruled 2026-09-23: one sub-book at £1,000 for the verdict, plus a £5,000 second pass reported side by side** (option 4 for the verdict run, option 2 as the second pass). The ruling does not say which sub-book takes the £1,000 or what capital threshold admits the other; the build reads it with (e) — each sub-book is run and judged on its own at £1,000 — and asks David before treating that reading as the ruling.

**(e) Sleeve verdict and benchmark operationalisation.** Each sub-book judged separately, a failing one dropped (§2.1)? Benchmark inside the same budget rules (§2.11 item 5)? Haircut as strategy Sharpe × 0.6 > benchmark Sharpe (§2.13)? Recommendation: yes to all three.

**Ruled 2026-09-23: yes to all three** — per-sub-book verdict with a failing one dropped; benchmark inside the same budget rules; haircut test = strategy Sharpe × 0.6 > benchmark Sharpe.

**(f) Which grid, and at which capital.** Grid A (8 trials, DSR bar ≈ 0.96) or Grid B (32 trials, bar ≈ 1.16) — §2.9 and the §2.7 table. Verdict at £1,000/70% with a £5,000 second pass (§2.11)? Recommendation: **Grid A**; a grid the gate cannot pass is not a test. Note honestly: even Grid A's bar sits above the replication prior's 0.4–0.8, so a FAIL on DSR is the likely outcome for a genuine but ordinary momentum edge. If you would rather the DSR clause be computed differently (for example DSR of the *excess* return with the same 0.95, which §2.7 shows is unpassable, or a lower DSR bar), that is a change to Q19 and is yours to make; this proposal does not make it.

**Ruled 2026-09-23: Grid A, 8 trials.**

**(g) "10y+" — bars or evaluated returns?** Alpaca's floor is 2016-01-04 (§6.2) and the shortest LSE survivor starts 2016-06-21 (IITU, §6.1). With a 12−1 lookback the evaluated window is ~9.7 years on the US side and ~9.3 on the LSE side. Options: accept 9.7 evaluated years on the US side; cap the US lookback at 126 days (~10.2 evaluated years); or stop the US sub-book until a deeper permitted source exists (Q15 names Norgate only after a pass — circular). Recommendation: accept, and state it in the verdict. Not a sentence this proposal can write on its own since Q7 says "10y+".

**Ruled 2026-09-23: accept bars ≥ 10y with evaluated returns ~9.7y US / ~9.3y LSE, stated in the verdict.**

**(h) Haircut sizes for coverage and survivorship.** §2.4's 0.05 Sharpe for missing US names (with the 2% stop rule) and §2.5's *no* separate LSE survivorship haircut are judgments. Keep, change, or set a number?

**Ruled 2026-09-23: haircuts as proposed** — 0.05 Sharpe for missing US delisted names with the 2% coverage stop; none for LSE.

**(i) MinBTL guard target Sharpe.** Run at the prior's 0.6 (23 trials admissible) rather than the code default 1.0 (1,067)? Recommendation: 0.6 — both grids fit.

**Ruled 2026-09-23: MinBTL target Sharpe 0.6.**

**(j) Two conventions G6 left to the loss-budget spec, needed now because the budget runs inside the backtest:** the USD→GBP rate for the US sub-book's P&L (proposal: fixed at each 1 January) and the reset's reference capital (proposal: equity at 1 January). Also whether "halt for the year" at −£1,500 means flat or freeze (proposal: flat at the next fill). Whatever you rule here is written into the loss-budget spec unchanged.

**Ruled 2026-09-23: all three confirmed** — USD→GBP fixed each 1 January; reset reference = equity at 1 January; halt = flat at the next fill. Written into the loss-budget spec unchanged.

**(k) Saxo history retention.** R7 records that keeping multi-year Saxo bars locally is an open point with Saxo. The 2026-09-22 ruling uses Saxo at £0; this proposal stores the bars in the repo's data directory (outside git) for own-use backtesting only. Confirm that is what you intend, or ask Saxo first.

**Ruled 2026-09-23 (David's words): "Github is private repo so you can commit."** Saxo bars are committed to the repo, not gitignored. Proposed location and format, for the build to adopt unless David objects: `data/bars/saxo/<TIDM>.csv` (one file per line, columns `date,open,high,low,close,volume`, GBP, one row per Saxo bar, plus a `manifest.json` with Uic, AssetType, `FirstSampleTime`, fetch date), and `data/bars/alpaca/<SYMBOL>.csv` for the US half if David extends the ruling to Alpaca bars (not asked; **unverified** that Alpaca's terms allow storing them in a repo — the 2026-09-22 ruling said "permitted" for use, not storage). Size: the 40 probed lines hold ~150k bars ≈ 9 MB as CSV; the 24 primaries ~95k bars ≈ 6 MB; parquet would be ~1/5 of that but needs a reader in TypeScript, so CSV. The citation checker scans only `.md`/`.ts`/`.tsx`, so CSV files under `data/` are outside its way; `.gitignore` line "Research bar cache (#787) — never commit market data" covers `docs/research/data/` <!-- cite-exempt: untracked — scratch cache, gitignored --> only and does not touch `data/bars/`, but its comment now contradicts this ruling and should be amended in the build PR. Nothing in `data/` is tracked today.

**(l) Saxo appropriateness test and the ETC lines (added 2026-09-23).** On the 2026-09-23 login, Saxo's live Risk Warning page listed the appropriateness test as **"Not Taken" for Complex ETFs, ETCs and ETNs**, while Stocks, Bonds and plain ETFs showed "Appropriate" (seen by the coordinator; accepted on David's instruction). The proposed list holds four instruments Saxo flags `IsComplex: true` — the ETCs SGLN, SSLN and their alternates PHGP, PHSP — and CMFP (also complex; fails the 10-year test, §4a). WCOG, the commodity replacement, is `IsComplex: false`; every plain ETF probed is `IsComplex: false`. All of them, complex or not, return `IsTradable: true`, `NonTradableReason: "None"` from `ref/v1/instruments/details` (2026-09-23). Cross-reference: doc 69 R13 q6 left "whether Saxo lets David's account trade them (appropriateness test)" **unknown**; the 2026-09-14 entitlements probe (memory `saxo-live-entitlements-probe`, recorded on #895) found `Etc` and `Etn` in the account's `LSE_ETF` **market-data** entitlement — a data fact, not a permission to trade; doc 44 §2 records `IsComplex: true` as "the appropriateness gate, visible in data" and `reg/v2/mifid/appropriateness` returning 403. **The facts do not conflict; they answer different questions.** The reference data says the lines are tradable in principle and flags which ones are complex; the Risk Warning page says the test that MiFID II requires before a retail client trades a complex product has not been taken on this account. Whether Saxo rejects an order in a complex line, or shows a warning and accepts it, is account-shaped and **unknown** — only an order attempt or Saxo's own answer settles it, and neither is proposed here (no orders in this phase). **Question:** (1) will you take the appropriateness test before paper, so gold and silver stay in the list as SGLN/SSLN; or (2) should the list carry no complex line — drop the two ETCs (22 lines, no precious-metals role, since every gold/silver ETC probed is complex) — until it is taken? Recommendation: (1), because gold is the one role in the list with low correlation to everything else (doc 11's wide basket held GLD for that reason), and the test is a one-off; the backtest can run either way, and the list only changes if you choose (2).

**Ruled 2026-09-23: take the appropriateness test before paper; keep SGLN, SSLN, PHGP, PHSP.** The test is David's admin; until it is recorded as taken, the paper phase must not send an order in a complex line.

## 5. Facts relied on and their verification status

| Fact | Status |
|---|---|
| 437 ETF + 20 ETC GBP/GBX lines admitted ≤ 2016-09-22, unlevered, all reporting funds | verified 2026-09-22 (files in §2.2, parsed locally) |
| Every line in §2.2 is an active reporting fund with the effective date shown | verified (ISIN join) |
| Alpaca SIP daily bars from 2016-01-04, delisted names included to their last day | verified (probe, §6.2) |
| `fja05680/sp500` MIT licence, row/ticker counts | verified (GitHub API + file parsed) |
| Saxo custody fee wording | verified (page re-read 2026-09-22) |
| Saxo depth per instrument | verified 2026-09-23 (probe, §6.1): 22/24 primaries ≥ 10y, IHCU and CMFP short |
| WCOG bar gaps are no-trade days rather than missing history | **inferred, unverified** — even spread, non-zero volume on present days, density rising to 100% by 2022 (§6.1); no second source checked |
| Current LSE line prices | verified 2026-09-23 (last close from the same probe, GBX × 0.01 by the LSE list currency; Saxo's own `CurrencyCode` field is not trusted, doc 44) |
| `IsTradable: true`, `NonTradableReason: "None"` on all 24 primaries plus WCOG, PHGP, PHSP, XSDR; `IsComplex: true` on SGLN, SSLN, PHGP, PHSP, CMFP only | verified 2026-09-23 (`ref/v1/instruments/details`, 28 calls, raw responses saved in the session scratch `saxo-details.json`) — tradability in principle, not appropriateness (§4l) |
| Appropriateness test "Not Taken" for Complex ETFs/ETCs/ETNs | reported by the coordinator from the live Risk Warning page, 2026-09-23; **not seen by this session** |
| Saxo bars' corporate-action adjustment | unknown (R8 q3) |
| Count of closed pre-2016 GBP ETF lines (survivorship size) | **unverified** |
| Alpaca data terms permitting this automated use | not re-read here; rests on David's 2026-09-22 ruling ("permitted") |
| LSEG DMD / paid EOD vendor cost and depth | **unverified** — not priced; only needed if Saxo is shallow |
| DSR/MinBTL bars in §2.7 | computed with the repo's own functions, 2026-09-22 |

## 6. Probe records

### 6.1 Saxo `chart/v3` depth (run 2026-09-23, live gateway, GET only, token held in memory)

Calls, per TIDM in §2.2 and its alternates, on `https://gateway.saxobank.com/openapi`:

1. `GET /ref/v1/instruments?Keywords=<TIDM>&AssetTypes=Etf,Etc,Etn&ExchangeId=LSE_ETF&IncludeNonTradable=true` → `Identifier` (Uic), `AssetType`.
2. `GET /chart/v3/charts?Uic=<uic>&AssetType=<type>&Horizon=1440&Count=1200&FieldGroups=ChartInfo,Data` (no `Mode` on the first call — `Mode=UpTo` without `Time` is a 400 "Time is not provided") → last bar, last close, `ChartInfo.FirstSampleTime`.
3. Page back with `&Mode=UpTo&Time=<earliest Time seen>` until a page returns fewer than 1,200 raw bars; the paging test is on the raw page length, because the earliest bar of each page repeats on the next and a filtered count of 1,199 stops one page early.
4. `GET /ref/v1/instruments/details/<uic>/<type>` → `IsTradable`, `NonTradableReason`, `IsComplex` — run in a second pass on 2026-09-23 for the 24 primaries plus WCOG, PHGP, PHSP and XSDR (28 calls, all 200), after the eval round found the first pass had not saved these responses.
5. `GET /chart/v3/charts?…&Count=300&Mode=UpTo&Time=<YYYY>-12-31T23:59:00Z` for WCOG and ISF, one call per year 2016–2022 → the set of bar dates per year, to test whether WCOG's low bar count is missing history or no-trade days (14 calls, all 200).

No order endpoint was called. Pass per line = earliest bar ≤ 2016-09-22 (ten years before the probe). Years = (last bar − earliest bar)/365.25. Prices are the last daily close, converted from GBX at the LSE list's currency for the line. Density = bars / (years × 252). † = a §2.2 primary; unmarked rows are alternates.

| TIDM | Uic | Type | Earliest bar | Bars | Density | Last bar | Last close | Years | 10y |
|---|---|---|---|---|---|---|---|---|---|
| ISF † | 4361 | Etf | 2000-04-28 | 6,676 | 100% | 2026-09-23 | £10.45 | 26.4 | PASS |
| CUKX | 1322714 | Etf | 2011-02-04 | 3,597 | 91% | 2026-09-23 | £221.70 | 15.6 | PASS |
| VMID † | 1207647 | Etf | 2014-10-01 | 3,027 | 100% | 2026-09-23 | £37.42 | 12.0 | PASS |
| CUKS † | 435060 | Etf | 2010-09-22 | 3,616 | 90% | 2026-09-22 | £287.10 | 16.0 | PASS |
| IUSA † | 19727 | Etf | 2002-03-19 | 5,878 | 95% | 2026-09-23 | £58.08 | 24.5 | PASS |
| CSP1 | 53895 | Etf | 2010-09-15 | 3,455 | 86% | 2026-09-23 | £629.60 | 16.0 | PASS |
| VUSA | 311665 | Etf | 2012-05-23 | 3,616 | 100% | 2026-09-23 | £110.58 | 14.3 | PASS |
| CUS1 † | 53915 | Etf | 2011-08-01 | 3,268 | 86% | 2026-09-23 | £512.40 | 15.1 | PASS |
| IEUX † | 53888 | Etf | 2011-08-02 | 3,827 | 100% | 2026-09-23 | £47.45 | 15.1 | PASS |
| VERX | 1207324 | Etf | 2014-10-03 | 3,022 | 100% | 2026-09-23 | £42.77 | 12.0 | PASS |
| IJPN † | 19726 | Etf | 2004-10-04 | 5,561 | 100% | 2026-09-23 | £19.30 | 22.0 | PASS |
| CSJP | 53900 | Etf | 2011-07-08 | 3,172 | 83% | 2026-09-23 | £228.56 | 15.2 | PASS |
| CPJ1 † | 969857 | Etf | 2010-09-28 | 3,244 | 81% | 2026-09-23 | £185.55 | 16.0 | PASS |
| VAPX | 7962188 | Etf | 2013-05-22 | 3,307 | 98% | 2026-09-23 | £35.02 | 13.3 | PASS |
| IEEM † | 21528 | Etf | 2005-11-21 | 5,275 | 100% | 2026-09-23 | £51.13 | 20.8 | PASS |
| SEMA | 49873 | Etf | 2009-09-28 | 4,103 | 96% | 2026-09-23 | £49.57 | 17.0 | PASS |
| VFEM | 4016593 | Etf | 2012-05-23 | 3,603 | 100% | 2026-09-23 | £62.59 | 14.3 | PASS |
| IITU † | 9404259 | Etf | 2016-06-21 | 2,519 | 97% | 2026-09-23 | £40.47 | 10.3 | PASS |
| IHCU † | 25583531 | Etf | 2021-10-21 | 1,242 | 100% | 2026-09-23 | £10.33 | 4.9 | **FAIL** |
| IESU † | 56577302 | Etf | 2015-12-03 | 2,470 | 91% | 2026-09-23 | £9.81 | 10.8 | PASS |
| UIFS † | 9140117 | Etf | 2016-06-20 | 2,521 | 98% | 2026-09-23 | £12.23 | 10.3 | PASS |
| ICDU † | 56577120 | Etf | 2016-01-28 | 2,197 | 82% | 2026-09-23 | £12.21 | 10.7 | PASS |
| SPGP † | 117643 | Etf | 2011-09-22 | 3,755 | 99% | 2026-09-23 | £33.65 | 15.0 | PASS |
| SPOG † | 3669356 | Etf | 2011-10-10 | 3,549 | 94% | 2026-09-23 | £25.72 | 15.0 | PASS |
| IUKP † | 37368 | Etf | 2007-03-20 | 4,928 | 100% | 2026-09-23 | £4.39 | 19.5 | PASS |
| IGLT † | 52706 | Etf | 2006-12-04 | 4,791 | 96% | 2026-09-23 | £9.62 | 19.8 | PASS |
| VGOV | 303942 | Etf | 2012-05-23 | 3,514 | 97% | 2026-09-22 | £15.30 | 14.3 | PASS |
| INXG † | 205626 | Etf | 2006-12-04 | 5,000 | 100% | 2026-09-23 | £11.06 | 19.8 | PASS |
| SLXX † | 275764 | Etf | 2004-03-30 | 5,678 | 100% | 2026-09-23 | £118.26 | 22.5 | PASS |
| VUTY † | 7962187 | Etf | 2016-03-03 | 2,492 | 94% | 2026-09-22 | £15.56 | 10.6 | PASS |
| SGLN † | 54130 | Etc | 2011-04-14 | 3,876 | 100% | 2026-09-23 | £63.10 | 15.4 | PASS |
| PHGP | 2831570 | Etc | 2007-10-29 | 4,776 | 100% | 2026-09-23 | £301.57 | 18.9 | PASS |
| SSLN † | 117644 | Etc | 2011-04-14 | 3,827 | 98% | 2026-09-23 | £47.20 | 15.4 | PASS |
| PHSP | 3671765 | Etc | 2007-10-29 | 4,731 | 99% | 2026-09-23 | £45.16 | 18.9 | PASS |
| CMFP † | 12264631 | Etf | 2019-02-20 | 1,914 | 100% | 2026-09-22 | £24.95 | 7.6 | **FAIL** |
| XDBG | 20880150 | Etf | 2021-01-12 | 1,428 | 100% | 2026-09-22 | £52.33 | 5.7 | **FAIL** |
| WCOG | 53407473 | Etf | 2016-05-05 | 1,910 | 73% | 2026-09-23 | £14.88 | 10.4 | PASS |
| WCOB | 22101172 | Etf | 2021-03-22 | 1,388 | 100% | 2026-09-22 | £17.73 | 5.5 | **FAIL** |
| XSDR | 53907 | Etf | 2011-08-02 | 3,738 | 98% | 2026-09-23 | £192.68 | 15.1 | PASS |
| IUSP | 53899 | Etf | 2007-06-13 | 4,796 | 99% | 2026-09-23 | £23.71 | 19.3 | PASS |

**Per-line verdict:** 22 of the 24 primaries pass; **IHCU** (4.9y) and **CMFP** (7.6y) fail. Of the alternates, WCOG (10.4y) and XSDR (15.1y) pass; XDBG and WCOB fail. Earliest bars run from 2000-04-28 (ISF) to 2021-10-21 (IHCU); the binding survivor is IITU at 10.3y, then UIFS 10.3y, WCOG 10.4y, VUTY 10.6y, ICDU 10.7y.

**List-level verdict:** 22 of the 24 original lines pass. What happens to the other two roles — WCOG with its density caveat, a drop, or a vendor for the missing years — is David's call in §4a; whether the 2026-09-22 ruling's £0 branch holds for the list depends on that call. This document does not conclude that doc 68's STOP branch is avoided.

**Bar density.** Eleven of the 40 lines print fewer than 95% of a 252-day year: WCOG 73%, CPJ1 81%, ICDU 82%, CSJP 83%, CSP1 86%, CUS1 86%, CUKS 90%, CUKX 91%, IESU 91%, SPOG 94%, VUTY 94%. Of the primaries in the §4a list that is CPJ1, ICDU, CUS1, CUKS, IESU, SPOG and VUTY. A daily series short of ~252 bars/yr has days with no bar, and the coverage invariant on windowed reads (CLAUDE.md, postmortem §2) must count those days when the bars are used; the build phase runs the same per-year date comparison against ISF for every line below 95% before any bar is consumed.

**WCOG gap test (step 5).** ISF trading days without a WCOG bar: 2016 (from WCOG's 2016-05-05 start) 223 of 253 ISF days that year, i.e. WCOG printed 30 bars; 2017 **168 of 252** (84 WCOG bars); 2018 149 of 253 (104); 2019 154 of 253 (99); 2020 69 of 254 (185); 2021 27 of 253 (226); **2022 0 of 250** (250). In 2017 the missing days are spread across every month (8–19 per month), the 84 bars that exist all have non-zero volume (median 5,390 shares against ISF's 3.1M), and no WCOG bar falls on a non-ISF day. That pattern fits a thinly traded line whose history Saxo prints only on days a trade occurred, not a block of lost history — but the two are indistinguishable from Saxo alone and no second source was checked, so it stays **inferred**. Either way WCOG does **not cleanly satisfy the 10-year branch**: its first five years are ~27–73% dense and its dense history begins in 2021. Raw dates and volumes are saved in the session scratch `saxo-details.json`.

**Rate limits and errors:** headers observed `x-ratelimit-chartminute-limit: 120`, `x-ratelimit-refdatainstrumentsminute-limit` present, `x-ratelimit-appday-limit: 10000000`. One **429** burst hit the chart limit (120/min) on the last four lines of the first pass; it cleared after ~65 s and those lines were re-run in a second pass. **No 401** in the run (the 2026-09-22 401s were an expired token, replaced on 2026-09-23 by `npm run saxo:login`). Every other call returned 200, including all 42 second-pass calls (steps 4–5). Latency 0.12–0.84 s per call. Every chart response carried `DelayedByMinutes: 15` — irrelevant to a daily close-to-close read but consistent with the delayed-data finding in doc 44. Raw responses are in the session scratch directory (`saxo-depth-main.json`, `saxo-depth-tail.json`, `saxo-depth-tail2.json`, `saxo-details.json`), not in the repo. The second pass found the token file's access token expired and used the refresh grant in memory (201, `expires_in` ~1200 s); the new access token was not written anywhere.

### 6.2 Alpaca daily-bar depth (run 2026-09-22, read-only, keys from `.env.local`)

`GET https://data.alpaca.markets/v2/stocks/bars?symbols=<S>&timeframe=1Day&start=2000-01-01&limit=3&sort=asc&feed=<feed>&adjustment=all`

| Symbol | SIP earliest | IEX earliest | Series end (SIP) | Note |
|---|---|---|---|---|
| SPY | 2016-01-04 | 2018-11-01 | 2026-09-22 (2,695 bars) | |
| VOO, IVV, QQQ, AAPL, MSFT, XOM | 2016-01-04 | 2020-07-27 | live | |
| TWTR | 2016-01-04 | 2020-07-27 | 2022-10-27 (1,718 bars) | delisted at acquisition; series ends on the day |
| XLNX | 2016-01-04 | 2020-07-27 | 2022-02-11 (1,540) | delisted at acquisition |
| CELG | 2016-01-04 | none | 2019-11-20 (979) | delisted at acquisition |
| YHOO | 2016-01-04 | none | 2017-06-16 (367) | delisted |
| MON | 2016-01-04 | 2021-03-18 | 2022-12-23 (1,758) | **Monsanto delisted 2018-06-07; the series continues 4.5 years with no gap > 30 days. What trades as MON after 2018 is unverified — evidence that ticker-level bars must be bounded by the membership window (§2.3).** |

Rate limit: `X-Ratelimit-Limit: 200` (per minute), reset header present. No 429 at ~3 requests/second.

### 6.3 Point-in-time S&P 500 coverage on Alpaca SIP (run 2026-09-22)

For each of the 745 distinct tickers appearing in a membership row dated ≥ 2016-01-04: one SIP request for a single daily bar inside [first membership date, last membership date].

| Measure | Value |
|---|---|
| Distinct member tickers, rows ≥ 2016-01-04 | 745 |
| Tickers with ≥ 1 SIP bar inside their membership window | **741** |
| Tickers with none | **4** — AABA (window to 2017-06-16), STI (to 2019-12-05), TE (to 2016-06-27), WYND (to 2018-05-24) |
| Missing tickers still members today | 0 |
| Missing member-days / total member-days (calendar days, windows clipped at 2016-01-04) | 3,010 / 1,964,696 = **0.15%** |

So `m` = 0.15%, far under §2.4's 2% stop rule. Two of the four look like dataset quirks rather than data gaps (AABA is the post-2017 name of YHOO, which Alpaca does serve; the dataset lists AABA from 2016), and none affects a current member. HTTP: 745 requests at ~3/s, no 429, no non-200.

## 7. What happens after approval

The build phase as doc 68 Session B states it: TypeScript under the module layout in §2.15; `overfitting.ts` reused; the three 0.05 → 0.10 changes in §2.14 with tests; the Saxo probe already run and recorded (§6.1), to be re-run only if the list changes, plus the per-line date comparison against ISF for every line under 95% density; costs per §2.10 with David's rulings on (c) and (j); both stop variants; the budget rules per §2.11; walk-forward per §2.14; the kill line applied verbatim; one PR, never merged by the session; the doc 68 session eval run on the PR. 22 of 24 lines meet the 10-year test (§6.1); for the two that do not, doc 68's STOP branch ("if the approved data source cannot supply 10 years, report and STOP, do not shorten it") is entered or avoided by David's answer to §4a — a drop avoids it, WCOG avoids it on dates only, a vendor enters it. David's answer (2026-09-23) was the vendor branch; §8 is the STOP report, and the build does not start on the LSE side until he picks from §8.4.

## 8. STOP-branch report — the two lines Saxo cannot supply (ruling (a), 2026-09-23)

Doc 68: "if the approved data source cannot supply 10 years, report and STOP, do not shorten it." David chose the vendor branch for both roles; this section is that report. Nothing was bought, signed up for, or emailed. Every figure carries its URL; anything not fetched is marked **unverified**.

### 8.1 Does the missing depth exist anywhere?

| Line | Fund inception | LSE GBX line admitted | Saxo series starts | Gap Saxo lacks | Sources |
|---|---|---|---|---|---|
| **IHCU** (iShares S&P 500 Health Care Sector UCITS ETF USD Acc, IE00B43HR379) | **2015-11-20** | **2015-11-23** (GBX line IHCU; USD line IUHC same day) | 2021-10-21 (Uic 25583531) | 2015-11-23 → 2021-10-20, ~5.9 years | inception: justETF <https://www.justetf.com/en/etf-profile.html?isin=IE00B43HR379> ("20 November 2015"; iShares' own product page <https://www.ishares.com/uk/individual/en/products/280507/ishares-sp-500-health-care-sector-ucits-etf> does not render the date to a fetch — **inception unverified at the issuer**); admission: LSE instrument list (R12 source, parsed §2.2) |
| **CMFP** (L&G Longer Dated All Commodities UCITS ETF, IE00B4WPHX27) | **2010-03-18** | **2010-03-18** (GBX line CMFP; USD line COMF same day) | 2019-02-20 (Uic 12264631) | 2010-03-18 → 2019-02-19, ~8.9 years | inception: justETF <https://www.justetf.com/en/etf-profile.html?isin=IE00B4WPHX27> ("18 March 2010", synthetic, Bloomberg Commodity 3 Month Forward); admission: LSE list |

So for **both** lines the GBP LSE line was listed well before 2016-09-22 and the fund is old enough: the ten years exist at the exchange, and Saxo's series is short because Saxo's own history for the Uic starts late, not because the line is young. A vendor that holds LSE ETF history from listing can, in principle, supply both in full — subject to §8.2's caveat that no vendor's coverage of these two specific tickers was confirmed. Ten years from IHCU's admission is 2025-11-23, so IHCU clears the bar by ~10 months; any vendor gap in its first year would fail it.

**Sibling lines at Saxo — not probed.** The USD lines IUHC and COMF, and the fund's other listings, might carry longer Saxo history than the GBX Uics (option (i) in the task: splice a sibling and convert at the daily GBP/USD rate). The probe for them (`saxo-siblings.json` in the session scratch, empty) hit **401 on every token including the refresh grant** on the afternoon of 2026-09-23 — the two second-pass probes earlier that day had used the refresh grant in memory, which rotates the refresh token, and the rotated token was deliberately not written back to `data/saxo-tokens/live.json` <!-- cite-exempt: untracked — token store is gitignored -->. A fresh `npm run saxo:login` is needed before this can be tested. **Unverified**, and cheap to check (6 instrument searches + a few chart pages).

**Same-role substitutes that reach 10 years at Saxo (option (ii)).** Commodities: only WCOG was found (10.4y on dates, 73% density, §6.1); XDBG and WCOB fail. US health: none; XSDR is Europe health. The doc 69 R14 screen (437 unlevered GBP ETF lines admitted ≤ 2016-09-22) was not re-run per role for this report — **unverified** whether another broad-commodity or US-health GBP line exists with ten years *at Saxo*, and the Saxo half of that check needs the token above.

### 8.2 Vendors with LSE ETF daily history

Web research only, 2026-09-23. "Carries IHCU/CMFP" was not confirmable for any vendor without an API key; every vendor below documents LSE coverage generically.

| Vendor | Product / plan | Price | Stated LSE ETF depth | Terms on backtest use | Carries the two lines? | Source |
|---|---|---|---|---|---|---|
| **EODHD** | "EOD Historical Data — All World" | **£19.99/month, or £199.90/year (£16.66/mo)**; minimum one month | "30+ years" on the plan; product page shows `BP.LSE` from **1988-07-01**; search result states non-US history "primarily dating back to January 3, 2000" (**unverified** on the page itself); LSE updated "2-3 hours after the market closes"; includes ETFs, splits/dividends, adjusted close, delisted data | Plan is **"Personal use"**; "For commercial use, choose Startups & Enterprise Data Solution Plan" — a private individual's own-account backtest reads as personal use, **unverified** against the full terms | Ticker convention `IHCU.LSE`, `CMFP.LSE`; the public per-ticker pages returned 404 to a fetch, so **unverified** | pricing <https://eodhd.com/pricing>; product <https://eodhd.com/financial-apis/api-for-historical-data-and-volumes>; exchanges <https://eodhd.com/financial-apis/list-supported-exchanges/> |
| **Marketstack** (apilayer) | Basic / Professional | **$9.99/mo (Basic, 10 years history) / $49.99/mo (Professional, "15+ Years History")**; Free = 1 year, non-commercial | "70 Stock Exchanges"; London not named on the plan page — **unverified** for LSE ETFs | Paid plans state "Commercial Use" | **unverified** | <https://marketstack.com/product> |
| **Twelve Data** | Grow / Pro | **$29/mo (Grow, "global EOD equities", "20+ markets") / $99/mo (Pro, "70+ markets")** | depth not stated on the pricing page — **unverified**; LSE referenced as available | plan copy is personal-use ("hobby projects", "personal use") | **unverified** | <https://twelvedata.com/pricing> |
| **Alpha Vantage** | Premium | **$49.99/mo (75 req/min) to $249.99/mo** | not stated on the premium page; LSE coverage via `LON:` symbols is **unverified** here | not stated — **unverified** | **unverified** | <https://www.alphavantage.co/premium/> |
| **LSEG Delayed Market Data** (doc 69 R14's first paid candidate) | Delayed (15-min) data licence, free of licence fees for own use without redistribution | **no retail price found**; the DMD portal page renders no content to a fetch, the LSEG equities page names no product or price | it is a **delayed-data** offer, not an historical-depth product — LSEG's end-of-day/tick history is an enterprise product with no published price | not applicable to history | not applicable | <https://dmd.lseg.com/>; <https://www.lseg.com/en/data-analytics/financial-data/pricing-and-market-data/equities-market-data/lse-market-data>; policy <https://docs.londonstockexchange.com/sites/default/files/documents/schedule-b-market-data-policy-2026.pdf> (not read here) |
| Yahoo / Stooq | — | £0 | — | **refuted / gated** (doc 69 R14 q2) | — | doc 69 |
| Norgate, Tiingo, Polygon, Databento | — | — | US/AU/CA-centred; LSE ETF coverage **unverified**, not checked | — | — | not fetched |

Reading: the only vendor whose page states both LSE coverage and a depth that reaches 2010 is EODHD, at £199.90/year (or £19.99 for one month to pull the history once, if David's ruling (k) — commit the bars — is read as allowing a one-off pull; whether a one-month "personal use" licence permits keeping the data after the month ends is **unverified** and must be read in EODHD's terms before buying). Marketstack's Basic tier is cheaper but its LSE ETF coverage and history for these two tickers are unverified, and its Basic tier's "10 years" is exactly the bar with no margin.

### 8.3 What the vendor data would and would not fix

- It fills the Saxo gap for the two roles' *history*. Live trading still runs on Saxo bars, so the backtest would run on a series (vendor 2010/2015 → 2019/2021, Saxo after) that is not the series paper and live read. Doc 66 Q19's "costs within ±25%" fidelity band is about costs, not prices, but a splice point is a discontinuity the coverage invariant (postmortem §2) must mark, and the verdict must state it.
- Vendor bars are exchange consolidated closes; Saxo bars are whatever Saxo's feed printed. For a daily close-to-close signal the difference is small but **unmeasured**; the build phase should overlap the two sources for the years both hold (2019–2026 for CMFP, 2021–2026 for IHCU) and report the disagreement before either is used.
- It does not answer §6.1's density finding for the seven under-95% primaries (CPJ1, ICDU, CUS1, CUKS, IESU, SPOG, VUTY); those are Saxo-only lines and are not in this STOP branch.

### 8.4 Options for David (not decided)

1. **EODHD one month, £19.99, pull the full history for CMFP and IHCU (and, at no extra cost, every line in the list as a cross-check on Saxo), commit under `data/bars/eodhd/` <!-- cite-exempt: planned — only if the EODHD fallback is taken --> per ruling (k), then cancel.** Cheapest path that a page actually documents as reaching 2010 on LSE. Blockers: the ticker coverage and the personal-use terms on retained data are unverified — read the terms and confirm the two tickers exist (the free 20-calls/day key can confirm existence before paying) first.
2. **EODHD annual, £199.90/year, kept as the LSE history source for the life of the system.** Same coverage caveat; removes the retention question; makes the Saxo-vs-vendor splice permanent (backtest on vendor, live on Saxo) — the overlap test in §8.3 then matters every year.
3. **Probe Saxo's sibling Uics (IUHC, COMF and the fund's other listings) after a fresh login, and splice/convert if one reaches 2016-09-22.** £0, a few read-only calls, but it needs a `saxo:login` and the outcome is unknown; a USD-line splice adds a daily FX conversion to the history that the GBX line never had.
4. **Re-screen the R14 list per role for another GBP line with ten years at Saxo, and swap roles rather than buy data.** £0, one session; changes the pre-declared list (the swap must be recorded before any trial is run, or it counts as one).
5. **Drop the two roles (22 lines) and buy nothing** — the option David declined on 2026-09-23; listed only so the ordering is visible.

Recommendation: **3, then 1** — run the free Saxo sibling probe first because it costs one login; if no sibling reaches 2016-09-22, buy one month of EODHD after confirming the two tickers on the free key and reading the retained-data terms, and record the vendor's earliest bar per line in §6.1 alongside Saxo's. Option 2 only if the overlap test in §8.3 shows Saxo's own series is not good enough to trade against, which nothing so far suggests.

## 9. Build-phase results (run 2026-09-24)

Branch `build/v2-session-b-momentum`, run from the committed bars with `npx tsx server/tools/backtest/momentum/run.ts --venue us`. Everything below replays byte-identically from the repository (`data/bars/`, `data/backtest/momentum/`); no LLM calls, no paid data. Rulings (a)–(l) in §4 were applied as written; where a ruling left a choice, the choice is recorded under "Interpretations" and can be re-run the other way.

### 9.1 US sub-book result: FAIL, all four passes

**Kill line, verbatim (doc 68 Session B):** *"fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10 (G9). Report pass/fail with numbers and the max drawdown. No LLM calls, no paid data."*

Evaluated window 2017-01-31 to 2026-09-23 (**9.64 years**, ruling (g): bars from 2016-01-04, the first 252 sessions are lookback); walk-forward out-of-sample path 2017-09-07 to 2026-09-23 (folds 2–16 of 16). Trials 5–8 of Grid A (§2.9), counted 8 from #1 (ruling (f)); MinBTL at target Sharpe 0.6 is 18 trials, so 8 is within (ruling (i)). Coverage: **0.3% of member-sessions** without a bar across 40 names, inside the 2% stop; the 0.05 Sharpe delisting haircut is applied (ruling (h)).

| Pass | WF strategy Sharpe | − 0.05 haircut, × 0.6 | Benchmark Sharpe (fractional, same budget) | Beats? | DSR (selected trial, N = 8) | DSR (WF path) | PBO (CSCV, 16 folds) | WF max DD strategy / benchmark | Capital ceiling £1,500 / (DD × 1.5) | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| £1,000, whole shares | 0.856 | **0.483** | 0.679 | no | 0.883 (#7) | 0.865 | 0.255 | 21.7% / 37.1% | £4,609 | **FAIL** |
| £1,000, fractional | 0.601 | **0.330** | 0.679 | no | 0.801 (#7) | 0.634 | 0.771 | 34.2% / 37.1% | £2,888 | **FAIL** |
| £5,000, whole shares | 0.526 | **0.286** | 0.635 | no | 0.713 (#7) | 0.548 | 0.824 | 29.3% / 23.9% | £2,798 | **FAIL** |
| £5,000, fractional | 0.531 | **0.289** | 0.635 | no | 0.690 (#6) | 0.554 | 0.952 | 35.7% / 23.9% | £2,801 | **FAIL** |

Numbers above are the 2026-09-25 re-run after the three simulator fixes in §9.7; the first run's figures are in §9.7 for comparison.

16 configurations were simulated (4 trials × 4 capital/share-mode passes) and N = 8 was used for DSR and MinBTL. Capital and share mode are selection dimensions, so if David authorises a second US grid the passes count in N against the MinBTL limit of 18.

Every pass fails all three gates, not one: the haircut Sharpe is below the benchmark's, DSR is 0.69–0.88 against 0.95, and PBO is 0.26–0.95 against 0.10. Per-trial full-window numbers (Sharpe, CAGR, vol, max DD, fills, stop hits, budget-step days) are in `data/backtest/momentum/us/verdict.md`; the JSON per pass carries the fold matrix and the per-fold selection.

What the numbers say, without spin:

- **The 40% haircut decides one pass; the other three fail before it.** At £1,000 whole shares the walk-forward path picks trial #7 (K = 10, no stop) in every fold and reaches 0.856 against the benchmark's 0.679, so it beats the benchmark unhaircut and fails only after the haircut (0.483), and on DSR (0.883) and PBO (0.255). In the other three passes the unhaircut walk-forward Sharpe (0.53–0.60) is already below the benchmark (0.64–0.68).
- **PBO of 0.82–0.95 at £5,000** means the trial that looks best in training is, out of sample, usually the worst of the four — the four US trials are interchangeable noise around the benchmark plus turnover.
- **Whole-share sizing at £1,000 is a different strategy.** With K = 10 equal weight, each slot is £100 and 441–532 monthly slot targets (of roughly 116 rebalances × 10 slots) round to zero shares (per-trial "zero-share targets" column), so the book holds about half its intended names (402–532 per trial after the §9.7 fixes). The fractional pass is the signal's true test and also fails.
- **The loss budget binds at £5,000 and never at £1,000.** At £1,000 no year's loss reached −£500 (the equity curve in the verdict JSON never falls £500 below a 1 January mark); at £5,000 trial #5 halted for 201 days of one year (−£1,500 reached, ruling (j) halt latched to 31 December) and #6–#8 spent 76–384 days at half size; #7 fractional halted for 203 days. The daily 1% cap blocked entries on 216–601 sessions per trial across passes.
- **Stops (trials 6 and 8, entry − 2 × ATR(20), never moved up) fired 184–404 times** per pass and reduced max drawdown (e.g. 25.0% vs 47.5% for #6 vs #5 at £5,000 whole) but not enough to change the verdict; the with-stop trials do not clear any gate either.

**Per ruling (e) the US momentum sub-book is dropped from the momentum sleeve as specced.** The open question here — a second pre-declared US grid (trials 9–N against MinBTL 18) or LSE-only — was **ruled 2026-09-25 (doc 66, Session B (m)): LSE-only.** No second US grid; the momentum sleeve is the LSE sub-book alone if it passes; if it fails too, the momentum sleeve is dead and v2 is debate-only pending a further ruling.

### 9.2 LSE sub-book: not run — awaiting bars (STOP branch route)

Ruling (a) routes CMFP and IHCU through Saxo sibling Uics first, EODHD one month as the fallback. Neither has happened: there was no valid Saxo live token this session (`data/saxo-tokens/live.json` <!-- cite-exempt: untracked — token store is gitignored --> holds a dead refresh token; the Saxo API was not called and `saxo:login` was not run, per the session brief). The window was not shortened and no proxy was substituted. The code path is built and tested on synthetic fixtures (`server/tools/backtest/momentum/run.test.ts`, "runs the LSE sub-book from a Saxo bar directory").

To run it once bars land, put one `<TIDM>.csv` per line under `data/bars/saxo/` <!-- cite-exempt: planned — created when the LSE bars land --> (header `date,open,high,low,close,volume` or the seven-column Alpaca layout) with a `manifest.json` of the form `{ "calendar_reference": "<TIDM>", "symbols": { "<TIDM>": { "half_spread_bps": <measured> } } }`.
The format is also in `data/bars/README.md`. Then

```
npx tsx server/tools/backtest/momentum/run.ts --venue lse
```

which writes `data/backtest/momentum/lse/verdict-{1000,5000}-{whole,fractional}.json` and `verdict.md` and appends trials 1–4 to `data/backtest/momentum/trials.json`. The Saxo bar puller itself is not written (no token to test it against); doc 44 §2.2 has the `chart/v3` paging recipe.

### 9.3 Interpretations made in the build (re-runnable the other way)

1. **Benchmark for the verdict is always fractional-share.** The whole-share benchmark at £1,000 is degenerate — equal weight over ~500 names at £2 a slot rounds every target to zero (58,020 zero-share targets, 13 fills in 9.6 years, Sharpe −0.59) — so a whole-share strategy pass compares against the fractional benchmark. The same-mode benchmark row is reported alongside for the record.
2. **Walk-forward selection by expanding-window training Sharpe.** Fold *f* (2..16) trades the trial with the best annualised Sharpe over folds 1..*f*−1; the out-of-sample path is folds 2–16 stitched. Fold 1 is training only.
3. **DSR is reported twice:** on the selected trial (best full-window Sharpe in the sub-book) deflated over N = 8 with the observed skew and kurtosis — this is the gate value — and on the walk-forward path itself. Both are below 0.95 in every pass.
4. **Stops evaluate on the adjusted series**, entry price and ATR both from `adjustment=all` bars; whole-share counts come from `raw_close`. A stop hit fills at the stop level less half spread, or at the open if the open gapped through it.
5. **Daily cap breach on a decision day drops that month's buys**, sells still run; the next entry opportunity is the next month end. This is the strictest reading of "blocks entries".
6. **Custody 0.12%/yr (ruling (c)) accrues daily on invested value, LSE only**; the US passes carry no custody line.
7. **Coverage `m` is member-sessions without a bar**, per §2.4, not files. The 40 names include ticker reuse (STI, TE), late SIP history (AABA, WYND) and names whose membership overlaps a gap in SIP; the list is in `data/backtest/momentum/us/verdict.md`. The pre-build probe in §6.3 measured 0.15% by calendar member-days on a single-bar request per name; the run measures 0.3% on every session.
8. **The R3 whole-share screen `price ≤ C/(5N)` was not applied.** Ruling (d) names the two capital passes, not the screen, so `withinWholeShareTolerance` (built in the first commit, never called by the runner) was deleted rather than left as a tested mechanism nothing calls; the whole-share passes report zero-share targets instead (441–532 per trial at £1,000). Re-add with a spec that wires it.
9. **US half spreads were measured over 10 sessions, not the 20 §2.8 proposed.** 503 names × 20 sessions is ~10,000 quote calls at the 200/min data-API limit; 10 sessions took ~50 minutes inside the session and the cross-sectional median (1.34 bps) is stable at the precision the cost model uses. The sampler's 15:59 ET window was computed as a fixed 19:59Z at the time (correct only under EDT, which held for all ten sessions); it now resolves America/New_York per date.

### 9.4 Data committed (ruling (k))

- `data/bars/alpaca/`: 746 CSVs (745 point-in-time members + SPY), 1,761,296 bars, 2016-01-04 to 2026-09-23, `feed=sip`, adjusted OHLCV plus `raw_close`. **86 MB on disk, ~32 MB packed in git.** `manifest.json` records per-symbol first/last/count; `missing` is empty.
- `data/bars/alpaca-spreads.csv`: 503 current members, median half spread from one SIP quote at or after 15:59:00 ET on each of the ten sessions 2026-09-10 to 2026-09-23. **Cross-sectional median 1.34 bps** (p25 0.88, p75 2.05, min 0.15 AAPL, max 7.02); names without a row take 1.34 bps.
- `data/bars/sp500-constituents.csv`: `fja05680/sp500`, MIT, rows from 2016-01-04 (489 rows); sha256 of the full source file in `data/bars/README.md`.
- `data/bars/fx/gbpusd-boe-xudluss.csv`: BoE XUDLUSS, OGL v3, converted once per calendar year at the last rate on or before 1 January (ruling (j)).
- `.gitignore`: the `#787` line that said market data is never committed is amended to say only the `docs/research/data/` <!-- cite-exempt: untracked — scratch cache, gitignored --> research cache stays out; `data/bars/` and `data/backtest/` are tracked.

### 9.5 Code shipped

- `server/pipeline/momentum/`: `bars` (sorted-unique-date invariant, `windowCoverage`/`coverageSatisfied` on every windowed read), `signal` (time-series trend, cross-sectional top-K), `sizing` (inverse-vol, equal-weight, whole-share rounding), `loss-budget` (G6/G10 state machine, ruling (j) reference and halt), `stop` (ATR(20), entry − 2 × ATR, never moved up, gap fill), `costs` (Saxo 0.08%/side + custody; Alpaca SEC/FINRA TAF/CAT + half spread). 73 unit tests; Stryker mutation score 98.64% across the six modules.
- `server/tools/backtest/momentum/`: runner, simulation (1-bar execution lag, cash-limited buys, delisting exits, custody accrual, budget marking in GBP), 16-fold CSCV via `overfitting.ts` (`pbo`, `deflatedSharpe`, `minbtl`), verdict and markdown report, trial ledger, Alpaca bar puller and spread measurer, synthetic fixtures. 80 tests including an end-to-end run on a fixture and a byte-identical reproducibility test.
- G9 alignment (§2.14): `KILL_LINE.maxPbo`, `max_pbo.max` and `PBO_REJECT_THRESHOLD` are 0.10, with tests; `server/shared/threshold-bounds-readers.test.ts` proves `resolveRiskConfig` and `SqliteTuningStore.setRiskThreshold` refuse 0.11 and accept 0.10 through `threshold-bounds`. Refs #1715.
- Ruling (l): the Saxo appropriateness test is David's admin; nothing in the code depends on it.

### 9.6 Session eval (doc 68), run 2026-09-24 on the branch

One independent read-only evaluator (Opus) re-ran the US command and reproduced the four summary lines and byte-identical outputs, verified every §9.1 cell against the committed JSON, ran its own future-invariance probe for look-ahead (bars after a cut rescaled; marks and fills before the cut unchanged), and checked folds, gates, costs, sources, guardrails and the definition of done. One CONFIRMED failure: `npm run check:citations` was red with nine violations in files this branch did not touch, because the checker resolves against the git index and tracking `data/bars/` made `data/` a citable root for the first time — fixed with `untracked` markers on those nine lines. Recorded, not fixed: a provisional US run with a placeholder 1 bps spread (before the measurement finished) gave 0.572/0.289 walk-forward Sharpe for the two £1,000 passes against the first run's 0.570/0.293 (§9.7) — the same verdict, and not a trial; the four capital × share-mode passes are not counted in N (pre-declared by rulings (d) and (f), immaterial while all four fail); the same-mode benchmark row duplicates the fractional row on fractional passes. The evaluator's look-ahead probe is now a committed test (`server/tools/backtest/momentum/simulate.test.ts`, "no look-ahead").

### 9.7 Simulator fixes after merge (2026-09-25)

A code review of the merged simulator found three defects in `server/tools/backtest/momentum/simulate.ts`; all three are fixed with a test each, and §9.1 is re-run from the same bars. The verdict is unchanged, FAIL on all four passes.

1. **Gaps longer than the carry-forward window.** A held line with no bar for more than five sessions but a later bar was valued at £0 and never exited. In the Alpaca set every such gap (nine: POM, CAM, PCL, CSRA, SPLS, NFX, APC, FB, BBBY) is a ticker retired and later reused, so a holding read as a total loss. The line now exits at its last close (reason `delisted`, half spread charged) on the first session with no bar inside the window, as a series that ends does. This fix accounts for nearly all the change in §9.1.
2. **Halt exit on a session with no bar.** The −£1,500 halt queued an exit per position; one whose line had no bar on the next session was dropped, and nothing re-issues it while halted, so the position ran to 1 January against ruling (j). The halt exit now carries to the next session with a bar. No US pass halts on such a session, so the US numbers do not move.
3. **Split between decision and fill (whole shares).** The whole-share target was counted in the decision day's raw shares and read in the fill day's, so a 4:1 split bought a quarter of the size. The target now carries in adjusted units and rounds to whole raw shares at the fill. Effect on the US numbers: PBO ±0.002.

First run (2026-09-24), for comparison with §9.1:

| Pass | WF strategy Sharpe | Haircut | Benchmark | DSR (selected) | DSR (WF) | PBO | WF max DD strategy / benchmark | Capital ceiling |
|---|---|---|---|---|---|---|---|---|
| £1,000, whole shares | 0.293 | 0.146 | 0.677 | 0.806 (#7) | 0.283 | 0.476 | 27.3% / 37.1% | £3,669 |
| £1,000, fractional | 0.570 | 0.312 | 0.677 | 0.788 (#6) | 0.598 | 0.872 | 39.9% / 37.1% | £2,801 |
| £5,000, whole shares | 0.499 | 0.270 | 0.634 | 0.655 (#6) | 0.516 | 0.993 | 28.4% / 23.9% | £3,997 |
| £5,000, fractional | 0.465 | 0.249 | 0.634 | 0.690 (#6) | 0.475 | 0.944 | 35.7% / 23.9% | £2,801 |
