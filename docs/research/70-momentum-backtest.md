# 70 — Momentum backtest: proposal (Session B, Step 1)

> **LSE sub-book run 2026-09-25 — FAILS the kill line on all four passes, on 22 of the 24 lines; the verdict is provisional on IHCU and CMFP, whose sibling splice missed the pre-declared 1 bp/day tolerance and needs David's call. See §10.** The first run of the day carried a ×100 unit break inside SGLN's history (§10.9); the numbers in §10.1 are the re-run on bars that passed the unit-break guard, and the verdict did not move. Combined Step 1 verdict: **US FAIL (§9), LSE FAIL (§10)** — under doc 68 Step 3 ("wire only sleeves that survived B and C") no momentum sub-book is wired in Step 3 as specced. The two banners below are the state as of 2026-09-24 and 2026-09-23 and stand as the record of those days.
>
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
- **Code changes in the build phase (recorded here so the eval can check them):** `KILL_LINE.maxPbo` in `server/tools/backtest/stage2-verdict.ts` (0.05 → 0.10), `max_pbo.max` in `server/shared/threshold-bounds.ts` (0.05 → 0.10), **and** `PBO_REJECT_THRESHOLD` in `server/tools/backtest/overfitting.ts` (0.05 → 0.10) — a third site doc 67 Step 1 does not list, found on reading the file — with their tests. <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

### 2.15 The strategy is written as the module live code imports

Proposal:

- New directory `server/pipeline/momentum/` holding a pure signal module (`bars in → target weights out`, no I/O, no clock), a sizing module (inverse-vol / equal-weight, whole-share rounding given a price and a capital), the budget-rule state machine, and the stop rule.
- The backtest runner under `server/tools/backtest/` and the Step 3 v2 root both import the same functions; the runner adds only data loading, the fold loop and reporting.
- The eval's "the strategy module is the one live code will import" is checked by grep at the build PR and again at Step 3. This is the postmortem's "backtest = live code" line (doc 66 Language row).

### 2.16 What the run reports

Per trial: annualised return, vol, Sharpe, deflated Sharpe, max drawdown, turnover, cost drag, trades, stop hits, budget-step days, fold table. Per sub-book: the selected trial, PBO, the benchmark's same numbers, the haircut comparison, **pass/fail against the kill line verbatim**, and the capital ceiling £1,500 / (max DD × 1.5). A FAIL is a valid result.

## 3. Rulings this proposal does not touch

Q17's Step 2 verdict (debate sleeve long and short, each a counted trial vs arm 2) and G18 (sentiment/social in the debate sleeve) concern the other sleeve; nothing above depends on or contradicts them. G5's veto shadow book is Step 3. Doc 67's G9 row also names `server/apps/orchestrator/production.ts`, `server/pipeline/feedback-loop/sqlite-tuning-store.ts` and `server/pipeline/risk-manager/risk-thresholds.ts` as 0.05 enforcement points; they read the bound from `server/shared/threshold-bounds.ts`, so the §2.14 change there carries through, and the build phase confirms each with a test rather than assuming it. <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at tag v1-final -->

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

To run it once bars land, put one `<TIDM>.csv` per line under `data/bars/saxo/` (header `date,open,high,low,close,volume` or the seven-column Alpaca layout) with a `manifest.json` of the form `{ "calendar_reference": "<TIDM>", "symbols": { "<TIDM>": { "half_spread_bps": <measured> } } }`.
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
- `data/bars/fx/gbpusd-boe-xudluss.csv`: BoE XUDLUSS, OGL v3, converted once per calendar year at the last rate on or before 1 January (ruling (j)). <!-- cite-exempt: untracked — gitignored since #2000; the tracked copy is data/bars/fx/gbpusd-boe-xudluss.snapshot.csv -->
- `.gitignore`: the `#787` line that said market data is never committed is amended to say only the `docs/research/data/` <!-- cite-exempt: untracked — scratch cache, gitignored --> research cache stays out; `data/bars/` and `data/backtest/` are tracked.

### 9.5 Code shipped

