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
on 2026-09-07/08 with a 24-hour developer token, against `ClientId 22690838` — except §2.1a, which
was measured on the same gateway and client on **2026-09-10** and says so in place. Three
qualifications bound this survey; a fourth is now resolved:

- **The SIM account is a trial account, not the UK GIA.** `port/v1/accounts/me` reports
  `IsTrialAccount: true`; `port/v1/clients/me` reports `DefaultCurrency: "EUR"`. (The flag is on
  **accounts**, not clients — `clients/me` does not carry it, and `users/me` carries neither.)
  Anything account-shaped — tariffs, entitlements, permissions — is **not** evidence about the live
  Saxo UK GIA. Anything
  reference- or market-shaped (instrument metadata, exchange calendars, bar history, field
  availability) is the same data the live gateway serves.
- **The market was closed** (`MarketState: "Closed"`, `PriceTypeAsk/Bid: "OldIndicative"`).
  Quote *magnitudes* — spreads especially — are stale and indicative. The *mechanisms* are
  proven; the numbers must be re-measured in session.
- **The price feed is 15 minutes delayed, and this is an entitlement tier rather than a session
  artifact — CONFIRMED by direct measurement 2026-09-08, no longer inferred.**
  `Quote.DelayedByMinutes: 15` on both LSE lines. An earlier version of this document listed that
  field alongside the market-closed evidence, which read as though it were caused by the close.
  Four circumstantial strands pointed that way (§2.9a); the direct test — reading the field on an
  LSE line *during* 07:00–15:30Z — has now been **run in session and confirms a hard ~15-minute
  floor** against a demonstrably trading market. **Everything price-shaped below — §2.3's movers
  screen and §2.5's spreads — is 15 minutes stale unless the LSE Level 1 subscription is bought.**
  That subscription is now known to **cover `LSE_ETF`** (§2.9-LIVE). See §2.9.
- **The Trader/Investor front-ends have since been surveyed** (2026-09-08). §3's
  "no news/research/sentiment" is a statement about the **OpenAPI**: those features exist in the
  platform but ride a separate cookie-authenticated `/oapi/` namespace that **404s on the developer
  gateway**, so they are unreachable by any token rather than gated behind a purchasable
  entitlement. See §4. SaxoInvestor remains unsurveyed and is immaterial.

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

### 2.1a The details envelope, the fields around the factor, and the ORDER-price unit

