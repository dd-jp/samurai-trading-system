# Saxo OpenAPI order idempotency — what a duplicate submit actually does

**Status:** MEASURED on the SIM gateway, 2026-09-05, for [#1032](https://github.com/dd-jp/samurai-trading-system/issues/1032) item 4 (successor to [#946](https://github.com/dd-jp/samurai-trading-system/issues/946)). Read this before touching `server/pipeline/execution/adapters/saxo-adapter.ts`'s placement path.

**One-line verdict:** Saxo OpenAPI has **no durable client-supplied idempotency key**. `ExternalReference` is echoed back but never uniqueness-checked; the only duplicate protection is a **rolling ~15-second window** keyed on the request body plus the `x-request-id` header, which answers `409 Conflict` with an empty body and then forgets. A retry after the window places a **second, live order**. The adapter therefore treats every placement as *adopt-or-place* and sends `x-request-id = client_order_id`, and `execution-spec.md`'s story 9 ("the venue itself dedups a duplicate submit the local check missed") is **not honoured by this venue** beyond 15 seconds — the local store is the only durable dedup.

## Question

Story 9 of `docs/specs/execution-spec.md` and `CONTEXT.md`'s "double idempotency" invariant assume the venue enforces client-order-id uniqueness (Alpaca does: a duplicate `client_order_id` is a 422). Does Saxo OpenAPI `POST /trade/v2/orders` support a client-supplied idempotency key, and what happens when the same order is submitted twice?

## Method

Probes against `https://gateway.saxobank.com/sim/openapi` with a 24-hour bearer for the SIM account, instrument **3USL** (`Uic` 16268043, `AssetType` `Etn`, `ExchangeId` `LSE_ETF`), out of hours so nothing could fill. Every order was a 1-unit `Limit` `DayOrder` at 10 (far below market, `Working` on the book, cancelled afterwards). Bursts of several requests in quick succession earned `429` from the per-second order limit before any semantic check ran, so each duplicate probe was a single pair with the rest of the session idle.

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

## What this means for the adapter

1. **Durable idempotency is ours, not the venue's.** `open_positions.idempotency_key` (local write-ahead) is the only dedup that survives 15 seconds. Story 9's second layer is real for Alpaca and **absent** for Saxo.
2. **Adopt-or-place.** Before every `POST`, the adapter looks the `ExternalReference` up on open orders and then on the audit trail; only if neither knows it does it place. On a `409` it looks again — the window remembering the request means the first attempt's order exists.
3. **`x-request-id = client_order_id`.** Inside the window this makes a true retry (same intent, same body) a `409` rather than a double, at zero cost. It is not relied on beyond that.
4. **No transport retry on placement.** `withRetry` is disabled for `placeOrder` (single attempt): a retry after a slow reply is exactly the probe-4 shape. Reads and cancels retry normally.
5. **Suffix-namespaced legs.** Related orders carry `${id}:stop` / `${id}:target`, so a fill on either is attributable to its bracket from the activity feed's `ExternalReference` alone.

## Not verified

- **Fill fields on the activity feed.** No order could fill on SIM (no market-data entitlement, out of hours), so `FillAmount` / `AveragePrice` on `orderactivities` rows are taken from the reference model and gated in code: a `Filled` row lacking them is thrown, not booked. First fill on SIM must confirm the names.
- **Position row shapes.** `/port/v1/netpositions/me` and `/positions/me` returned `{"__count":0,"Data":[]}` throughout; `NetPositionBase.Amount`/`Uic`/`NetPositionView.AverageOpenPrice` are documented names validated at the boundary, not observed.
- **Live gateway.** Every figure is SIM. Saxo documents SIM and live as behaviourally equivalent for order handling, but the 15-second window and the 120/min limit were measured on `/sim/` only.
- **Behaviour on partial fill of an IfDone master** — whether the related orders resize. Never observed.
