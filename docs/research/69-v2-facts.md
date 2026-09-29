# 69 — Samurai v2 facts research (Session R)

**Date:** 2026-09-21. **Map:** [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706). **Tickets:** R1 #1724, R2 #1725, R3 #1726, R5 #1727, R6 #1728, R7 #1729, R8 #1730, R9 #1731, R10 #1732, R11 #1733, R12 #1734, R13 #1735, R14 #1736, R15 #1737, R16 #1738, R17 #1739 (there is no R4).

This document answers the facts-research questions of [doc 67](67-v2-plan-and-handoff.md) §5a, as handed off in [doc 68](68-fable-handoff.md). It measures nothing about strategy and changes no code.

## Method and marking

- Every external claim carries a URL. **Every URL in this document was accessed on 2026-09-21** unless a line says otherwise.
- **verified** = a primary source (the regulator, the venue, the vendor's own documentation or terms, the paper itself) states it, and the raw page or file was read directly (`curl` plus local parsing, not a summariser). **refuted** = a primary source contradicts the premise. **unknown** = no primary source found, the source is silent, or it could not be fetched; the reason is given. **partly verified** is used where one half of a question is answered and the other is not; both halves are spelled out.
- Decisions are **proposed, never taken**. Each proposal is labelled "Proposal" and is David's to rule on.
- No broker API was called. Account-shaped facts (what David's own Alpaca or Saxo account is entitled to) are therefore unknown by construction and listed in the closing section.
- One caution on method: page summarisers fabricated details twice during this session (an NYSE early-close date that does not exist was the clearest case). All load-bearing claims below were re-read from the raw page, the GOV.UK content API, the vendor's Markdown docs, or a parsed PDF/ODS/XLSX. The few claims that rest on a summarised read only are flagged "summarised read" and should be treated as weaker.

## Summary table

| R | Ticket | Questions | verified | partly | refuted | unknown | Decision proposed |
|---|---|---|---|---|---|---|---|
| R1 | #1724 | 3 (q3 is a decision) | 2 | 0 | 0 | 0 | yes |
| R2 | #1725 | 3 (q3 is a decision) | 2 | 0 | 0 | 0 | yes |
| R3 | #1726 | 1 | 0 | 1 | 0 | 0 | yes |
| R5 | #1727 | 2 | 2 | 0 | 0 | 0 | yes |
| R6 | #1728 | 1 | 0 | 1 | 0 | 0 | yes |
| R7 | #1729 | 1 | 0 | 1 | 0 | 0 | yes |
| R8 | #1730 | 3 | 2 | 1 | 0 | 0 | yes |
| R9 | #1731 | 1 | 0 | 1 | 0 | 0 | yes |
| R10 | #1732 | 3 | 3 | 0 | 0 | 0 | yes |
| R11 | #1733 | 1 | 0 | 1 | 0 | 0 | yes |
| R12 | #1734 | 2 | 2 | 0 | 0 | 0 | yes |
| R13 | #1735 | 6 | 3 | 1 | 0 | 2 | yes |
| R14 | #1736 | 2 (q2 split: Yahoo, Stooq) | 1 | 0 | 1 | 1 | yes |
| R15 | #1737 | 2 | 0 | 1 | 0 | 1 | yes |
| R16 | #1738 | 3 | 1 | 0 | 0 | 2 | yes |
| R17 | #1739 | 2 | 1 | 0 | 0 | 1 | yes |

"partly" means one half of the question is verified and the other half is unknown; the section says which.

---

## R1 — Trading versus investing for UK tax (#1724)

**q1. Which tax applies to an individual running this system? — verified: HMRC's stated default for an individual is Capital Gains Tax, not trading income.**

- HMRC's Business Income Manual says of share transactions by individuals: "for individuals we take the view that transactions in shares which do not amount to investment are speculative transactions falling short of trading, unless there are particular factors which take the case 'out of the norm'", and that such cases are "dealt with under the Capital Gains Tax rules". Source: <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim56850>.
- Whether activity is a trade is "a question of fact": <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim56810>.

**q2. What are the tests, and where do momentum and swing trading sit? — verified.**

- The nine badges of trade: <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim20205>.
- The badges are of limited use for shares; "Frequency cannot by itself be decisive" (*Clarke v BT Pension Scheme*); the test is the overall impression (*Salt v Chamberlain*, *Ransom v Higgs*): <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim56840>.
- Case law summarised by HMRC: *Salt v Chamberlain* (about 200 transactions, computer forecasting — not trading); *Wannell v Rothwell* (borderline); *Manzur* (240–300 trades a year — portfolio management, not trading): <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim56860>.
- The fact-finding list HMRC officers use includes frequency, holding period, stop-loss use, and "If use is made of any 'robot' program, what influence does the person have": <https://www.gov.uk/hmrc-internal-manuals/business-income-manual/bim56830>.
- Where v2 sits: a monthly or weekly momentum sleeve plus roughly one swing trade a day on a £1,000–£1,500 book is below the volumes HMRC's own cited cases treated as *not* trading. Automation and short selling are the two features that could be argued as "out of the norm"; nothing in the manual says either is decisive. Derivatives (CFDs, futures, options) have their own pages (BIM56880/BIM56900) and are out of v2's scope.

**q3. Is an accountant needed? — decision, not a fact.** The manual is HMRC's internal guidance, not law, and it does not bind a tribunal.

**Proposal:** treat all disposals as CGT events, keep per-disposal records from day one, and buy one fixed-fee written confirmation from an accountant before the first live trade, specifically on (a) automation and (b) shorting. Not before paper.

## R2 — Alpaca stops and brackets on fractional and short positions (#1725)

**q1. Can a plain stop rest on a fractional position? — verified: yes, but only as a DAY order.**

- "Alpaca currently supports fractional trading for market, limit, stop & stop limit orders with a time in force=Day": <https://docs.alpaca.markets/docs/fractional-trading>.
- The order-type matrix confirms fractional = DAY only; GTC, IOC, FOK, OPG and CLS are not available for fractional quantities: <https://docs.alpaca.markets/docs/orders-at-alpaca>.
- Consequence: a fractional position cannot carry a venue-resting multi-day stop. The stop expires at each close and must be re-placed before each open, which makes the protective action tick-dependent — the exact failure class the carried constraints in [doc 66](66-v2-grill-decisions.md) forbid. Fractional orders also cannot be bracket/OCO legs (v1 observed Alpaca's 422 "fractional orders must be simple orders").

**q2. Why were whole-share short brackets refused? — verified, and the ticket's premise is stale.** The refusals were not a shorting or borrow restriction.

- Repo history: commit `f95375d2` (#1003/#1005, 2026-09-02) live-reproduced the SPY/QQQ whole-share short 422s and traced them to sub-penny bracket leg prices; commit `82eeffcf` (#983) fixed it with tick rounding. Alpaca's rule: prices at or above $1 take at most two decimals, else the order is rejected for "sub-penny increment": <https://docs.alpaca.markets/docs/orders-at-alpaca>.
- The paper database (read-only query) shows six whole-share short entries filled after the fix (TSLA, AMD, SMCI ×2, NVDA, NFLX), from 2026-09-02 on.
- Fractional shorts are impossible by rule: "We do not support short sales in fractional orders. All fractional sell orders are marked long." (<https://docs.alpaca.markets/docs/fractional-trading>).
- Bracket rules that do bind: time in force `day` or `gtc` only, no extended hours, take-profit above stop-loss for a buy and the reverse for a sell; GTC orders are auto-cancelled after 90 days (same orders page).

**q3. Whole-share only? — decision.**

**Proposal:** whole shares for every Alpaca position that needs a resting GTC stop or bracket — which is all of them under the carried constraint — and for all shorts (forced by rule). Fractional quantities only if David accepts daily re-placed DAY stops backed by a watchdog, which this document does not recommend.

## R3 — Minimum viable capital per holdings count (#1726)

**q1. — partly verified (the fixed floors), partly unknown (the price-dependent floor).**

- Alpaca margin/short floor: "In order to trade on margin or sell short, you must have $2,000 or more account equity": <https://docs.alpaca.markets/us/docs/margin-and-short-selling>. The debate sleeve's Alpaca shorts therefore need ≥ $2,000 (≈ £1,500 at 1.3367) in that one account, which is more than the whole v2 book. **This alone blocks Alpaca shorting at £1,000–£1,500 total capital split across two venues.**
- No commission floor on either venue: Alpaca's fee schedule lists no equity commission for Trading API users (<https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf>, revised 2026-09-17); Saxo's live tariff on David's account was measured at 0.08% per side with no minimum (repo memory and [doc 58](58-cost-floor-sizing-and-per-instrument-spread.md) context — account-shaped, not a public-page fact).
- What remains is whole-share granularity (Saxo LSE lines trade in whole shares; R2 proposes whole shares at Alpaca). Derived, not sourced: with `N` equal-weight holdings, capital `C`, and share price `P`, the worst rounding error is half a share, so holding weight error ≤ 10% of target needs `C ≥ 5·N·P`. At the Q14 live split (70% of £1,000 = £700 momentum), `N = 5` gives £140 per holding, so the rule admits only lines priced ≤ £28; `N = 3` admits ≤ £46.
- Unknown: actual share prices of the candidate LSE lines, because no licensed price source is settled yet (R7/R14).

**Proposal:** make "price ≤ C/(5N)" a pre-declared universe-screen rule alongside min ADV and max spread, and let the backtest choose `N` among values the capital can actually hold. Treat the Alpaca short leg as unfundable until the Alpaca account alone holds ≥ $2,000; the Saxo-side 1× inverse ETFs (R13 q6) are the only short route at the current book.

## R5 — Look-ahead-free evidence that an LLM signal has edge (#1727)

**q1. Is there look-ahead-free evidence? — verified: yes for single-LLM news sentiment, and it is decaying; none was found for multi-agent debate.**

- Lopez-Lira and Tang, "Can ChatGPT Forecast Stock Price Movements?" (arXiv 2304.07619, v6 2025-10-28): uses **post-knowledge-cutoff** headlines; GPT-4 scores predict subsequent drift "especially for small stocks and negative news"; and "Strategy returns decline as LLM adoption rises". <https://arxiv.org/abs/2304.07619>
- Glasserman and Lin (arXiv 2309.17322): in-sample backtests of LLM sentiment are biased by look-ahead and a "distraction effect"; "Out-of-sample, look-ahead bias is not a concern". <https://arxiv.org/abs/2309.17322>
- Lopez-Lira, Tang and Zhu, "The Memorization Problem" (arXiv 2504.14765): LLMs "cannot be trusted for economic forecasts during periods covered by their training data"; masking and date instructions fail; "Post-cutoff, we observe no recall". <https://arxiv.org/abs/2504.14765> — this is primary support for doc 66's ruling that the debate sleeve cannot be honestly backtested.
- He, Lv, Manela and Wu, "Chronologically Consistent Large Language Models" (arXiv 2502.21206): models trained only on point-in-time text reach Sharpe ratios comparable to a larger Llama model on next-day news prediction, "indicating that lookahead bias is modest" in that application. <https://arxiv.org/abs/2502.21206>
- Against: FINSABER (arXiv 2505.07078) — over two decades and 100+ symbols, "previously reported LLM advantages deteriorate significantly"; LLM strategies are "overly conservative in bull markets… overly aggressive in bear markets". <https://arxiv.org/abs/2505.07078>. StockBench (arXiv 2510.02209), contamination-free: "most models struggle to outperform the simple buy-and-hold baseline". <https://arxiv.org/abs/2510.02209>. LiveTradeBench (arXiv 2511.03628), 50-day live runs of 21 LLMs: general capability scores "do not imply superior trading outcomes". <https://arxiv.org/abs/2511.03628>
- The multi-agent debate design closest to Samurai's, TradingAgents (arXiv 2412.20138), reports superiority on a backtest "from January 1st to March 29th, 2024" over five large technology stocks — three months, five names, no matched no-LLM control. <https://arxiv.org/abs/2412.20138>

**q2. If none, say so. — verified as stated: for debate-as-entry specifically, the edge rests on hope.** The look-ahead-free evidence that exists is for a different mechanism (one model scoring one headline, strongest in small caps and negative news, shrinking as adoption grows), not for a bull/bear debate choosing large-cap or ETF swing entries. The evidence also matches the v1 observation that conviction is only high when bearish.

**Proposal:** keep doc 66's forward-only validation against arm 2; pre-declare that the debate sleeve's 30% stays in cash until that forward record exists; and note in the v2 ADR that the published evidence favours negative-news/short-side and small caps, which v2's universe mostly excludes.

## R6 — News source for LSE ETFs (#1728)

**q1. — partly verified.** No primary source offers per-ticker news for LSE-listed ETFs at £0; an index-tracking ETF has almost no issuer-level news in any case.

- Alpaca News is Benzinga, from 2015, for US stock and crypto symbols: <https://docs.alpaca.markets/docs/historical-news-data>. It carries no LSE tickers. Already held, £0.
- Saxo's news endpoints are on the platform gateway, not the developer OpenAPI ([doc 44](44-saxo-data-surface.md)); unreachable by token.
- GDELT: "available for unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee", with citation and link required: <https://www.gdeltproject.org/about.html>. [Doc 22](22-mi-source-licensing.md) §5 already keeps it.
- Official macro releases (R17) cover UK rates/inflation, which is what moves gilt and UK-equity ETFs.
- Unknown: whether LSE RNS carries anything for ETFs beyond NAV notices (not checked against a primary source), and its automated-use terms (LSE website terms bar programmatic access per [doc 34](34-lse-mark-source-options.md)).

**Proposal:** key each LSE ETF's debate on its underlying exposure, not its ticker — US-equity trackers on the Alpaca News feed for the matching US proxy (the v1 "screening instrument" pattern), everything else on GDELT themes plus the R17 calendar. Cost £0. No new vendor.

## R7 — LSE end-of-day price source permitting automated use (#1729)

**q1. — partly verified: one candidate is technically and contractually available, with one open legal point; the two free sources doc 66 named are not usable.**

- Saxo OpenAPI `chart/v3/charts` serves OHLC samples per `Uic`/`AssetType` with `Horizon`, `Count`, `Mode`, `Time`: <https://www.developer.saxo/openapi/referencedocs/chart/v3/charts>. [Doc 44](44-saxo-data-surface.md) measured daily bars for LSE ETF lines on David's app with the OpenAPI market-data terms accepted; the 15-minute delay is irrelevant to an end-of-day read taken after the close. Open point carried from doc 44: the terms allow own non-commercial use but bar copying/redistribution, and whether retaining a multi-year local history counts as permitted use has not been answered by Saxo.
- Yahoo: **refuted** for automated use (see R14 q2).
- Stooq: unknown, and now behind an anti-bot gate (R14 q2).
- LSE's own website: programmatic access barred by its terms ([doc 34](34-lse-mark-source-options.md)); LSEG Delayed Market Data is the licensed route ([doc 46](46-lseg-dmd-pretrade-surface.md)).
- Paid EOD vendors (for example EODHD) were not evaluated against primary terms in this session — unknown.

**Proposal:** use Saxo `chart/v3` for forward daily bars; ask Saxo in writing whether retaining those bars locally for own-use backtesting is permitted; if the answer is no or history depth is under ten years, open one ticket to price a licensed EOD vendor before Step 1 depends on it.

## R8 — Accumulating versus distributing, ex-dividend drops, corporate actions (#1730)

**q1. Accumulating versus distributing, in backtest and live — verified (tax mechanics).**

- A reporting fund must report, per unit, the amount distributed and "the excess of the amount of the reported income… over the amount actually distributed": <https://www.gov.uk/hmrc-internal-manuals/investment-funds/ifm12624>.
- That excess is taxed on the holder as if it were an additional distribution, "treated as made on the fund distribution date to participants holding an interest in the fund at the end of the reporting period"; the date is six months after period end: <https://www.gov.uk/hmrc-internal-manuals/investment-funds/ifm13326>.
- Consequence: an accumulating share class does not avoid income tax; it moves it to excess reportable income, and only for holders on the fund's reporting-period end date. A swing position not held over that date carries none. Backtest: use total-return (dividend-adjusted) series for signals in both cases so accumulating and distributing classes of one fund rank identically.

**q2. Ex-dividend drops versus stops — verified for Alpaca; by reasoning for LSE.**

- Bracket legs are sent "with a DNR/DNC (Do Not Reduce/Do Not Cancel) instruction. Therefore, the order price will not be adjusted and the order will not be canceled in the event of a dividend or other corporate action"; by contrast "Non-marketable GTC limit orders are subject to price adjustments to offset corporate actions"; trailing stops may be cancelled or adjusted on splits at Alpaca's discretion: <https://docs.alpaca.markets/docs/orders-at-alpaca>.
- So a resting stop is not moved down on ex-date, and a normal ex-dividend gap can trigger it. For a distributing LSE ETF the same applies mechanically (Saxo's stop handling on ex-date is unknown — account-shaped).

**q3. Corporate-action handling per data source — partly verified: Alpaca verified, Saxo unknown.**

- Alpaca bars take `adjustment` = `raw` (default), `split`, `dividend`, `spin-off`, `all`: <https://docs.alpaca.markets/reference/stockbars>.
- Saxo `chart/v3` reference documentation does not state whether samples are split- or dividend-adjusted: <https://www.developer.saxo/openapi/referencedocs/chart/v3/charts> — unknown.

**Proposal:** signals on `adjustment=all` series; stops evaluated and placed on raw prices; on an ex-date, lower each long stop by the dividend amount before the open (a pre-declared, tighten-neutral rule); prefer accumulating LSE classes where both exist so the Saxo side has no ex-date gaps; measure Saxo's adjustment behaviour once across a known split before trusting its history.

**2026-09-29 addendum (#1785, candidate 2 build) — the split case, measured, is worse than q2's dividend case.** q2's proposal covers ex-dividend gaps (a small, linear adjustment); it does not cover splits, and `server/apps/v2/cycle.ts`'s simulated `bracketExit` has no split handling at all (this is a v2 backtest-harness gap, not an Alpaca live-order behaviour — q2's DNR/DNC citation is about Alpaca's real bracket orders, which the backtest does not use). `stopGbp` is a fixed absolute price level computed once at entry (`bracketLevelsGbp`, `cycle.ts`) and compared every day against `bar.low` rescaled to raw terms via that day's own `rawClose / close` ratio (`toRawGbp`, same file). Measured directly against the committed Alpaca parquet store: NVDA's `rawClose / close` ratio is ~10.03 on 2024-06-07 and ~1.003 on 2024-06-10 (the 10:1 split date) — a discontinuous ~10x jump in what "raw" means, while a position's stored `stopGbp` never moves. Any long position held into a split will, on the first post-split day, almost certainly show `bar.low * toRawGbp` far below the pre-split-scaled `stopGbp` and fire a forced exit at a price with no relation to real market movement. This lands hardest on a risk-matched **buy-and-hold benchmark** that holds one name for years rather than a short-horizon strategy: candidate 2's benchmark (#1785 ruling f) holds US large caps from the point-in-time top-300 and will cross AAPL (Aug 2020), TSLA (Aug 2020, Aug 2022), NVDA (Jul 2021, Jun 2024), GOOGL and AMZN (both Jun 2022) at minimum inside the 2016–2025 window. Candidate 1's LSE ETF universe (#1785 ruling b) is not exposed to this in the same way — conventional splits are rare on that universe — which is likely why this did not surface in the S2 run. Not fixed here: a correct fix touches `cycle.ts`/`books.ts` position-stop mechanics shared by every sleeve (including the already-recorded candidate 1 trial and the debate sleeve), which is outside one candidate's ticket and needs its own mutation-tested change under [#1865](https://github.com/dd-jp/samurai-trading-system/issues/1865) (R8/#1730 is closed; #1865 is the live tracker), not a quiet patch inside #1785. Candidate 2's own recorded trial (this ticket) should be read with this caveat: a beats-benchmark PASS may reflect a benchmark artificially damaged by false split stop-outs rather than genuine strategy edge.

**2026-09-29 addendum 2 (#1785) — scanned, and the #1785 gap-through-stop fix (same PR) makes a false split stop-out a bigger single-day loss, not a smaller one.** Scanned the committed Alpaca parquet store directly (`rawClose / close` day-over-day ratio changing by more than 1.5x or less than 0.667x, 2016-10-11 to 2025-09-24, no universe filter): **91 such events**, including all five megacaps named above (AAPL 2020-08-31, TSLA 2020-08-31 and 2022-08-25, NVDA 2021-07-20 and 2024-06-10, GOOGL 2022-07-18, AMZN 2022-06-06) — this is a measured lower bound on how often a held benchmark position could cross one, not a claim that all 91 land inside a benchmark hold (that needs the actual run). Separately, this same PR fixes an unrelated, explicitly-scoped-in build item — a simulated stop now fills at the bar's open when the open itself has already gapped through the stop, instead of always filling at the stale stop price (`stopFillGbp`, `cycle.ts`). On an ordinary gap this is a strictly more honest fill. On a split day it is not: the post-split `bar.open` is scaled by the same day's collapsed `rawClose/close` ratio, so `min(stopGbp, openGbp)` (long) picks the post-split, unadjusted-quantity open — routinely near what was the entry price divided by the split ratio, i.e. close to a full write-off of the position on the fill leg alone, not the smaller "stopped out at the old level" loss the unfixed code produced. The two defects compound rather than offset. Neither this candidate's own build (a 10-session time stop rarely spans a real split) nor a fix are in scope here; both land on [#1865](https://github.com/dd-jp/samurai-trading-system/issues/1865).

**2026-09-29 addendum 3 (#1785) — tracking moved off the closed R8 ticket; no real trial recorded.** #1730 (R8) is closed, so it cannot be a live blocker tracker; the split-stop defect and the gap-fix interaction above are now tracked on a fresh, open ticket, [#1865](https://github.com/dd-jp/samurai-trading-system/issues/1865). Per this defect interaction, candidate 2's own backtest was **not run** as a real recorded trial in this PR: doing so would either record a verdict against a benchmark now known to be more damaged by false split stop-outs than before the gap-fix landed, or silently understate the finding by burying it in a PASS/FAIL number. The PR ships the build (signal, benchmark, embargo, universe/ordering, orchestration, this defect's discovery and documentation) as an open PR with #1865 as the named blocker; whether to run and record a trial with an explicit caveat, or wait for #1865's fix first, is David's call.

## R9 — Trading calendars and their publication horizon (#1731)

**q1. — partly verified (US fully, UK bank holidays fully, LSE early closes for 2026+ not).**

- NYSE publishes holidays and early closes for 2026–2028: <https://www.nyse.com/markets/hours-calendars>. Parsed from the raw page: remaining 2026 closures Thu 26 Nov and Fri 25 Dec; early closes (1:00 pm ET) Fri 27 Nov 2026, Thu 24 Dec 2026, Fri 26 Nov 2027, Mon 3 Jul 2028, Fri 24 Nov 2028. Horizon: about two to three years.
- Alpaca's calendar endpoint "serves the full list of market days from 1970 to 2029… taking into account early closures": <https://docs.alpaca.markets/us/reference/calendar-2> (description read from Alpaca's docs index <https://docs.alpaca.markets/us/llms.txt>). Machine-readable; not called in this session.
- UK bank holidays, machine-readable to 2028-12-26: <https://www.gov.uk/bank-holidays.json> (England and Wales division).
- LSE's 2025 calendar shows 12:30 early closes on 24 and 31 December: <https://docs.londonstockexchange.com/sites/default/files/documents/lse-turquoise-calendar-2025.pdf>. The 2026 and 2027 equivalents were not found (guessed URLs 404; <https://www.londonstockexchange.com/equities-trading/business-days> is a script-rendered page that could not be read raw) — **unknown** for 2026+ from LSE itself.

**Proposal:** US side from Alpaca `/v2/calendar` at start-up, cross-checked yearly against the NYSE page; UK side from GOV.UK JSON plus a hand-maintained early-close pair (24 and 31 December, half day) confirmed each November from LSE's page in a browser; a start-up check that fails closed when the calendar does not cover the next 30 days.

## R10 — Pinning GPT and DeepSeek via OpenRouter; retention; rate limits (#1732)

*2026-09-25: superseded on routing — David ruled all four seats go through the existing Nous account, with no OpenRouter or first-party keys (doc 66 Q16 amendment, spec §4). The OpenRouter pin tuple below is kept as the record of what was researched, not the pin in use.*

**q1. Pinning — verified.**

- `GET https://openrouter.ai/api/v1/models` returns a dated `canonical_slug` per model (for example `openai/gpt-5.5-20260423`, `deepseek/deepseek-v4-pro-20260423`), and `/api/v1/models/<dated slug>/endpoints` resolves — read directly, no key. A completion against a dated slug was not sent (no key use in this session).
- The model version is not the whole pin. DeepSeek V4 Pro is served by several third-party hosts at different quantisations (fp8, fp4 among them). Provider routing supports `order`, `only`, `allow_fallbacks: false`, `quantizations`, `data_collection: "deny"` and `zdr`: <https://openrouter.ai/docs/features/provider-routing>.

**q2. Retention and privacy — verified.**

- OpenRouter publishes each provider's training/retention policy: <https://openrouter.ai/docs/features/privacy-and-logging> (data at <https://openrouter.ai/api/frontend/v1/all-providers>). DeepSeek first-party: trains on prompts, retains prompts. DeepInfra, Together, Fireworks, Azure: no training, zero retention listed.
- DeepSeek's own policy (last updated 2026-02-10): "we directly collect, process and store your Personal Data in People's Republic of China": <https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html>.
- OpenAI API: not used for training unless opted in; abuse-monitoring logs up to 30 days; zero retention by approval: <https://developers.openai.com/api/docs/guides/your-data>.
- Anthropic API: "we automatically delete inputs and outputs on our backend within 30 days", with listed exceptions: <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>.

**q3. Rate limits — verified.** OpenRouter paid models have no fixed per-minute cap (credit-based, plus abuse protection); free-model variants are capped at 20 requests a minute and a daily count: <https://openrouter.ai/docs/api-reference/limits>. Anthropic's lowest published tier is far above v2's load: <https://platform.claude.com/docs/en/api/rate-limits> (summarised read). v2's load is about 20 debates a day.

**Proposal:** define a "model pin" as the tuple (dated slug, single provider, quantisation, `allow_fallbacks: false`, `data_collection: "deny"`), log it per call, and count a change to any element as a new trial under Q16. Route DeepSeek through one zero-retention US host, never DeepSeek first-party.

## R11 — Funding Alpaca from the UK: wire fees, Wise, conversion (#1733)

**q1. — partly verified.**

- Alpaca fee schedule (revised 2026-09-17): outbound international wire $35, outbound domestic wire $15; "Local Currency Transfers (Inbound and Outbound) 1.5% conversion fee, max $40 USD per transaction"; no inbound wire fee is listed: <https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf>.
- Local-currency funding runs through CurrencyCloud; the United Kingdom is in the supported list; "Alpaca charges a 1.5% transaction (maximum $40) fee"; Revolut is not supported through it: <https://alpaca.markets/support/currencycloud-transfer-questions>.
- Alpaca's own tutorial (updated 2026-01-26) says an international wire must arrive in USD, and quotes withdrawal fees that differ from the fee schedule; the schedule is newer and is the disclosure document: <https://alpaca.markets/learn/fund-live-trading-account>.
- Wise's public quote API, `POST https://api.wise.com/v3/quotes`, GBP→USD on £1,000 at access time: fee £4.60 (0.46%), mid rate 1.3367, $1,330.55 received.
- **Unknown:** whether Alpaca accepts a USD wire that originates from Wise in David's name; the support pages read do not say. The sending bank's own SWIFT and intermediary fees are also unknown.

Cost on £1,000: CurrencyCloud ≈ £15 (the $40 cap only bites above ≈ $2,667); Wise ≈ £4.60 if accepted.

**Proposal:** David asks Alpaca support one question before funding — "is a USD wire from a Wise account in my own name accepted?" — and uses CurrencyCloud if the answer is no or slow. The difference is about £10 once; not worth delay.

## R12 — Reporting-fund screen and share-matching rules (#1734)

**q1. How to screen LSE ETFs for reporting status — verified, and measured.**

- Non-reporting offshore funds produce offshore income gains taxed as income, not capital gains: <https://www.gov.uk/hmrc-internal-manuals/investment-funds/ifm13100>, <https://www.gov.uk/hmrc-internal-manuals/investment-funds/ifm13414>. A loss on one gives no income relief: <https://www.gov.uk/hmrc-internal-manuals/investment-funds/ifm13550>.
- HMRC publishes the list monthly as a spreadsheet keyed by ISIN with "Reporting Fund, with effect from" and "Ceased to be an RF on" dates: <https://www.gov.uk/government/publications/offshore-funds-list-of-reporting-funds> (file dated 2026-09-04: <https://assets.publishing.service.gov.uk/media/6a9fea9392e72b8ac437eeea/20260904_Master-Weblist.ods>).
- Measured by ISIN join against the LSE instrument list (as at 2026-07-31, <https://docs.londonstockexchange.com/sites/default/files/reports/Instrument%20list_82.xlsx>): of 2,346 distinct LSE ETF ISINs, 2,263 are active reporting funds, 2 have ceased, 81 are absent; ETCs 139 of 240; ETNs 390 of 410.
- The same list answers the Alpaca side: 501 active US-ISIN share classes, including VOO, IVV, QQQ and VTI; **SPY (US78462F1030) is absent**, so gains on SPY would be offshore income gains.

**q2. Exact share-matching rules — verified.** Order of identification: (1) same-day acquisitions, TCGA 1992 s105(1); (2) acquisitions in the 30 days after the disposal, s106A(5); (3) the s104 pool; (4) later acquisitions, earliest first: <https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51555>. Same-day aggregation and worked examples: <https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51560>. Pool mechanics, and that same-day/30-day matched shares never enter the pool: <https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg51550>.

**Proposal:** a hard universe gate — ISIN present in the current HMRC list, effective date ≤ today, no ceased date — refreshed monthly, failing closed; and a tax ledger that implements the four-step order per ISIN across both venues, because a momentum sleeve re-entering a name within 30 days will hit rule 2 routinely.

## R13 — Alpaca margin, US-ETF access, borrow fees, PDT; Saxo FX; 1× inverse ETFs (#1735)

**q1. Alpaca margin for a UK resident — unknown.** The documented floor is $2,000 equity for margin or shorting (<https://docs.alpaca.markets/us/docs/margin-and-short-selling>); the public docs state no UK-specific rule either way. Account-shaped; answered only by David's application.

**q2. UK-resident access to US-listed ETFs at Alpaca — unknown.** Alpaca's public docs are silent. The UK rule set is mid-change: the FCA's Consumer Composite Investments regime replaces PRIIPs (<https://www.fca.org.uk/publications/policy-statements/ps25-20-supporting-informed-decision-making-final-rules-consumer-composite-investments>, summarised read). Whatever access exists, R12 narrows the useful set to reporting-status funds.

**q3. Borrow fees on easy-to-borrow names — verified:** no locate or borrow fee on easy-to-borrow shares for Trading API users; hard-to-borrow varies daily; margin interest 6.25%; regulatory pass-through fees on sells (SEC, FINRA TAF, CAT): <https://files.alpaca.markets/disclosures/library/BrokFeeSched.pdf>.

**q4. Date Alpaca removed PDT — partly verified.** FINRA Regulatory Notice 26-10: effective 2026-06-04, phase-in ends 2027-10-20: <https://www.finra.org/rules-guidance/notices/26-10>. Alpaca's intraday-margin page (updated 2026-07-07) describes the pattern-day-trader designation and $25,000 minimum as gone, with $2,000 still required for margin and shorting: <https://docs.alpaca.markets/us/docs/the-intraday-margin-rule>. The exact go-live day at Alpaca is unknown; moot for swing holding periods.

**q5. Saxo FX conversion fee — verified:** mid-price ± 0.60% (Classic), 0.40% (Platinum), 0.20% (VIP), applied to settlement amounts in a non-base currency: <https://www.home.saxo/en-gb/rates-and-conditions/commissions-charges-and-margin-schedule>. It does not apply to GBP-denominated LSE lines in a GBP account. **The same page lists a custody fee of 0.12% a year (Classic/Platinum), calculated daily and charged monthly, with a note that it varies by country of residence** — not in any v2 cost model so far.

**q6. 1× inverse products on LSE — verified to exist and to be reporting funds.** By ISIN in both the LSE instrument list and the HMRC list (R12 sources): Xtrackers S&P 500 Inverse Daily Swap (LU0322251520, GBX line XSPS), Xtrackers FTSE 100 Short Daily Swap (LU0328473581, XUKS), WisdomTree FTSE 100 1x Daily Short (IE00B94QKG22, SUK1) and WisdomTree FTSE 250 1x Daily Short (IE00BBGBF313, 1MCS). The two WisdomTree lines sit in LSE's ETN segment, not its ETF segment, so doc 66 Q8's wording (1× inverse ETFs only) admits only the Xtrackers pair as written. Issuer fees and whether Saxo lets David's account trade them (appropriateness test) are unknown.

**Proposal:** David confirms q1, q2 and the inverse-ETF permission during account admin; add the 0.12% custody fee to the Step 1 cost model now and confirm it on the first live statement; note that daily-reset inverse funds drift over multi-week holds, so the debate sleeve's time stop matters more on the Saxo side.

## R14 — Ten-year LSE ETF history, and Yahoo/Stooq terms (#1736)

**q1. How many LSE ETFs have ten or more years? — verified (by listing date).** From the LSE instrument list (R12 source): 1,875 GBP/GBX ETF lines; 451 admitted on or before 2016-09-21; 437 of those unlevered and non-inverse by name filter; all 437 are active reporting funds. ETCs: 91 → 21 → 20. Caveat: admission date proves the line existed, not that any usable source holds its ten-year price history.

**q2. Yahoo and Stooq terms — Yahoo refuted; Stooq unknown.**

- Yahoo's terms (last updated 2026-08-04) prohibit accessing or collecting data "using any automated means… robots, spiders, scrapers… for any purpose without our express, prior permission", and commercial use: <https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html>. **Doc 66 Q15's "Yahoo `.L`" is not a permitted source.**
- Stooq publishes no terms page that could be found, and its CSV endpoint now returns a browser proof-of-work challenge to non-browser clients — unknown on permission, blocked in practice.

**Proposal:** Q15 needs re-ruling for the LSE half. Options, in cost order: Saxo `chart/v3` history if depth and retention allow (R7); LSEG Delayed Market Data; one paid licensed EOD vendor. The US half (Alpaca daily bars) is unaffected.

## R15 — Open, close and closing-auction execution, and a slippage model for each (#1737)

**q1. Mechanics — partly verified.**

- Alpaca: time in force `opg` (market/limit-on-open) and `cls` (market/limit-on-close) route to the primary exchange's auction; `opg` orders are rejected between 9:28 am and 7:00 pm ET, `cls` between 3:50 pm and 7:00 pm ET; neither is available for fractional quantities: <https://docs.alpaca.markets/docs/orders-at-alpaca>.
- LSE: the trading day is opening auction, continuous trading, closing auction, then a Closing Price Crossing session at the auction price, with random end periods; auction-only times in force include OPG and ATC: <https://docs.londonstockexchange.com/sites/default/files/documents/mit201-guide-to-the-trading-system-15-8-20260119_0.pdf> (MIT201 issue 15.8, effective 2026-01-19). The rulebook refers to closing auctions concluding after 16:30: <https://docs.londonstockexchange.com/sites/default/files/documents/rules-of-the-london-stock-exchange-effective-19-january-2026_0.pdf>. The exact timetable lives in LSE's Business Parameters spreadsheet, which was not retrieved.
- Saxo: whether OpenAPI exposes at-the-open/at-the-close durations for LSE ETF lines on David's account is unknown (account-shaped).

**q2. Slippage model — unknown: no primary source exists; this is a modelling choice.**

**Proposal (pre-declared, to be checked in paper under Q19's ±25% cost band):** auction fills at the auction print plus commission only, zero spread; continuous-session market fills at half the measured spread plus commission, using per-instrument spreads from [doc 58](58-cost-floor-sizing-and-per-instrument-spread.md) and [doc 46](46-lseg-dmd-pretrade-surface.md), with the first and last 15 minutes of the LSE session at double the half-spread; a rebalancing sleeve prefers the closing auction where the venue exposes it, otherwise a limit at mid that converts to market after a fixed wait.

## R16 — Key and token security (#1738)

**q1. Can withdrawals be disabled per key? — unknown; nothing documented.** Alpaca Trading API keys have no documented permission scopes (scopes exist only on the OAuth flow for third-party apps: <https://docs.alpaca.markets/us/docs/using-oauth2-and-trading-api>); authentication is key ID plus secret: <https://docs.alpaca.markets/us/docs/authentication>. Alpaca's docs index shows no Trading API endpoint for fiat withdrawal, but does show crypto-wallet withdrawals, which require an address allow-listed at least 24 hours ahead: <https://docs.alpaca.markets/us/llms.txt>. Saxo's OpenAPI does document cash-withdrawal and beneficiary services: <https://www.developer.saxo/openapi/referencedocs/atr/v1/cashmanagement>; whether David's app's claims permit them is account-shaped and unknown.

**q2. IP allow-lists — unknown; not documented** for Alpaca Trading API keys or for Saxo OpenAPI apps on the pages read (<https://www.developer.saxo/openapi/learn/security>).

**q3. Token storage — verified guidance from Saxo:** refresh tokens rotate ("this refresh token replaces and invalidates the previous refresh token") and must be kept "in a secure long-term storage": <https://www.developer.saxo/openapi/learn/security>.

**Proposal:** do not enable crypto on the Alpaca account (removes the only API-reachable withdrawal path found); ask Saxo to confirm the app has no write claim on cash management, and ask both venues whether IP restriction exists; keep both secrets in the macOS Keychain, write the rotating Saxo refresh token atomically so a crash cannot lose the only valid copy, and never let either enter the repo, logs, or an LLM prompt. This rewrites the "withdrawals disabled, IP-whitelisted" line in the project briefing as an aspiration neither venue documents.

## R17 — Macro calendar source (#1739)

**q1. Source — verified: the official publishers suffice, each with a different horizon and format.**

- Fed FOMC dates, including all eight 2027 meetings, HTML only, "tentative until confirmed": <https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm>.
- BLS release schedule with iCal offered; CPI and Employment Situation at 8:30 am ET: <https://www.bls.gov/schedule/news_release/> (summarised read; the `.ics` file returned 403 to a plain client, so automated retrieval needs a compliant user agent or a yearly manual import).
- Bank of England MPC dates for 2026 and 2027: <https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates>.
- ONS release calendar as RSS (`https://www.ons.gov.uk/releasecalendar?rss&release-type=type-upcoming`), horizon about one to two months.
- FRED release-dates API, key required: <https://fred.stlouisfed.org/docs/api/fred/releases_dates.html>; terms at <https://fred.stlouisfed.org/docs/api/terms_of_use.html> (both FRED pages are summarised reads only — the host refused raw fetches in this session, so FRED is an optional extra here, not part of the verified basis).

**q2. Forex Factory — unknown; the earlier rejection stands by default.** The site refuses automated fetches (403), so its terms could not be read; nothing found overturns the rejection, and q1 makes it unnecessary.

**Proposal:** a checked-in yearly table built from the Fed, BoE and BLS pages, plus the ONS RSS for UK releases, plus a start-up check that fails closed when the table does not cover the next 30 days. [Doc 55](55-fomc-cpi-nfp-event-study.md) holds the prior event-study context.

---

## What only David's accounts can answer

Alpaca: margin approval as a UK resident; whether US-listed ETFs are tradable; acceptance of a Wise-originated USD wire. Saxo: custody fee actually charged; permission to trade 1× inverse ETFs; at-the-open/at-the-close durations on LSE ETF lines; whether `chart/v3` history may be retained; whether the app's claims include cash management; IP restriction. None of these was probed, because doing so needs the account secrets this session was barred from touching.

## Rulings in doc 66 that these facts disturb

1. **Q15 (free LSE history via Yahoo + Stooq)** — Yahoo's terms forbid it; Stooq is unknowable and gated (R14).
2. **Q8 (debate sleeve shorts on Alpaca)** — needs $2,000 equity in the Alpaca account alone (R3, R13).
3. **Q2/Q15 universe** — SPY is not a reporting fund; VOO/IVV are (R12).
4. **Cost model** — Saxo's 0.12% custody fee is unmodelled (R13 q5).
5. **Carried constraint "venue-resting stops"** — incompatible with fractional quantities at Alpaca (R2).