- `server/pipeline/momentum/`: `bars` (sorted-unique-date invariant, `windowCoverage`/`coverageSatisfied` on every windowed read), `signal` (time-series trend, cross-sectional top-K), `sizing` (inverse-vol, equal-weight, whole-share rounding), `loss-budget` (G6/G10 state machine, ruling (j) reference and halt), `stop` (ATR(20), entry − 2 × ATR, never moved up, gap fill), `costs` (Saxo 0.08%/side + custody; Alpaca SEC/FINRA TAF/CAT + half spread). 73 unit tests; Stryker mutation score 98.64% across the six modules.
- `server/tools/backtest/momentum/`: runner, simulation (1-bar execution lag, cash-limited buys, delisting exits, custody accrual, budget marking in GBP), 16-fold CSCV via `overfitting.ts` (`pbo`, `deflatedSharpe`, `minbtl`), verdict and markdown report, trial ledger, Alpaca bar puller and spread measurer, synthetic fixtures. 80 tests including an end-to-end run on a fixture and a byte-identical reproducibility test.
- G9 alignment (§2.14): `KILL_LINE.maxPbo`, `max_pbo.max` and `PBO_REJECT_THRESHOLD` are 0.10, with tests; `server/shared/threshold-bounds-readers.test.ts` proves `resolveRiskConfig` and `SqliteTuningStore.setRiskThreshold` refuse 0.11 and accept 0.10 through `threshold-bounds`. Refs #1715. <!-- cite-exempt: historical — deleted in v1 teardown wave 2 (#1748); preserved at commit 79e88af4 -->
- Ruling (l): the Saxo appropriateness test is David's admin; nothing in the code depends on it.

### 9.6 Session eval (doc 68), run 2026-09-24 on the branch

One independent read-only evaluator (Opus) re-ran the US command and reproduced the four summary lines and byte-identical outputs, verified every §9.1 cell against the committed JSON, ran its own future-invariance probe for look-ahead (bars after a cut rescaled; marks and fills before the cut unchanged), and checked folds, gates, costs, sources, guardrails and the definition of done. One CONFIRMED failure: `npm run check:citations` was red with nine violations in files this branch did not touch, because the checker resolves against the git index and tracking `data/bars/` made `data/` a citable root for the first time — fixed with `untracked` markers on those nine lines. Recorded, not fixed: a provisional US run with a placeholder 1 bps spread (before the measurement finished) gave 0.572/0.289 walk-forward Sharpe for the two £1,000 passes against the first run's 0.570/0.293 (§9.7) — the same verdict, and not a trial; the four capital × share-mode passes are not counted in N (pre-declared by rulings (d) and (f), immaterial while all four fail); the same-mode benchmark row duplicates the fractional row on fractional passes. The evaluator's look-ahead probe is now a committed test (`server/tools/backtest/momentum/simulate.test.ts`, "no look-ahead"). <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at commit 09012b29 (last main commit before the deletions) -->

### 9.7 Simulator fixes after merge (2026-09-25)

A code review of the merged simulator found three defects in `server/tools/backtest/momentum/simulate.ts`; all three are fixed with a test each, and §9.1 is re-run from the same bars. The verdict is unchanged, FAIL on all four passes. <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at commit 09012b29 (last main commit before the deletions) -->

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

## 10. LSE sub-book result (run 2026-09-25)

Branch `build/v2-session-b-lse`, run from the committed bars with `npx tsx server/tools/backtest/momentum/run.ts --venue lse`; a second run is byte-identical on the four verdict JSONs and `verdict.md`. The numbers below are the **second pull of 2026-09-25**, after the unit-break guard of §10.9 was added; the first pull's numbers are kept in §10.9 for the record. Read-only Saxo calls only (`chart/v3/charts`, `ref/v1/instruments`, `ref/v1/instruments/details`, `trade/v1/infoprices/list`); no orders, no LLM calls, no paid data. Nothing was bought from EODHD and nothing was signed up for.

### 10.1 Verdict: FAIL, all four passes, on 22 of 24 lines — provisional

**Kill line, verbatim (doc 68 Session B):** *"fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and PBO <= 0.10 (G9). Report pass/fail with numbers and the max drawdown. No LLM calls, no paid data."*

Evaluated window **2017-06-30 to 2026-09-24 (9.23 years)**: bars from 2016-06-21 (the latest first bar among the 22 included lines, IITU — the window binds there, ruling (g)), the first 252 sessions are lookback; the fetch-day bar (2026-09-25, pulled intraday) is dropped. Walk-forward out-of-sample path 2018-01-26 to 2026-09-24 (folds 2–16 of 16). Trials 1–4 of Grid A (§2.9: lookback 252/126 × stop none/2 × ATR(20)), counted 8 from #1 (ruling (f)); MinBTL at target Sharpe 0.6 is 16 trials, 8 is within (ruling (i)). As in §9.6: the four capital × share-mode passes are selection dimensions and are **not** counted in N — pre-declared by rulings (d) and (f), immaterial while all four fail, and they would count against MinBTL 16 if David authorised a second LSE grid. No delisting haircut and no coverage stop on LSE (ruling (h)); custody 0.12%/yr accrued daily on invested value (ruling (c)). Coverage: **1.5% of line-sessions** inside the window have no Saxo bar (§10.5).

