# Saxo OpenAPI order idempotency — what a duplicate submit actually does

**Status:** MEASURED on the SIM gateway, 2026-09-05, for [#1032](https://github.com/dd-jp/samurai-trading-system/issues/1032) item 4 (successor to [#946](https://github.com/dd-jp/samurai-trading-system/issues/946)). Read this before touching `server/pipeline/execution/adapters/saxo-adapter.ts`'s placement path.

**Scope note — the filename says Saxo; round 3 does not.** This doc's question is "does the VENUE dedup a duplicate submit", and it was opened against Saxo because Saxo is where the answer was in doubt. The Alpaca half of that question was asserted here in passing and never measured, so [#1346](https://github.com/dd-jp/samurai-trading-system/issues/1346) measured it and the result is recorded in **Round 3** below rather than in a new doc: it is the same question, the same shape of evidence, and the "What this means for the adapter" section already compares the two venues line by line. Anything in rounds 1-2 is Saxo SIM; round 3 is Alpaca paper. The file is not renamed — `yarn check:citations` and the inbound references cite it by name.

**One-line verdict:** Saxo OpenAPI has **no durable client-supplied idempotency key**. `ExternalReference` is echoed back but never uniqueness-checked; the only duplicate protection is a **rolling ~15-second window** keyed on the request body plus the `x-request-id` header, which answers `409 Conflict` with an empty body and then forgets. A retry after the window places a **second, live order**. The adapter therefore treats every placement as *adopt-or-place* and sends `x-request-id = client_order_id`, and `execution-spec.md`'s story 9 ("the venue itself dedups a duplicate submit the local check missed") is **not honoured by this venue** beyond 15 seconds — the local store is the only durable dedup.

## Question

Story 9 of `docs/specs/execution-spec.md` and `CONTEXT.md`'s "double idempotency" invariant assume the venue enforces client-order-id uniqueness (Alpaca does, **permanently**: a duplicate `client_order_id` is a 422 whatever state the prior order is in, and the id is never released — measured in round 3 below, #1346; when this line was first written the Alpaca half was an assertion, not a measurement). Does Saxo OpenAPI `POST /trade/v2/orders` support a client-supplied idempotency key, and what happens when the same order is submitted twice?

## Method

Probes against `https://gateway.saxobank.com/sim/openapi` with a 24-hour bearer for the SIM account, instrument **3USL:xlon** (`Uic` 3347273, `AssetType` `Etn`, `ExchangeId` `LSE_ETF`, quoted in USD — the same line `lse-etp-pool.ts` records), out of hours so nothing could fill. The venue's own audit rows for the probe orders echo `Uic 3347273`; an earlier revision of this doc and of the adapter test fixtures printed 16268043, a transcription error corrected in PR #1212's review round — the probe itself was sound. Every order was a 1-unit `Limit` `DayOrder` at 10 (far below market, `Working` on the book, cancelled afterwards). Bursts of several requests in quick succession earned `429` from the per-second order limit before any semantic check ran, so each duplicate probe was a single pair with the rest of the session idle.

Reference documentation consulted: the OpenAPI Trading service-group reference for `POST /trade/v2/orders` (request model, `ExternalReference` description, 50-character limit), the rate-limiting page (120 requests/minute per service group; one order request per second per session), and the "Order placement — duplicate order check" note. Saxo's reference pages render client-side, so only the shells could be fetched programmatically; the 409 behaviour below was established from the gateway's own responses, not quoted from the page.

## Findings

| # | Probe | Result |
|---|---|---|
| 1 | Two identical bodies, same `ExternalReference`, **no** `x-request-id`, inside the window | second → `409`, empty body |
| 2 | Two identical bodies, same `ExternalReference`, **same** `x-request-id`, inside the window | second → `409`, empty body |
| 3 | Two identical bodies, same `ExternalReference`, **different** `x-request-id`, inside the window | second → `200`, **second order placed** (distinct `OrderId`) |
| 4 | Two identical bodies, same `ExternalReference`, same `x-request-id`, **~17 s apart** | second → `200`, **second order placed** |
| 5 | `ExternalReference` length | **not probed** — the 50-character limit is the reference model's, enforced in the adapter, not measured |
| 6 | `GET /port/v1/orders/me` after 3 and 4 | both orders `Working`, each echoing the same `ExternalReference` |

So the guard is: **(body, x-request-id) identical within ~15 s → 409; anything else → a new order.** `ExternalReference` participates only as part of the body; changing nothing but the header defeats the guard, and time defeats it by itself.

Related, verified in the same session and relied on by the adapter:

- A rejected placement (`400` with `{ErrorInfo: {ErrorCode, Message}, ExternalReference, Orders: [...]}`) still leaves an **audit row** in `GET /cs/v1/audit/orderactivities` with an `OrderId`, `Status: "Placed"`, `SubStatus: "Rejected"` and the `ExternalReference` — so a rejected order is findable by reference after the fact.
- `DELETE /trade/v2/orders/{OrderId}?AccountKey=…` on an IfDone master cancels its related orders too (`200 {"Orders":[{"OrderId"}]}`); a repeat or unknown id answers `404 {"Orders":[{"ErrorInfo":{"ErrorCode":"OrderNotFound"}}]}`.
- `GET /port/v1/orders/{ClientKey}/{OrderId}` for a cancelled or unknown order answers `200 {"__count":0,"Data":[]}` — it is an *open* orders view, not a lookup.
- Plain `OrderType: "Stop"` is `OrderTypeNotSupported` on the Etn; the stop leg is `StopIfTraded`. `IsOcoOrderSupported` is `false` on every pool line's instrument details.

## Round 2 — the cancel-vs-fill race, and the first real fills (2026-09-10)

**Status:** MEASURED on the same SIM gateway, 2026-09-10 ~19:12Z, for [#1216](https://github.com/dd-jp/samurai-trading-system/issues/1216). **Venue caveat: not LSE.** `LSE_ETF` was closed at run time (`/ref/v1/exchanges/LSE_ETF`: `Closed`, session 15:35:30Z → 06:50Z), so no pool line could fill. The probe substituted **QQQ on NASDAQ** (`Uic` 4328771, `AssetType` `Etf`, exchange open), 1 unit, IfDone bracket in the exact shape `submitBracket` sends. Everything below is measured on `Etf`/NASDAQ; the shapes are order-handling shapes, not exchange-specific ones, but they have **not** been re-measured on `LSE_ETF`.

**The question.** `cancel()` reads the open-orders list, finds the master, and DELETEs it. If the master fills in between, what does the DELETE answer? The code assumed `404 OrderNotFound` and re-derives the legs on that basis.

**The answer: it holds.** Three trials, each placing a marketable `Limit` master (ask x 1.02) with `StopIfTraded` + `Limit` legs:

| Trial | Master state at DELETE | DELETE response |
|---|---|---|
| `fill` | polled until it left the open list, position confirmed | `404 {"Orders":[{"ErrorInfo":{"ErrorCode":"OrderNotFound","Message":"Requested order ID was not found"},"OrderId":"5040156979"}]}` |
| `0` (true race, DELETE issued immediately after the POST returned) | filled 8 ms after placement | `404 {"Orders":[{"ErrorInfo":{"ErrorCode":"OrderNotFound","Message":"Requested order ID was not found"},"OrderId":"5040156983"}]}` |
| `rest` (control, master far from market and resting) | `Working` | `200 {"Orders":[{"OrderId":"5040156993"}]}`, and the open list then returned `{"__count":0,"Data":[]}` — the legs went with it |

`isOrderNotFound` matches on `status === 404` **and** on `ErrorCode: "OrderNotFound"`, and `parseSaxoErrorInfo` reads the `Orders[].ErrorInfo` shape above, so `cancel()`'s catch fires. The control also re-confirms finding 33 (master DELETE takes its legs) on `Etf`, where it was first measured on `Etn`.

**What is NOT measured: the sub-round-trip window.** The master's own audit rows are `Placed/Requested` at `19:12:57.581Z` and `FinalFill` at `19:12:57.589Z` — **8 ms**. A DELETE cannot arrive sooner than one HTTP round trip, measured at 127-334 ms in this session. So the venue was never asked to cancel an order in the act of filling; it was asked about one that had been filled for two orders of magnitude longer than the fill took. `404` is the answer for a **settled** filled order. Whether a DELETE landing inside those 8 ms answers differently is unmeasurable over REST and remains unknown — a bound, not a measurement.

**Dormant legs are not top-level order rows.** While the master rests, `GET /port/v1/orders/me` returns **one** row — the master, `OrderRelation: "IfDoneMaster"` — with both legs nested under `RelatedOpenOrders` at `Status: "NotWorking"`. Once the master fills, the legs become **two top-level rows**, `Status: "Working"`, `OrderRelation: "Oco"`, each carrying the other under its own `RelatedOpenOrders`. So the `NotWorking`-as-never-activated reading (#1215) describes a nested sub-row, and a top-level `NotWorking` leg pair with no master — the shape `findOpen`'s dormant branch and `corroborateDormantLegs` exist for — was **never produced by a fill**. Whether a master that *expires* leaves one is still unmeasured.

**Cancelling one activated OCO leg does not kill its sibling.** DELETE on the stop → the target's next audit row is `Status: "Changed"`, `OrderRelation: "StandAlone"`, still working; it needed its own DELETE. `cancelLegs`' per-leg loop is right.

**The venue's full-fill status is `FinalFill`, never `Filled`.** Every fill row in the session — brackets and Market flattens alike — reads `Status: "FinalFill"`, `SubStatus: "Confirmed"`. Over 22 activity rows the observed `(Status, SubStatus)` set was `Placed/Requested`, `Placed/Confirmed`, `FinalFill/Confirmed`, `Cancelled/Confirmed`, `Changed/Confirmed`. `"Filled"` appears nowhere. `activityState` switched only on `'Filled'`, so **every real full fill normalized to `partially_filled`** through the `FillAmount > 0` default — reaching `lookup`'s no-open-rows path, `getOrder`, and adopt-on-409. Fixed in this change by adding a `FinalFill` case to `activityState` and to `toQuotedFill`'s loud-failure guard, which had the same defect — it would have dropped a fill row lacking `FillAmount`/`AveragePrice` silently rather than throwing. `Filled` is kept in both because this measures only that this path does not emit it, not that no path does. A partial fill's own status string is still unmeasured.

**Fill and position fields, previously unverified, now observed.** A fill row: `{"Status":"FinalFill","SubStatus":"Confirmed","FillAmount":1.0,"AveragePrice":709.07,"Amount":1.0,"OrderRelation":"IfDoneMaster","OrderType":"Limit","RelatedOrders":["5040156980","5040156981"],"PositionId":"5027430598","LogId":"252169181"}` — so `FillAmount` and `AveragePrice` are the right names, and the row carries `FilledAmount`, `ExecutionPrice`, `PositionId` and `RelatedOrders` besides, which `SaxoOrderActivity` does not declare. A net-position row: `NetPositionId: "4328771__Share"`, `NetPositionBase: {Amount: 1.0, Uic, AssetType, AmountLong, AmountShort, OpenOrdersCount, ...}`, `NetPositionView: {AverageOpenPrice: 709.07, AverageOpenPriceIncludingCosts: 724.07, ConversionRateCurrent: 0.861319, TradeCostsTotal: -30.01, ...}`. `DisplayAndFormat` was absent, but the probe did not request its field group — the HTTP client does — so its absence proves nothing about it.

**Cleanup.** Every trial tore down in a `finally`: cancel every probe order, market-flatten any position, re-read. Final state after the session: `/port/v1/orders/me`, `/port/v1/netpositions/me` and `/port/v1/positions/me` each returned `{"__count":0,"Data":[]}`.

## Round 3 — Alpaca's `client_order_id`: how long is it spent for? (2026-09-15)

**Status:** MEASURED on the real Alpaca **PAPER** venue (`https://paper-api.alpaca.markets`, account `PA3II2VV2I1B`, `status: ACTIVE`, `trading_blocked: false`, equity 99878.66 USD), 2026-09-15 12:12-12:15Z, for [#1346](https://github.com/dd-jp/samurai-trading-system/issues/1346) under David's 2026-09-14 authorization to probe the paper venue. No live capital. Every probe order was a 1-share `SPY` `limit` `gtc` at 10.00 — far below market, so nothing could fill — and every probe id is prefixed `probe1346-<epoch>-`; teardown was scoped to those ids. Final state: open orders `[]`, positions `[]`.

**The question.** `AlpacaBrokerAdapter.rearmProtectiveLegs` places a residual's protective OCO under a derived wire id and, finding a prior one there, adopts it or cancels it and places again *under the same id*. That fall-through assumed — never measured — that a reused `client_order_id` would be refused once the prior order was terminal. Two facts were asked for: **(1)** is a reused `client_order_id` accepted after the prior order went terminal, and **(2)** what does `GET /v2/orders:by_client_order_id` return when two orders share an id.

**Fact 1: the id is consumed permanently. Four trials, four refusals.**

| Trial | State of the prior order | Response to the reuse `POST /v2/orders` |
|---|---|---|
| T1.2 | `accepted`, resting on the book, 115 ms after placement | `HTTP 422` `{"code":42210000,"message":"client_order_id must be unique"}` |
| T2.3 | `canceled`, **0 ms** after the terminal status was confirmed | `HTTP 422` `{"code":40010001,"message":"client_order_id must be unique"}` |
| T4.1 | `canceled`, **~90 s** later, same id | `HTTP 422` `{"code":40010001,"message":"client_order_id must be unique"}` |
| T6.1 | `canceled` **13 days** earlier (`repro-1003-SPY-1788327559145`, created 2026-09-02, cancelled 2026-09-02T05:53Z) | `HTTP 422` `{"code":40010001,"message":"client_order_id must be unique"}` |

The `code` differs between a resting prior (`42210000`) and a terminal one (`40010001`); the `message` and the refusal do not. There is no window: this is the opposite of Saxo's rolling ~15 s guard. **An Alpaca `client_order_id` is spent the moment an order is accepted under it, and stays spent.**

**Fact 2: unprobeable by construction — and that is the answer.** Two orders can never share a `client_order_id`, because fact 1 refuses the second one. The lookup for the probe id returned the single canceled row, and a full `GET /v2/orders?status=all` scan confirmed exactly one row carries it:

```
GET /v2/orders:by_client_order_id?client_order_id=probe1346-1789474336-a
HTTP 200
{"id":"aed39ed2-876d-4b10-851f-00b183e49b14","client_order_id":"probe1346-1789474336-a", ... ,"canceled_at":"2026-09-15T12:12:17.580269617Z", ... ,"status":"canceled", ... }

ROWS WITH client_order_id=probe1346-1789474336-a: [ 1 row — the canceled one above ]
```

So the ambiguity the ticket asked the adapter to handle explicitly does not exist at this venue. There is no ordering to depend on, because there is never a second row.

**Corollary, and the reason one terminal status is still unmeasured: a submit the venue REFUSES leaves no row and does not consume the id.** The oversized-buy probe was refused at submit time and its id stayed free:

```
POST /v2/orders  {"symbol":"SPY","qty":"1000000","side":"buy","type":"limit","limit_price":"900.00","time_in_force":"gtc","client_order_id":"probe1346-1789474509-c"}
HTTP 403
{"buying_power":"399514.64","code":40310000,"cost_basis":"900000003","message":"insufficient buying power"}

GET /v2/orders:by_client_order_id?client_order_id=probe1346-1789474509-c
HTTP 404
{"code":40410000,"message":"order not found for probe1346-1789474509-c"}
```

An earlier attempt to manufacture a `rejected` row the same way was refused for its own reason (`HTTP 422 {"code":42210000,"message":"take_profit.limit_price must be < stop_loss.stop_price"}`) and likewise left no row — the id was then reusable and a plain `POST` under it returned `HTTP 200`. **So reuse after a genuinely `rejected` or `expired` ROW is NOT measured**: paper refused every attempt to produce one at submit time, which is precisely the case that consumes nothing. It does not change the fix — a spent id is spent whatever terminal status its row carries, and the adapter advances past any id the venue answers for.

**What this changed in the code (#1346).** The ticket's premise — that the fall-through could place a *second* OCO under one residual marker — is **disproved**: the venue makes a duplicate impossible. The real defect is the mirror image. A single `:rearm` id could protect a lot exactly **once**: the re-arm places its OCO, the next `executeExit` cancels it (#516), that flatten partially fills, the fresh residual marks the same lot, and the sweep's next re-arm 422s — and 422s identically on every later pass, so `confirmResidualProtected` is never reached, the marker never clears, and **the residual is never protected**. A permanent protection gap that reads as a transient venue error. `rearmProtectiveLegs` now walks attempt-indexed wire ids (`${key}:rearm`, `${key}:rearm-1`, …, bounded, mirroring `resolveExitRetryKey`'s `:retry-N`), adopting or retiring what it finds and placing under the first id the lot has not spent.

## What this means for the adapter

1. **Durable idempotency is ours, not the venue's — on Saxo.** `open_positions.idempotency_key` (local write-ahead) is the only dedup that survives 15 seconds there. Story 9's second layer is real for Alpaca and **absent** for Saxo. Measured on both sides now (round 3): Alpaca's layer is not merely real but *permanent*, which cuts the other way as well — an id Alpaca has accepted can never be submitted under again, so any scheme that derives a venue id per lot must be able to derive a *fresh* one, not just a deterministic one.
2. **Adopt-or-place.** Before every `POST`, the adapter looks the `ExternalReference` up on open orders and then on the audit trail; only if neither knows it does it place. On a `409` it looks again — the window remembering the request means the first attempt's order exists.
3. **`x-request-id = client_order_id`.** Inside the window this makes a true retry (same intent, same body) a `409` rather than a double, at zero cost. It is not relied on beyond that.
4. **No transport retry on placement.** `withRetry` is disabled for `placeOrder` (single attempt): a retry after a slow reply is exactly the probe-4 shape. Reads and cancels retry normally.
5. **Suffix-namespaced legs.** Related orders carry `${id}:stop` / `${id}:target`, so a fill on either is attributable to its bracket from the activity feed's `ExternalReference` alone.

## Not verified

- ~~**Fill fields on the activity feed.**~~ **Closed 2026-09-10** by round 2 above: `FillAmount` and `AveragePrice` are the right names, observed on real fills.
- ~~**Position row shapes.**~~ **Closed 2026-09-10** by round 2 above: `NetPositionBase.Amount`/`Uic` and `NetPositionView.AverageOpenPrice` observed on a real open position.
- **Alpaca reuse after a `rejected` or `expired` ROW** (round 3). Measured for `accepted` and for `canceled` at 0 ms, 90 s and 13 days. Paper would not produce a `rejected` row: every attempt was refused at submit time, and a submit-time refusal leaves no row and frees the id. `expired` needs a `day` order to survive to the close, which this session did not run.
- **Alpaca LIVE.** Round 3 is the paper venue only, per the authorization it was run under.
- **Live gateway.** Every Saxo figure is SIM. Saxo documents SIM and live as behaviourally equivalent for order handling, but the 15-second window and the 120/min limit were measured on `/sim/` only.
- **Behaviour on partial fill of an IfDone master** — whether the related orders resize, and what `Status` a partial-fill activity row carries. Never observed; round 2's fills were all 1-unit and instant.
- **`LSE_ETF` order handling.** Round 2 measured `Etf`/NASDAQ because the LSE session was closed. The fill/cancel shapes above have not been re-measured on a pool line.
- **A DELETE landing inside the fill itself.** The fill took 8 ms; one HTTP round trip is 127-334 ms. `404` is measured for a settled filled master, not for one mid-fill.
- **Whether a master that expires (rather than fills) leaves top-level `NotWorking` legs, or `Working` legs the same way a fill does.** Neither payload shape has ever been produced — the SIM probe that would settle it is [#1426](https://github.com/dd-jp/samurai-trading-system/issues/1426). `SaxoBrokerAdapter` (#1215) does not wait on the answer to recognize either shape when it does land: `findOpen`/`lookup` corroborate BOTH shapes against the master's own audit-trail row before trusting a `Status` read, asymmetrically for the `Working` case (`corroborateActivatedLegs` — only a settled, terminal, non-`Filled` master row downgrades a `Working` pair, and only once NO row for the reference in the lookback carries any evidence of a fill; every row is scanned, not just the chronologically latest one, so an earlier fill row followed by a separate, later terminal row — a partial-fill residual cancelled at close — still counts as evidence and is not missed by reading only the latest row (#1215 round 3); a `NotWorking` pair may defer on inconclusive evidence, a `Working` one never does, since a real fill must not be missed). That `Working`-case defense is itself conditional on Saxo actually emitting a terminal audit row for an expired-unfilled master at all — if it emits nothing, or only a non-terminal row, the pair is read as filled regardless, by design (missing a live position is worse than the phantom-fill risk being guarded against). Whether Saxo emits such a row is part of what #1426 still has to observe.
- **FX on USD-quoted lines is unmodelled.** 9 of the 13 Saxo-listed pool lines (3USL included) are quoted in USD inside a GBP GIA. Saxo converts at its own FX rate plus a currency-conversion margin on every fill; that cost is not in `CostConfig.venues.saxo` (8 bps commission only) and is likely larger than the commission. `NormalizedFill.fee_currency` carries the line currency so a USD fee is not summed as GBP, but nothing converts it yet. The GBP-quoted line of the same ISIN (3LUS:xlon, Uic 29049628) exists on Saxo and is recorded as 3USL's `sibling_line`; whether the fallback subset should prefer it is a follow-up, not settled here.
