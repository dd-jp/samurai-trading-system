# PEAD earnings data: free sources first (S5)

**Status:** FACTS AND RECOMMENDATION, DECISION FOR DAVID (2026-10-21, [#1785](https://github.com/dd-jp/samurai-trading-system/issues/1785), ruling S5 in `docs/research/66-v2-grill-decisions.md`). Web research and public-file reads only. No account was opened, no key was used, nothing was bought. Every price and coverage claim below names its source and the date it was read (all 2026-10-21 unless marked). Prices in USD are converted at the Bank of England XUDLUSS rate for 19 Oct 2026, 1.3318 USD per GBP.

## Recommendation and cost

**Use the free route. Cost: £0 a month, £0 one-off.**

1. **Event dates and timing from SEC EDGAR.** Every 8-K carrying item 2.02 ("Results of Operations and Financial Condition") is an earnings release. EDGAR keeps the filings of companies that later delisted, has them from late 2004, and publishes new ones within about a second. It is free with no key.
2. **The surprise measured by the price reaction, not by consensus.** For each event, the return over the reaction session (the next session for a release after the close, the same session for one before the open), in excess of the market, from the Alpaca bars the repo already stores. This version of PEAD needs only dates. It is the earnings-announcement-return drift studied by Brandt, Kishore, Santa-Clara and Venkatachalam ("Earnings announcements are full of surprises", Duke working paper, January 2008; seen only as a citation in this session), and it is the measure behind the 2025 papers that find drift still alive (below).
3. **Optionally, a consensus surprise from Alpaca news at £0.** Benzinga's automated earnings headlines carry both the reported figure and the consensus at release time ("Q2 Adj. EPS $10.32 Beats $10.08 Estimate"). Alpaca serves the Benzinga wire from 2015 on the keys David already holds. This is the only free source found whose estimate is point-in-time by construction. Its parse rate and its coverage of delisted names are not measured yet.

Paid data is not needed for a first counted trial. If David wants an analyst-consensus surprise with history before 2015, the cheapest paid option found is **EODHD's Fundamentals Data Feed, £59.99 for one month** (earnings back to the 1990s with before/after-market flags, actual and estimate). It is a separate plan from the $19.99 EOD All World plan doc 66 rules for corporate actions (listed as £19.99 Historian on the GBP page), and its coverage of names delisted before 2018 is unverified. A cheaper candidate is EODHD's **Corporate Events Calendar & News API add-on at £19.99/month**, sold separately from the core plans. Its description covers earnings and historical events, but whether it carries estimates, how far back its earnings go, and whether it needs a core plan are not stated (https://eodhd.com/pricing, read 2026-10-22). It must be checked before the £59.99 plan is chosen. Do not buy either until a free trial has been run.

**A prior that argues against spending money first.** Martineau (2022), *Critical Finance Review* 11(3–4), 613–646, abstract: "For large stocks, PEAD have been non-existent since 2006 but has only disappeared recently for microcap stocks" (IDEAS listing, https://ideas.repec.org/a/now/jnlcfr/104.00000122.html). Candidate 4 trades US large caps over roughly 2016–2025, which is the segment and period where this paper finds no drift on the analyst-surprise measure. The pushback is on the price-reaction measure: UCLA Anderson Review (21 Jan 2026, https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again/) reports that Dickerson, Julliard and Mueller (JFE, in press) find a drift factor built from "abnormal stock price returns around earnings rather than accounting earnings surprises". The same article reports Subrahmanyam's replication of that factor: t = 2.18 with all stocks, 1.43 without microcaps. So the expected outcome for large caps is a FAIL on either measure. The case for running it anyway is S4 (all candidates run), and the free route spends no money to find out.

### Top three options

| Option | History | Delisted names | Estimate point-in-time | Cost |
|---|---|---|---|---|
| EDGAR 8-K item 2.02 dates + Alpaca bars (price-reaction surprise) | Item 2.02 from Aug 2004; bars from 2016 | Yes, measured on Twitter (CIK 1418091, delisted 2022) | Not needed | £0 |
| Alpaca news, Benzinga earnings headlines (consensus surprise) | 2015 onward | Unverified (likely: the news archive is not pruned by listing status) | Yes, written at release time | £0 on existing keys |
| EODHD Fundamentals Data Feed, calendar API | Earnings "back to the 1990s"; estimate-revision trends only from fiscal 2017 | Unverified for earnings; fundamentals only for delistings after 2018 | Unverified for the calendar estimate; the Trends endpoint gives consensus 7/30/60/90 days earlier | £59.99 a month; one month for the backfill |

## What PEAD needs

- For each event: the announcement date and whether it fell before the open or after the close; actual EPS; a consensus estimate (or a revenue surprise), ideally as it stood before the release.
- US large caps including delisted names. Candidate 2's universe is the point-in-time top 300 by 20-day dollar volume over 745 S&P 500 members since 2016-01-04, Alpaca bars, about 2016-10 to 2025-09 (#1785, candidate 2 rulings of 2026-09-29). From 2006 would be better: candidate 3's window starts 2006-01-03, but Alpaca SIP bars start 2016-01-04.
- A forward feed for the daily paper cycle.
- Terms that allow automated personal use.

## Free sources

### SEC EDGAR — dates and timing, yes; consensus, no

Read: the EDGAR API page (https://www.sec.gov/search-filings/edgar-application-programming-interfaces), the developer resources page (https://www.sec.gov/about/developer-resources), and public files fetched directly with no key.

- **Access.** "These APIs do not require any authentication or API keys to access." The submissions API has "a typical processing delay of less than a second"; the XBRL APIs under a minute. Bulk ZIPs (all filers' submissions, all company facts) are rebuilt nightly at about 03:00 ET.
- **Rate limit and terms.** "No more than 10 requests per second" per user; unclassified bots are not allowed, so requests must carry a declared User-Agent. There is no licence restriction on use of the filings, which are public records.
- **History.** Measured on Apple's older submissions file: item 2.02 8-Ks from 2004-10-13 (the item did not exist before August 2004), four a year from 2007. Some years have extra 2.02 filings that are not quarterly releases (Apple has seven in 2006), so events need de-duplicating to one per fiscal quarter.
- **Delisted names.** Twitter's submissions file still serves its 27 item 2.02 8-Ks from 2016-02-10 to 2022-07-22.
- **Timing — a trap.** The submissions JSON field acceptanceDateTime ends in "Z", but it is not reliable UTC. Compared with the "Accepted" time on each filing's own index page (Eastern time): Twitter 2022-07-22 shows 08:00:46 on the page and 12:00:46Z in the JSON (consistent with UTC); Apple shows 16:30:28 on the page and 00:30:28Z the next day in the JSON for 2026-07-30, and 16:31:02 against 02:31:02Z for 2017-01-31 (offsets of 8 and 10 hours, consistent with neither). Read the acceptance time from the filing's index page or SGML header, never from the JSON or from filingDate. Even the true acceptance time is an upper bound: a release issued before the open with the 8-K filed after it would be classed late. The bars can check this, since the reaction gap shows which session took the news.
- **The ticker gap.** EDGAR keys on CIK. SEC's company_tickers.json maps only current tickers: measured against `data/bars/sp500-constituents.csv`, **600 of the 745 members since 2016-01-04 resolve and 145 do not**. Method: every distinct ticker on any date in the file from 2016-01-04 on, with `.` written as `-` (BRK.B as BRK-B; without that step the count is 147), looked up in company_tickers.json. The 145 include delisted or merged names (TWTR, CELG, XLNX, ATVI, RTN, UTX), names trading under a new ticker (FB is now META, BK is now BNY), and a few that are neither on inspection (AVB, CMA), so the list needs checking name by name. They need a one-off hand map to CIK, which is stable for life; SEC's full entity-name list (cik-lookup-data.txt) is the free source. The 600 are not safe either: a ticker that was reused would resolve to today's company, not the member, so each mapping needs a check that the CIK filed under that name during the membership window. This map is the real survivorship work in the free route and must carry a coverage check (every member resolved, or the run refuses), per the postmortem's coverage rule.
- **Actual EPS — not usable for the surprise.** XBRL company facts carry GAAP EPS (EarningsPerShareDiluted), from fiscal 2007 for Apple and 2012 for Twitter. Two problems. The quarterly figure arrives with the 10-Q, not the 8-K: Apple's quarter ended 2026-06-27 was filed 2026-07-31, the day after the release; Twitter's Q2 2022 on 2022-07-26, four days after. And it is GAAP, while consensus estimates are almost always on the company's adjusted ("street") basis. A surprise built from EDGAR actuals and any consensus would mix definitions.

### Alpha Vantage — free surprise history, but 25 calls a day and coverage unverified

Read: documentation (https://www.alphavantage.co/documentation/), support FAQ (https://www.alphavantage.co/support/), premium page (https://www.alphavantage.co/premium/). Terms were read for doc 39 on 2026-08-26.

- **What it has.** The EARNINGS function "returns the annual and quarterly earnings (EPS) for the company of interest. Quarterly data also includes analyst estimates and surprise metrics." EARNINGS_CALENDAR returns expected releases for the next 3, 6 or 12 months, with a pre-market or post-market field (live call shown in doc 39). EARNINGS_ESTIMATES returns estimates "along with analyst count and revision history". LISTING_STATUS returns delisted US symbols as of any date after 2010-01-01, "to facilitate equity research on asset lifecycle and survivorship". None of these carries the premium label in the docs index.
- **Limits.** "25 API requests per day" on the free key. EARNINGS returns one symbol's full history per call, so a 745-name backfill takes about 30 days of free calls. Premium starts at $49.99 a month for 75 requests a minute (£37.54), which would do it in an afternoon.
- **Unverified.** History depth of EARNINGS; whether it answers for delisted symbols such as TWTR or CELG; whether estimatedEPS is the consensus as it stood before the release or a later figure; whether reportedEPS is GAAP or adjusted. None can be checked without a key. Doc 39 found no clause in the terms against automated use; personal, non-commercial use only.
- **Role.** A free cross-check of EDGAR's dates and of the Benzinga parse, and the forward calendar (doc 39 already recommends EARNINGS_CALENDAR for upcoming dates). Not the primary history until the delisted question is answered.

### Alpaca news (Benzinga) — the free consensus surprise

- **Facts.** Alpaca's news API: "historical news data dating back to 2015", "an average of 130+ news articles per day", "all news data is currently provided directly by Benzinga" (https://alpaca.markets/docs/news-api). Free on the existing Basic plan (repo note of 2026-08-07, not re-checked against Alpaca's pricing page here; the launch post gave 200 calls a minute on the free plan, https://alpaca.markets/blog/introducing-news-api-for-real-time-fiancial-news/, a beta-era figure, unverified today). A forum report of a 2015–2016 gap turned out to be the user's pagination bug (https://forum.alpaca.markets/t/historical-news-data-missing-for-2016/13576, 2024-01-31).
- **The headline template.** Benzinga's automated earnings headlines follow one shape, seen in syndicated copies: "Broadcom Q2 Adj. EPS $10.32 Beats $10.08 Estimate, Sales $8.73B Beat $8.71B Estimate"; "Bank of Montreal Q2 Adj. EPS $2.17 Misses $2.37 Estimate"; with no consensus, "Vs $(0.44) prior Year" instead (examples at https://news.streetbeat.com/article/32680709 and https://news.streetbeat.com/article/32546496). That gives actual, consensus and a revenue surprise, timestamped at publication, so the estimate cannot be revised after the fact.
- **Prior art.** `docs/research/18-fetch-earnings.py` already pulls these headlines per symbol, and #685's stricter matcher required a reported "EPS $" figure. The parse for actual and estimate is new.
- **Unverified, measure before relying on it.** The share of EDGAR events that have a matching headline, by year (2015–2017 coverage is the likely weak spot); whether delisted names' headlines are served; and that "Estimate" is a consensus and not one analyst's figure. One query per symbol over 2015–2025 with the existing keys answers the first two.

### Others checked

- **Finnhub free.** Endpoint metadata on its API docs page (https://finnhub.io/docs/api/earnings-surprises): the earnings-surprises endpoint ("historical quarterly earnings surprise going back to 2000") is free for the "Last 4 quarters" only; the earnings calendar for "1 month of historical earnings and new updates"; EPS and revenue estimates are "Premium Access Required". Too shallow for a backtest.
- **FMP free (Basic).** $0, "250 Calls / Day", 5 years of history on the Basic column of the plan table (https://site.financialmodelingprep.com/pricing-plans; the page refused a re-check on 2026-10-22, so unverified). Five years cannot cover 2016. Doc 39 found its earnings calendar cannot tell a confirmed date from an estimated one, and its terms define commercial use broadly.
- **Polygon (Massive) free.** 5 calls a minute, 2 years of history (https://massive.com/pricing); earnings are a Benzinga partner dataset, not on the free tier.
- **EODHD free.** 20 calls a day, one year of EOD, no calendar (https://eodhd.com/pricing).
- **Yahoo Finance.** Terms bar it: members may not "access or collect data … from our Services using any automated means" (https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html, §2(d)(9)).
- **Nasdaq.com calendar.** No published API; the site's pages load from an undocumented internal endpoint. Its terms page could not be fetched in this session (timeout, then 404 to a script), so its terms are unverified. Not usable without a licence.
- **The repo's EODHD plan.** The £19.99 Historian (EOD All World) plan "does not include … the corporate calendar"; the calendar is only in the £59.99 Equity analyst (Fundamentals) and £99.99 All-in-One plans (https://eodhd.com/pricing). The core plan doc 66 rules for splits gives PEAD nothing. The separate £19.99/month Corporate Events Calendar & News API add-on lists earnings and corporate calendars; its estimates, history depth and plan requirement are unstated (https://eodhd.com/pricing, read 2026-10-22).

## Can a surprise be built from free parts?

Not from EDGAR actuals plus a free consensus. EDGAR's EPS is GAAP and arrives with the 10-Q days to weeks after the release, and no free source of historical consensus with delisted coverage was found. The free sources that carry a consensus already carry their own actual: Benzinga headlines (point-in-time, from 2015, coverage to be measured) and Alpha Vantage EARNINGS (25 calls a day, delisted and point-in-time status unverified). Use the actual and estimate from the same source, never across sources.

## Does the price-reaction proxy remove the need for consensus?

Yes. A PEAD sleeve that ranks events by the excess return over the reaction session, using EDGAR dates and the Alpaca bars already stored, needs no consensus, no actual EPS and no paid data. Three things it must handle:

- **Timing.** Before-open versus after-close decides which session is the reaction day. Get it from the filing's accepted time (above), and cross-check against the bars.
- **Look-ahead.** Entry can only follow the close of the reaction session; the signal is known then and not before.
- **Overlap with candidate 2.** Candidate 2's dip-buying rule buys exactly the post-miss drops that PEAD expects to keep falling (#1785, candidate 2 proposal). Their correlation should be reported if both reach paper.

Whether candidate 4 uses this measure, the Benzinga surprise, or both as two counted trials is David's call at the candidate 4 proposal; this document does not decide it.

## Paid options

Prices as published on 2026-10-21, GBP at 1.3318 where the vendor quotes USD.

| Vendor and plan | Price | History | Delisted | Point-in-time estimate | Limits | Terms on automated use |
|---|---|---|---|---|---|---|
| EODHD Fundamentals Data Feed ("Equity analyst") | £59.99/month, £49.99/month annual (https://eodhd.com/pricing) | Earnings "back to the 1990s"; Trends fiscal 2017–2027 (https://eodhd.com/financial-apis/calendar-upcoming-earnings-ipos-and-splits) | Fundamentals for delistings after 2018 only; before 2018 "EOD only"; earnings not stated (https://eodhd.com/financial-apis/delisted-stock-companies-data-2) | Calendar estimate unverified; Trends gives consensus 7/30/60/90 days earlier | 100,000 calls a day, 1,000 a minute; one call per calendar request | Non-professional users may "store, manipulate, and analyze the data for private, non-commercial purposes"; no automated-trading clause; silent on keeping data after cancelling (https://eodhd.com/financial-apis/terms-conditions) |
| EODHD Corporate Events Calendar & News API (add-on) | £19.99/month, sold separately from the core plans (https://eodhd.com/pricing, read 2026-10-22) | Earnings and historical events listed; depth unstated | unverified | unstated | unverified | as the EODHD row above (unverified for the add-on) |
| EODHD All-in-One | £99.99/month | as above | as above | as above | as above | as above |
| FMP Premium | $69/month (£51.81), $49/month annual (£36.79) (https://site.financialmodelingprep.com/pricing-plans; the page refused a re-check on 2026-10-22, so unverified) | "Up to 30 Years"; "Corporate Calendars" listed from Premium | A "Delisted Companies" list exists; earnings coverage for them unverified | Unverified; no confirmed-date flag (doc 39) | 750 calls a minute | Commercial use defined to include "data-driven decision-making" for commercial purposes (doc 39) |
| FMP Starter | $29/month (£21.78) | 5 years | as above | as above | 300 a minute | as above |
| Alpha Vantage premium | from $49.99/month (£37.54) | as the free tier (unverified) | unverified | unverified | 75 calls a minute and up | Personal, non-commercial; no automated-use clause (doc 39) |
| Finnhub Estimates-1 / Estimates-2 | $75 (£56.31) / $200 (£150.17) a month, from the price map on https://finnhub.io/pricing-fundamental-data | Surprises "going back to 2000"; which tier includes them unverified | unverified | unverified | 300 calls a minute on fundamental tiers (search result, unverified) | "Strictly for personal use", no redistribution; no automated-trading clause (doc 39) |
| Massive (Polygon) Benzinga earnings | $99/month per partner dataset (£74.34) (https://massive.com/pricing); whether a Stocks plan (from $29) is also needed is unverified | "Records date back to April 30, 2010" (https://massive.com/docs/rest/partners/benzinga/earnings) | not stated | Has a confirmed/projected date flag; estimate history not stated | Unlimited on paid plans | Open licensing finding against this vendor (docs 22 and 30) |
| Zacks via Intrinio | Enterprise only, "$1,250/mo+", feed prices not listed (https://intrinio.com/pricing) | EPS Surprises "20+ years" | unverified | Field is "the pre-earnings release mean EPS estimate" (https://docs.intrinio.com/documentation/web_api/get_zacks_eps_surprises_v2) | n/a | Business licence |
| Zacks via Nasdaq Data Link | Premium, contact sales (doc 39; search, unverified) | unverified | unverified | unverified | n/a | n/a |
| Estimize | Contact sales; an archived 2021 page showed $325 a quarter for subscribers (search, unverified) | EPS and revenue "since 2012 (point-in-time)" per its WRDS document (https://wrds-www.wharton.upenn.edu/documents/1766/Estimize.pdf, via search) | unverified | Yes, by its own description | n/a | n/a |

None of the paid options was confirmed to cover large caps delisted before 2018 with their earnings history. Before any purchase, the question to put to the vendor's support is whether TWTR, CELG, XLNX and ATVI return earnings rows with estimates.

## Forward feed for paper

- **EDGAR** submissions, polled after the close and before the morning cycle, for new item 2.02 8-Ks on held and candidate names. Sub-second publication, free, no key.
- **Alpha Vantage EARNINGS_CALENDAR**, one call a day, for upcoming dates (doc 39's recommendation, unchanged).
- **Alpaca news** for the Benzinga headline, if the consensus surprise is used.

## What is still unverified

1. Alpha Vantage EARNINGS: depth, delisted symbols, whether the estimate is pre-release and whether the actual is adjusted.
2. Benzinga headlines in Alpaca's archive: the match rate against EDGAR events by year, and delisted names.
3. EODHD earnings for names delisted before 2018, and whether the calendar's estimate is the pre-release consensus.
4. Nasdaq.com terms.
5. Which Finnhub tier carries the surprise history.

Items 1 and 2 need only free calls with keys David already holds (Alpaca) or a free sign-up (Alpha Vantage, David's to make). They belong in the candidate 4 build session, not here.
