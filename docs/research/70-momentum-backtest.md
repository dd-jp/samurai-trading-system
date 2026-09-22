# 70 — Momentum backtest: proposal (Session B, Step 1)

> **PROPOSAL — awaiting David's approval, nothing run.** No backtest has been executed, no code has been changed, no data has been stored beyond the two read-only probes recorded in §6. Every item below is a proposal or a question; the decisions are David's. The build phase (doc 68 Session B, second paragraph) starts only after his approval of this document.

**Date:** 2026-09-22. **Map:** [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706). **Ticket:** Step 1 (#1742). **Authority:** [doc 66](66-v2-grill-decisions.md) (Q2, Q6, Q7, Q8, Q14, Q15, Q19, G5, G6, G9, G10, "Still open") over [doc 67](67-v2-plan-and-handoff.md) Step 1 and §5a over [doc 68](68-fable-handoff.md) Session B. Facts from [doc 69](69-v2-facts.md) (R3, R7, R8, R12–R15). Priors from [doc 64](64-paperswithbacktest-replication-prior-and-orb.md) and [doc 11](11-trend-signal-measurement.md).

**Rulings since doc 68 was written (David, 2026-09-22, recorded in a docs PR in flight):** Q15 re-ruled for the LSE half — "Saxo chart/v3 first, paid vendor if too shallow": probe Saxo's chart history depth on David's account; if it holds 10 years for the ETF list use it at £0, otherwise stop and report vendor cost and depth. The US half is Alpaca daily bars (permitted). Yahoo and Stooq: never. Q17/Step 2: the debate sleeve calls long and short, each side a separate counted trial against arm 2 (not this sleeve; nothing here contradicts it). G18: sentiment and social enter the debate sleeve only.

## 0. Status of the two probes this proposal had to run

| Probe | Result |
|---|---|
| **Saxo `chart/v3` depth on David's live account** (mandatory per the 2026-09-22 Q15 ruling) | **BLOCKED — 401.** The stored live token (`data/saxo-tokens/live.json`) records `accessTokenExpiresAt` 2026-09-15T13:01Z and `refreshTokenExpiresAt` 2026-09-15T13:41Z; the file's mtime is 2026-09-15 13:41 and nothing has refreshed it since. `GET /port/v1/users/me` returned 401 with the file's access token, with `SAXO_LIVE_ACCESS_TOKEN` from `.env.local`, and the refresh grant against `SAXO_LIVE_TOKEN_URL` returned 401. Both SIM tokens are also expired (401). Per the session rules this is a STOP for the parent, not an issue. The probe script is written and re-runnable the moment a fresh live token is in place (§6.1 gives the exact calls). **Consequence: the per-instrument earliest bar and bar count that the ruling asks for are not in this document, and the "10 years at £0 or stop and report vendor cost" branch cannot be taken yet.** |
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
| 11 | US health sector | IHCU | IE00B43HR379 | 2015-11-23 | 2015-11-23 | Acc | — |
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
| 24 | Broad commodities | CMFP | IE00B4WPHX27 | 2010-03-18 | 2010-03-15 | Acc | XDBG (ex-agriculture, GBP-hedged, 2011-03-14) |

Notes. (i) All 24 primary lines and all alternates are active HMRC reporting funds by ISIN (§4b). (ii) Row 21 is the youngest line at 10.57 years; row 10–14 are 10.83 years. (iii) Excluded on purpose: world/ACWI trackers (double the US weight), Euro-area trackers (overlap row 6), 0–5-year gilts (near-zero volatility breaks inverse-vol sizing), every USD-quoted line (Saxo's 0.60% FX charge, doc 69 R13 q5), every ETN (R13 q6 classification). (iv) Dist vs Acc: R8 rules signals run on total-return series so the classes rank identically; where an Acc alternate exists the live choice prefers Acc so the Saxo side has no ex-date gap (R8 proposal). (v) The alternate column exists for §4d: the same index is listed at prices an order of magnitude apart (IUSA against CSP1, for example), and the whole-share rule may force the cheaper class. **Prices are unverified** — no permitted LSE price source was reachable in this session; the Saxo probe records last close per line when it runs.

Sanity of the ten-year claim: admission date proves the line existed, not that Saxo holds its bars (doc 69 R14 q1's caveat). Doc 44 §2.2 found Saxo depth is **per-instrument inception** (`ChartInfo.FirstSampleTime`), not a rolling window, so a 2004 line may well have 20 years — but this is exactly what the blocked probe was to establish.

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
| LSE | Saxo `chart/v3/charts`, `Horizon=1440`, `Count` 1200 per page, paged with `Mode=UpTo&Time=<earliest>` (doc 44 §2.2; doc 69 R7) | **Not measured — token expired (§0)** | Unknown. Doc 44 found depth is per-instrument inception, which for a 2004 line would exceed ten years, but nothing here confirms it. |
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
4. **Daily cap:** if the day's close-to-close loss ≥ 1.0% of reference capital, no new entries at the next fill; exits still run.
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

- New directory `server/pipeline/momentum/` <!-- cite-exempt: planned — written in the build phase after approval --> holding a pure signal module (`bars in → target weights out`, no I/O, no clock), a sizing module (inverse-vol / equal-weight, whole-share rounding given a price and a capital), the budget-rule state machine, and the stop rule.
- The backtest runner under `server/tools/backtest/` and the Step 3 v2 root both import the same functions; the runner adds only data loading, the fold loop and reporting.
- The eval's "the strategy module is the one live code will import" is checked by grep at the build PR and again at Step 3. This is the postmortem's "backtest = live code" line (doc 66 Language row).

### 2.16 What the run reports

Per trial: annualised return, vol, Sharpe, deflated Sharpe, max drawdown, turnover, cost drag, trades, stop hits, budget-step days, fold table. Per sub-book: the selected trial, PBO, the benchmark's same numbers, the haircut comparison, **pass/fail against the kill line verbatim**, and the capital ceiling £1,500 / (max DD × 1.5). A FAIL is a valid result.

## 3. Rulings this proposal does not touch

Q17's Step 2 verdict (debate sleeve long and short, each a counted trial vs arm 2) and G18 (sentiment/social in the debate sleeve) concern the other sleeve; nothing above depends on or contradicts them. G5's veto shadow book is Step 3.

## 4. Questions for David (nothing below is decided)

**(a) LSE price-history source — re-ruled 2026-09-22, but the probe could not run.** The ruling's branch ("10 years at £0, else stop and report vendor cost/depth") needs the depth measurement in §6.1, which needs a live Saxo token. Please provide a fresh one (the file `data/saxo-tokens/live.json` or the login tool); the probe runs in under two minutes and this document is then amended with the per-instrument table. If Saxo turns out too shallow for some roles, the report will price the alternatives the earlier ruling named — LSEG Delayed Market Data (doc 46) or one paid EOD vendor — with depth; neither was priced in this session (**unverified**), and no paid data is bought without your word.

**(b) The R12 reporting-fund gate.** Evidence: all 24 proposed LSE lines and all alternates are active HMRC reporting funds by ISIN (§2.2). The momentum sleeve's US half holds *single stocks*, to which the offshore-fund rules do not apply, and it holds **no US ETF**, so SPY's non-reporting status (doc 69 R12) does not touch this sleeve as proposed. Recommendation: adopt doc 69's hard gate (ISIN present, effective date ≤ today, no cessation date, refreshed monthly, failing closed) as a pre-declared universe rule for every fund line in either sleeve; SPY is then excluded wherever it might otherwise appear (debate sleeve, US-ETF extension). Your call whether the gate is universe-wide or momentum-only.

**(c) Saxo's 0.12%/yr custody fee.** Evidence: the rates page states it for Classic/Platinum accounts on stocks and ETFs/ETCs, daily accrual, monthly charge, varying by country of residence (§2.10); whether it is charged on your GIA is account-shaped and unknown (doc 69 "What only David's accounts can answer"). Recommendation: **model it** at 0.12%/yr on the LSE sub-book's average invested notional (it is at most ~£0.84/yr at £700 fully invested — immaterial to the verdict, but its omission would fail Q19's "costs within ±25%" check for the wrong reason), and confirm on the first live statement.

**(d) R3's whole-share rule `price ≤ C/(5N)`.** Evidence: doc 69 R3 derives the rule at £700 to momentum (N = 5 admits lines ≤ £28). With §2.11's 50/50 sub-book split the LSE sub-book has **£350**, so N = 5 admits only lines priced ≤ **£14** and N = 3 ≤ £23 — and a 24-line time-series book holding, say, 12 lines at once is nowhere near that. Several of the oldest lines in §2.2 trade in the hundreds of pounds (IUSA/CSP1 for example — prices unverified until the Saxo probe). Options: (1) apply the rule as a pre-declared screen and let it pick the cheaper share class in the alternate column, accepting that most roles drop out at £350; (2) run the verdict at a capital where whole-share error is ≤ 10% for the full list (the £5,000 pass in §2.11) and treat £350 as a paper-phase fidelity question; (3) relax the tolerance (rounding error ≤ 25%, `C ≥ 2N·P`); (4) give the whole 70% to one sub-book at £1,000 and add the other only above a capital threshold. Recommendation: **(1) for the verdict run at £1,000 plus (2) as the second pass**, both reported, so you see the executable-at-£350 answer and the signal answer side by side; and an honest note that at £1,000 total the momentum sleeve may not be executable at all with whole shares, which the paper phase would show as a fidelity failure, not the backtest. The US side has the same problem: whole shares at Alpaca (R2's proposal) with K = 10 at £350 is £35 per name — one share of some S&P names and zero of many.

**(e) Sleeve verdict and benchmark operationalisation.** Each sub-book judged separately, a failing one dropped (§2.1)? Benchmark inside the same budget rules (§2.11 item 5)? Haircut as strategy Sharpe × 0.6 > benchmark Sharpe (§2.13)? Recommendation: yes to all three.

**(f) Which grid, and at which capital.** Grid A (8 trials, DSR bar ≈ 0.96) or Grid B (32 trials, bar ≈ 1.16) — §2.9 and the §2.7 table. Verdict at £1,000/70% with a £5,000 second pass (§2.11)? Recommendation: **Grid A**; a grid the gate cannot pass is not a test. Note honestly: even Grid A's bar sits above the replication prior's 0.4–0.8, so a FAIL on DSR is the likely outcome for a genuine but ordinary momentum edge. If you would rather the DSR clause be computed differently (for example DSR of the *excess* return with the same 0.95, which §2.7 shows is unpassable, or a lower DSR bar), that is a change to Q19 and is yours to make; this proposal does not make it.

**(g) "10y+" — bars or evaluated returns?** Alpaca's floor is 2016-01-04 (§6.2). With a 12−1 lookback the evaluated window is ~9.7 years. Options: accept 9.7 evaluated years on the US side; cap the US lookback at 126 days (~10.2 evaluated years); or stop the US sub-book until a deeper permitted source exists (Q15 names Norgate only after a pass — circular). Recommendation: accept, and state it in the verdict. Not a sentence this proposal can write on its own since Q7 says "10y+".

**(h) Haircut sizes for coverage and survivorship.** §2.4's 0.05 Sharpe for missing US names (with the 2% stop rule) and §2.5's *no* separate LSE survivorship haircut are judgments. Keep, change, or set a number?

**(i) MinBTL guard target Sharpe.** Run at the prior's 0.6 (23 trials admissible) rather than the code default 1.0 (1,067)? Recommendation: 0.6 — both grids fit.

**(j) Two conventions G6 left to the loss-budget spec, needed now because the budget runs inside the backtest:** the USD→GBP rate for the US sub-book's P&L (proposal: fixed at each 1 January) and the reset's reference capital (proposal: equity at 1 January). Also whether "halt for the year" at −£1,500 means flat or freeze (proposal: flat at the next fill). Whatever you rule here is written into the loss-budget spec unchanged.

**(k) Saxo history retention.** R7 records that keeping multi-year Saxo bars locally is an open point with Saxo. The 2026-09-22 ruling uses Saxo at £0; this proposal stores the bars in the repo's data directory (outside git) for own-use backtesting only. Confirm that is what you intend, or ask Saxo first.

## 5. Facts relied on and their verification status

| Fact | Status |
|---|---|
| 437 ETF + 20 ETC GBP/GBX lines admitted ≤ 2016-09-22, unlevered, all reporting funds | verified 2026-09-22 (files in §2.2, parsed locally) |
| Every line in §2.2 is an active reporting fund with the effective date shown | verified (ISIN join) |
| Alpaca SIP daily bars from 2016-01-04, delisted names included to their last day | verified (probe, §6.2) |
| `fja05680/sp500` MIT licence, row/ticker counts | verified (GitHub API + file parsed) |
| Saxo custody fee wording | verified (page re-read 2026-09-22) |
| Saxo depth per instrument | **unverified — probe blocked (§0)** |
| Current LSE line prices | **unverified** |
| Saxo bars' corporate-action adjustment | unknown (R8 q3) |
| Count of closed pre-2016 GBP ETF lines (survivorship size) | **unverified** |
| Alpaca data terms permitting this automated use | not re-read here; rests on David's 2026-09-22 ruling ("permitted") |
| LSEG DMD / paid EOD vendor cost and depth | **unverified** — not priced; only needed if Saxo is shallow |
| DSR/MinBTL bars in §2.7 | computed with the repo's own functions, 2026-09-22 |

## 6. Probe records

### 6.1 Saxo `chart/v3` depth — the calls (not run; token expired)

For each TIDM in §2.2 and its alternates, read-only, on the live gateway `https://gateway.saxobank.com/openapi`:

1. `GET /ref/v1/instruments?Keywords=<TIDM>&AssetTypes=Etf,Etc,Etn&ExchangeId=LSE_ETF&IncludeNonTradable=true` → `Identifier` (Uic), `AssetType`.
2. `GET /chart/v3/charts?Uic=<uic>&AssetType=<type>&Horizon=1440&Count=1200&Mode=UpTo&FieldGroups=ChartInfo,Data` → `ChartInfo.FirstSampleTime` (doc 44 line 721 shows the field), last bar, last close.
3. Page backwards with `&Time=<earliest Time seen>` until fewer than 1,200 bars return; record earliest bar, total bar count, pages, HTTP status per call, any `RateLimit` headers, latency.

Pass per line = earliest bar ≤ 2016-09-22. Output table: TIDM, Uic, earliest bar, bar count, last close (for §4d), pass/fail. The script exists in the session scratch directory and holds the token in memory only.

Observed 2026-09-22: `users/me` → 401 with every stored token; refresh grant → 401. No chart call was made.

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

The build phase as doc 68 Session B states it: TypeScript under the module layout in §2.15; `overfitting.ts` reused; the three 0.05 → 0.10 changes in §2.14 with tests; the Saxo probe re-run and this document amended with its table before any LSE bar is used; costs per §2.10 with David's rulings on (c) and (j); both stop variants; the budget rules per §2.11; walk-forward per §2.14; the kill line applied verbatim; one PR, never merged by the session; the doc 68 session eval run on the PR. If the Saxo depth probe fails the 10-year test for any role, the LSE sub-book stops and reports vendor options rather than shortening the window (doc 68: "if the approved data source cannot supply 10 years, report and STOP, do not shorten it").
