# 44 — Saxo's data surface, measured

**Date:** 2026-09-08
**Question:** What data does Saxo actually give us — across the Trader/Investor platforms and
the OpenAPI — and which prior spec decisions does it reopen?
**Status:** Live. Supersedes the "LSE intraday bars unavailable" row of
[`33-intraday-data-availability.md`](33-intraday-data-availability.md); see §2.2.

Prompted by two questions from David while provisioning the live account: *"there is a lot of
market data in the app, have we considered this as a source?"* and *"can we not use saxo for
market sentiment or intelligence"*.

---

## 1. Method, and what the evidence is worth

Every figure below was pulled from the **SIM gateway** (`gateway.saxobank.com/sim/openapi`)
on 2026-09-07/08 with a 24-hour developer token, against `ClientId 22690838`. Three
qualifications bind the whole document:

- **The SIM account is a trial account, not the UK GIA.** `port/v1/clients/me` reports
  `IsTrialAccount: true` and `DefaultCurrency: "EUR"`. Anything account-shaped — tariffs,
  entitlements, permissions — is **not** evidence about the live Saxo UK GIA. Anything
  reference- or market-shaped (instrument metadata, exchange calendars, bar history, field
  availability) is the same data the live gateway serves.
- **The market was closed** (`MarketState: "Closed"`, `PriceTypeAsk/Bid: "OldIndicative"`).
  Quote *magnitudes* — spreads especially — are stale and indicative. The *mechanisms* are
  proven; the numbers must be re-measured in session.
- **The price feed is 15 minutes delayed, and the weight of evidence says that is an
  entitlement tier rather than a session artifact — with one confirming test still outstanding.**
  `Quote.DelayedByMinutes: 15` on both LSE lines. An earlier version of this document listed that
  field alongside the market-closed evidence, which read as though it were caused by the close.
  Four independent strands say otherwise (§2.9a), but all four are circumstantial: the direct
  test — read the field on an LSE line *during* 07:00–15:30Z — has not been run, because the
  survey window fell outside LSE hours. **Everything price-shaped below — §2.3's movers screen
  and §2.5's spreads — is 15 minutes stale unless the LSE Level 1 subscription is bought**,
  subject to that test. See §2.9.
- **The Trader/Investor front-ends were not surveyed** — the platform session had expired and
  logging in is David's to do. See §4; it bounds exactly one conclusion.

Reproduction scripts are throwaway (`$CLAUDE_JOB_DIR/tmp/saxo_*.py`); every call in them is a
plain GET against the paths quoted inline below.

---

## 2. Findings that change something

Ranked by what they cost us if we keep believing the current thing.

### 2.1 The pence bug has a first-class fix in the API — `PriceToContractFactor`