| Pass | WF strategy Sharpe | × 0.6 haircut | Benchmark Sharpe (fractional, same budget) | Beats? | DSR (selected trial, N = 8) | DSR (WF path) | PBO (CSCV, 16 folds) | WF max DD strategy / benchmark | Capital ceiling £1,500 / (DD × 1.5) | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| £1,000, whole shares | 0.537 | **0.322** | 0.565 | no | 0.636 (#1) | 0.549 | **0.044** | 12.7% / 20.9% | £7,898 | **FAIL** |
| £1,000, fractional | 0.414 | **0.248** | 0.565 | no | 0.509 (#1) | 0.407 | 0.245 | 20.9% / 20.9% | £5,288 | **FAIL** |
| £5,000, whole shares | 0.293 | **0.176** | 0.455 | no | 0.519 (#1) | 0.277 | 0.222 | 21.9% / 20.9% | £5,555 | **FAIL** |
| £5,000, fractional | 0.273 | **0.164** | 0.455 | no | 0.447 (#1) | 0.259 | 0.255 | 21.5% / 20.9% | £5,108 | **FAIL** |

Full-window per-trial numbers (Sharpe, CAGR, vol, max DD, fills, stop hits, zero-share targets, cost, budget-step days) are in `data/backtest/momentum/lse/verdict.md`; the per-pass JSON carries the fold matrix and the per-fold selection.

What the numbers say, without spin:

- **No pass beats the benchmark even before the haircut.** The best walk-forward Sharpe (0.537, £1,000 whole shares) is below the fractional benchmark's 0.565; the other three are 0.27–0.41 against 0.46–0.57. The haircut is not what decides it.
- **PBO passes once, on the pass that fails the other two gates.** At £1,000 whole shares the walk-forward picks trial #1 (252-day lookback, no stop) in 11 of 15 folds and PBO is 0.044 — the trials are not interchangeable there, #1 is consistently the least bad — but DSR is 0.636 and the Sharpe does not beat the benchmark. The other passes have PBO 0.22–0.26.
- **Full-window trial #1 (0.595 Sharpe at £1,000 whole) sits just above the fractional benchmark (0.588) with 12.7% drawdown against 20.9%.** That is the strongest line in the LSE result: the long/flat trend rule roughly matched buy-and-hold at 60% of the drawdown over the full window. It does not survive walk-forward selection (0.537) or the deflation over 8 trials (0.636).
- **Stops (trials 2 and 4) fired 254–357 times per pass and lowered neither drawdown enough nor Sharpe at all** (#2 0.489 vs #1 0.595; #4 0.132 vs #3 0.221 at £1,000 whole).
- **Whole shares at £1,000 bind less than on the US book.** 257–276 zero-share targets per trial (22 lines, ~111 rebalances); the fractional pass, which is the signal's true test, is *worse* (0.414 vs 0.537 walk-forward), so rounding did not hide a passing signal.
- **The loss budget binds only at £5,000**: 40–225 half-size days per trial, no quarter-size day and no halt in any pass. The daily 1% cap blocked entries on 48–176 sessions per trial.
- **Custody is small**: over 9.23 years, whole shares £6.71–£9.19 per trial at £1,000 and £44.50–£55.56 at £5,000; fractional £9.70–£12.20 and £46.41–£58.38; the fractional benchmark £13.29 and £60.25. All inside the cost column.

**Provisional because two roles are missing.** IHCU (US health) and CMFP (broad commodities) are not in the run (§10.3). The verdict on 22 lines is the same kind of FAIL on all three gates as the US book; adding two lines to a 22-line inverse-vol long/flat book would have to move the walk-forward Sharpe from 0.54 past 0.94 (0.565 / 0.6) to change it, and that is an interpretation, not a measurement — the run with them is one command once David rules.

### 10.2 Sibling-Uic probe (ruling (a), step 1) — outcome per line

`ref/v1/instruments?Keywords=<ISIN>` on the live gateway, then details and `chart/v3` earliest-bar paging per Uic (raw JSON `saxo-siblings.json` in the session scratch). Every listing of both funds at Saxo:

| Line | Listing (Uic) | Exchange | Currency | Earliest Saxo bar | Bars to 2026-09-24 (LSE lines after §10.9's hygiene; other exchanges as probed) | Reaches 2016-09-22? |
|---|---|---|---|---|---|---|
| **IHCU** (IE00B43HR379) | IHCU:xlon (25583531) | LSE_ETF | GBP (GBX, factor 0.01) | 2021-10-21 | 1,243 | no |
| | **IUHC:xlon (4925944)** | LSE_ETF | USD | **2016-06-21** | 2,574 | **yes** — chosen sibling (same exchange, same fund) |
| | IUHC:xswx (34934627) | SWX_ETF | USD | 2016-04-12 | 2,033 | yes, but SIX and 77% density |
| | QDVG:xetr (14096141) | XETR_ETF | EUR | 2019-06-19 | 1,851 | no |
| **CMFP** (IE00B4WPHX27) | CMFP:xlon (12264631) | LSE_ETF | GBP (GBX) | 2019-02-20 | 1,916 | no |
| | **COMF:xlon (46434)** | LSE_ETF | USD | **2010-03-25** | 3,441 (83% density; a three-bar ×100 spike 2010-04-06→08 rescaled by §10.9's guard) | **yes** — chosen sibling |
| | ETL2:xetr (5205444) | XETR_ETF | EUR | 2010-05-06 | 4,117 | yes, but Xetra/EUR |
| | COMF:xams (21364808) | AMS | EUR | 2014-10-13 | — | no |
| | COMF:xswx (10477255) | SWX_ETF | CHF | 2018-08-17 | — | no |
| | COMF:xmil (19872347) | MIL | EUR | 2014-10-17 | — | no |

So §8.1's "sibling lines — not probed" is closed: for **both** roles a same-exchange USD line reaches 2016-09-22 at Saxo, and the EODHD fallback was not needed to *obtain* history. Whether that history can be *used* is §10.3.

### 10.3 Splice test — both siblings exceed the pre-declared tolerance; STOP for David

Method: convert the USD sibling to GBP at the BoE XUDLUSS daily fix (same-day fix, else the last fix on or before; the series was extended back to 2010-01-04 for COMF), splice it onto the GBX line at the GBX line's first bar, require ≥ 60 overlap sessions, and report the mean absolute daily return difference over the overlap; **if > 1 bp/day, say so and stop.** The ≥ 60-session and 1 bp/day bars are **not in doc 70 at the branch base and were not ruled by David**: they come from the coordinator's session brief for this run, written before any bar was pulled, and entered the tree as `SPLICE_MIN_OVERLAP_SESSIONS` and `SPLICE_MAX_MEAN_ABS_RETURN_DIFF_BPS` in `server/tools/backtest/momentum/splice.ts` in commit 4fa5c6a5 on this branch. They are pre-declared in that sense only. <!-- cite-exempt: historical — deleted in v1 teardown wave 1 (#1748); preserved at commit 09012b29 (last main commit before the deletions) -->

| Line ← sibling | Overlap sessions | Mean abs return diff | Mean (signed) return diff | Return correlation | Cumulative return diff over the overlap | Sibling bars that would be spliced in | Within 1 bp/day? |
|---|---|---|---|---|---|---|---|
| IHCU ← IUHC:xlon | 1,242 (2021-10-22 → 2026-09-24) | **15.00 bp/day** | −0.01 bp/day | 0.9756 | −19 bp | 1,331 (2016-06-21 → 2021-10-20) | **no** |
| CMFP ← COMF:xlon | 1,915 (2019-02-21 → 2026-09-24) | **16.39 bp/day** | −0.01 bp/day | 0.9629 | +8 bp | 1,523 (2010-03-25 → 2019-02-19) | **no** |

Both lines are therefore **excluded from the run** and the GBX-only series, the raw USD siblings and the spliced candidates are committed under `data/bars/saxo-aux/` so the run can be repeated with them on one manifest edit. Interpretation, not measurement: 15–16 bp/day of absolute daily difference with a signed mean of ~0 and correlation 0.96–0.98 is what two closing prints of the same fund on two order books, converted at a 4 pm fix that is not the close, look like; the 1 bp/day bar is below the noise floor of any two such lines, and a splice at this level would not bias a 126/252-day trend signal, but it would add ~15 bp/day of noise to the history of two of 24 lines. **The bar was pre-declared, so it is David's to relax, not the session's.** Per the brief, EODHD was not signed up for, not paid, not called; §8.4 options 1 and 2 remain exactly as written.

### 10.4 Data pulled and committed (ruling (k))

- `data/bars/saxo/`: **22 lines, 4.3 MB** (`manifest.json` alongside), 2000-04-28 (ISF) to 2026-09-24, 15-minute-delayed feed. Prices are in GBP **after the hygiene step of §10.9**: GBX × 0.01 once at ingest, each line checked against Saxo's `PriceToContractFactor` for today's unit, and then every close/close ratio scanned for a mid-series unit change — `PriceToContractFactor` is a property of the instrument today and says nothing about the unit Saxo stored older bars in. `data/bars/saxo-aux/`: the 7 derived series (IHCU, CMFP, IUHC, COMF, the two spliced candidates, CUKX) plus `raw/` with the **27 pre-hygiene series exactly as Saxo returned them** (5.0 MB), so every transformation is auditable. `data/bars/fx/gbpusd-boe-xudluss.csv` extended from 2015-12-01 back to 2010-01-04 (4,226 rows; the old file is a strict subset). `data/bars/saxo-spreads.csv`: 24 rows. Total committed for this run: **~10.3 MB** on disk (5.9 MB aux of which 5.0 MB raw). <!-- cite-exempt: untracked — gitignored since #2000; the tracked copy is data/bars/fx/gbpusd-boe-xudluss.snapshot.csv -->
- **Per line: earliest bar, bars, density (bars ÷ (years × 252)), last bar.** All last bars are 2026-09-24 (the fetch-day bar is dropped, §10.5 (7)).

| Line | First bar | Bars | Density | | Line | First bar | Bars | Density |
|---|---|---|---|---|---|---|---|---|
| ISF | 2000-04-28 | 6,672 | 100% | | UIFS | 2016-06-20 | 2,522 | 98% |
| VMID | 2014-10-01 | 3,028 | 100% | | ICDU | 2016-01-28 | 2,198 | **82%** |
| CUKS | 2010-09-22 | 3,618 | **90%** | | SPGP | 2011-09-22 | 3,756 | 99% |
| IUSA | 2002-03-19 | 5,879 | 95% | | SPOG | 2011-10-10 | 3,550 | 94% |
| CUS1 | 2011-08-01 | 3,269 | **86%** | | IUKP | 2007-03-20 | 4,929 | 100% |
| IEUX | 2011-08-02 | 3,828 | 100% | | IGLT | 2006-12-04 | 4,792 | 96% |
| IJPN | 2004-10-04 | 5,551 | 100% | | INXG | 2006-12-04 | 5,001 | 100% |
| CPJ1 | 2010-09-28 | 3,245 | **81%** | | SLXX | 2004-03-30 | 5,679 | 100% |
| IEEM | 2005-11-21 | 5,265 | 100% | | VUTY | 2016-03-03 | 2,494 | 94% |
| IITU | 2016-06-21 | 2,520 | 97% | | SGLN | 2011-04-14 | 3,877 | 100% |
| IESU | 2015-12-03 | 2,470 | **91%** | | SSLN | 2011-04-14 | 3,828 | 98% |
| *excluded:* IHCU | 2021-10-21 | 1,243 | 100% | | *excluded:* CMFP | 2019-02-20 | 1,916 | 100% |

  **What the hygiene step found and did, per line** (`manifest.json` `symbols.<TIDM>.hygiene`, raw under `data/bars/saxo-aux/raw/`): **SGLN** ×100 unit break at 2017-06-23 (raw close 0.1946 → 19.425; the 1,540 bars from 2011-04-14 were stored in pounds-per-hundredth and are rescaled ×100 — 255 of them inside the evaluated window, which is what falsified the first run, §10.9); **IGLT** ÷100 break at 2011-10-20 (earlier segment rescaled ×0.01); **VMID** ÷100 break at 2014-10-17 (its first 12 bars, rescaled ×0.01); **COMF** (sibling) a three-bar ×100 spike 2010-04-06→08, rescaled back to the surrounding unit and therefore also gone from `CMFP-spliced.csv`. All three primary breaks except SGLN's are before the window. **Suspect flips** (adjacent closes ±35% or more, not a unit break): **CUS1** 65 between 2011-08-05 and 2013-05-03, **SPGP** 65 between 2012-01-11 and 2012-11-06, CPJ1 2 (2014-11-27/28), VUTY 2 (2016-03-11/16) — all before the window, recorded and left in the series (they are alternating prints, not a unit change; a run over a window that reaches them must treat them as a data hole). **Dropped bars**: weekend-dated bars in 2007–08 on ISF (5), IEEM (11), IJPN (11), IESU's 2017-01-01 (a Sunday), and every line's 2026-09-25 fetch-day bar. No line hit the > 3× hole refusal.

  The four lowest densities (CPJ1 81%, ICDU 82%, CUS1 86%, CUKS 90%) match §6.1's probe. **Inside the evaluated window the picture differs**: CPJ1, CUS1 and CUKS have no missing session against ISF's calendar from 2016-06-21 — their thinness is pre-2016 — while the window's gaps sit on ICDU (408 sessions, 15.7%, longest run 19 sessions, 22 runs longer than the 5-session carry-forward), IESU (170, 6.6%, longest 18), VUTY (119, 4.6%), IITU (74, 2.9%), UIFS (73, 2.8%), and a handful on SGLN, SPOG, SSLN. 1.49% of all line-sessions.
- **Half spreads** (`data/bars/saxo-spreads.csv`): one `infoprices/list` burst of 5 reads spaced 2 s at 2026-09-25T11:14:26Z (market open, 15-minute delayed), **p25 per line**, measured once. p25 half spreads run from 0.65 bp (IUSA) and 0.96 bp (ISF) through 2–7 bp for most lines to 9.2 (INXG), 9.6 (SPOG), 10.7 (SPGP), 21.2 (CUKS) and 54.8 bp (CMFP, excluded anyway); median of the 22 p25s 4.9 bp. Doc 44 §5's caveat applies: a single time point is not a session profile, and the universe median of one snapshot swings 1.68× across time points; the run's cost model reads these once and does not re-measure. A session-profile measurement (doc 44's method, 20+ time points) is the upgrade if the spread ever decides a verdict — here the sub-book fails before costs matter (the benchmark, which pays the same spreads, wins).
- **Saxo closes are price-only, not distribution-adjusted.** ISF (distributing) against CUKX (accumulating, same index): the close ratio drifts **−3.77%/yr** from 2011-02-11 to 2026-09-25 (`manifest.json` `checks.distribution_adjustment`), which is the FTSE 100 dividend yield. So on the 11 distributing lines in the run (ISF, VMID, IUSA, IEUX, IJPN, IEEM, IUKP, IGLT, INXG, SLXX, VUTY) the trend signal and the P&L are price return, not total return, and the same is true of the benchmark. Doc 69 R8 q3 left Saxo's adjustment behaviour unknown; it is now measured. R8 q1's rule — signals on total-return series so Acc and Dist classes rank identically — is therefore not met on those 11 lines by Saxo's own bars, and cannot be met from Saxo alone. This under-states both sides equally on a long/flat rule but under-states the always-long benchmark's carry more, so if anything the comparison flatters the strategy.

### 10.5 Interpretations made in this run (re-runnable the other way)

1. **The window starts at the latest first bar among included lines (IITU, 2016-06-21), not at 2016-09-22.** Ruling (g) says the window is what the bars allow; 21 lines reach further back, one binds. The run therefore evaluates 9.24 years, not 10; the 10-year requirement (Q7) is met by 21 of 22 lines individually and by the sub-book to the day IITU listed on LSE at Saxo.
2. **Coverage is measured, not asserted.** The first build (§9.2) returned 0% missing for LSE by construction; this run measures member-sessions without a bar against ISF's calendar the same way the US run does (1.5%). The 2% *stop* stays US-only per ruling (h) — the number is reported, it does not gate. Inside the simulator the per-line 95% window coverage invariant (`coverageOk`) already excludes a line from a decision whose lookback is under-covered, which is why ICDU's 15.7% gap rate did not become a position problem.
3. **A gap longer than the 5-session carry-forward exits the line as `delisted`** (§9.7 fix 1). On LSE that path fired **exactly once per line held, on 2023-08-14, for ICDU (every trial) and IESU (trials 1–2), and on the benchmark too (both lines, both share modes)**. The only in-window gap longer than five sessions that is held is 2023-08-07 → 2023-08-18, and it is **identical on ICDU and IESU** — two iShares US sector lines going dark for the same ten sessions is a probable Saxo data hole, not illiquidity. Effect on Sharpe, measured two ways in scratch: (a) *carry instead of exit* — the simulator's gap exit switched off so a held line with no bar is marked at its last close until a bar returns (the only change): full-window Sharpe moves by **+0.004 to −0.004** on every trial and pass except #4 at £5,000 fractional (−0.026), and by +0.001 on the benchmark — immaterial; (b) *hole filled* — the ten missing sessions on both lines inserted as carried closes in a copy of the bars: walk-forward Sharpe moves by **−0.066 (£1k whole), −0.159 (£1k fractional), −0.165 (£5k whole), −0.047 (£5k fractional)** and the benchmark by −0.006 to −0.008. (b) is not the hole's effect: filling ten sessions lifts ICDU's rolling 252-day coverage past the 95% invariant for the months that follow, so ICDU (15.7% missing in the window) enters the book where the committed run leaves it out, and the delta is ICDU's inclusion. Neither changes the verdict; (a) is the exit path's cost and it is ~0.
4. **Spliced lines carry no coverage discontinuity marker because none is in the run.** The manifest and report print `Spliced lines: none`; the mechanism (manifest `spliced_from`, report line, run-time assertion that every line's first bar is on or before the window start) is built and tested for the re-run.
5. **Benchmark is fractional-share** (§9.3 interpretation 1) — the whole-share benchmark on 22 lines at £1,000 is *not* degenerate here (0.585 Sharpe against 0.594) and is printed alongside.
6. **GBP-quoted lines (VMID, IGLT, INXG, SLXX, VUTY) are stored as quoted; GBX lines are scaled by 0.01 once at ingest**, so a bar file never carries pence, `raw_close` equals `close`, and whole-share rounding, the 0.08%/side commission and the half spread all act on pounds. Each line's unit was asserted against Saxo's `PriceToContractFactor` at pull time — which, the first run showed, only vouches for today's unit (§10.9). The per-bar unit-break guard (§10.4) is what makes the sentence true across the whole series, and `loadLseData` now refuses any bar file that still carries a break.
7. **The fetch-day bar is dropped.** Saxo's daily bar for the pull date is the session so far (the first pull was at 11:16Z, the second at 11:43Z, LSE closes 16:30 London), so every line ends at 2026-09-24. The first run kept a partial 2026-09-25 bar on every line.

### 10.6 Questions for David

**Ruled 2026-09-25 (doc 66, Session B (n)): "drop momentum, go debate only".** (1) stands as ruled on #1742 (no paid data); (2) the FAIL stands; (3) and (4), ruled on #1742 at 16:26Z for a grid 2, are overturned — there is no grid 2.

1. **IHCU and CMFP.** Three options, none taken: (i) **accept the sibling splice at 15–16 bp/day** mean absolute overlap difference (signed mean ~0, correlation 0.96–0.98) and re-run on 24 lines — one manifest edit, the spliced series are committed, and that edit is safe only because the window binds at IITU's 2016-06-21 first bar, which both spliced candidates (IUHC from 2016-06-21, COMF from 2010-03-25) reach, so neither the window nor the evaluated span moves; (ii) **EODHD one month (£19.99)** per §8.4 option 1, still with its unverified ticker coverage and retained-data terms, and with the same overlap question against Saxo's own series (§8.3); (iii) **let the provisional 22-line verdict stand** as the Step 1 LSE result. The session's reading: (i) is the cheapest honest answer and cannot change a three-gate FAIL into a PASS on two lines, but the tolerance was pre-declared and the session does not move it.
2. **Does the provisional 22/24-line FAIL stand as the Step 1 LSE verdict** if no option in (1) is taken?
3. **Price-only bars on the 11 distributing lines** (§10.4). The pre-declared list took the oldest line per role, not the share class; §2.2's alternate column already names Acc classes for four of them (CUKX for ISF, CSP1 for IUSA, CSJP for IJPN, SEMA for IEEM), each with ten years at Saxo per §6.1. Swapping to Acc classes would change the pre-declared list (a recorded change before any trial, per §8.4 option 4's rule) and would give total-return signals on those roles, as R8 q1 asks; the other seven Dist lines have no Acc alternate at Saxo in §2.2 and would stay price-only. Keep the list as declared, or swap where an Acc class exists?
4. **Whether the momentum sleeve continues at all** now both sub-books fail: doc 68 wires only sleeves that pass B into Step 3. The choices §9.1 raised for the US arm (a second pre-declared grid counted against MinBTL) apply to LSE as well — MinBTL here is 16, so a second LSE grid of 8 would reach the limit.

### 10.7 Code shipped

- `server/providers/saxo-bars/lse-lines.ts` (the 24 lines with Uic, asset type, quote unit and the two sibling declarations; CUKX as the aux line), `server/providers/saxo-bars/saxo-api.ts` (read-only client: chart paging, details, infoprices; 429 backoff, 401 retry, 100 chart calls/min pacing; the live token source refuses to start on a dead token with "Saxo token dead, needs `npm run saxo:login`"), `splice.ts` (BoE conversion, overlap statistics, splice with the pre-declared tolerance), `measure-saxo-spread.ts` (burst, p25, CSV), `pull-saxo-bars.ts` (pull, unit assertion, splice-or-exclude, distribution check, manifest), `bar-hygiene.ts` (§10.9: weekend and fetch-day drop, per-bar unit-break detection and rescale, hole refusal, suspect-flip count; raw series kept). `run.ts` clips the calendar to the manifest window, asserts every line starts by it, measures coverage; `report.ts` prints the LSE header, splices, exclusions and coverage. 23 new unit tests in `saxo-tools.test.ts` plus runner tests for the window/splice/exclusion path and for refusing a bar file with a unit break; 111 tests in the momentum tool directory.
- The first pull finished inside one access-token lifetime; the second pull's refresh rotated the tokens and `SaxoTokenRefresher` wrote them back to `data/saxo-tokens/live.json` <!-- cite-exempt: untracked — token store is gitignored --> (mode 0600), as the login tool does. No token was printed or committed.

### 10.8 Combined Step 1 verdict

**US sub-book: FAIL (§9.1). LSE sub-book: FAIL on 22 of 24 lines (§10.1), provisional pending §10.6 (1).** Doc 68 Step 3, verbatim: *"wire only sleeves that survived B and C"* — so, as specced, **no momentum sub-book is wired into the v2 composition root** unless David takes an option in §10.6 (1) or (4) and the re-run passes. The kill line was applied as written; nothing was shortened, substituted or bought.

### 10.9 Fix round after the session eval (2026-09-25): a ×100 unit break inside SGLN

The doc 68 eval on the first push (5f3507db) found that `data/bars/saxo/SGLN.csv` <!-- cite-exempt: historical — moved into the Parquet store in doc 67 Step 3b --> was **100× too small from 2011-04-14 to 2017-06-22** (raw close 0.1946 on 2017-06-22, 19.425 on 2017-06-23): Saxo stores that segment of SGLN's history in a different unit from the rest, and `assertUnitMatchesSaxo` only compares the declared unit with today's `PriceToContractFactor`, so nothing looked at the series itself. 255 of the mis-scaled bars sit inside the clipped window, and the 252-day trend signal read a ~+10,000% return on SGLN through mid-2018 on the walk-forward path. §10.4's "prices in GBP", §10.5 (6) and the README's "Prices in GBP" were false for that segment. Confirmed by scanning every committed series for adjacent-close ratios: the scan also found the pre-window breaks in IGLT (2011-10-20), VMID (2014-10-17) and COMF (2010-04-06→09, carried into `CMFP-spliced.csv`), the alternating ±40–60% flips in CUS1 and SPGP in 2011–13, and weekend-dated bars (IESU 2017-01-01; ISF, IEEM, IJPN in 2007–08).

What changed: `server/tools/backtest/momentum/bar-hygiene.ts` <!-- cite-exempt: historical — moved to server/providers/bar-store/ in #1775's Step 3b bar-puller refactor --> — a close/close ratio inside (90, 110) or its inverse is a unit break and every earlier bar is rescaled to the latest unit (×100 or ×0.01, composed across multiple breaks so COMF's three-bar spike returns to unity); a ratio beyond 3× or under 1/3 that is not a unit break refuses the pull unless the line is allow-listed with a reason (no line needed it); ratios beyond 1.35× are counted as suspect flips; weekend-dated and fetch-day bars are dropped; each line's report goes into `manifest.json` and the raw series into `data/bars/saxo-aux/raw/`. `loadLseData` refuses a bar file that still carries a break. Tests: a ×100 break, a ÷100 break, a three-bar ×100 spike, a genuine 4× move (throws), the weekend/fetch-day drop, and the runner's refusal. Every line was re-pulled through the guard (read-only, 2026-09-25T11:43Z) rather than patched, and the four passes were re-run; a second run is byte-identical.

First run of 2026-09-25 (SGLN mis-scaled, partial fetch-day bar kept), for the record:

| Pass | WF strategy Sharpe | × 0.6 | Benchmark | DSR (selected) | DSR (WF) | PBO | WF max DD strategy / benchmark | Capital ceiling |
|---|---|---|---|---|---|---|---|---|
| £1,000, whole shares | 0.548 | 0.329 | 0.571 | 0.647 (#1) | 0.561 | 0.050 | 12.4% / 20.9% | £8,052 |
| £1,000, fractional | 0.356 | 0.214 | 0.571 | 0.510 (#1) | 0.342 | 0.264 | 22.6% / 20.9% | £5,288 |
| £5,000, whole shares | 0.288 | 0.173 | 0.462 | 0.522 (#1) | 0.273 | 0.188 | 21.5% / 20.9% | £5,748 |
| £5,000, fractional | 0.210 | 0.126 | 0.462 | 0.449 (#1) | 0.202 | 0.301 | 23.3% / 20.9% | £5,175 |

The corrected numbers are §10.1's. The verdict on every pass is unchanged (FAIL on all three gates); the largest moves are the fractional passes (£1,000: 0.356 → 0.414; £5,000: 0.210 → 0.273), where the phantom SGLN return had been sized at full weight. The evaluator's hand-patched preview (0.541 / 0.419 / 0.296 / 0.277) was within 0.01 of the re-pull on three passes and 0.004 on the fourth.
