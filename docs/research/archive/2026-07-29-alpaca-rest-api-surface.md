# Research: Alpaca REST API surface for `AlpacaClient` (2026-07-29)

> **ARCHIVED — folded into [`32-vendor-api-reference.md`](../32-vendor-api-reference.md).** The crypto-path correction below is preserved there verbatim; it documents a bug that shipped.

Ticket: Research: Alpaca REST API surface for AlpacaClient (broker + data), part of
[Live Transport Layer: Alpaca / Polygon / Anthropic / Telegram HTTP clients + account-state](https://github.com/dd-jp/samurai-trading-system/issues/259).

> **CORRECTION 2026-08-05 ([#358](https://github.com/dd-jp/samurai-trading-system/issues/358)).**
> The crypto rows in the Market Data table below are **wrong** and were implemented as
> written. Alpaca's crypto data endpoints are on **`/v1beta3`**, not `/v2`:
> `GET /v1beta3/crypto/us/bars` and `GET /v1beta3/crypto/us/latest/quotes` return `200`;
> both paths under `/v2` return `404`. The equity rows (`/v2/stocks/...`) and the whole
> Broker/Trading table are correct — re-verified live the same day. This is exactly the
> failure mode the caveat below warned about, so treat that caveat as load-bearing rather
> than boilerplate: it took a live paper run to catch, because the 404 surfaced as a quiet
> `analysts: quorum_skip` rather than an error.

**No live network access in this sandbox** — same boundary already documented for
`PolygonClient` (#241) and Stage 2's real data run. This is written from training-data
knowledge of Alpaca's public Trading API v2 and Market Data API v2, which have been
stable in shape for years. **Before implementing, re-verify every endpoint/field/limit
below against https://docs.alpaca.markets** — the ticket's job is to unblock the design
decision (what the client needs to do), not to be the final source of truth on Alpaca's
wire format.

## Two clients, two base URLs, two API keys (same key pair)

This codebase already splits Alpaca into two interfaces along exactly Alpaca's own
API split:

- **Broker/Trading API** (`src/execution/adapters/alpaca-client.ts`'s `AlpacaClient`) —
  `https://paper-api.alpaca.markets` (paper) / `https://api.alpaca.markets` (live).
- **Market Data API** (`src/market-data-service/sources/alpaca-source.ts`'s `AlpacaClient`
  — same name, different interface, different module) —
  `https://data.alpaca.markets` (one host, serves both paper and live accounts; data is
  not paper/live-separated the way trading is).

Both use the same `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` header pair from one paper
account. No OAuth, no token refresh — the key pair is the whole auth story.

## Broker/Trading side — methods `AlpacaClient` (alpaca-client.ts) needs

| Interface method | Endpoint | Notes |
|---|---|---|
| `submitOrder(request)` | `POST /v2/orders` | Body matches `AlpacaBracketOrderRequest` closely: `symbol`, `side`, `qty` (string), `type: 'limit'` (implied — entry is `limit_price` not `market`), `time_in_force`, `order_class: 'bracket'`, `client_order_id`, `take_profit: {limit_price}`, `stop_loss: {stop_price}`. Response shape is `AlpacaOrder` (id, client_order_id, status, legs on the bracket parent) — this codebase's type already matches Alpaca's real response shape closely enough that no mapping layer looks necessary beyond parsing JSON. |
| `getOrder(alpacaOrderId)` | `GET /v2/orders/{order_id}` | Straightforward. |
| `getOrderByClientOrderId(clientOrderId)` | `GET /v2/orders:by_client_order_id?client_order_id={id}` | Alpaca returns 404 for unknown client_order_id — must be mapped to this interface's documented `null` return, not thrown. |

Not yet in the interface but worth flagging for the `AccountStateProvider` decision
(ticket #264, see below): `GET /v2/account` (cash, portfolio_value/equity,
daytrading_buying_power) and `GET /v2/positions` are the two endpoints an
Alpaca-account-endpoint-based `AccountStateProvider` would read.

## Market Data side — methods `AlpacaClient` (alpaca-source.ts) needs

| Interface method | Endpoint | Notes |
|---|---|---|
| `getBars(symbol, timeframe, asOf, limit)` | `GET /v2/stocks/{symbol}/bars` (equities) or `GET /v2/crypto/us/bars` (crypto — note the different path root) | `timeframe` param matches Alpaca's own query param (`1Min`, `1Day`, etc — this codebase already passes through an opaque `timeframe: string`, so no enum mismatch). `asOf`/`limit` map to `end`/`limit` query params; Alpaca paginates via `next_page_token` for results beyond one page, which this interface's single-array return doesn't yet model — the client implementation will need an internal pagination loop if `limit` can exceed a single page (Alpaca's page cap is in the thousands, so for typical dashboard-scale bar counts this may never trigger — worth confirming against real usage before adding pagination code no path exercises). |
| `getLatestQuote(symbol)` | `GET /v2/stocks/{symbol}/quotes/latest` (equities) or `GET /v2/crypto/us/latest/quotes` (crypto) | Response nests under a `quote`/`quotes` key keyed by symbol — thin unwrapping needed to produce this interface's flat `AlpacaQuote`. |

Crypto vs equity is a **path-root split, not a param** — the client implementation
needs to route on `asset_class`/symbol shape (this module already threads
`asset_class` through `AlpacaSourceOptions`, so the routing point already exists,
just not the second path template).

## Rate limits (Trading API)

Alpaca's standard paper/live account tier is **200 requests/minute** per API key
(shared across both trading and data calls on some tiers — reconfirm current split
against live docs). A 429 response carries no `Retry-After` guarantee in all cases;
exponential backoff on 429/5xx is the conventional approach other Alpaca client
libraries (alpaca-py, alpaca-trade-api-python) use. This is a design input for the
LlmClient/TelegramClient/PolygonClient shared-conventions fog patch on the map — none
of the four clients have picked a retry policy yet, and Alpaca's own limit is the
tightest of the four (Anthropic and Telegram are both far more permissive per-key).

## What this settles for the spec

- Two separate client classes (already matches the two existing interfaces — no
  interface change needed), one shared auth-header helper.
- Crypto/equity is a path-root switch inside the data client, not two separate clients.
- `getOrderByClientOrderId`'s 404-to-null mapping is the one non-obvious response
  handling case worth calling out explicitly in the spec, since crash-restart
  reconciliation (#86) depends on it behaving exactly that way.
- Pagination on `getBars` is a real open question — deferred to implementation time
  with a note to check whether it's ever actually hit, rather than speculatively built.
- Retry/backoff policy is *not* settled here — genuinely shared fog across all four
  transport clients, left for the map's "shared conventions" patch once the other three
  tickets (LlmClient, TelegramClient, PolygonClient) land their own per-service limits.
