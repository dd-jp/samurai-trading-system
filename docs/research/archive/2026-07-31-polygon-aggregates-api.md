# Research: Polygon (now Massive.com) Aggregates API for real `PolygonClient`

> **ARCHIVED — folded into [`32-vendor-api-reference.md`](../32-vendor-api-reference.md).**

**Ticket:** #263 "Research: Polygon aggregates API for real PolygonClient" (child of wayfinder map #259 "Live Transport Layer")
**Date:** 2026-07-31
**Purpose:** Ground truth for implementing a real `PolygonClient` (`src/cost-model-backtest/stage2-historical-store.ts`) against Polygon's own current docs, so this file can be lifted directly into `docs/specs/transport-layer-spec.md`.

## Important context: Polygon.io rebranded to Massive.com

Primary docs at `polygon.io/docs/*` now 301-redirect to `massive.com/docs/*`. Per Massive's own docs and blog:

> "Polygon.io has rebranded as Massive.com on Oct 30, 2025. Existing API keys, accounts, and integrations continue to work exactly as before."
(source: https://massive.com/blog/build-and-test-your-apis-with-polygon-io-postman-collection ; corroborated by https://github.com/massive-com/client-python)

- New base URL: `api.massive.com`
- Legacy base URL: `api.polygon.io` — stated to "remain supported for an extended period"
- Official SDKs are now published under the `massive-com` GitHub org (e.g. `massive-com/client-python`, `massive-com/client-go`), defaulting to the new base URL but able to point at the legacy one.
- **Implication for this repo:** `POLYGON_API_KEY` and existing assumptions still work unchanged. The real HTTP client should target `api.polygon.io` (documented, stable, matches the interface's existing naming) OR `api.massive.com` (identical API surface, forward-looking) — pick one as a constant, not hardcoded per-call, so a later swap is a one-line change. No urgency to decide now; flagging as a naming/branding fact the spec should mention so a future engineer doesn't think `PolygonClient` is stale.

## 1. Endpoint shape (stocks aggregates)

Source: https://massive.com/docs/rest/stocks/aggregates/custom-bars (redirected from https://polygon.io/docs/rest/stocks/aggregates/custom-bars)

**URL:**
```
GET /v2/aggs/ticker/{stocksTicker}/range/{multiplier}/{timespan}/{from}/{to}
```

**Path/query params:**
- `stocksTicker` (path, required) — case-sensitive ticker symbol (e.g. `AAPL`)
- `multiplier` (path, required) — integer size of the timespan window (use `1` for daily bars)
- `timespan` (path, required) — e.g. `day`
- `from` / `to` (path, required) — `YYYY-MM-DD` or millisecond timestamp
- `adjusted` (query, optional) — boolean, defaults to `true`
- `sort` (query, optional) — `asc` | `desc`
- `limit` (query, optional) — integer, max `50000`, default `5000`

**Response envelope — NOT a flat array.** The repo's `PolygonAggregate[]` return type must be built by unwrapping `.results`:

```json
{
  "adjusted": true,
  "queryCount": 1,
  "request_id": "...",
  "resultsCount": 1,
  "status": "OK",
  "results": [
    {
      "t": 1578114000000,
      "o": 1.23,
      "h": 1.25,
      "l": 1.20,
      "c": 1.24,
      "v": 1000000,
      "vw": 1.235,
      "n": 5321
    }
  ],
  "next_url": "https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw"
}
```

**Field mapping to this repo's `PolygonAggregate`:**
```ts
interface PolygonAggregate { t: number; o: number; h: number; l: number; c: number; v: number; }
```
- `t`, `o`, `h`, `l`, `c`, `v` map 1:1, same names, same types (numbers; `t` is a Unix **millisecond** timestamp, not seconds — worth a comment in the client since `DateRange` uses JS `Date`).
- Real responses include two extra fields the repo's shape deliberately drops: `vw` (volume-weighted average price) and `n` (transaction count in the bar). The client should destructure/pick only `{t,o,h,l,c,v}` when mapping, not spread the raw result, so `vw`/`n` don't leak into the interface silently (and so a future Polygon field addition doesn't need a repo-side change).
- The envelope's `results` key can be **absent** when there's no data for the range (per Polygon's general API convention — not explicitly re-confirmed on this fetch, flagged as an assumption below) — the client should treat a missing `results` as `[]`, not throw.

## 2. Ticker format (crypto vs equities)

Source: https://massive.com/docs/rest/crypto/aggregates/custom-bars (redirected from https://polygon.io/docs/rest/crypto/aggregates/custom-bars)

- **Equities:** plain ticker, e.g. `AAPL`, `SPY`, `QQQ`, `TSLA` — no prefix.
- **Crypto:** `X:` prefix + concatenated pair, e.g. `X:BTCUSD`, `X:ETHUSD` (confirms this repo's `BTC-USD` / `ETH-USD` universe symbols must be translated to `X:BTCUSD` / `X:ETHUSD` before hitting Polygon — the client needs a symbol-mapping step, not a pass-through).
- **Same endpoint, not a different one:** crypto aggregates come from the identical `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` path — only the ticker string's prefix differs. Docs describe it as "the same endpoint structure as stocks."
- Crypto response envelope is the same shape (`results[]` with `o,h,l,c,v,vw,n,t`), plus an extra top-level `"ticker"` field echoing the requested ticker (e.g. `"X:BTCUSD"`). Not a field on each bar, so it doesn't affect the per-bar mapping.
- One documented crypto-specific nuance: results are noted as derived from "qualifying crypto trades that meet specific conditions" — i.e. some trade-condition filtering happens server-side before aggregation. Not actionable for the client's shape, but worth a one-line spec footnote in case bar counts look sparse for illiquid pairs.

**Practical consequence for this repo's universe (SPY, QQQ, AAPL, TSLA, BTC-USD, ETH-USD):** the client needs a small ticker-translation function, e.g.:
```ts
function toPolygonTicker(symbol: string): string {
  return symbol.endsWith('-USD') ? `X:${symbol.slice(0, -4)}USD` : symbol;
}
```

## 3. Pagination

Source: same aggregates doc page.

- When a date range's results exceed the page size (`limit`, max 50000, default 5000), the response includes a top-level `next_url` string.
- Example observed in docs: `https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw`
- Mechanic: "If present, this value can be used to fetch the next page of data" — i.e. the client should `GET` `next_url` directly (it already encodes the full path + a `cursor` param) rather than reconstructing query params itself, looping until a response has no `next_url`.
- **Open question / caveat:** the docs page fetched did **not** explicitly state whether the API key must be re-appended to `next_url`, or whether it's embedded/handled automatically. This is a real gap — could not confirm it from the page content returned. **Recommendation for the implementer:** reuse the same `Authorization: Bearer ${POLYGON_API_KEY}` header on the follow-up request rather than appending the key as a query param — an `?apiKey=` on `next_url` puts the credential in the URL, where it lands in request logs, proxies, and error reporters (the header-based approach avoids that regardless of which auth mechanism turns out to be required). Verify empirically against a real 5000+ bar request during implementation — for the MVP universe (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD, daily bars) pagination is unlikely to trigger in practice given `default limit 5000` and `max 50000`, since even ~10 years of daily bars is ~2500 rows, well under one page. Treat as low-priority polish, not a blocker — but whatever loop follows `next_url` should still cap the number of pages it will follow (e.g. a small fixed max, well above what this universe could ever produce) so a malformed or cyclical `next_url` can't spin forever and burn the rate limit.

## 4. Rate limits and lookback (Free / Starter tier)

Source: https://massive.com/pricing?product=stocks (redirected from https://polygon.io/pricing?product=stocks)

| Tier | Rate limit | Historical lookback | Data freshness |
|---|---|---|---|
| Free ("Stocks Basic") | 5 API calls / minute | 2 years | End of day only |
| Starter | Unlimited API calls | 5 years | 15-minute delayed |

- Free tier is **both** rate-limited (5 calls/min — meaningfully slow for backfilling 6 symbols) **and** capped at 2 years of history, end-of-day granularity only (no intraday, no delayed real-time).
- Starter removes the per-minute cap and extends lookback to 5 years, but is still delayed (not real-time) — consistent with this being historical-store/backtest usage rather than a live feed.
- **Caveat:** could not get crypto-specific pricing/rate-limit figures — the `product=crypto` pricing page fetch returned "Loading..." placeholders (client-side rendered content that didn't resolve via WebFetch's HTML snapshot). **This is an unresolved gap.** The stocks table above should NOT be assumed to apply identically to crypto tiers without checking `massive.com/pricing?product=crypto` in a real browser, since Polygon has historically priced/rate-limited crypto plans separately from stocks. Flag this for whoever implements the client to check directly (or via a logged-in dashboard) before assuming free-tier crypto lookback also caps at 2 years.
- For the MVP universe mixing equities (SPY/QQQ/AAPL/TSLA) and crypto (BTC-USD/ETH-USD), whichever tier is chosen must be checked against **both** asset classes' limits, not just stocks.

## 5. Auth

Sources: https://github.com/massive-com/client-python (via WebFetch), https://massive.com/blog/build-and-test-your-apis-with-polygon-io-postman-collection

- Confirmed: the official Python client authenticates via `RESTClient(api_key="<API_KEY>")` and the docs state "your API key will be automatically added [to] the correct authentication header for any API request" — i.e. **current official guidance favors an `Authorization` header**, injected by the SDK, over a raw query param.
- **Not fully confirmed from primary sources fetched today:** the exact header name/format (`Authorization: Bearer <key>` is the industry-standard assumption and matches Polygon's long-documented historical behavior, but no verbatim header example turned up in either fetch — both pages described the mechanism in prose rather than showing a raw curl example).
- **Also not disproven:** Polygon's classic (pre-rebrand) REST API has long supported `?apiKey=<key>` as a query parameter — this was the standard for years and is what most existing third-party integrations use. Nothing in the fetched docs said this was deprecated or removed; the Postman/SDK docs simply describe the *convenience* of auto-injecting a header rather than stating the query param is gone. That said, prefer the header regardless: a query-string key is credential-bearing text that ends up in request logs, proxies, and error reporters, so it shouldn't be the client's primary mechanism even where it's still accepted.
- **Recommendation:** implement the client using the `Authorization: Bearer ${POLYGON_API_KEY}` header as the primary, documented-recommended method (matches current official guidance, and keeps the key out of URLs), but don't be surprised if `?apiKey=` also works as a fallback — this is the safer assumption given incomplete primary-source confirmation. **Verify empirically with one real request during implementation** rather than trusting this doc alone for the header name's exact casing/format.

## Summary for spec-writing

`fetchAggregates(symbol, window)` implementation shape:
1. Translate `symbol` → Polygon ticker (`X:BTCUSD` for crypto, pass-through for equities).
2. Format `window.start`/`window.end` as `YYYY-MM-DD`.
3. `GET {BASE_URL}/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}?adjusted=true&sort=asc&limit=50000` with `Authorization: Bearer ${POLYGON_API_KEY}` — `BASE_URL` is the one constant this doc recommends deciding once (`api.polygon.io` vs `api.massive.com`, see §"Important context" above), not hardcoded per-call.
4. Unwrap `.results` (default to `[]` if absent), map only `{t,o,h,l,c,v}` — drop `vw`/`n`.
5. Follow `.next_url` in a loop if present (rare for daily bars at this universe's scale), reusing the same `Authorization` header rather than an `?apiKey=` query param; cap the number of pages followed so a malformed or cyclical `next_url` can't loop forever.
6. Respect free-tier 5 calls/min if that's the provisioned plan (add a throttle/queue in front of the client, not per-call).

## Open questions / caveats (could not resolve from primary sources fetched)

1. **`next_url` auth mechanic** — undocumented on the page fetched whether the API key must be manually re-appended. Verify empirically.
2. **Crypto-tier pricing/rate-limits** — `massive.com/pricing?product=crypto` did not render statically; only stocks tier data was retrievable. Do not assume crypto shares the stocks free-tier's 2-year/5-calls-per-minute limits without checking directly.
3. **Auth header exact format** — inferred as `Authorization: Bearer <key>` from SDK prose, not a verbatim quoted example. `?apiKey=` query param was Polygon's long-standing classic method and nothing fetched today said it was removed, but no explicit current statement either way turned up.
4. **Missing-`results`-key behavior** — assumed (not re-verified from a primary source in this session) that a truly empty range omits `results` entirely rather than returning `"results": []`; treat both as equivalent (empty list) defensively in the client.
5. **Which base URL to standardize on** — `api.polygon.io` (legacy, still supported "for an extended period," no stated deprecation date) vs `api.massive.com` (current/forward-looking). Not a research gap so much as a decision the spec should make explicitly and record as a constant.
