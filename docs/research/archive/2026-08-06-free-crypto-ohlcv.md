# Free 5-year daily OHLCV for BTC-USD / ETH-USD — verification

**Ticket:** [#484 Wayfinder: research — free 5y crypto OHLCV (Coinbase/Binance/Tiingo vs Kraken 720-cap)](https://github.com/dd-jp/samurai-trading-system/issues/484)
**Map:** [#482 Wayfinder: free 5-year historical OHLCV for the MVP universe — revisit Polygon paid decision](https://github.com/dd-jp/samurai-trading-system/issues/482)
**Sibling:** [#483](https://github.com/dd-jp/samurai-trading-system/issues/483) resolved the equities leg (`docs/research/free-equities-ohlcv-2026-08-06.md`).
**Date:** 2026-08-06 · **Probed from:** the deployment host (UK residential IP, no VPN)

Every claim below is labelled **PROBED** (I called the endpoint and read the bytes) or **DOC** (vendor documentation, unverified against a live call). Nothing here is inferred from a README alone — that was the explicit instruction on map #482.

---

## Verdict

**Coinbase Exchange public candles (`api.exchange.coinbase.com`) is the recommendation for the crypto leg. Free, no key, no account, 11 years deep, gap-free over the 5-year window, and — the deciding property — it is the only free source that carries a *usable volume column*.**

**Implication, not this ticket's verdict:** a verified free source now exists for *both* legs, so the whole $78/mo of decision [#157](https://github.com/dd-jp/samurai-trading-system/issues/157) ($29 Stocks Starter + $49 Currencies Starter) is technically avoidable. Whether to actually drop the paid tier — free stack with no SLA versus one paid vendor with support — is map [#482](https://github.com/dd-jp/samurai-trading-system/issues/482)'s decide step, deliberately **not** settled here.

The obvious candidate — Alpaca crypto, which would have tape-matched the MVP execution venue and reused a key already in `.env.local` — **is rejected on a defect that only showed up when I compared its volume column against another venue's**. See "The Alpaca crypto trap" below. It survives as a price cross-check, not as the source.

---

## The deciding axis: crypto has no splits, so PIT isn't what discriminates

The equities leg turned on adjustment/point-in-time (`adjustment=raw` vs restated prices). That axis is **inert for crypto** — no splits, no dividends, no corporate actions to restate. All five sources returned the same prices for the same dates within noise (below).

What actually discriminates free crypto sources is **whose tape it is**, and specifically **whether the volume column is real**. Samurai consumes bar volume in three places, so this is not academic:

| Consumer | Location | What breaks on a bad volume column |
| --- | --- | --- |
| `MarketDataService.getADV()` | `src/market-data-service/service.ts:234` | Documented as "the liquidity proxy for the **cost model's √-law market impact term**" (`src/market-data-service/types.ts:181`). Understated ADV inflates the impact charge by √(ratio). |
| `technical-analyst` | `src/analysts/technical-analyst.ts:113` | `avgVolume` goes into the LLM prompt as liquidity context. |
| `sentiment-analyst` | `src/analysts/sentiment-analyst.ts:74` | Same — volume is the "normalize crowd" context. |

Given `docs/research/10-cost-model-calibration-2026-08-05.md` and the Stage 2 history — where a *miscalibrated cost model*, not the signal, produced a KILL verdict — a source that silently understates crypto ADV is the single most expensive mistake available on this ticket.

---

## The Alpaca crypto trap

`GET https://data.alpaca.markets/v1beta3/crypto/us/bars` looks like the winner on every axis the ticket asked about:

- **PROBED — depth:** `start=2000-01-01&limit=10000` returns **2,044 daily bars per symbol, 2021-01-01 → 2026-08-06**, `next_page_token: null`. The entire 5.6-year history for *both* symbols arrives in **one request in 0.98s**.
- **PROBED — gaps: none.** 2,044 bars across a 2,044-day span for both BTC/USD and ETH/USD. Zero missing calendar days, zero zero-volume days. Cleaner than any other candidate.
- **PROBED — prices are consensus:** median |close difference| vs Coinbase over all 2,044 common days is **0.018% (BTC) / 0.025% (ETH)**; worst day 1.73% / 1.79% (both 2023-05-07/08).
- **Free, no extra key** — the execution key in `.env.local` already authorises it. (The endpoint needs the header pair; `loc` must be `us` — `global` returns `400 Invalid location`.)

**And its volume column has a ~600× structural break in the middle of the backtest window.**

PROBED — BTC/USD, consecutive daily bars:

| Date | Volume (BTC) | Trades (`n`) |
| --- | --- | --- |
| 2023-06-13 | 584.0 | 49,149 |
| 2023-06-14 | 109.9 | 8,143 |
| **2023-06-15** | **3.54** | **228** |
| 2023-06-16 | 0.92 | 172 |

Median daily volume by year, against Coinbase over the identical days:

| Year | Alpaca BTC median | Coinbase BTC median | Ratio | √ratio (impact inflation) |
| --- | --- | --- | --- | --- |
| 2021 | 1,247 | 16,039 | 13× | 3.6× |
| 2022 | 3,089 | 20,041 | 6× | 2.5× |
| 2023 | 5.23 | 12,219 | **2,336×** | **48×** |
| 2024 | 2.00 | 11,691 | **5,860×** | **77×** |
| 2025 | 1.68 | 7,140 | **4,242×** | **65×** |
| 2026 | 1.85 | 8,049 | **4,346×** | **66×** |

PROBED — ETH/USD breaks on the **same date**, same shape: 2023-06-13 = 2,002 ETH / 10,387 trades → 2023-06-14 = 487 / 2,115 → **2023-06-15 = 20.1 / 125**. Per-year ratios run 12× → 3,900×.

Coinbase's own volume merely drifts down over the same period (16,039 → 8,049, i.e. ×0.5 across five years). Alpaca's drops **~600× overnight**. So the discontinuity is in Alpaca's reporting, **not in the market** — that much is evidenced. *Why* Alpaca's printed crypto volume collapsed on that date is **not established here**, and the consequence below does not depend on it. Prices are unaffected throughout, which is exactly what makes it dangerous: nothing in the price series signals that the volume column changed meaning.

⚠️ **The pre-break half is not clean either.** Even in 2021–2022, before the discontinuity, Alpaca's volume runs 6–13× under Coinbase's for the same days — a 2.5–3.6× impact inflation. There is no sub-window of this column that can be used as ADV; the break just makes the later half catastrophic rather than merely wrong.

**Consequences if used unguarded:**

1. `getADV()` over any recent window returns ~2 BTC/day. The cost model's √(size/adv) impact term is then inflated **~65×** — the precise failure mode that produced a false Stage 2 KILL before.
2. A backtest spanning June 2023 sees a phantom 600× liquidity collapse mid-window. Any volume-relative feature, regime detector, or LLM prompt reading `avgVolume` is reacting to a vendor event.
3. The analysts would be told, in prose, that BTC trades ~2 coins a day.

**Alpaca crypto is therefore rejected as the history source.** Its price series is excellent and free — keep it as a cross-check (see Recommendation step 3), but its volume column must never reach `getADV()`.

> Note on tape-match: the MVP executes crypto through Alpaca, so "use the venue you trade on" argues for Alpaca's ADV. It doesn't survive contact with the numbers. 2 BTC/day is Alpaca's own retail print, not the depth its liquidity providers actually offer; charging impact against it would price a $50-budget order as if it moved a market 65× thinner than the one it reaches. Coinbase's ADV is the better estimator of accessible USD-pair liquidity, and it is the venue CLAUDE.md already names for long-term crypto execution via ccxt.

---

## Candidate table

| Source | Verdict | Depth | Gaps in 5y | Volume column | Key |
| --- | --- | --- | --- | --- | --- |
| **Coinbase Exchange public candles** | ✅ **Recommended** | **BTC 2015-07-20, ETH 2016-05-18** (PROBED) | **0** (PROBED) | Real venue volume, no break (PROBED) | None |
| Alpaca `/v1beta3/crypto/us/bars` | ⚠️ Price cross-check only | 2021-01-01 (PROBED) | **0** (PROBED) | ❌ ~600× break 2023-06-15 (PROBED) | Existing |
| Binance `/api/v3/klines` | ⚠️ Works, wrong pair | 2017-08-17 (PROBED) | not measured | Real, deepest liquidity | None |
| Yahoo / yfinance `BTC-USD` | ⚠️ Dominated | 2016-08-06, 3,653 bars (PROBED) | not measured | Aggregate index, USD notional | None |
| Tiingo crypto | ❌ Unverifiable + licence risk | — | — | — | `403 {"detail":"Please supply a token"}` (PROBED) |
| Kraken `/0/public/OHLC` | ❌ **Dealbreaker confirmed** | **721 candles, 2024-08-16 →** (PROBED) | — | Real | None |

### Kraken — #155's blocker reconfirmed

PROBED: `?pair=XBTUSD&interval=1440&since=1420070400` (since = 2015-01-01) returns **721 candles starting 2024-08-16**. The `since` parameter is ignored beyond the cap; the response is always the most-recent ~720. #155 was right, and it is still right in 2026-08. **ccxt-against-Kraken cannot backfill multi-year crypto history at any granularity.**

### Binance — reachable from the UK, but it's the wrong pair

PROBED: `https://api.binance.com/api/v3/klines` returns **HTTP 200 from the deployment host's UK residential IP** — no 451, no geoblock. (The `data-api.binance.vision` public mirror also works identically; not needed.) 1d klines go back to **2017-08-17**, 1,000 bars/request, so 5y = 2 requests/symbol.

It is rejected on a subtler ground: **there is no BTC-USD pair.** Binance's liquid pair is `BTCUSDT` — a *stablecoin* tape. USDT is not USD; it has depegged before (its own price series is not identically 1.0000), so a USDT-denominated backtest carries an unhedged basis against a USD-settled account. Samurai's universe is specified as BTC-USD/ETH-USD and its account is USD-denominated. Binance also carries a live UK regulatory question for anything past market data. Free and deep, but the wrong instrument.

### Yahoo — works, but adds nothing over Coinbase

PROBED: `query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=10y&interval=1d` returns **3,653 daily bars, 2016-08-06 → 2026-08-06**, UTC-midnight stamps. Same objection as the equities leg: undocumented, unversioned, ToS-grey, best-effort. Coinbase is deeper for BTC, officially public, and a real venue tape. No reason to prefer Yahoo.

### Tiingo — same wall as the equities leg

PROBED: `403 {"detail":"Please supply a token"}`. Unverifiable without signup, and #483 already found the binding constraints its README omits (50 req/hour, **"Internal Use Only"** licence that the planned web dashboard may breach). Not pursued — a free source that needs no account beat it.

---

## Coinbase: exact call pattern and measured limits

```
GET https://api.exchange.coinbase.com/products/{BTC-USD|ETH-USD}/candles
    ?granularity=86400          # 1 day, in seconds
    &start=<ISO8601 UTC>
    &end=<ISO8601 UTC>
```

- **No authentication, no account, no key.** Public market data endpoint.
- **Response:** array of `[time, low, high, open, close, volume]`, **newest first**. ⚠️ Note the ordering of the OHLC fields — it is `low, high, open, close`, *not* the conventional OHLC order. Reading it positionally as OHLC silently swaps open with low and close with high.
- `time` is a **Unix second timestamp of the UTC-midnight bar open.**
- **PROBED — hard 300-candle cap per request, and it errors rather than truncating:** a 2021→2026 range returns `400 {"message":"granularity too small for the requested time range. Count of aggregations requested exceeds 300"}`. **Paginate in ≤300-day windows.** A wide range failing is a pagination bug, not evidence of shallow history.
- **PROBED — full 5-year backfill: 7 requests per symbol, 14 total, ~3s wall clock** at a 120ms courtesy sleep. DOC: 10 req/s per IP on public endpoints; no `RateLimit-*` headers are returned, so pace conservatively rather than reading back a budget.
- **PROBED — depth floors:** BTC-USD **2015-07-20**, ETH-USD **2016-05-18** (each product's listing date on the exchange). That is **11.0y / 10.2y**, comfortably matching the 10.5y the equities leg gets from Alpaca.
- **PROBED — gap-free:** 2,044 bars over the 2,044-day window 2021-01-01 → 2026-08-06 for both symbols. **Zero missing calendar days.**

### Bar boundary convention — verified across all five sources

Crypto is 24/7, so "daily" is a convention, and [#420](https://github.com/dd-jp/samurai-trading-system/issues/420) is the standing proof that a bar-alignment mismatch silently distorts every reported Sharpe in this codebase. Probed: BTC 2025-03-14 from all five sources.

| Source | Open | High | Low | Close |
| --- | --- | --- | --- | --- |
| Alpaca | 81,021.50 | 85,360.76 | 80,801.66 | 84,048.93 |
| Coinbase | 81,071.50 | 85,318.61 | 80,771.17 | 83,980.49 |
| Binance (USDT) | 81,115.78 | 85,309.71 | 80,818.84 | 83,983.20 |
| Yahoo | 81,066.99 | 85,263.29 | 80,797.56 | 83,969.10 |
| Kraken | 81,112.30 | 85,278.70 | 80,847.20 | 83,997.60 |

**All five use UTC-midnight day boundaries.** The spread across sources is ~0.06% — venue-level price difference, not a boundary offset. (A boundary shifted by even an hour would move open and close by far more than the day's own range permits at this agreement level.) So Coinbase's crypto days align with the equities leg's daily bars on the same UTC convention, and #241 can treat the two legs as one timeline without a re-stamping step.

### Survivorship and point-in-time (ticket question 5)

- **Survivorship:** not a live axis. The universe is a fixed two-ticker list of the two assets least likely to delist, and both predate the window on Coinbase.
- **Point-in-time:** crypto has no corporate actions, so there is nothing to restate. Coinbase publishes settled trade prints; the candles for a past day are static. **No `adjustment=raw` equivalent is needed** — this is the one place the crypto leg is *simpler* than equities.
- **Residual PIT risk:** exchange outages. Coinbase has had trading halts; a halt inside a UTC day yields a thin-but-present bar rather than a missing one (confirmed by the zero-gap count — no day is absent). Worth a thin-bar sanity check at ingestion, not a blocker.

---

## Recommendation for #241 (ingestion)

1. **Source crypto daily history from Coinbase Exchange public candles**, paginated in 300-day windows. No key, so no new precondition — combined with #483's equities result, **#241's Polygon API-key precondition is fully removable.**
2. **The seam already exists and needs no new dependency.** `src/market-data-service/sources/ccxt-source.ts` defines `CcxtClient` as a *structural* interface (`fetchOHLCV` / `fetchTicker`) with the client **injected**, and **`ccxt` is not in `package.json`**. A small Coinbase REST client satisfying `CcxtClient`, constructed with `{ source: 'coinbase' }`, drops straight into `CcxtDataSource`.
3. **Use Alpaca crypto as a free price cross-check**, not a source: it is one request for the whole history and agrees with Coinbase to 0.02% median. Diffing the two at ingestion is a near-zero-cost data-quality gate. **Never let its volume column reach `getADV()`.**
4. ⚠️ **Recalibration flag, for #241 not for this ticket:** Coinbase's volume is also *single-venue* — real, continuous, and far larger than Alpaca's, but not consolidated crypto volume. Adopting it changes the liquidity denominator in the cost model's √(size/adv) term relative to whatever the existing calibration (`docs/research/10-cost-model-calibration-2026-08-05.md`) assumed. Worth one look when the crypto backfill lands; not chased here.

### Two defects this ticket found in code that already exists

- 🚩 **`CcxtDataSource.fetchRawCandles` issues exactly one `fetchOHLCV` call** (`ccxt-source.ts:99`) and does not paginate. Against Coinbase that silently caps at 300 bars; against Kraken, 720. It is adequate for the rolling live window it was written for, but **a 5-year backfill through this path will silently return a truncated series** — the same shape of failure as #483's `feed=iex` trap. Backfill needs a paginating path.
- 🚩 **`CcxtSourceOptions.source` defaults to `'kraken'`** (`ccxt-source.ts:74`). Given the confirmed 720-candle cap, that default is a trap for exactly the history use case. Whatever else happens, the backfill path must set `source` explicitly.

Both are implementation findings, recorded here for #241 rather than fixed on a wayfinder ticket.

---

## Probe log

| # | Call | Result |
| --- | --- | --- |
| 1 | Alpaca `v1beta3/crypto/us/bars`, `start=2000-01-01&limit=10000`, BTC+ETH | 200, 2,044 bars each, 2021-01-01→2026-08-06, `next_page_token: null`, 0.98s |
| 2 | Alpaca `loc=global` | `400 {"message":"Invalid location: global"}` |
| 3 | Kraken `OHLC?pair=XBTUSD&interval=1440&since=1420070400` | 200, 721 candles, 2024-08-16→2026-08-06 — cap confirmed |
| 4 | Coinbase candles, 2021→2026 unpaginated | `400 ... exceeds 300` |
| 5 | Coinbase candles, 300-day windows ×7/symbol | 200, 2,044 bars/symbol, 0 gaps, ~3s |
| 6 | Coinbase candles, 2015 / 2016 windows | BTC oldest 2015-07-20; ETH oldest 2016-05-18; 2014-06→2015-03 returns `[]` |
| 7 | Binance `klines?symbol=BTCUSDT&interval=1d&startTime=2014` | 200 from UK IP, 1,000 bars, 2017-08-17→2020-05-12 |
| 8 | `data-api.binance.vision` same call | 200, byte-identical |
| 9 | Yahoo chart `BTC-USD?range=10y` | 200, 3,653 bars, 2016-08-06→2026-08-06 |
| 10 | Tiingo `crypto/prices` no token | `403 {"detail":"Please supply a token"}` |
| 11 | Five-source same-day OHLC comparison, BTC 2025-03-14 | All UTC-midnight aligned, ~0.06% spread |
| 12 | Alpaca vs Coinbase volume, all 2,044 common days | Break at 2023-06-15; per-year ratios 6× → 5,860× |