[#1302](https://github.com/dd-jp/samurai-trading-system/issues/1302) records that Saxo reports
GBX-quoted LSE lines as `GBP`, a 100× scale collision that reaches 17 of the pool's rows. That
is true of `/ref/v1/instruments` (the *search* endpoint the pool was built from) and of
`DisplayAndFormat.Currency` on `infoprices`. It is **not** true of instrument details.

`GET /ref/v1/instruments/details/{Uic}/{AssetType}` carries two fields the search endpoint omits:

| Uic | Symbol | `CurrencyCode` | `PriceCurrency` | `PriceToContractFactor` |
| --- | --- | --- | --- | --- |
| 29391797 | `LQQ3:xlon` | `GBP` | **`GBX`** | **`0.01`** |
| 3347273 | `3USL:xlon` | `USD` | `USD` | `1.0` |

So the quote unit is knowable, per instrument, from the venue itself. The invariant is:

> **cash per share = quoted price × `PriceToContractFactor`**, in `CurrencyCode`.

LQQ3's quote of 31151 is 31151 GBX = **£311.51**, not £31,151.00 and not £311.51-by-guesswork.
This turns #1302 from "we must hand-maintain a GBX flag on 17 pool rows" into "read one field at
resolve time, and never trust `CurrencyCode` or `DisplayAndFormat.Currency` alone." Hand-
maintained flags would have gone stale the moment a row was added; this does not.

### 2.2 Intraday LSE bars on the tradeable line **do** exist — but not at Stage 2's depth

Doc 33's verdict table says, for the row it calls *"the actual live tradeable universe"*:

> **LSE 1-minute bars — NOT AVAILABLE FREE at 10y** | best free option ~1y

The first half is falsified. `GET /chart/v3/charts` serves LQQ3 at **every horizon from
1 minute to monthly** (1, 5, 10, 15, 30, 60, 120, 240, 360, 480, 1440, 10080, 43200), 1200
samples per request, paged by `Mode=From&Time=…`. Each sample is a real OHLCV bar:

```json
{"Time":"2026-07-30T08:00:00Z","Open":25449.0,"High":25449.0,"Low":25425.0,
 "Close":25425.0,"Volume":270.0,"Interest":0.0,"MarketTradingState":"Automated"}
```

`MarketTradingState` is worth noting on its own — it lets auction and halt bars be excluded
rather than silently averaged into an intraday signal.

**Depth is per-instrument inception, not a rolling window.** `Mode=From&Time=2016-01-04`
returns 2022-05-30, and the daily series starts 2022-05-27 and returns 1080 rows whether
`Count` is 1200 or 5000 — i.e. that *is* all of it. LQQ3 listed in May 2022. Corroborating:
LQQ3's `HistoricalChanges` has no `PercentChange5Years` while 3USL's does.

**This does not clear Stage 2, and should not be reported as clearing it.** Doc 33's bar was
10 years; this is ~4.3 for the pool's *oldest* member, and any basket's usable window is set by
its shortest-lived member. Stage 2's PBO/DSR rejection
(doc 13's Stage 2 chain) gets *worse* on a shorter sample, not better. The
honest statement is: **"not available" was wrong; "sufficient" is unestablished.**

**And retention is an open legal question, not a settled one.** The Data Notification terms
accepted to enable OpenAPI access permit own non-commercial use and bar copying, reproduction,
duplication and distribution. Persisting 4.3 years of 1-minute bars into a local backtest store
is the same class of act that disqualified Yahoo in
[`34-lse-mark-source-options.md`](34-lse-mark-source-options.md) (*"ToS bars automated
collection"*) and the LSE free endpoint under its §8. Quote-time use and bulk retention are
different questions and only the first is clearly permitted. **Saxo is not yet the LSE backtest
source; whether it may be is a decision, and it is charted as one.**

### 2.3 A complete movers screen exists, in one call, at zero marginal cost

ADR-0016 D1 states *"the universe objective is **movers**"*. The universe-path gap sweep
(`docs/reviews/universe-path-gap-sweep-2026-09-03.md`) recorded F2 — #750's ranked axis has no
sort key — and F8 — that both halves of #1002's evidence rest on sources this repo has ruled it
cannot collect from. Saxo answers both.

`GET /trade/v1/infoprices/list` accepts the **entire 146-instrument LSE ETN universe in a
single request** (`Uics=` comma-joined, `AssetType=Etn`), returning all 146 rows in **0.23 s**.
Batches of 25/50/100/146 all returned in full; no cap was hit. Per row it carries:

| Field group | What it gives |
| --- | --- |
| `InstrumentPriceDetails` | `AverageVolume`, `AverageVolume30Days`, **`RelativeVolume`**, `IsMarketOpen`, `ShortTradeDisabled` |
| `HistoricalChanges` | `PercentChangeDaily`/`Weekly`/`1Month`/`2Months`/`3Months`/`6Months`/`1Year`/`2Years`/`3Years`/`5Years`, `FiftyTwoWeekHigh`/`Low` |
| `PriceInfo` / `PriceInfoDetails` | `Open`, `High`, `Low`, `LastClose`, `LastTraded`, `Volume`, `NetChange`, `PercentChange` |
| `Quote` | `Bid`, `Ask`, `Mid`, `PriceTypeAsk`/`Bid`, `DelayedByMinutes`, `MarketState` |
| `Commissions` | `CostBuy`, `CostSell` for a given `Amount` |

**`RelativeVolume`: the formula is proven, the baseline is not.** The field is undocumented and
reconciles with none of its neighbours at face value, so it was checked against all 146 rows:

> `RelativeVolume == 100 × Volume / AverageVolume` — exact on **128 of 128** rows carrying all
> three inputs, worst relative error 0.0000%.

That settles the arithmetic, **not the semantics: what `AverageVolume` averages is undocumented,
and it is demonstrably not `AverageVolume30Days`.** Across the 145 rows carrying both, the ratio
`AverageVolume / AverageVolume30Days` runs **0.29 (`ETHP:xlon`) to 96.4 (`1ARK:xlon`)**, median
1.17, and equals 1.0 on **no row at all** (`LQQ3:xlon` 6.72, `3USL:xlon` 1.07). The spread is
consistent with a uniform but longer window — illiquid names like `1ARK` have a near-zero 30-day
figure, which inflates the ratio — and equally consistent with a per-instrument window; **the
data cannot separate the two.** So the safe reading is *today's volume over a Saxo-defined
baseline, ×100*: the ×100 scaling is established (`609.86` on `BTC3:xlon` is 6.1×, not 610×),
the denominator is not.

**Two limits on how it may be used, both from the same probe.** `Volume` is session-cumulative,
so mid-session `RelativeVolume` climbs monotonically through the day — any *absolute* threshold
fires late and is not comparable across sample times. And a cross-instrument ranking divides each
name by its own baseline, which is only apples-to-apples if that baseline follows a uniform rule;
that is the open question above. What is unambiguously safe is the **cross-sectional ranking at a
single sampled moment, read as a candidate generator rather than a calibrated statistic** — which
is what a movers screen needs.

`PercentChangeDaily` is present on **146 of 146**, needs no reconstruction, and carries neither
caveat: it should be the primary axis, with `RelativeVolume` secondary until its baseline is
pinned down. Even so this is a lawful, vendor-free sort key over the whole tradeable universe,
refreshed as often as we care to poll — which is the thing #750/#1002/#1035 lacked.

**Third caveat, from §2.9: the screen is 15 minutes delayed** unless LSE Level 1 is subscribed.
For *candidate generation* ahead of a debate that itself takes time, a 15-minute-old ranking is
defensible. For an entry trigger it is not.

### 2.4 Saxo's LSE coverage was never the binding constraint — spread is

The pool file curates 54 rows, of which **13** resolve to their own Saxo line. Saxo lists, on
`ExchangeId=LSE_ETF`:

| AssetType | Instruments | Currencies (`CurrencyCode`) | Leveraged by description |
| --- | --- | --- | --- |
| `Etn` | **146** | 77 USD / 64 GBP / 5 EUR | 110 |
| `Etc` | **127** | 95 USD / 30 GBP / 2 EUR | 37 |
| `Etf` | **1521** | 785 GBP / 684 USD / 52 EUR | 6 |

~153 leveraged ETPs against a pool of 13. These are **candidates, not tradeables** — the same
screen shows why. Ranking the 146 ETNs by relative volume and reading the spread off `Quote`:

| RelVol | %day | spread | symbol |
| ---: | ---: | ---: | :--- |
| 609.9 | −0.68% | 12.9 bp | `BTC3:xlon` |
| 457.5 | +1.04% | **446.5 bp** | `MSTS:xlon` |
| 320.7 | −1.80% | **219.8 bp** | `2BRK:xlon` |
| 314.2 | +0.91% | 4.9 bp | `AETH:xlon` |
| 311.9 | −0.66% | 7.2 bp | `CBTC:xlon` |
| 279.3 | −0.68% | 3.6 bp | `BITP:xlon` |
| 269.0 | +3.08% | **459.3 bp** | `3SMI:xlon` |
| 249.7 | +3.76% | **644.4 bp** | `NIO3:xlon` |

(Stale, closed-market marks — magnitudes indicative, per §1.)

Spread ranges over **two orders of magnitude, 3.6 bp to 644 bp**, inside one asset type on one
exchange. At ADR-0018's brackets a 200 bp spread is most of the move. Widening the universe is
therefore not a matter of adding rows: it needs a **spread gate**, which the system does not
currently have and which this data now makes possible. Note also `SOXL:xlon` — *"Leverage
Shares 4X Long Semiconduct ETN"* — a **4×** product, outside ADR-0016's 3× framing.

### 2.5 Spread is measurable at all, for the first time

Worth separating from §2.4 because of what it replaces. The repo has had **no lawful spread
source**: #1036's retraction, Yahoo disqualified in doc 34, the LSE free endpoint barred by its
§8 (doc 34), and
`cost-floors-undersized-for-live-venue` recording that 1 bp floors charge ~4 bps round trip
where Saxo alone is 16 bps. `Quote.Bid`/`Ask`/`Mid` on `infoprices` is that source, per
instrument, at poll cadence, under the data terms we have already accepted. Doc 53's
`CostModelImpl` currently floors commission at a 1 bp-of-notional *rate* with no per-instrument
spread input; it now has one available.

**Where a delayed quote would actually bite, read off the code rather than assumed.** Nothing in
the pipeline triggers an entry from a quote. `getQuote` has exactly two non-test callers, both
inside execution: `captureSubmitSnapshot` (`server/pipeline/execution/execute.ts:409`), which is
best-effort instrumentation that logs and proceeds on failure, and `getSpreadEstimate`
(`execute.ts:485`, `simulated-adapter.ts:348`), which feeds the cost model at submit time. The
signal path — every analyst, the trader, the risk manager's correlation and invalidation checks
— reads `getBars`. So the exposure is (a) a submit-time spread check priced off a quote 15
minutes old, and (b) if Saxo ever becomes the LSE *bar* source, a signal computed on bars whose
newest sample predates the decision by ≥15 minutes, at a horizon ADR-0014 defines as intraday
flat-by-close. Both are real; neither is "the entry trigger reads a stale quote".

**But it is a delayed source by default** (§2.9): `DelayedByMinutes: 15`. That is a real
limitation and it splits by use. For **cost calibration** — what does a typical spread on this
instrument look like, to replace doc 53's 1 bp floor — a 15-minute-delayed sample is fine, since
the quantity being estimated is a distribution, not a instant. For a **live execution mark or a
pre-trade spread check** it is not fine at ADR-0014's intraday horizon. The first use needs no
subscription; the second does.

### 2.6 The commission floor — a scare that resolved, and a cheap gate that did not

The SIM tariff prices `LQQ3` as **min £8, then 0.10%** of notional:

| `Amount` | notional | `CostBuy` | implied |
| ---: | ---: | ---: | :--- |
| 1 | £311.51 | £8.00 | floor |
| 10 | £3,115 | £8.00 | floor |
| 100 | £31,163 | £31.16 | 0.100% |
| 1000 | £311,630 | £311.63 | 0.100% |

Taken at face value that would be fatal: £16 round trip on a £350 ADR-0018 D5 ticket is **4.6%**.
It would also **invert the venue decision** — ADR-0015's 2026-08-30 amendment disqualified IBKR
precisely on its £3/order minimum (*"1.71%/2.40% round trip at D5's £350/£250 tickets"*) and
chose Saxo on the strength of a claim it states three times: *"Saxo's 8bps-per-side Classic tier
with **no per-order minimum**"*, *"**Saxo has no per-order minimum**: 8bps is a flat rate on
notional, proportional at both D5 ticket sizes, so this risk does not materialise."* An £8 floor
is worse than the £3 floor IBKR was rejected for.

**It is not evidence.** Per §1 the SIM account is an EUR trial account, and its tariff is that
account's, not Saxo UK's. Saxo's published UK stock commissions page states *"No minimums on UK
stocks"* (the asterisk there attaches to SETSqx minimum *trade sizes*, a different thing),
consistent with ADR-0015. The scare is defused.

**What survives is better than the scare.** ADR-0015's load-bearing fact was sourced from a
marketing page and a sales conversation, and `Commissions` is a **live gateway field group**. One
`infoprices` call on the live token, at `Amount=1`, settles it against the venue's own pricing
engine before a single pound is at risk. Also unresolved and now sharper: the adapter's own
comment (`server/pipeline/execution/adapters/saxo-adapter.ts`, `feeCurrencyFor`) hard-codes
*"the published GBP-ETP tariff (ADR-0015 §"Saxo", 0.08 %, no minimum)"* — a modelled constant,
never verified against a fill, and structurally unable to represent a floor if one exists.

### 2.7 Flat-by-close has a venue-native mechanism, and the ADR-0015 clause has a referent

One thing ADR-0014's flat-by-close does is available from the venue, and one thing this section
originally claimed for it is **wrong** — corrected 2026-09-08 while working [#1312](https://github.com/dd-jp/samurai-trading-system/issues/1312):

- `GET /ref/v1/exchanges/LSE_ETF` returns **`ExchangeSessions`** — explicit
  `Closed` / `OpeningAuction` / `AutomatedTrading` / `CallAuctionTrading` windows with exact UTC
  boundaries, plus `TimeZoneAbbreviation: "BST"` and `TimeZoneOffset`.

  **But it is not a replacement for what we have, and flat-by-close was never "a hardcoded
  15:30Z".** Since #668 the Trader flattens at `close − N` resolved through
  `TradingCalendar.sessionEnd`, and `LseRegularHoursCalendar`
  (`server/providers/market-data-service/trading-calendar.ts`) already models LSE hours, UK bank
  holidays and 12:30 half-days through `Intl.DateTimeFormat` on `Europe/London`. DST is therefore
  already handled against the IANA zone, which is *more* robust than a session feed — and
  `TimeZoneOffset: "01:00:00"` is the offset **right now**, a snapshot rather than a rule, so a
  consumer trusting it in December would be an hour out.

  Measured, the feed also cannot serve as the table: `ExchangeSessions` publishes **9 entries ≈ 2
  days forward**, systematically across `LSE_ETF` / `LSE_SETS` / `NASDAQ` / `NYSE`, against
  `MAX_SESSION_SEARCH_DAYS = 10` and a `LSE_HOLIDAYS` table whose own comment says coverage ends
  **2027-12-28**. (Whether the window widens over a weekend is untested — it was sampled on a
  Tuesday.) The live proposal in #1312 is therefore an **overlay**: use the two-day window to
  *validate* the hand table before each session, not to replace it.
- `GET /ref/v1/algostrategies` lists 20 strategies. **`Market on Close (MOC)`,
  `Limit on Close (LOC)` and `Target Close` all carry `MinAmountUSD: 0.0`** — no size floor
  (only `Iceberg` has one, at $11,000) — and instrument details list all three under
  `SupportedStrategies` for both pool lines checked. A flat-by-close exit could be routed into
  the LSE closing auction natively.

**Caveat, and it is a real one.** ADR-0015 records as unresolved what the Commissions Schedule's
*"specific algorithmic orders… must be executed with the help of the trading desk"* clause
scopes — Saxo sidestepped the question twice and David ruled it non-blocking by judgment. That
clause now has a concrete candidate referent: this very `AlgoStrategies` list. Using MOC is
therefore a *different* risk posture from using plain `Market`/`Limit`, and the ruling that the
clause is non-blocking was made about the latter. Do not adopt MOC without re-asking.

### 2.8 Confirmations (no action, but they close open guesses)

- `FractionalOrderEnabled: false`, `FractionalOrderEnabledAssetTypes: []`,
  `LotSizeType: "OddLotsNotAllowed"`, `MinimumLotSize: 1.0`, `AmountDecimals: 0` — **whole
  shares only**, corroborating the whole-share sizing constraint
  from the venue rather than by inference.
- `IsComplex: true` on both pool lines — the appropriateness gate, visible in data.
- `IsExtendedTradingHoursEnabled: false`, `AllowedTradingSessions: "Regular"` — no extended hours.
- `PositionNettingMode: "Intraday"`, `PositionNettingProfile: "FifoRealTime"`.
- `TradingSignals: "NotAllowed"` on both lines — see §3.
- `IsOcoOrderSupported: false` is **already recorded** in
  [`43-saxo-openapi-order-idempotency.md`](43-saxo-openapi-order-idempotency.md) along with the
  IfDone-master + `:stop`/`:target` bracket model. Not a new finding; noted so it is not re-filed.


### 2.9 Market data over OpenAPI is opt-in, delayed by default, and priced — and this conditions everything above

Found while verifying §2.2's retention question (#1309). It is listed last because it was found
last, not because it matters least: **it is a precondition for §2.2, §2.3 and §2.5 all three.**

Two Saxo sources appear to contradict each other:

> *"Market data is by default **disabled** for all non-FX instruments in applications **other**
> than Saxo Bank's trading platforms."* — developer.saxo, *Enabling Market Data*

> *"By default, clients have access to **delayed** market data on the equities and futures
> exchanges on which they are enabled to trade."* — home.saxo/en-gb, *Market Data Subscriptions*

**They reconcile, and the gateway settles it.** `GET /port/v1/users/me` returns a field whose
existence is the answer:

| field | SIM value |
| --- | --- |
| `MarketDataViaOpenApiTermsAccepted` | **`true`** |
| `Quote.DelayedByMinutes` (both LSE lines) | **`15`** |
| `root/v1/sessions/capabilities` → `DataLevel` | `Standard` |

So: OpenAPI market data is gated behind an **explicit per-user acceptance** (developer.saxo's
"disabled by default" — it is a flag, and it is readable), and what acceptance grants is the
**delayed** tier (home.saxo's line). Real time is a separate paid subscription. Both documents
are correct about different steps; neither alone describes the outcome.

**The prices, verified on home.saxo/en-gb for a UK client:**

| London Stock Exchange | Private (non-professional) | Professional |
| --- | ---: | ---: |
| Level 1 | **£7.00 / month** | £65.00 / month |
| Level 2 | £8.00 / month | £229.00 / month |

**And a refund scheme that decides whether the cost is £84/yr or £0:**

> *"Saxo has introduced a refund scheme where fees are refunded per exchange should clients trade
> a minimum of four (4) times across stocks, ETFs or CFDs on the exchange during each calendar
> month."* — with *"Refunds are only applicable for non-professional clients subscribing to
> **level 1** data"*, *"calculated on a monthly basis but paid out on a quarterly basis"*.

**Level 2 is £1/month more and forfeits the refund.** Unless order-book depth is actually
required, Level 1 is strictly the better buy — a conclusion that inverts the usual "the dearer
tier is barely dearer" instinct.

**What the fee is worth, in doc 54's units.** Doc 54 expresses a running bill as the accuracy it
costs: `Δp = bill × 10⁴ / (N × notional × width)`. At `N = 252` sessions and ADR-0018 D5's
tickets:

| bill | index (£350, width 4.16) | single-stock (£250, width 12.25) |
| --- | ---: | ---: |
| LSE Level 1, unrefunded — £84/yr | **2.29 pp** | **1.09 pp** |
| LLM bill for comparison — ~£169/yr (doc 54's revised figure; **not** the superseded £58) | 4.61 pp | 2.19 pp |

So an unrefunded data fee is roughly **half the weight of the entire LLM bill** — the same order,
not second-order. Stated the other way, and secondarily because it is not the comparable form:
£84/yr is **8.4% of the £1,000 book per year**.

**Two things must be verified before this is priced either way, and neither is settled here.**

1. **Does an entry and its exit count as two trades or one?** The clause says four trades
   "across stocks, ETFs or CFDs on the exchange". At ADR-0014's flat-by-close horizon every
   position is an entry *and* an exit, so the reading decides whether **two** signals a month
   clear the bar or **four** do.
2. **Does this system trade four times a month at all?** [#625](https://github.com/dd-jp/samurai-trading-system/issues/625)
   measured **96 debates and 0 trades** — the stocks ceiling sat below the conviction floor.
   That is a measured historical state of the debate layer, not a forecast, but it is the exact
   state in which the refund does not arrive and the fee is pure drag on a £1,000 book.

**Consequences.** #895's entitlement probe stops being "check entitlements" and becomes four
named reads on the live token, one round trip:

```
GET /port/v1/users/me                -> MarketDataViaOpenApiTermsAccepted
GET /root/v1/sessions/capabilities   -> DataLevel
GET /trade/v1/infoprices?...&FieldGroups=Quote      -> Quote.DelayedByMinutes, PriceTypeAsk/Bid
GET /chart/v3/charts?...&FieldGroups=ChartInfo      -> ChartInfo.DelayedByMinutes
```

The fourth is the one that settles whether the funded GIA gets **bars** on the free tier, which
is what §2.2's backtest source depends on and which SIM cannot answer. Doc 53's cost model gains
an input it can use immediately (delayed spreads are adequate for calibration) and a fixed annual
line item it currently does not carry.

**The delay is not quote-only — chart bars carry it too.** `chart/v3/charts` returns a
`ChartInfo` block with `DelayedByMinutes` beside `ExchangeId` and `FirstSampleTime`:
`{"DelayedByMinutes": 15, "ExchangeId": "LSE_ETF", "FirstSampleTime": "2022-05-30T12:43:00Z"}`
for `LQQ3:xlon`. It applies to the bar series §2.2 proposes as a backtest source and that the
analysts actually consume, not just to quotes.

**This does not tell us the live account gets bars free.** `ChartInfo.DelayedByMinutes` is an
entitlement field read on an `IsTrialAccount`, and entitlements are the account-shaped class of
fact that SIM evidence does not carry (§1). A sandbox is if anything likelier to be permissive
than a funded retail GIA. So the open question stays open in the form it was originally posed —
*does the live GIA serve chart data at all, and on which tier* — and belongs on the live-token
list. What SIM did establish is the weaker, useful thing: the field exists and is readable, so
the live check is one more call rather than an investigation.

### 2.9a How strong is the "entitlement, not session artifact" reading?

Stated plainly because five other artifacts now cite it. The claim rests on four strands, none
of them the direct test:

1. **`DelayedByMinutes` is exchange-specific and matches each exchange's published standard
   delay** — `15` for `LSE_ETF`, `20` for `ASX`, read on the same token minutes apart. A staleness
   marker caused by market closure would not be keyed to the exchange in exactly the pattern the
   exchanges publish their own delay conventions in. *The ASX `20` here is the same reading the
   contaminated control below rests on, and it survives: whether ASX was mid-session or between
   sessions changes nothing about the field being keyed to the exchange. The control failed as a
   test of session-dependence, not as an observation of the value.*
2. **It lives in static series metadata.** In `chart/v3`, `DelayedByMinutes` sits inside
   `ChartInfo` alongside `ExchangeId` and `FirstSampleTime` — descriptors of the series, not of
   the current session.
3. **`MarketDataViaOpenApiTermsAccepted` exists as a readable per-user flag**, and
   `root/v1/sessions/capabilities` reports `DataLevel: "Standard"`. Both are tier-shaped.
4. **home.saxo states the default tier is delayed** in prose, and prices the real-time upgrade.

**What was attempted and did not work as a control.** Reading the field on a cash-equity market
that was open at survey time: `ref/v1/exchanges` listed ASX in `AutomatedTrading`, and
`infoprices` on three ASX stocks returned `MarketState: "Open"` with `DelayedByMinutes: 20`.
That looks like the control, and it is not one — the newest `chart` bar for the same instrument
was ~18 hours old, so ASX was in fact between sessions and `MarketState: "Open"` was reporting
the imminent session, not a trading one. The reading is recorded here so it is not mistaken for
evidence later. (It does establish one negative: `PriceTypeAsk: "OldIndicative"` is not a
market-closed marker specifically, since it appears identically on both.)

**The outstanding test, in one line — and it is cheap:** `GET
/trade/v1/infoprices?Uic=29391797&AssetType=Etn&FieldGroups=Quote` between 07:00Z and 15:30Z on
an LSE trading day. `DelayedByMinutes: 15` with `MarketState: "Open"` confirms this section as
written; `0` falsifies it and the £7/month question dissolves.

This needs a **SIM** token during LSE hours — a timing constraint, not an account one. An earlier
draft said it needed the live token and was therefore blocked behind #1311; that was wrong, and
it made a five-minute check look like it was queued behind the scarcest resource in the project.
The survey simply ran outside LSE hours. The SIM token in `.env.local` at time of writing expires
**2026-09-08T22:57Z**, so it covers the whole of that day's session; if it has lapsed, a fresh one
is two clicks at developer.saxo → *Get 24 Hour Token*.

---

## 3. What Saxo does **not** give us

Answering David's sentiment/intelligence question directly, from the API surface rather than
from impression. The OpenAPI has **17 service groups**: Account History, Asset Transfers, Chart,
Client Management, Client Reporting, Client Services, Corporate Actions, Disclaimer Management,
ENS, Market Overview, Partner Integration, Portfolio, Reference Data, Regulatory Services, Root
Services, Trading, Value Add.

- **No news, research, analyst ratings, sentiment, or client-positioning endpoint anywhere.**
  **Value Add is price alerts only** (`vas/v1/pricealerts/definitions` — verified, returns an
  empty definition list, not a 404).
- **No screener or movers endpoint was found — but this is a weaker negative than the rest of
  this section, and is flagged as such.** `mkt/v1/marketoverview`, `mkt/v1/moversandshakers` and
  `mkt/v1/prices/subscriptions` all return **404**; those three paths were *guessed*, and Market
  Overview is one of the 17 groups above, so a real path may exist under a name not tried.
  Service discovery was attempted and yielded nothing: `mkt`, `mkt/v1`, `mkt/$metadata` and
  `mkt/v1/$metadata` all 404 — **but so do `ref/v1`, `port/v1`, `trade/v1` and `chart/v1`**, so
  the gateway 404s every group root and those results carry no information. The public reference
  page for `mkt/v1` is itself a 404. **The accurate claim is: the group is enumerated, no path
  under it was reachable or documented, and §2.3's screen is one we build from `infoprices`
  rather than one Saxo was found to ship.** Read as a failure to find, not as measured absence.
  Nothing downstream turns on the difference — §2.3 works either way.
- `TradingSignals: "NotAllowed"` on the pool instruments — the trade-signals product does not
  reach them.

**So: Saxo replaces no part of the MI stack.** It is a market-data and execution venue. #1305
stands as filed on the sentiment question; what it gains is §2.3 and §2.5, which are worth more
than the thing it was asked for.

---

## 4. The gap in this survey

The **SaxoTraderGO / SaxoInvestor front-ends were not inspected** — the platform session had
expired, and logging in is David's to do, not something to automate with his credentials.

This bounds exactly one claim. §3's "no sentiment/news/research" is a statement about the
**OpenAPI**. Saxo's retail platforms are widely understood to bundle news and research, and if
they do, the accurate finding is *"exists in the platform, not exposed over OpenAPI"* — which is
a different statement with a different implication (it would be licensable or scrapeable-in-
principle rather than absent). Nothing else in this document depends on it, and it does not
block the conclusions. Worth ten minutes at the next login.

---

## 5. What this reopens

| # | Decision as it stands | What changes it | Where it goes |
| --- | --- | --- | --- |
| 1 | #1302: GBX handled by a hand-maintained pool flag | `PriceToContractFactor` is authoritative and per-instrument (§2.1) | comment on #1302 |
| 2 | Doc 33: LSE intraday bars unavailable | ~4.3y of 1-min OHLCV on the tradeable line (§2.2) | comment on #1304 |
| 3 | Bars may not be retained under the data terms | Unresolved; same class as the Yahoo/LSE §8 disqualifications (§2.2) | **wayfinder child** |
| 4 | #750/#1002/#1035: movers axis has no lawful sort key | Whole universe, one call, two axes — one proven, one caveated (§2.3) | comment on #1305 |
| 5 | ADR-0016: pool of 13, 3× framing | 146 ETN + 127 ETC listed; 4× exists; spread gate needed (§2.4) | **wayfinder child** |
| 6 | ADR-0015: "Saxo has no per-order minimum" — the fact that disqualified IBKR | Unverified against the venue; one live call settles it (§2.6) | **wayfinder child**, pre-ramp gate |
| 7 | ADR-0014: flat-by-close is *already* calendar-driven (`sessionEnd`, #668) — the original "client-side timing" framing was wrong | Session feed as an **overlay validating** the hand table (2 days forward, not a replacement) + native MOC/LOC (§2.7) | **wayfinder child** [#1312](https://github.com/dd-jp/samurai-trading-system/issues/1312); MOC still gated on the ADR-0015 clause |
| 8 | Doc 53 `CostModelImpl`: 1 bp rate floor, no spread input | Per-instrument spread now available (§2.5) | folds into 6 |
| 9 | #895 + doc 53: market data assumed free and real-time | Opt-in, **delayed** by default (quotes *and* chart bars), **£7/mo** for LSE Level 1 real time, refunded at 4 trades/month (§2.9). The delay is read as an entitlement tier on four circumstantial strands; the confirming in-session read is outstanding (§2.9a) | comment on #895 |

Items 1, 2 and 4 are evidence for tickets that already exist and should not be re-filed. Items 3, 5, 6 and 7 are genuine
reopenable spec decisions and want a wayfinder map.

**The one that gates the live ramp is 6.** It is cheap, it is decidable with a single call, and
it is the only item on this list where being wrong costs money rather than time.
