# Vendor API reference — Alpaca and Polygon/Massive

**Status:** Consolidated 2026-08-08 from the Alpaca REST surface study (2026-07-29, #259) and the Polygon aggregates study (2026-07-31, #241/#263). Originals: [Alpaca](archive/2026-07-29-alpaca-rest-api-surface.md), [Polygon](archive/2026-07-31-polygon-aggregates-api.md).

This is endpoint reference, cited from `src/`. Probe-derived facts about *which vendor to use* are in [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md).

---

## Alpaca

> **CORRECTION 2026-08-05 (#358) — load-bearing.** Alpaca's crypto data endpoints are on **`/v1beta3`, not `/v2`**: `GET /v1beta3/crypto/us/bars` and `GET /v1beta3/crypto/us/latest/quotes` return `200`; both paths under `/v2` return `404`. The original study had this wrong **and it was implemented as written**. It took a live paper run to catch, because the 404 surfaced as a quiet `analysts: quorum_skip` rather than an error. Equity paths (`/v2/stocks/...`) and the entire Broker/Trading table were re-verified live the same day and are correct.
>
> The original was written **without live network access**, from training-data knowledge. That caveat was not boilerplate — it produced a shipped bug. Re-verify against <https://docs.alpaca.markets> before implementing anything new from this page.

### Two clients, two base URLs, one key pair

- **Broker/Trading API** — `https://paper-api.alpaca.markets` (paper) / `https://api.alpaca.markets` (live).
- **Market Data API** — `https://data.alpaca.markets`. One host serves both paper and live accounts; data is not paper/live-separated the way trading is.

Both authenticate with the same `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` header pair. No OAuth, no token refresh.

### Broker / Trading

| Method | Endpoint | Notes |
|---|---|---|
| `submitOrder` | `POST /v2/orders` | Body: `symbol`, `side`, `qty` (string), `type`, `time_in_force`, `order_class: 'bracket'`, `client_order_id`, `take_profit: {limit_price}`, `stop_loss: {stop_price}`. Entry is `limit_price`, not market |
| `getOrder` | `GET /v2/orders/{order_id}` | |
| `getOrderByClientOrderId` | `GET /v2/orders:by_client_order_id?client_order_id={id}` | **Returns 404 for an unknown id — must map to `null`, not throw.** Crash-restart reconciliation (#86) depends on exactly this |

For account state: `GET /v2/account` (cash, equity, daytrading_buying_power) and `GET /v2/positions`.

### Market Data

| Method | Equities | Crypto |
|---|---|---|
| `getBars` | `GET /v2/stocks/{symbol}/bars` | `GET /v1beta3/crypto/us/bars` |
| `getLatestQuote` | `GET /v2/stocks/{symbol}/quotes/latest` | `GET /v1beta3/crypto/us/latest/quotes` |

Crypto vs equity is a **path-root split, not a parameter** — route on `asset_class`. `timeframe` passes through as Alpaca's own query param (`1Min`, `1Day`, …). `asOf`/`limit` map to `end`/`limit`. Pagination is via `next_page_token`. Quote responses nest under a `quote`/`quotes` key by symbol and need unwrapping.

For historical bars specifically, pin `feed=sip&adjustment=raw` — see [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md) for why `feed=iex` is a trap.

### Rate limits

**200 requests/minute** per API key on the standard paper/live tier. A 429 does not always carry `Retry-After`; exponential backoff on 429/5xx is the convention. Alpaca's limit is the tightest of the transport clients.

---

## Polygon / Massive

**Polygon.io rebranded to Massive.com on 2025-10-30.** `api.polygon.io` remains legacy-supported.

### Aggregates

```
GET /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
```

- `limit` — max **50000**, default 5000.
- Timestamps (`t`) are **milliseconds**.
- **Crypto uses the same endpoint** with a prefixed ticker: `X:BTCUSD`.
- For point-in-time bars, pass `adjusted=false` — it matches Alpaca's `raw` exactly (max |close diff| 0.0000 over 128 shared bars).
- Pagination via `next_url`.
- Prefer `Authorization: Bearer <key>` over `?apiKey=` so the key stays out of logs and referrers.

### Tiers

| Tier | Rate | History |
|---|---|---|
| Free | 5 calls/min | 2 years EOD |
| Starter | unlimited | 5 years, 15-min delayed |
| Higher | unlimited | 10 and 20+ years |

We are on **Free**. That is a paid entitlement boundary, not a data gap — a 5-year request returns 2 years, and probing for `NOT_AUTHORIZED` is what confirmed it.

### Open questions (unresolved from primary sources)

Whether `next_url` carries auth or needs the key re-attached; crypto-tier rate limits specifically; behaviour when `results` is absent from an otherwise-200 response.

⚠️ See [`30-data-vendor-decisions.md`](30-data-vendor-decisions.md) for Massive's derivative-works licensing clause, which touches these aggregates in live use.