Measured on SIM 2026-09-10 for
[#1444](https://github.com/dd-jp/samurai-trading-system/issues/1444), against the same
`ClientId 22690838` and a token refreshed that day. §2.1 above tabulates field *values*; this
records the *shape* they arrive in, which fields are present at all, and — new — the unit Saxo
**reads an order price in**, which §2.1 never touched.

**The envelope is a BARE object, not `{ "Data": [ … ] }`.** `GET
/ref/v1/instruments/details/29391797/Etn` returns HTTP 200 with 43 top-level keys and no `Data`
member. `validateInstrumentDetails` in `server/pipeline/execution/adapters/saxo-http-client.ts`
parses bare while every other endpoint in that file goes through `readData` for the wrapper; the
bare parse is **correct as shipped**, and `readData` here would fail the resolver on its first
line. Same shape on the USD control (`3347273/Etn`).

**Every field the resolver and the validator depend on is present, on both lines:**

| field | `29391797` (LQQ3, GBX) | `3347273` (3USL, USD) |
| --- | --- | --- |
| `Uic` | `29391797` | `3347273` |
| `AssetType` | `"Etn"` | `"Etn"` |
| `CurrencyCode` | `"GBP"` | `"USD"` |
| `PriceCurrency` | `"GBX"` — **present** | `"USD"` — **present** |
| `PriceToContractFactor` | `0.01` | `1.0` |
| `TickSize` | **absent** | **absent** |
| `TickSizeScheme` | present (below) | present, identical |
| `Format` | `{ "Decimals": 2, "OrderDecimals": 2 }` | same |
| top-level `OrderDecimals` | **absent** — it is nested under `Format` | **absent** |
| `AmountDecimals` / `MinimumLotSize` / `LotSizeType` | `0` / `1.0` / `OddLotsNotAllowed` | same |

So `assertUnitIsSelfConsistent`'s refusal branch — a factor other than 1 with `PriceCurrency`
absent — is not triggered by SIM on either measured line, and the validator's `optionalString`
treatment of `PriceCurrency` is not being leaned on. The 2026-09-08 values in §2.1 reproduced
exactly, two days on.

`TickSizeScheme` is `{ "DefaultTickSize": 0.01, "Elements": [ {0.0995 → 0.0005}, {4.999 → 0.001},
{9.9975 → 0.0025}, {24.995 → 0.005} ] }` (`HighPrice → TickSize`), byte-identical on the GBX and
the USD line. **Which unit the `HighPrice` bands are denominated in is NOT settled by this
measurement**, and it matters: read as pence, all four Elements are dead on any GBX line trading
above 25p and the grid is `DefaultTickSize` 0.01 pence = 0.0001 GBP everywhere; read as pounds,
they are the familiar sub-£25 bands and LQQ3 at ~£300 still falls to the 0.01 default. Both
readings put LQQ3 on the default tick today, so today's grid is not in doubt — the *denomination*
is, and a cheaper line in the pool could land inside the bands. Recorded as open; `ORDER_DECIMALS`
(2) in `saxo-adapter.ts` remains an assumption about precision, not a measured grid.

#### The order-price unit — the marketability probe did NOT run, and why

#1444's SIM item 3 asks for the marketability form of AC3's probe: a `Buy Limit` at `OrderPrice:
1000` against a ~30000-pence market, which **rests** if Saxo reads pence (£10) and **fills at
once** if it reads pounds (£1,000). It was not placed, because the LSE ETF session had already
closed when the token ran:

- `GET /ref/v1/exchanges/LSE_ETF` at 15:37Z: `AutomatedTrading` 07:00–15:30Z,
  `CallAuctionTrading` 15:30–15:35:30Z, then **`Closed` until 2026-09-11T06:50Z**.
- `GET /trade/v1/infoprices?Uic=29391797&AssetType=Etn` at 15:36Z: `MarketState:
  "ClosingAuction"`, `IsMarketOpen: false`, `PriceTypeAsk/Bid: "OldIndicative"`,
  `DelayedByMinutes: 15`, `Bid 30007 / Ask 30076 / Mid 30041.5`, `LastClose 30551`.

Outside continuous trading the probe loses its discriminating power in one direction: a fill is
impossible, so "it rested" no longer means "Saxo read pence" — it means only that nothing was
trading. Per #1444's own *Ambiguous* guidance the probe is re-run in session rather than inferred
from; a queued `DayOrder` would also have sat open overnight against the ticket's own
leave-nothing-resting rule.

(The ticket's premise line quotes ~£311.51 / 31151 from §2.1's 2026-09-08 reading. The measured
level on 2026-09-10 is ~£300.4 / 30041.5 mid. The probe design is unaffected — 1000 is far below
the market as pence and far above it as pounds under either level.)

#### What settled the unit instead: `precheck`'s cash requirement, in the ACCOUNT currency

`POST /trade/v2/orders/precheck` places nothing, works with the market closed, and returns
`EstimatedCashRequired` in the **account** currency (EUR here) — which is exactly the
account-currency observable #1444 names as AC3's fallback when a read-back cannot discriminate,
except that it costs no order at all. Sweeping `OrderPrice` with `Amount: 1`, `BuySell: "Buy"`,
`OrderType: "Limit"`, `DayOrder`:

| Uic | `OrderPrice` | `EstimatedCashRequired` (EUR) | `InstrumentToAccountConversionRate` |
| --- | --- | --- | --- |
| 29391797 (GBX, factor `0.01`) | 100 | 19.78 | 1.16377 |
| 29391797 | 280 | 21.88 | 1.16378 |
| 29391797 | 1000 | 30.25 | 1.16379 |
| 29391797 | 2000 | 41.89 | 1.16379 |
| 29391797 | 30000 | 367.72 | 1.16387 |
| 3347273 (USD, factor `1.0`) | 10 | 27.22 | 0.86000 |
| 3347273 | 100 | 104.61 | 0.85998 |
| 3347273 | 200 | 190.60 | 0.85999 |

Both series are linear in `OrderPrice` to within €0.01 across the sweep, and both fit one model:

> `EstimatedCashRequired` = fixed + `Amount` × `OrderPrice` × `PriceToContractFactor` × FX

Fitted on each line's endpoints: LQQ3 slope **0.0116374** EUR per unit of `OrderPrice`, intercept
**€18.616**; 3USL slope **0.85990**, intercept **€18.621**. Two things carry the argument. The
intercepts agree to within €0.005 on instruments in different currencies, which isolates the slope
as the whole price-dependent term. And the slope ratio, 0.013533, matches
`(0.01 × 1.16378) / (1.0 × 0.86)` = 0.013532 — i.e. the two lines differ by exactly the ratio of
their `PriceToContractFactor`s once the reported `InstrumentToAccountConversionRate`s are divided
out. (The fitted per-unit rate sits a shade below the reported conversion rate; the rates above are
as reported, the slopes as fitted.)

**So Saxo reads `OrderPrice` in the QUOTED unit and multiplies by `PriceToContractFactor` to get
cash** — the same invariant §2.1 records for the read direction, applied symmetrically to the
write direction. On the GBX line `OrderPrice: 1000` commits €11.64 ≈ £10, not €1,164 ≈ £1,000; and
`OrderPrice: 30000` — today's market in pence — commits £300, which is what one LQQ3 share costs.
`saxoQuotedPrice` in `server/pipeline/execution/adapters/saxo-price-unit.ts` divides cash by the
factor to reach the venue's number, and that is **confirmed, not corrected**. EUR cannot be
confused with either GBX or GBP, so the 100× question cannot hide in the units here the way it
hides in a `Price` read back off `/port/v1/orders/me`.

What this does **not** settle, and what keeps AC3 open: it is `precheck`'s cash arithmetic, not
the matching engine's marketability test. The two agreeing is the only coherent reading — the cash
committed *is* the order's value — but the in-session marketability probe is still the direct
measurement, and the tick-grid half of the question (whether two decimals of pence is a legal
price) is untouched by any of this. Both are the live/in-session follow-ups #1444 carries.

The €18.62 intercept is **account-shaped** — a trial EUR account's fixed cost, per §1's split —
and is *not* evidence about the live UK GIA's tariff or about ADR-0015's "no per-order minimum".
It is recorded here only because it is the constant the slope fit had to subtract.

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

### 2.5a One large intraday excursion, a stable tight core, and a noise floor that bounds the rest

§2.5 established that spread is measurable. This is what it measures to. The full 146-line ETN
listing, sampled every 90 minutes through 2026-09-08's session (all spreads in bp of mid):

| sample (UTC) | median | p25 | p75 | movers (`relvol ≥ 1.5`) | movers median | movers ≤ 30 bp |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 07:42 | 58.6 | 18.6 | 147.3 | 44 | 20.5 | 25 |
| 09:12 | 38.1 | 17.3 | 118.3 | 77 | 28.8 | 44 |
| 10:42 | 43.2 | 17.6 | 118.3 | 88 | 32.3 | 41 |
| 12:12 | 45.3 | 17.3 | 114.2 | 97 | 31.2 | 48 |
| 13:42 | **84.1** | 22.5 | 156.2 | 100 | **81.1** | 32 |
| 15:12 | **35.2** | **13.6** | 114.3 | 116 | **27.0** | **61** |

#### First, the noise floor — measured, and it disqualifies most of the table above

A single `infoprices/list` snapshot is far noisier than 90-minute spacing implies. Six reads of the
same 146 lines inside three minutes, immediately after the 15:12Z sample:

| read (UTC) | median | p25 | movers median |
| --- | ---: | ---: | ---: |
| 15:15:15 | 49.8 | 16.2 | 39.9 |
| 15:15:29 | 45.2 | 16.4 | 41.3 |
| 15:16:14 | 30.3 | 15.3 | 27.6 |
| 15:16:59 | 32.9 | 15.7 | 29.7 |
| 15:17:45 | 30.1 | 15.3 | 29.2 |
| 15:18:30 | 29.7 | 14.8 | 27.6 |

**The universe median ranges 29.7–49.8 bp — a 1.68× swing with no time-of-day content at all.** The
movers' median ranges 1.50×. Whatever this is — a handful of wide lines flickering in and out of a
two-sided quote, a delayed-feed batching artifact — it sets a floor on what single spaced samples can
resolve.

**Consequence: most of the session table's variation is not interpretable.** Its non-spike samples
span 35.2–58.6 bp, a 1.66× range — *at* the noise floor, not above it. Only the **13:42Z excursion**
(84.1 bp, 2.4× the 15:12Z reading, with the movers' median at 81.1 against a 27.6–41.3 noise band)
clearly exceeds it.

**p25 is the exception, and this is why it carries the gate.** Across the noise burst it ranges
14.8–16.4 bp — a 1.11× swing, far tighter than the median's 1.68×. So its 13.6–22.5 bp range across
the session is **larger than its own noise** and is plausibly a real, small, time-of-day effect. The
tight core is both genuinely tight and genuinely stable; the median is dominated by a flickering tail.

Anything future work does here needs **repeat samples per time point**, not one snapshot per slot.

**Three findings, in decreasing order of how much weight they can carry.**

**1. p25 is stable at 13.6–22.5 bp all day, and — per the noise floor above — this is the only
column that survives it.** The tight core of the universe stays tight; it is the tail that moves, so
a **fixed 30 bp spread gate is defensible** — it cuts against a stable boundary rather than a drifting
one. How *many* names sit inside that gate at a given moment is a separate question this table cannot
answer: the `movers ≤ 30 bp` column is contaminated by the counter artifact below. Downstream must
handle a shortlist of unknown, varying cardinality either way.

**2. The universe median swings 2.4× within one session** (35.2 to 84.1 bp) — but only the 13:42Z
end of that range is above the noise floor, so read it as *one excursion happened*, not as *the median
varies smoothly through the day*.

**3. The 13:42Z blow-out is transient, not a regime.** It sits twelve minutes after the US open
(13:30Z), and these are leveraged ETPs on US underlyings, so market makers widening as their hedge
goes live is a plausible mechanism — the movers' median **quadruples**, 31.2 → 81.1 bp, far more
sharply than the universe median moves. But by 15:12Z it has fully reversed, back inside the noise
band. **So there is no "afternoon is expensive" rule**, and an earlier draft of this section which
claimed one, along with a "cheap window is 09:00–12:30Z", was wrong on both counts.

#### The flat-by-close exit cost is **open**, not favourable

A flat-by-close strategy pays spread twice, and the exit leg is fixed at end-of-session by
construction — the one leg it does not get to time. So what liquidity looks like near the close is a
real question for ADR-0018. The 15:12Z sample invites an encouraging answer (27.0 bp movers median,
against 81.1 at 13:42Z), **but it does not replicate**: three minutes later the same universe read
39.9 bp, inside the noise band above. **No conclusion is drawn here.** Answering it needs repeat
samples through the closing half-hour, which `docs/research/44-spread-session-profile.py` supports
and nobody has run.

#### Two caveats that bound all of the above

- **The mover *count* is a session-progress counter, not a mover count.** It rises monotonically
  44 → 116 across the day — and the noise burst discriminates why: across all six reads in three
  minutes the count sat at **exactly 116, unmoved, while the median swung 1.68×**. An instantaneous
  measure would flicker with the spreads; a cumulative one would not. So Saxo's `RelativeVolume`
  almost certainly compares *cumulative session volume* to an average, and names cross `≥ 1.5`
  simply as the session accumulates. **`movers ≤ 30 bp` must therefore not be used to size a
  shortlist** — it counts how far into the session you are as much as what is moving. The median
  columns do not depend on the count and are unaffected.
- **These are SIM delayed-feed numbers, and §2.9-LIVE measured the delayed feed understating spread
  by 27%** on the one instrument checked against live. Treat the *shape* here as informative and the
  *levels* as optimistic.

**One day, six samples, 90-minute spacing** — wide enough to miss a spike entirely, which given
13:42Z reversed within 90 minutes is a live possibility rather than a formality. Repeat sessions and
tighter spacing around 13:30Z and the close would settle it, at one call per sample — the profiler is
committed as `docs/research/44-spread-session-profile.py` with `SAMPLES` and `INTERVAL_S` env-set.

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
comment (`server/pipeline/execution/adapters/saxo-adapter.ts`, `toCashFill`) hard-codes
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

### 2.9-LIVE The £7/month entitlement **does** cover our universe — observed on the live platform

**2026-09-08, 14:39Z, LSE in session.** David subscribed to LSE Level 1 Private on 2026-09-07, and the
live platform was read directly. This closes the item
[`34-lse-mark-source-options.md`](34-lse-mark-source-options.md) lists as its **sole unresolved
question**, and which Saxo *declined to answer in writing* on ticket 20084 (2026-09-03).

Observed on SaxoTraderGO (live), for **`3UKL:xlon` — WisdomTree FTSE 100 3x Daily Leveraged ETN**, a
3× leveraged ETN of exactly the class ADR-0016 trades:

| field | value |
| --- | --- |
| exchange | **London Stock Exchange (ETFs)** — i.e. `LSE_ETF`, not SETS |
| state | `Open` |
| data | **`Realtime prices`** |

Confirmed as genuinely live rather than a label: the quote moved between two reads seconds apart
(bid `2,430.00` → `2,433.50`), and an LSE cash line in the same watchlist (`BP Plc`) carried a
timestamp **21 seconds old**. The `15:20:17` stamp on the ETN is its last *trade*, not its quote.

**So the entitlement covers the leveraged-ETP universe.** #895's coverage question is answered
affirmatively, by observation rather than by correspondence.

#### What the same-instrument, same-moment comparison shows — and it is not comfortable

`3UKL` read simultaneously on both feeds:

| | bid | ask | spread | mid |
| --- | ---: | ---: | ---: | ---: |
| **SIM, 15-min delayed** | 2428.50 | 2432.50 | **16.5 bp** | 2430.50 |
| **Live, real time** | 2433.50 | 2439.00 | **22.6 bp** | 2436.25 |

Two consequences, both of which cut against calibrating from the delayed feed:

1. **The delayed feed *understates* the spread by 27%** (16.5 vs 22.6 bp). Any cost model calibrated
   from SIM is therefore **optimistic**, compounding the direction doc 53's 1 bp floors already err in.
2. **The delayed mid is 23.6 bp away from the live mid** — larger than the spread itself. At
   ADR-0014's intraday horizon a decision priced off a delayed mark is, on this sample, further from
   the tradeable price than the entire cost of crossing it.

**Caveat, stated plainly:** one instrument, one moment, and SIM-vs-live differ in more than latency
(different environment, different account). This is an observation that motivates a measurement, not
the measurement itself. But it points the same way as the whole-session profile in §2.5.

#### A trap in the screen path worth naming

`DisplayAndFormat.Currency` on the **price** response returns **`GBP`** for LSE lines whose prices are
actually in **pence** — 43 of the 64 "GBP"-labelled ETN lines have prices above 100, i.e. pence. The
authoritative pair is on the **instrument-details** endpoint, and §2.1 already records it:

```
GET /ref/v1/instruments/details/{uic}/{AssetType}
  CurrencyCode          = "GBP"   <- settlement currency
  PriceCurrency         = "GBX"   <- the unit prices are quoted in
  PriceToContractFactor = 0.01    <- the conversion
```

So the fix exists and §2.1 is right — but it is **not reachable from `infoprices` alone**. Anything
screening off `infoprices/list` (§2.3, and #1310's gate) must join to instrument details for the unit,
or it will be out by 100×.

---

### 2.9a "Entitlement, not session artifact" — **CONFIRMED by direct measurement, 2026-09-08**

> **RESOLVED.** The outstanding test described at the end of this section was run at **07:32Z on
> 2026-09-08**, 32 minutes into the LSE session. The result confirms the reading, and it was confirmed
> by measuring the delay directly rather than by reading the metadata field. **The four circumstantial
> strands below are superseded by one observation** and are kept only as a record of how the claim was
> held before it was tested.
>
> **Control — the market was genuinely trading.** `LSE_ETF` was inside its `AutomatedTrading` window
> (07:00–15:30Z), `MarketState` read `Open` on all five instruments, and fresh volume was printing
> (one line traded 376 units at 07:17Z). This is the control the ASX attempt below failed to be.
>
> **Measurement — the data was 15 minutes behind a demonstrably live market.** Across five LSE
> ETP/ETC lines, **no instrument had a bar newer than 15 minutes**, and the most active line's newest
> bar sat at **15.3 minutes** old. On a real-time feed a line printing volume every few minutes would
> show a bar seconds old, not a quarter of an hour. The delay is therefore **demonstrated**, not
> inferred from `DelayedByMinutes`.
>
> **Confirmed as a *rolling* delay, not a one-off**, by sampling the two most active lines every 150 s
> for 8 minutes:
>
> | sampled at | `NVD3` newest bar / lag | `3OIL` newest bar / lag |
> | --- | --- | --- |
> | 07:32:52 | 07:17 — 15.9 m | 07:13 — 19.9 m |
> | 07:35:23 | 07:19 — 16.4 m | 07:13 — 22.4 m |
> | 07:37:53 | 07:19 — 18.9 m | 07:13 — 24.9 m |
> | 07:40:23 | 07:25 — **15.4 m** | 07:23 — 17.4 m |
>
> The signature is a **sawtooth with a hard floor at ~15.4 minutes**: lag grows while no new bar
> arrives, then drops back to ~15–17 m when one lands, and **never once falls below 15 minutes** in
> eight observations. The sawtooth above the floor is bar sparsity — bars print only when trades
> occur — while the floor itself is the entitlement. A real-time feed has no such floor.
>
> Two further results from the same read:
>
> - **`PriceTypeBid`/`PriceTypeAsk: "OldIndicative"` persists mid-session**, with `MarketState: "Open"`
>   and live volume. It is confirmed as a **non-discriminator**: it says nothing about session state.
>   The parenthetical negative recorded below is now positively established.
> - **`Quote.Amount: 0` mid-session, but that does *not* mean "no depth"** — an earlier version of this
>   line said it did and was wrong. `PriceInfoDetails` carries **`BidSize` and `AskSize`, populated on
>   145 of 146** LSE ETN lines in session (e.g. `QQQS:xlon` 124,119 / 68,000). `Quote.Amount` is the
>   *requested* amount echoed back on an infoprice, not the book. Depth is available; read it from
>   `PriceInfoDetails`, not from `Quote.Amount`.
> - **`InstrumentPriceDetails.IsMarketOpen`** is a first-class boolean and read `True` on all 146 lines.
>   It is the session indicator to use — `MarketState` is the one this project found unreliable.
>
> **What this does and does not settle.** It settles the *semantics* — `DelayedByMinutes: 15` is an
> entitlement tier, not a market-closed artifact — and semantics carry from SIM to live. It does **not**
> settle what tier the **live** GIA is on: `port/v1/accounts/me` reports `IsTrialAccount: True`, so this
> is a trial account's entitlement, and per this project's standing split, account-shaped facts do not
> carry. **The £7/month question is still open and still needs the live token** (#1311, #895).

The claim originally rested on four strands, none of them the direct test:

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

**The test, in one line — and it was cheap:** `GET
/trade/v1/infoprices?Uic=29391797&AssetType=Etn&FieldGroups=Quote` between 07:00Z and 15:30Z on
an LSE trading day. **Run 2026-09-08T07:32Z: `DelayedByMinutes: 15` with `MarketState: "Open"`** —
this section is confirmed as written. The stronger form actually used was to measure the newest
`chart/v3` bar's age against wall clock, which does not depend on trusting the metadata field at all.

This needs a **SIM** token during LSE hours — a timing constraint, not an account one. An earlier
draft said it needed the live token and was therefore blocked behind #1311; that was wrong, and
it made a five-minute check look like it was queued behind the scarcest resource in the project.
The survey simply ran outside LSE hours. The SIM token in `.env.local` at time of writing expires
**2026-09-08T22:57Z**, so it covers the whole of that day's session; if it has lapsed, a fresh one
is two clicks at developer.saxo → *Get 24 Hour Token*.

---

### 2.9b The delayed feed is not just cheaper — it is outside a licensing regime that real time is inside

**Prior art first: [`34-lse-mark-source-options.md`](34-lse-mark-source-options.md) §5 got here before
this section did**, and is the authority on the licence arithmetic. It already records that
Non-Display Usage is defined over Real Time Data, quotes §6.5, prices the LSEG direct route at
**£6,695/yr** (Schedule A **2026**, §3.3.2 — read there as *Client Facilitation*; the 2025 figure was
£6,500), and — the part this section originally got wrong — establishes that **delayed data is not
self-evidently licence-free**. Read doc 34 §5 for the arithmetic; what follows adds three things it
does not carry, and corrects one overstatement made here on 2026-09-08.

**The definitions do the work.** LSE Schedule B (2026) defines *Non-Display Usage* as the access,
processing or use of **Real Time Data** which is not *Display Data*, and defines *Display Data* as data
used via a screen and human readable. A program reading prices to generate orders is therefore
Non-Display **by definition**. §6.1 requires a licence for it; §6.5 states it includes automated
trading; and the Policy Guidelines enumerate the qualifying use cases — **6.4.15 "algorithmic
trading"**, 6.4.1 automated order/quote generation, 6.4.5 price referencing for trading purposes.
Samurai is squarely described.

**On the category, this section and doc 34 differ, and it is worth resolving.** Doc 34 cites §3.3.2
*Client Facilitation*; but Samurai trades **its own account for its own benefit**, which is Schedule
B's **Trading as Principal** — "trading-based activities as 'principal', on such Customer's own
account". Client Facilitation is for facilitating a customer's *business*. Principal looks like the
right row; the two are priced identically at this banding anyway (£6,500 in 2025 / £6,695 in 2026), so
nothing downstream turns on it. From the 2025 Price List, for ETF/ETP — our universe — at 1–5
entitlements:

| | Level 1 | Level 2 |
| --- | ---: | ---: |
| ETF/ETP, Trading as Principal, 1–5 entitlements | **£6,500 / yr** | £13,000 / yr |

*(Year seam: definitions and policy from the **2026** Schedule B; charge figures from the **2025**
Price List. Doc 34 §5 carries the **2026** figure, £6,695 — prefer it.)*

**There is no Private Investor exemption in §6.** Schedule B's Private Investor carve-outs sit in
redistribution (3.2), derived data (4.4) and per-price-request (3.5.3); none reach the Non-Display
policy.

**This is a question to ask, not a cost to book.** Every obligation in Schedule B runs to *"the
Customer"* — the party holding an LSE Order Form. **That is Saxo, not us.** The single place the
Guidelines put a Non-Display licence on the End Customer is §6.2, and that clause is about **hosted
environments** (colocation), not a machine running against a broker API. Retail algorithmic trading
through broker APIs is also an ordinary, widely sold product; were the regime to bind every retail end
client at £6,500/yr, that market could not exist. Saxo itself holds a Private Investor redistribution
licence (Level 1 UK market data, £7,976/yr on the same price list), which the £7/month plausibly
amortises. **Record £6,500 as what is at stake if the answer is bad — not as a live cost against a
£1,000 book.**

**The load-bearing consequence — stated more carefully than it first was here.** Non-Display Usage is
scoped to **Real Time Data only**, so the delayed feed is outside **that** regime. It is *not* outside
all licensing, and this section said "licence-clean" before checking doc 34: §7.2 exempts **Data
Charges** only, and only as against the End Customer, while **Delayed Data *Licence* Charges are a
separate line** (£5,831/yr per *Website*, Level 1). That charge is redistribution-shaped — priced per
website — so it very likely does not reach a single self-consuming user, but doc 34 is right that this
is a question for LSEG rather than one to assume. **The honest claim is narrower: delayed data avoids
the non-display question, not every licensing question.** Put that beside what the code actually
reads — the analysts and the Trader consume **`getBars`**, while `getQuote` has only two
non-test callers, both in execution (§2.5) — and:

- Samurai's **signal path already runs on delayed data**, since `chart/v3` bars carry
  `ChartInfo.DelayedByMinutes: 15` exactly as quotes do (measured across five LSE ETP/ETC lines).
- Staying on the delayed feed therefore **carries no non-display exposure**, and no Data Charge
  against the End Customer — with the Delayed Data Licence question above left open.
- The £7/month would sharpen quotes for **two execution-path callers** while opening a licensing
  question the delayed feed does not raise.

**What to ask Saxo**, alongside #1309's retention question and in one letter: *does the LSE Level 1
Private Investor subscription cover automated/algorithmic order generation by the client via OpenAPI,
or does that constitute Non-Display Usage requiring a separate licence?*

**One cell deliberately not cited.** Price List 3.5.1 shows "Fee waived" for Private Investor UK market
Data per-device charges, but the **ETF/ETP row's Private Investor cells are blank**. A blank in a table
extracted from a PDF may mean "not offered", "waived", or a mis-aligned column. It is read in neither
direction here.

Sources: [Schedule B — Market Data Policy 2026](https://docs.londonstockexchange.com/sites/default/files/documents/schedule-b-market-data-policy-2026.pdf),
[Market Data Policy Guidelines 2025](https://docs.londonstockexchange.com/sites/default/files/documents/market-data-policy-guidelines-2025_0.pdf),
[Price List and Data Product Schedule 2025](https://docs.londonstockexchange.com/sites/default/files/documents/price-list-and-product-schedule-2025_1.pdf).

## 3. What Saxo does **not** give us

Answering David's sentiment/intelligence question directly, from the API surface rather than
from impression. The OpenAPI has **17 service groups**: Account History, Asset Transfers, Chart,
Client Management, Client Reporting, Client Services, Corporate Actions, Disclaimer Management,
ENS, Market Overview, Partner Integration, Portfolio, Reference Data, Regulatory Services, Root
Services, Trading, Value Add.

- **No news, research, analyst ratings, sentiment, or client-positioning endpoint anywhere.**
  **Value Add is price alerts only** (`vas/v1/pricealerts/definitions` — verified, returns an
  empty definition list, not a 404). Price alerts are nonetheless **not** a usable lever: they
  would fire off the same 15-minute delayed feed (§2.9a), the delivery route
  `vas/v2/notifications/targets` returns **403** on our token, and the pipeline polls bars on a
  schedule rather than reacting to events. **§4 now names the mechanism behind this bullet** —
  these features exist in the platform but ride a separate internal namespace.
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
  reach them. That product is **Autochartist**, and §4 shows it is unreachable by any token
  regardless of the flag.

**So: Saxo replaces no part of the MI stack.** It is a market-data and execution venue. #1305
stands as filed on the sentiment question; what it gains is §2.3 and §2.5, which are worth more
than the thing it was asked for.

---

## 4. The gap, now closed: a **separate namespace**, not a missing subscription

*Written 2026-09-08 from a live platform session. This section previously recorded the
front-ends as un-surveyed; that gap is closed, and the answer it anticipated —* "exists in the
platform, not exposed over OpenAPI" *— is confirmed, with the mechanism proved.*

### What the platform bundles

SaxoTraderGO's RESEARCH sub-nav carries **Inspiration | Markets | Themes | Webinars | Education |
News | Trade signals | Calendar**. News is a live instrument-tagged wire; "Trade signals" is
**Autochartist**, whose pattern table filters down to 15- and 30-minute intervals — intraday-native,
and superficially a good match for ADR-0014's horizon. So §3's *"no sentiment/news/research"* is
correct **only as a statement about the OpenAPI**, and must be read that way.

### Why it is unreachable

These features are served from an `/oapi/` namespace on `www.saxotrader.com`, authenticated by the
**platform session cookie** (`api/login/refresh_token?appId=desktop`) rather than by a developer app
token. Observed in the browser: `oapi/news/v1/sources` (200), `oapi/news/v1/topstories/collections`
(200), `oapi/ts/v1/subscriptions` (200), `oapi/microratings/v1/subscriptions` (200).

That is a different host **and** a different path root from `gateway.saxobank.com/openapi/…`. Both
spellings probed against the developer gateway, 2026-09-08 14:49:37Z:

| path | result |
| --- | --- |
| `oapi/news/v1/sources` | **404** |
| `oapi/news/v1/topstories/collections` | **404** |
| `oapi/ts/v1/subscriptions` | **404** |
| `oapi/microratings/v1/subscriptions` | **404** |
| `openapi/news/v1/sources` | **404** |
| `openapi/ts/v1/signals` | **404** |
| `openapi/microratings/v1/instruments` | **404** |
| `openapi/vas/v2/notifications/targets` | 403 |
| `openapi/reg/v2/mifid/appropriateness` | 403 |

**The 403s are the control.** The gateway distinguishes *no permission* from *no such route*, and
every news/signals/ratings path returns the latter. So this is **not** an entitlement that could be
purchased, and **not** something the pending live app would unlock: the routes do not exist on the
public API. The platform BFF is a separate API surface, not a subset of the documented one.

This matters beyond the immediate answer. §2.3's "no screener endpoint" is explicitly hedged above as
a failure to find; **this negative is not of that kind** — it is measured against a gateway that
demonstrably signals permission failures differently.

### Autochartist, judged on reachability alone

It is served from `/oapi/ts/v1/`, which 404s on the gateway, so it **cannot feed Samurai** whatever
its coverage. The pattern table was viewed but only as the freshest batch under an unaccepted
disclaimer, so nothing about that sample's content is recorded here as a property of the feed.

### The news question is moot regardless

Samurai already has a **free** news feed on keys it holds — Alpaca's Benzinga wire: stocks and
crypto, history to 2015, WebSocket streaming, £0. A cookie-authenticated Saxo wire would be a
downgrade even if it were reachable. Inspiration, Education, Webinars and Calendar are human-facing
editorial, not machine-consumable feeds.

### Scope, stated honestly

- The **gateway probe** closes this, and it is front-end-independent: the 404s settle "not exposed
  over OpenAPI" whatever any UI bundles.
- The **SaxoTraderGO survey** is illustrative of what sits behind the cookie.
- **SaxoInvestor was not surveyed** — immaterial, being a simplified skin over the same back-end.
- Probed against the **SIM** gateway. Route existence is reference-shaped rather than account-shaped,
  so it carries to live under the same split this document applies throughout (§2.9).

**Nothing in §5 changes.** #1305 stands as filed on the sentiment question.

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
| 8 | Doc 53 `CostModelImpl`: 1 bp rate floor, no spread input | Per-instrument spread now available (§2.5); its tight core is stable but it spiked 2.4x on one measured intraday excursion (§2.5a) | folds into 6 |
| 9 | #895 + doc 53: market data assumed free and real-time | Opt-in, **delayed** by default (quotes *and* chart bars), **£7/mo** for LSE Level 1 real time, refunded at 4 trades/month (§2.9). The delay is read as an entitlement tier on four circumstantial strands, and the confirming in-session read is now **RUN and CONFIRMED** — 15-min lag measured against a demonstrably trading market, 2026-09-08 (§2.9a). **And the delayed feed is outside LSE's Non-Display Usage regime, which real time is inside (§2.9b)** | comment on #895 |

| 10 | #1302 AC3 / `saxoQuotedPrice`: the WRITE-direction unit was UNVERIFIED on SIM as well as live | `precheck`'s `EstimatedCashRequired` scales as `OrderPrice × PriceToContractFactor` on both a GBX and a USD line, in the account currency — Saxo reads order prices in the QUOTED unit (§2.1a). The in-session marketability probe and the tick grid are still owed | comment on [#1444](https://github.com/dd-jp/samurai-trading-system/issues/1444) |

Items 1, 2, 4 and 10 are evidence for tickets that already exist and should not be re-filed. Items 3, 5, 6 and 7 are genuine
reopenable spec decisions and want a wayfinder map.

**The one that gates the live ramp is 6.** It is cheap, it is decidable with a single call, and
it is the only item on this list where being wrong costs money rather than time.
