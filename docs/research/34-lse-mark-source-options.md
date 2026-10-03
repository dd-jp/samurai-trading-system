# LSE mark source — what can lawfully and reliably price the live equity leg

**Date:** 2026-08-19 · **Ticket:** [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) · **Extends:** [`33-intraday-data-availability.md`](33-intraday-data-availability.md) §3, [`30-data-vendor-decisions.md`](30-data-vendor-decisions.md), [`22-mi-source-licensing.md`](22-mi-source-licensing.md)

Doc 33 established that ten years of LSE intraday *history* is not obtainable at £0, and left the
live question open. This document answers the live question: **what can mark an open position on an
LSE-listed ETP, tick by tick, well enough that `stale_feed`
([#641](https://github.com/dd-jp/samurai-trading-system/issues/641)) and the Risk valuation bound
([#640](https://github.com/dd-jp/samurai-trading-system/issues/640)) can pass.** Those gates need no
history. They need a price with an honest observation timestamp, in the book's currency, no older
than `max_mark_age.stocks = 15 minutes`.

Claims marked **VERIFIED** were tested by an HTTP call made 2026-08-18/19 with this project's own
keys, against the eleven `lse_ticker` values in `server/providers/universe-pool/lse-etp-pool.ts`, or <!-- cite-exempt: historical — deleted in v1 teardown wave 4 (#1748); preserved at tag v1-final -->
quoted from a vendor document retrieved at the URL given. Claims that could not be established that
way are marked **NOT VERIFIED** and nothing is planned against them. No probe placed an order and no
key appears here.

**Update 2026-09-01 — recommendation moved to Saxo, superseding §6's IBKR pick below.** Saxo (the
execution venue decided after this document was written — ADR-0015's 2026-08-30 amendment) confirmed
in writing that LSE data, including real-time subscriptions, is delivered over OpenAPI on a live
account (Alexander Henry, Saxo OpenAPI Team, support ticket 20084, 2026-09-01): *"Most market data
(and real-time data subscriptions) are available via OpenAPI. LSE exchanges are as well... only
delayed data is available on simulation, even after linking your live account (which itself may have
real-time data entitlements)."* This is a **written vendor statement, not an HTTP-probed claim** — it
does not carry this document's VERIFIED marking, and none of §5/§6's IBKR findings below are wrong or
withdrawn; they now describe the runner-up. David chose Saxo over IBKR on 2026-09-01 (grilling record
on [#895](https://github.com/dd-jp/samurai-trading-system/issues/895)): one account for execution and
data beats IBKR's cheaper sticker price (£1/mo non-pro vs Saxo's ~£7/mo) once IBKR's second account,
USD 500 minimum-equity tie-up, and its own unverified LSEETF-coverage gap are counted. Saxo carries
the equivalent open items IBKR has below — confirmation that this is the same ~£7/month L1
entitlement, the OpenAPI endpoint/field carrying the tick timestamp, and per-instrument coverage for
the pool's leveraged ETPs/ETCs (3USL, 3UKL, an oil ETC) rather than ordinary shares — chased in a
2026-09-01 follow-up on the same ticket, not yet answered.

**Update 2026-09-03 — the chase is over; support won't confirm the rest in writing.** Alex's
2026-09-03 reply on ticket 20084 declined the entitlement-match and ETP-coverage questions outright
("We do not advise on what market data subscriptions include" / "Same as answer 1, I am afraid"),
pointing instead to the public [market-data subscriptions page](https://www.home.saxo/products/market-data-subscriptions)
and the in-platform subscription agreements shown before purchase. It did answer the endpoint
question: the price feed is `POST /trade/v1/subscriptions/prices`
([reference docs](https://www.developer.saxo/openapi/referencedocs/trade/v1/prices/post__trade__subscriptions)),
still without naming the tick-timestamp response field. So 1 of 3 chased specifics has a concrete
OpenAPI answer; the other 2 (exact entitlement name/price, per-instrument leveraged-ETP/ETC coverage)
are **not obtainable from support by further ticket replies** — resolving them means reading the
linked pricing/subscription pages, or probing the endpoint against a funded live account, not
emailing again. This does not change the Saxo-over-IBKR recommendation.

**Update 2026-09-03 (continued) — entitlement name/price resolved from the linked page, VERIFIED.**
The [market-data subscriptions page](https://www.home.saxo/products/market-data-subscriptions),
fetched directly at that URL, lists **"London Stock Exchange" — Level 1 - Private — 7.00 GBP**/month
(Professional tier is 65.00 GBP; Level 2 tiers are 8.00/229.00 GBP). This matches the ~£7/month figure
used throughout this document and closes the first of the two remaining unknowns under this document's
own VERIFIED convention (§0: "quoted from a vendor document retrieved at the URL given"). The same
page states coverage generically: *"A subscription to live price data from an exchange gives you
access to live prices on Stocks, Single Stock CFDs, ETFs/ETCs and CFDs on ETFs/ETCs from the
particular exchange."* ETFs/ETCs are named, which covers the pool's instrument *wrapper* (3USL, 3UKL,
the oil ETC are themselves ETPs/ETCs) — but the page does not say "leveraged" or "short" anywhere, so
whether the *leverage* is what's covered, not just the wrapper, is **still NOT VERIFIED** and is the
one unknown left before #895 can close. That one needs a live-account probe, not a docs read — the
public page has nothing more granular to offer.

**Read §4 before anything else.** It is not a data-vendor finding, and it is larger than this ticket.

---

## Verdict

| Candidate | Serves the LSE pool? | Verdict |
|---|---|---|
| **Alpaca** (integrated) | **No — VERIFIED** | Cannot serve the equity leg at any price. |
| **Polygon** (integrated, fallback) | **No — VERIFIED** | Cannot serve the equity leg at any price. |
| **Trading 212** (the account provider) | **No — VERIFIED from its own docs** | No quote endpoint exists; the one price field has no timestamp; the API Terms bar algorithmic trading outright (§4). |
| **Yahoo Finance** | **Yes, 11/11 at 1-minute — VERIFIED** | Technically able for *bars*, but last-trade only, ~20 min delayed, and unlicensed. Research only. |
| **Saxo** (the execution venue) | **Yes — real-time over OpenAPI on a live account; entitlement name/price VERIFIED from vendor page** | **The recommendation as of 2026-09-01.** Same account as execution; endpoint confirmed (`POST /trade/v1/subscriptions/prices`); entitlement is "LSE, Level 1 - Private, £7.00/mo" (VERIFIED); whether *leveraged* ETPs/ETCs specifically are covered is the one item still NOT VERIFIED — see the 2026-09-03 update notes above and §6. |
| **Interactive Brokers** | **Yes — LSE L1, GBP 1.00/month non-professional** | **Runner-up as of 2026-09-01** (was the recommendation). Real-time bid/ask at a retail price, but a second account, USD 500 minimum equity, and unverified LSEETF coverage lost it to Saxo's single-account path. |
| Twelve Data / EODHD / FMP / Databento | **No real-time XLON found** (not the same as none existing) | Delayed, EOD, Cboe-not-LSE, or US-only in what was checked; Twelve Data's real-time-EU add-on advertises Cboe Europe and its LSE price was NOT FOUND rather than shown to be absent. See §5. |
| Finnhub / Tiingo / marketstack / Alpha Vantage / IEX Cloud | **NOT VERIFIED** | Not confirmed against the pool or their own terms; recorded as open, not rejected. |
| Google Finance | **No API since 2012** | Not a candidate. |

**Recommendation as of 2026-09-01: Saxo, over OpenAPI, on the account already used for execution.**
See the update note above and §6 — this replaces the IBKR pick below, which stands as the runner-up
and as the record of why IBKR was ruled out on total cost (second account, USD 500 minimum equity,
unverified LSEETF coverage) rather than on data quality.

**Original recommendation (2026-08-19, superseded above): Interactive Brokers, "LSE UK (L1)", GBP
1.00/month non-professional.** It is the only retail-priced real-time LSE Level 1 feed with bid/ask
found anywhere in this sweep. It requires an IBKR account (ADR-0001 already names IBKR as the
long-term equities broker) and a USD 500 minimum equity balance to hold any market-data subscription.

**And the blocker is bigger than the mark.** Trading 212's API Terms prohibit exactly what Samurai
is. That is an execution-venue problem, not a data problem, and no mark source fixes it.

---

## 1. What the gates actually require

`Mark { price, observed_at, source, asset_class }`. `observed_at` is the **observation** time, never
the request time; `mark-freshness.ts` derives `markAgeMs` from it and `paper-profile.ts` bounds it at
`15 * 60_000` for stocks. A mark source must therefore satisfy four things, three of which are
usually treated as details:

1. **Coverage** — it must know the `lse_ticker`, not merely the US underlying (§3.1).
2. **Currency** — the price must reach GBP without an FX rate this system does not hold (§3.2).
3. **Recency** — the *observation* must be under 15 minutes old at the moment of the tick, on a pool
   whose lines print rarely (§3.3).
4. **Licence** — the project must be permitted to use the feed to trade real money (§4, §5).

Failing any one disqualifies a vendor, and (3) turns out to eliminate a whole class of otherwise
adequate ones. A **15-minute-delayed feed consumes the entire freshness budget before the first
print gap is counted**, which is why almost every free tier in §5 is unusable regardless of price:
delayed data is what LSE lets vendors redistribute without a per-user licence.

## 2. The two integrated vendors do not serve the LSE

**Alpaca — VERIFIED absent.** With this project's own keys:

```
GET /v2/stocks/bars?symbols=3USL&timeframe=1Min   -> {"message":"invalid symbol: 3USL"}
GET /v2/stocks/bars?symbols=LQQ3                  -> {"message":"invalid symbol: LQQ3"}
GET /v2/stocks/bars?symbols=NVD3                  -> {"message":"invalid symbol: NVD3"}
GET /v2/assets/3USL                               -> 404
GET /v2/assets/3USL.L                             -> 404
```

**Polygon — VERIFIED absent.**

```
GET /v3/reference/tickers?search=3USL   -> {"results":[]}
GET /v3/reference/exchanges             -> no XLON; every MIC returned is a US venue
```

This is the whole of the hole #734 names. Both integrated sources answer for the *screening
instruments* (SPY, QQQ, NVDA…) and for nothing the account can hold. That asymmetry is what makes
the substitution — marking `3USL` off `SPY` — tempting, and it is why the implementation refuses it
structurally rather than by comment (§7).

## 3. What a probe of the pool found

### 3.1 Coverage — Yahoo has it; it is the only free source that does

Yahoo's undocumented `v8/finance/chart/<TICKER>.L` returned **HTTP 200 with 1-minute bars for all
eleven pool tickers**, `exchangeName: "LSE"`, ~500 one-minute bars per session. Genuine LSE
coverage, and the only free instance of it found. It is also the only good news in this section:
see §5 for why it still cannot carry a mark.

### 3.2 Currency — the pool is not the GBP universe the restriction assumes

[#659](https://github.com/dd-jp/samurai-trading-system/issues/659) restricted the equity leg to
**GBP** LSE-listed ETFs/ETCs, to avoid Trading 212's 0.30% round-trip FX fee. The checked-in pool
does not satisfy that restriction:

| Declared in `lse-etp-pool.ts` | Count | Tickers |
|---|---|---|
| `USD` | **8 of 11** | 3USL, 3LTS, NVD3, 3LNV, 3QQQ, MST3, 3LPA, PLT3 |
| `GBX` (pence) | 2 | LQQ3, 3SPY |
| `GBP` | 1 | 3AAP |

And the venue disagrees with the file on two rows. Yahoo-reported currency per ticker, probed
2026-08-18 and **re-confirmed 2026-08-19** by the §3.3 script (its log's last line records the
venue's currency for all eleven): 3USL `USD`, LQQ3 `GBp`, 3SPY `GBp`, 3LTS `USD`, NVD3 `USD`, **3AAP `GBp`** (the file
says `GBP` — a **100x** discrepancy), 3LNV `USD`, **3QQQ `GBp`** (the file says `USD`), MST3 `USD`,
3LPA `USD`, PLT3 `USD`.

Two findings; the second is for David rather than for code:

1. **`GBp` and `GBP` differ by one character's case and by a factor of one hundred.** Any
   normalisation that upper-cases before comparing turns a 312.40 mark into a 31,240 one. The
   implementation tests pence *before* pounds for this reason, and carries a test named after the
   trap.
2. **The pool is majority-USD, so the GBP-only restriction ADR-0016/#659 asserts is not true of the
   instruments in the pool.** The FX-fee rationale that produced the restriction is undermined by
   its own universe. This is not something to convert around: marking a USD line into a GBP book
   needs an FX rate, which is a second feed with a second staleness question. Either the universe
   narrows to the GBP/GBX lines (three of eleven today) or the FX question gets an answer. A related
   hazard flagged independently by the vendor sweep: the same ETP is listed in different currencies
   across XLON/BCXE/XMIL/XPAR, so any vendor integration must pin the MIC **and** assert the
   currency on every payload, never trust the symbol.

### 3.3 Recency — a last-trade mark fails #641 on illiquidity alone

**MEASURED**, and reproducible: the producer is
[`34-print-gap-measurement.py`](34-print-gap-measurement.py) and its raw output is
[`archive/raw/2026-08-19-34-print-gaps.txt`](archive/raw/2026-08-19-34-print-gaps.txt). The table
below is that log, not a transcription of an earlier unrecorded run — the first pass of this
document published figures from a 2026-08-18 window with no script and no log, and they are replaced
here rather than restated, because a MEASURED label with nothing behind it is the thing this repo's
convention exists to prevent.

Method, since the numbers mean nothing without it: a **print** is a 1-minute Yahoo bar with a
non-null close AND non-zero volume (Yahoo emits a bar per session minute regardless of activity);
gaps are measured **within a session only**, over the LSE continuous window **08:00–16:30
Europe/London**; the figure is the fraction of consecutive-print gaps strictly greater than 15
minutes. Yahoo's 1-minute history reaches back about seven days, so this can only ever measure the
last handful of sessions — **re-running it on another day measures different sessions and will not
reproduce these figures exactly.** It reproduced the earlier run's *ordering* and its conclusion, not
its decimals.

Five sessions to 2026-08-19:

| Ticker | 3USL | LQQ3 | 3SPY | 3LTS | NVD3 | 3AAP | 3LNV | 3QQQ | MST3 | 3LPA | PLT3 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gaps > 15 min | 33.6% | 3.2% | 50.0% | 17.5% | 11.5% | **72.7%** | 50.0% | 64.0% | 18.4% | *n/a* | 7.3% |
| prints in 5 sessions | 148 | 671 | 26 | 262 | 354 | 27 | 57 | 30 | 266 | **4** | 512 |
| median gap (min) | 9 | 2 | 27 | 4 | 4 | 44 | 16 | 23 | 4 | *n/a* | 2 |

**3LPA is the worst line, not the exception its blank cell suggests.** It printed **four times across
five whole sessions**, so it has no within-session consecutive pair to measure and the percentage is
undefined. An instrument that trades four times a week cannot be marked off its last trade at any
freshness bound worth having.

**This is the most consequential measurement here, and it is vendor-independent.** These ETPs trade
thinly. A mark taken from the last *trade* is stale by the system's own definition for a large part
of every session — 72.7% of the time on 3AAP — however fast the vendor is, because there is no more
recent trade to report. #641 would fire constantly and #640 would refuse to value the book, on
instruments that are perfectly liquid in the sense that matters: a market maker is quoting them
continuously.

So **the mark must come from the quote midpoint, not the last trade.** A market maker's bid/ask
refreshes even when nothing prints. The implementation prefers the midpoint and falls back to last
trade only when one side of the book is missing.

The corollary is a decision for David: **if the chosen vendor supplies only last-trade prices, then
either `max_mark_age.stocks` must be relaxed — weakening the protection #641 exists to give — or the
universe must move to lines that print more often.** It cannot be fixed downstream. It is also the
single criterion that eliminates most of §5.

## 4. Trading 212 — the finding that outgrows this ticket

The obvious answer to "who may lawfully price the instruments in your own account" is the account
provider. For Samurai that answer fails three times over, and the third failure is not about data.

**4.1 There is no quote endpoint.** The public API (`https://docs.trading212.com/api`, OpenAPI
bundle at `https://docs.trading212.com/_bundle/api.yaml`) exposes account/summary,
metadata/exchanges, metadata/instruments, orders, positions, history and pies. `metadata/instruments`
returns ticker/ISIN/name/`currencyCode`/type/quantity limits and **no price**, refreshed every 10
minutes. The **only** price field in the entire surface is `Position.currentPrice`.

**4.2 That one field cannot be a mark.** It exists only for instruments already held — so it can
never price an *entry* — and it carries **no timestamp** of its own (`createdAt` on a position is
the open date). A `Mark.observed_at` derived from it would be the request time wearing an
observation's name, which is precisely the failure mode #641 and #640 exist to catch. Rate limits
compound it: 1 request/second on positions, 1 request/50 seconds on instruments, 1 request/30
seconds on exchanges. The API is also self-described as *"currently in beta and under active
development"*, and the LSE ticker form is undocumented (the convention is proprietary, e.g.
`AAPL_US_EQ`) — so it may not be inferred.

**4.3 The API Terms prohibit what Samurai is.** From the API Terms PDF
(`https://www.trading212.com/legal-documentation/API-Terms_EN.pdf`, last updated 17.10.2025;
extracted from a subset-font PDF, so **the exact wording should be confirmed by eye before this is
acted on**):

- **4.2(a)** — *"You are expressly prohibited from using our API for Algorithmic Trading purposes or
  for providing any commercial services…"*
- **§11 definitions** — *"Algorithmic Trading means any kind of trading in Instruments where a
  computer algorithm automatically determines individual parameters of Orders, such as whether to
  initiate the Order, the timing of execution, price or quantity of the Order, or how to manage the
  Order after its submission, with limited to no human intervention."*
- **6.2** — access is *"solely for your personal use … and only for testing purposes"*; **6.6**
  requires prior written consent for automated mass data entry.
- **4.2(b)(2)** — separately names *"Scalping"* as prohibited conduct.
- **7.1(b)** — *"You will not receive real-time information on Market Data."*

The §11 definition describes Samurai exactly, including ADR-0007's decision that there is no human
gate in paper or live. **This bears on Trading 212 as the live execution venue at all, not merely as
a data source** — ADR-0015 names the T212 ISA as where the equity leg trades, and 4.2(a) says its
API may not be driven this way. Doc 33 §5's suggestion that *"Trading 212's demo API can supply
quotes going forward"* is superseded by 7.1(b) and 4.2(a).

This document does not resolve that. It records it as the largest open item on the live path and
routes it to David, because the options — seek written consent, change venue, or change the
automation posture — are all his. It is filed as
[#896](https://github.com/dd-jp/samurai-trading-system/issues/896), and #665/#666 were opened on a
premise these terms contradict.

## 5. The rest of the field, and why a free tier does not exist here

**The governing rule is the exchange's, not the vendors'.** Quoted from the **2026** edition,
effective 01 January 2026 — Schedule B – Market Data Policy
(`https://docs.londonstockexchange.com/sites/default/files/documents/schedule-b-market-data-policy-2026.pdf`)
and Schedule A – Price List
(`https://docs.londonstockexchange.com/sites/default/files/documents/schedule-a-price-list-and-products-schedule-2026.pdf`),
both retrieved and text-extracted 2026-08-19. The first pass of this document quoted the **2025**
edition, in August 2026, and the section numbers and prices moved between the two.

- **§7.2, in full:** *"If Level 1 or 2 Data is delayed by 15 minutes or more prior to dissemination
  and display, Data Charges are not payable by the End Customer."* The 2025 wording ended at *"are
  not payable"*; the 2026 wording rescopes it to the **End Customer**.
- **"Delayed Data", in full:** *"means Data made available 15 minutes after publication, but before
  midnight on the day of its original publication."* The trailing clause is not decoration — data
  older than that day is **After Midnight Data**, a separately licensed thing.
- **§6.5** (2025's §6.1.6): *"For the avoidance of doubt, Non-Display Usage includes but is not
  limited to automated processing (including automated trading), semi-automated processing
  (including semi-automated trading) and Non-Display Usage within hosted environments."* Non-Display
  Usage is defined over **Real Time Data**.

**What §7.2 actually grants is narrower than "the 15-minute path is free".** It exempts *Data
Charges* only, and only as against the End Customer. **Delayed Data *Licence* Charges are a separate
line item** — Schedule A prices the UK market Data Delayed Data licence at **£5,831/year per Website
for Level 1** (£13,160 Level 2). Whether a single self-consuming user needs one at all is a question
for LSEG, not one this document can answer; what can be said is that a delayed feed is **not
self-evidently licence-free**, and it is useless for a 15-minute freshness bound anyway, while the
real-time path is exactly what carries the non-display fee. Direct from LSEG, ETF/ETP Non-Display
Level 1 for 1–5 applications is **£6,695/year** (Schedule A 2026, §3.3.2 Client Facilitation; the
2025 figure was £6,500), 50% off the first year.

That single distinction explains every row below.

| Vendor | XLON coverage | Cheapest with LSE | LSE freshness | Bid/ask | Terms for a private for-profit algo |
|---|---|---|---|---|---|
| **IBKR** | market-data bundles **`LSE` ("LSE UK") / `LSEIOB` ("LSE International")** — see note | **GBP 1.00/mo** L1 non-pro (L2 £7) | **real-time on subscription**; free tier 15 min delayed | **yes** (`reqTickByTickData`, `BidAsk`) | non-professional test is IBKR's own and is **not** paraphrasable — see §6 |
| Twelve Data | XLON — request form is **`symbol=AZN&exchange=LSE`** (VERIFIED at `twelvedata.com/docs`, 2026-08-19); XLON is **EOD-only** there | Pro **$229/mo** is on the **Individual** ladder, headed *"Access the data for personal, internal, and non-commercial purposes"* (VERIFIED at `twelvedata.com/pricing`, 2026-08-19) — **so it is not a tier this system may buy**; the Business ladder is unpriced here | add-on advertises **Cboe Europe**, not LSE primary; LSE figure not found | not found | private for-profit use falls outside the Individual ladder by its own heading |
| EODHD | `3USL.LSE` | £29.99/mo (EOD+Intraday) | *"Prices are delayed: **15-20 minutes** for stocks"*; the real-time WebSocket is US/FX/crypto only | **no** — OHLCV snapshot | personal vs commercial toggle |
| FMP | `.L` from Premium | $49/mo | real-time claim is scoped to **US** ETFs | not found | commercial use of exchange data → enterprise |
| Databento | **no XLON dataset** (US equities + futures) | — | — | yes | good terms, wrong geography |
| Finnhub / Tiingo / marketstack / Alpha Vantage | **NOT VERIFIED** | — | — | — | not confirmed; see note below |
| **Yahoo Finance** | `3USL.L` — 11/11 VERIFIED | free | **~20 min** (ICE); `v8/chart` is bars, i.e. last trade | **no** — `v7/finance/quote` returned **HTTP 401** during this probe | ToS bars automated collection and commercial use; no official API at all |
| Google Finance | no API since 2012 | — | up to 20 min | — | *"not for trading purposes"*; walled off from the Sheets API |
| TradingView | no data API | — | — | — | *"prohibited uses include… any form of automated trading… price referencing"* |
| IEX Cloud | **NOT VERIFIED** — reported defunct, not confirmed here | — | — | — | — |
| LSEG / ICE / Barchart | yes | **no self-serve price published** — "request details" | — | — | contact sales |

**Yahoo deserves its own sentence** because it is the only free source that covers the pool, and it
still fails twice independently: the quote endpoint that carries bid/ask answered **401
Unauthorized** on every attempt, leaving bars — i.e. last trade, which §3.3 rules out on most of the
pool — and there is no licence to rely on, only undocumented internals of a website whose terms
prohibit exactly this use. The 401 is that risk already materialising. Yahoo stays useful for
**research** (offline studies, spread measurement, doc 33's event work), where a broken endpoint
costs a re-run rather than a mispriced position. It must not sit on the live path.

**Four names are recorded as NOT VERIFIED, not as rejected:** Finnhub, Tiingo, marketstack and
Alpha Vantage. The research pass assigned to them did not return, and this document does not assert
coverage, delay, or licence terms it has not seen. They should be probed against the pool's tickers
before any of them is either adopted or written off. Note the prior on that probe, though: leveraged
ETP lines are small, numerous and issuer-specific, which is exactly where thin vendor coverage stops,
and §5's structural rule means even full coverage is likely to arrive 15 minutes late.

**One cheap lead left open:** LSE's own **Per Price Request** licence — **£5,812/year** for UK and
International market Data (Schedule A 2026, §3.1.4 Other Licences; the 2025 figure was £5,535) with the first
300,000 requests included, delivering *"all Level 1 components including best bid & offer"*. It is
published under Redistribution, so whether a single self-consuming user may hold it is unknown.
Worth an email to `marketdata@lseg.com` if IBKR falls through.

## 6. Recommendation

**Superseded 2026-09-01 — see the update note after §0 and the Verdict table.** David chose Saxo
over IBKR (grilling record on [#895](https://github.com/dd-jp/samurai-trading-system/issues/895)):
one account for both execution and data beats IBKR's cheaper sticker price once IBKR's second
account, USD 500 minimum-equity tie-up, and unverified LSEETF coverage are counted against it. Saxo's
own load-bearing unknowns — whether the confirmed real-time feed is the same ~£7/month L1 entitlement,
which endpoint/field carries the tick timestamp, and whether leveraged ETPs/ETCs are covered, not
just ordinary shares — were chased in a 2026-09-01 follow-up on Saxo support ticket 20084. **Closed
out 2026-09-03:** support confirmed the endpoint (`POST /trade/v1/subscriptions/prices`, timestamp
field still unnamed) and declined the other two outright, pointing to the public subscriptions page
instead of answering directly. That page **VERIFIED the entitlement — "LSE, Level 1 - Private,
£7.00/month"** — but only describes coverage generically ("Stocks... ETFs/ETCs..."), leaving
**whether the leverage itself is covered, not just the ETP/ETC wrapper, as the one item still open**
(§0's second 2026-09-03 note). That needs a live-account probe, not a docs read. The IBKR analysis
below is kept as the record of the runner-up, not retracted.

**Original recommendation (2026-08-19): Interactive Brokers, "LSE UK (L1)", GBP 1.00/month non-professional.**

- It is the **only retail-priced real-time LSE Level 1 feed with bid/ask** found in this sweep. The
  next cheapest real-time route is LSEG direct at £6,695/year (§5).
- Bid/ask is native, which §3.3 shows is not a nicety but the difference between a mark source that
  works and one that trips #641 through most of the session.
- ADR-0001 already names IBKR as the long-term equities broker, so this is a step onto a path the
  project had chosen anyway rather than a new dependency.
- Non-professional status is what makes it £1 rather than £56/month. **Its conditions are not
  paraphrased here on purpose.** IBKR's own test names **US** regulators specifically, and its
  employment prong is about acting *in a role requiring registration* rather than "working at a
  financial institution" — a paraphrase that sounds equivalent and is not. Eligibility is
  **David's to confirm against IBKR's own wording at application time**, and nothing in this
  document should be read as having settled it.

Costs and unknowns to carry into that decision, none of them settled by this document:

- **USD 500 minimum account equity** is required to hold any IBKR market-data subscription; fees are
  not pro-rated.
- **Whether "LSE UK (L1)" covers the segment these ETPs list on is NOT VERIFIED, and it is the
  load-bearing unknown in this recommendation.** IBKR's *market-data* bundles for the venue are
  `LSE` ("LSE UK") and `LSEIOB` ("LSE International"); the `LSE / LSEETF / LSEIOB1` trio is IBKR's
  **commission** schedule, a different list, and the .co.uk entity's page omits `LSEETF` from it
  altogether. So there is no "LSEETF market-data bundle" to buy, and the question is not which of
  several bundles to pick but **whether the one GBP 1.00 "LSE UK" bundle carries these ETP lines at
  all**. Ask IBKR before subscribing; if it does not, the recommendation is unfunded. (Neither
  claim could be re-fetched here — `interactivebrokers.co.uk` answers **HTTP 403** to non-browser
  requests, the same refusal noted for the docs site below.)
- The **timestamp field on IBKR's tick-by-tick callback is NOT VERIFIED** (the docs site refuses
  non-browser fetches). Since `Mark.observed_at` must be the vendor's stamp, this needs confirming
  at integration time, not assumed.

**Fallback:** none that satisfies §3.3. Every other option is delayed, EOD, or US-only. "Take a
15-minute-delayed feed and relax `max_mark_age.stocks`" is the shape of the only alternative, and it
is a decision to weaken a safety gate, so it belongs to David rather than to an implementation.

**What must not happen:** marking an `lse_ticker` off its `screening_instrument`. It is the one
substitution that makes every problem above vanish from the logs while making the book wrong —
Alpaca answers instantly for SPY, the mark is fresh, the currency is clean, and the number describes
an instrument the account does not hold.

## 7. What the code half does, given that none of this is decidable in code

[#734](https://github.com/dd-jp/samurai-trading-system/issues/734) asked for a `DataSource` that
serves the LSE. The vendor cannot be chosen without §4 and §6 being answered by David, so the
implementation ships everything that does not depend on the answer:

- `LseMarkDataSource` normalises on the **LSE** calendar, converts **pence to GBP** with pence
  tested before pounds, and prefers the **quote midpoint** over last trade per §3.3.
- The vendor is an injected port (`LseMarkClient`: `getBars`, `getLatestQuote`), so adopting IBKR —
  or anything else — is one adapter, not a rework.
- The `lse_ticker` allow-list is enforced structurally: a `screening_instrument` is refused with an
  error that names the substitution, before any vendor call.
- The composition root **refuses to boot** an LSE universe with no vendor client, rather than
  silently routing it to Alpaca and collecting `invalid symbol`.
- A pool row whose **declared currency is not GBP or pence is refused at construction**, not on the
  first live read — §3.2 makes that the majority case, and a mid-tick currency throw would arrive
  after the orchestrator was up and possibly holding a position.

## 8. What this leaves open — for David, not for code

1. **Trading 212's API Terms bar algorithmic trading (§4.3), and this is an execution-venue
   question, not a data one.** Seek written consent, change venue, or change the automation posture.
   Filed as [#896](https://github.com/dd-jp/samurai-trading-system/issues/896); #665/#666 rest
   on a premise these terms contradict.
2. **Which vendor may serve the live mark** — filed as
   [#895](https://github.com/dd-jp/samurai-trading-system/issues/895). Recommended as of 2026-09-01:
   Saxo, over OpenAPI, on the execution account (§0 update note, §6). Of the three specifics chased
   on ticket 20084: the endpoint is confirmed (`POST /trade/v1/subscriptions/prices`); the entitlement
   is VERIFIED from Saxo's public page as "LSE, Level 1 - Private, £7.00/month"; **only whether
   leveraged ETPs/ETCs specifically are covered (not just the wrapper) remains open**, and needs a
   live-account probe, not a docs read or another ticket reply.
   IBKR LSE UK (L1) at £1/month non-pro (§6) is the runner-up, still gated on the same class of open
   question (LSEETF-segment coverage) plus its own second-account/USD 500 minimum overhead.
3. **The USD majority (§3.2).** Narrow the universe to the GBP/GBX lines, or answer the FX question.
   Until then the orchestrator refuses to boot on a USD-declared line rather than guessing a rate.
4. **The 15-minute bound versus print frequency (§3.3).** Every non-IBKR option is ≥15 min delayed,
   so choosing one means relaxing the bound. That is a safety decision.
5. **The two currency discrepancies (§3.2), `3AAP` and `3QQQ`.** File and venue disagree; on 3AAP
   the error is 100x.

Until (1) and (2) are answered this leg cannot be marked at all, so **#641 and #640 can be exercised
only against fixtures, never yet against a real LSE mark.** That limitation is stated here rather
than left implied.
