# Fallback Historical OHLCV Sources — Both Legs

Research supporting the resolution of GitHub issue [#487](https://github.com/dd-jp/samurai-trading-system/issues/487) ("grilling — free two-source stack vs Polygon paid"), child of wayfinder map [#482](https://github.com/dd-jp/samurai-trading-system/issues/482).

Primaries were settled by [#483](https://github.com/dd-jp/samurai-trading-system/issues/483) (equities: Alpaca free Basic, `feed=sip&adjustment=raw`) and [#484](https://github.com/dd-jp/samurai-trading-system/issues/484) (crypto: Coinbase Exchange public candles). This document answers the question those two left open: **when a free primary breaks, what takes over?**

All probes run 2026-08-06 against live endpoints. Evidence tagged **PROBED** (called it, read the response), **DOC** (quoted from a vendor page fetched today), or **UNVERIFIED**.

---

## Verdict (up front)

| Leg | Primary (already decided) | **Fallback (this document)** | Runner-up |
|---|---|---|---|
| Crypto | Coinbase Exchange public candles (#484) | **Bitstamp `/api/v2/ohlc`** — no key, BTC to 2011-08-18, ETH to 2017-08-16, zero gaps | Crypto.com Exchange (works, but only reaches 2020-11) |
| Equities | Alpaca free Basic (#483) | **Polygon free tier** — key **already provisioned**, 2y rolling window, `adjusted=false` | Yahoo `chart` (10y, but split-adjusted — needs an un-adjust layer) |

Both fallbacks are £0. Neither needs a signup. The two-source free stack becomes a four-source stack with two spares, still at zero standing cost, versus $78/mo for Polygon paid.

---

## The reframe that makes this cheap

The grilling of #487 turned on a code fact: **every Stage 2 run currently re-fetches the entire window from the vendor.**

- `Stage2HistoricalStore` (`src/cost-model-backtest/stage2-historical-store.ts:63`) does persist bars to SQLite, `INSERT OR IGNORE` on `(instrument, timeframe, open_time)`.
- But `ingest()` (`:92`) calls `client.fetchAggregates(...)` unconditionally. Dedup happens on the **write**, after the network call. A persistent DB does not avoid the fetch.
- The direct CLI entrypoint (`src/scripts/run-stage2.ts:536`) passes no `dbPath`, so the store opens `:memory:` (`:311`). Every run starts from an empty database.

Once that is fixed — persistent path plus a fetch-skip for covered windows — **a fallback only has to serve the daily increment, not five years of history.** History lives on disk; a dead vendor costs you new bars, not old ones.

This changes what a fallback must be good at. Depth stops being the discriminator (any source covering the last few days will do) and **consistency with the primary's adjustment convention becomes the discriminator**, because bars from two sources land in the same table.

Append-only caching is sound here because both primaries are unadjusted: Alpaca is pinned `adjustment=raw`, and crypto venues do not restate candles. A fallback that serves *adjusted* prices breaks that property — see Yahoo below.

### ⚠️ The equities recommendation depends on that fix, and the fix does not exist yet

**Polygon free physically cannot serve a cold backfill** — it 403s beyond 2 years, and the Stage 2 window is 5. It is a valid fallback *only* in the increment-only role, which *only* exists once bars persist across runs.

So the ordering is a hard dependency, not a preference: **the caching change (persistent `dbPath` + skip covered windows) must land before any equities failover is implemented.** Implement failover first and the fallback is wrong in practice — the first stall would try a 5-year fetch against a 2-year key and fail.

The crypto leg has no such ordering constraint: Bitstamp's 15 years cover a cold backfill on their own. (Crypto.com's 2020-11 floor would not — a third reason Bitstamp wins.)

---

## Crypto leg

### 1. Bitstamp — ✅ **RECOMMENDED FALLBACK**

`GET https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=86400&limit=1000&start={unix}`

No key, no account, true USD pairs (`btcusd`, `ethusd` — not USDT proxies).

**PROBED**, walking from the venue's own start to today:

```
btcusd: 2011-08-18 .. 2026-08-06   5468 bars   missing=0
ethusd: 2017-08-16 .. 2026-08-06   3278 bars   missing=0
```

Over the 5-year Stage 2 window (2021-08-06 →), both pairs return **1827 bars, zero missing days, zero zero-volume days**. 1000 bars per request means the full 5y backfill is 2 requests per symbol — fewer than Coinbase's 7.

**Volume regime — PROBED.** This is the #484 trap: Alpaca crypto was rejected because its volume column dropped ~600× overnight on 2023-06-15, which would have inflated the cost model's `√(size/adv)` impact charge ~65× through `getADV()`. Bitstamp was checked the same way — month-over-month median volume, flagging any ≥10× step. Over the 5y window: **no breaks**. The only flagged step is 2011-08→2011-09 (×365), which is the venue's own genesis period, fifteen years before the window.

**Caveat — PROBED.** Paginating with `start = last_timestamp + 86400` returns one overlapping bar at the boundary. Harmless with `INSERT OR IGNORE`, but a naive `append` double-counts a day. Dedup by date, do not concatenate.

**Caveat — UNVERIFIED.** Bitstamp is a single venue, so its volume is single-venue like Coinbase's. Switching between them changes the `adv` denominator. See "Open question" below — this applies to the primary too, and is not a mark against the fallback.

### 2. Crypto.com Exchange — ⚠️ works, but no headroom

`GET https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=BTC_USD&timeframe=1D&count=300&start_ts=&end_ts=`

No key. Returns `o/h/l/c/v/t`. **PROBED** over the 5y window:

```
BTC_USD: 1826 bars 2021-08-06..2026-08-05  missing=0  zero_vol=0  (7 requests)
ETH_USD: 1826 bars 2021-08-06..2026-08-05  missing=0  zero_vol=0  (7 requests)
```

Clean over the window, no volume regime breaks. **But the history is shallow — PROBED:** `BTC_USD` begins **2020-11-24** and `ETH_USD` begins **2021-06-24**. It covers the current 5-year window with roughly two months and six weeks of slack respectively. Any extension of the backtest window, or simply the passage of time, walks off the end of `ETH_USD` first.

Also note `count` caps at 300 per request, so it needs 7 paginated calls per symbol against Bitstamp's 2.

**Usable, but Bitstamp dominates it on depth and request count.** Keep as third-line.

### 3. CoinGecko — ❌ **fails, three ways**

The ticket named it explicitly, so it was probed rather than assumed.

- **Depth — PROBED.** `?days=max` returns HTTP error 10012: *"Your request exceeds the allowed time range. Public API users are limited to querying historical data within the past 365 days. Upgrade to a paid plan to enjoy full historical data access."* One year, hard stop.
- **Granularity — PROBED.** At `days=365` the returned bars are **4 days apart** (`1754265600000` → `1754611200000` = 345600000 ms). CoinGecko auto-selects granularity by range; daily bars are not available beyond ~30 days on the public tier. `&interval=daily` is refused: `{"error":"invalid interval parameter"}`.
- **No volume — PROBED.** The `/ohlc` payload is `[timestamp, o, h, l, c]`. There is no volume column at all. `getADV()` has nothing to read.

Any one of these is disqualifying. **Rejected.**

### 4. Gemini — ❌ fails

`GET https://api.gemini.com/v2/candles/btcusd/1day` — **PROBED**: 364 bars, 2025-08-07 → 2026-08-05. The endpoint takes no pagination parameters, so ~1 year is the ceiling. Clean data, insufficient depth even for the increment-only role if a stall runs long. **Rejected.**

### 5. OKX — ⚠️ viable, USDT-only

`GET https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1Dutc&limit=100` — **PROBED**: 2000 bars back to 2021-02-14 in 20 paginated requests, zero missing, no volume breaks. Deeper history is likely available with more pagination (not probed to the floor).

Two marks against it: 100 bars/request makes backfill chatty, and the liquid pairs are **USDT-quoted**, not USD. A USDT pair is a different instrument from `BTC-USD` — it prices in a stablecoin whose peg has broken before. Fine as a cross-check, wrong as a drop-in for a USD-denominated backtest. **Third-line at best.**

### 6. Binance — ⚠️ works, but jurisdictional risk unverified

`GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000` — **PROBED**: 1827 bars over the 5y window, zero missing, no volume breaks, 1000 bars/request. Technically the best of the USDT venues.

**UNVERIFIED and the reason it is not recommended:** the owner is UK-based, and Binance's UK retail availability has been restricted. Whether keyless public *market data* access is affected is not established here, and it is not a question worth answering when Bitstamp is cleaner, USD-quoted, and carries no such question. **Not recommended.**

---

## Equities leg

First, a framing correction the ticket carried: **Alpaca is the primary, not a fallback for Polygon.** #483 already replaced Polygon paid for equities. The live question is what backs up Alpaca.

### 1. Polygon free tier — ✅ **RECOMMENDED FALLBACK**

**Map #482 is stale on this point.** It records the Polygon API key as "an unprovisioned precondition" for #241. `POLYGON_API_KEY` **is present and populated in `.env.local`** (32 characters). Probed today, it works.

**Tier — PROBED.** It is the **free** tier, established by two independent behaviours:

```
AAPL 1 year back  (2025-08-05)  -> HTTP 200, resultsCount=22
AAPL 3 years back (2023-08-05)  -> HTTP 403 NOT_AUTHORIZED
     "Your plan doesn't include this data timeframe. Please upgrade your plan"
AAPL 6 years back (2020-08-05)  -> HTTP 403 NOT_AUTHORIZED
AAPL 11 years back(2015-08-05)  -> HTTP 403 NOT_AUTHORIZED

burst of 6 identical requests -> req1..req5 HTTP 200, req6 HTTP 429
     "You've exceeded the maximum requests per minute"
```

That is exactly the documented free profile: **2-year rolling window, 5 requests/minute.** It is not the $29/mo Starter tier #157 chose — nobody is being billed.

**Why it is the right fallback despite being the weakest tier:**

- The 2-year window is irrelevant to the increment-only role. A stall needs the last few days.
- 5 req/min is ample: the equities increment is 1 request/day for the whole 4-symbol universe.
- `adjusted=false` gives unadjusted bars matching Alpaca's `adjustment=raw` convention, so fallback bars and primary bars are the same kind of number. **PROBED directly** — this is the load-bearing claim, so it was measured rather than read off a docs page. Both sources, same 6-month range, all four tickers:

  ```
  SPY : 128 bars each, 128 shared dates, max |close diff| = 0.0000
  AAPL: 128 bars each, 128 shared dates, max |close diff| = 0.0000
  TSLA: 128 bars each, 128 shared dates, max |close diff| = 0.0000
  QQQ : 128 bars each, 128 shared dates, max |close diff| = 0.0000
  ```

  Closes agree **exactly**, to the cent, on every shared bar, with no date mismatches. The two conventions are interchangeable for price.

  ⚠️ **Volume does not agree exactly.** Polygon/Alpaca volume ratio ranges 0.918–1.001 — Polygon reports up to ~8% *less* volume on SPY, ~1% less on the single names. That is trade-condition/odd-lot consolidation differing between vendors, not a defect. It is small enough not to threaten a mixed table the way #484's ~600× Alpaca-crypto break would, but it does mean **failover shifts `getADV()`'s denominator by up to ~8%** and therefore the cost model's `√(size/adv)` charge by up to ~4%. Acceptable for a stall; worth recording which source each bar came from so it can be re-derived from the primary later.

  Note this also means no split test was needed: agreement is measured on live data, not inferred. (None of the four split inside the free tier's 2-year window anyway.)
- It is an official, documented API with terms, and the key is already in hand. Zero provisioning work.
- There is already a `HttpPolygonClient` in the codebase (`src/cost-model-backtest/http-polygon-client.ts`) — the transport exists.

### 2. Yahoo `chart` endpoint — ⚠️ second line, with a real defect

`GET https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=10y&interval=1d&events=div,split`

No key. **PROBED**: 2513 bars, 2016-08-08 → 2026-08-06 for all four tickers; 1255 bars inside the 5y window (~251/yr, correct for trading days).

**The defect — PROBED. Yahoo's `close` is split-adjusted, not raw.** AAPL split 4:1 effective 2020-08-31. Yahoo returns:

```
AAPL 2020-08-28 close=124.81 volume=187,630,000
AAPL 2020-08-31 close=129.04 volume=225,702,700
```

The tape printed roughly $499 on 2020-08-28. Yahoo prints 124.81 — the price retroactively restated by the split. Volume is restated too. The `events` block does ship the split (`numerator: 4.0, denominator: 1.0`), so the raw series is **reconstructible**, but it is not given.

This independently corroborates #483, which found the same thing via TSLA's 2022 3:1 split (Yahoo 297.10 vs Alpaca raw 890.91). Two different splits, same conclusion — the behaviour is systematic, not a per-symbol quirk.

**Why that matters more for a fallback than it did for a primary:** a split-adjusted source *rewrites history* at every future split. That breaks the append-only caching property the whole "stall is fine" argument rests on, and mixing Yahoo bars into a table of Alpaca `raw` bars puts two incompatible price conventions in one column. Usable only behind an un-adjustment replay layer, which must be correct or it silently corrupts every backtest.

Also **UNVERIFIED/DOC:** unofficial endpoint, no SLA, no terms permitting programmatic use, 429s under load.

**Keep as second line.** It is the only keyless equities source with real depth, so it is worth having — but Polygon free is strictly easier to trust.

### 3. TradingView — ❌ **not a data source at all**

The ticket named it, so it was checked. **DOC**, TradingView Charting Library documentation fetched 2026-08-06:

> "The library does not provide any market data. You must connect the library to your own data source or a third-party provider."

The integrator's datafeed is required to "Supply historical bar data (OHLC)." **The direction is inverted** — TradingView is a charting front-end that consumes a feed you provide, not a vendor that serves one. There is no public REST API for historical bars.

Any "TradingView data" one sees in the wild comes from reverse-engineering their internal websocket, which is unauthorised scraping of a licensed redistribution. **Rejected on structure, not on limits.**

### 4. Stooq — ❌ bot-walled

`GET https://stooq.com/q/d/l/?s=spy.us&i=d` — **PROBED**: returns an HTML JavaScript challenge page (`<meta name="robots" content="noindex,nofollow">`), not CSV, for `spy.us`, `aapl.us`, and the `stooq.pl` mirror. No programmatic access without defeating the challenge. **Rejected.**

### 5. Already ruled out by #483 — not re-probed

Tiingo (free tier "Internal Use Only" licence, a live problem given the dashboard component), Alpha Vantage (25 req/day), EODHD (20 calls/day), Finnhub (unverified, pricing page would not render). See `free-equities-ohlcv-2026-08-06.md`.

---

## Corrections this research forces on map #482

1. **"Polygon/Massive API key is still an unprovisioned precondition" is wrong.** The key is provisioned and works. It is free tier — 2y window, 5 req/min, PROBED. It is a usable fallback today.
2. The #483 and #484 writeups (`docs/research/free-equities-ohlcv-2026-08-06.md`, `free-crypto-ohlcv-2026-08-06.md`) are **not on `main`** — they live on the unmerged branches `origin/worktree-wayfinder-483-free-equities-ohlcv` and `origin/worktree-wayfinder-484-free-crypto-ohlcv`. Anyone reading `docs/research/` on `main` will not find the evidence the map's decisions cite.

---

## Open question this research deliberately did not settle

Map #482's "Not yet specified" section frames Coinbase's single-venue volume as a *cost of going free* — it shifts the cost model's `√(size/adv)` liquidity denominator relative to an exchange-aggregated source.

**Whether Polygon Currencies volume is exchange-aggregated is UNVERIFIED** (the free key cannot reach crypto aggregates to test). If it is aggregated, a recalibration is owed under *either* choice and it is not a discriminator between free and paid. If it is not, the paid tier has the same single-venue property and the point dissolves entirely.

Either way it should not be priced against the free stack until someone checks. Note that every crypto fallback above is also single-venue, so **switching between free crypto sources shifts `adv` too** — the recalibration question is about source-switching in general, not about free versus paid.

---

## What this does not cover

- Intraday/tick data. Daily bars only, per map #482's scope.
- Automatic failover *mechanics* — when to trip over to the fallback, how to mark which source a bar came from, how to re-derive from the primary once it returns. That is implementation, and belongs on #241's follow-up tickets, not here.
- Live-money data licensing for any of these sources. #483 already flagged this as owed for Alpaca before real capital; the same question applies to every source named here.
