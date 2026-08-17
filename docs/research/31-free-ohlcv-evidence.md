# Free OHLCV — the probe evidence

**Status:** Consolidated 2026-08-08 from three probe studies run 2026-08-06 against live endpoints (#483 equities, #484 crypto, #487 fallbacks). Originals preserved verbatim: [equities](archive/2026-08-06-free-equities-ohlcv.md), [crypto](archive/2026-08-06-free-crypto-ohlcv.md), [fallbacks](archive/2026-08-06-free-ohlcv-fallback-sources.md).

Decisions drawn from this evidence are in [`30-data-vendor-decisions.md`](30-data-vendor-decisions.md). This document is the evidence itself.

## Equities primary — Alpaca free Basic

**`feed=sip&adjustment=raw` returns 2662 daily bars, 2016-01-04 → 2026-08-05, in a single request.**

- **The IEX objection applies to real-time only.** Historical SIP is served on the free tier, with only the most recent 15 minutes withheld.
- **The trap:** `feed=iex` does not error. It silently returns a shallow ~5-year archive. IEX carries roughly 1.5–2% of consolidated volume, so it is also a materially thinner tape. Pin `feed=sip`.
- **Point-in-time proven** on TSLA's 3:1 split: `adjustment=raw` returns 890.91 where `adjustment=all` returns 296.97. Raw is what an append-only cache needs.
- ⚠️ **Precondition:** confirm the Alpaca dashboard shows the Basic plan. No endpoint reports the plan name, so this cannot be asserted programmatically.

**Rejected for equities:** Tiingo — "Internal Use Only" licence plus 50 req/hr; Alpha Vantage — 25 requests/day; EODHD — 20/day; Stooq — bot-walled.

## Crypto primary — Coinbase Exchange candles

**No key, no account. BTC-USD back to 2015-07-20, ETH-USD to 2016-05-18.**

- **300-candle cap per request** — it *errors* rather than truncating, so a paging loop is mandatory but a silent short read is not a risk.
- **Array order is `[time, low, high, open, close, volume]` — not OHLC.** Misreading this transposes low and open.

**Alpaca crypto is rejected**, and the reason matters: its volume column has a **~600× structural break on 2023-06-15**. Feeding that to `getADV()` inflates market-impact estimates by up to ~77×, and the pre-break half is itself 6–13× under. A cost model built on it would be wrong in both directions across the sample.

**Also rejected:** Kraken — hard cap of ~720 candles per pair (probed at 721), which no ccxt wrapper works around; Binance — quotes USDT, the wrong instrument for a USD book.

**Two code defects found during probing:** `ccxt-source.ts` does not paginate, and `CcxtSourceOptions.source` defaults to `'kraken'` — the capped venue.

## Fallbacks

**Crypto → Bitstamp.** `btcusd` back to 2011-08-18, `ethusd` to 2017-08-16, zero gaps over the window, 1000 bars per request, and — unlike Alpaca — no volume regime break.

**Equities → Polygon free.** Key already provisioned. `adjusted=false` matches Alpaca's `raw` exactly: **max |close difference| = 0.0000 across 128 shared bars on all four tickers.** Volume is not identical — ratios run 0.918–1.001, which propagates to roughly an 8% ADV shift and a ~4% cost-model shift. Acceptable for a fallback, not for a primary.

> **Hard dependency.** Polygon-free is 2 years deep at 5 calls/min, so it is only valid in an **increment-only** role. That requires the persistent-`dbPath` and skip-covered-window behaviour, which **does not exist yet** — `run-stage2.ts` passes no `dbPath`, leaving the store `:memory:`. Until that lands, equities failover produces wrong results rather than degraded ones.

### Two probes #562 added (2026-08-17, live endpoints, SPY)

Both were named as unverified by #560/#562 and both are now answered. Run against the live Alpaca and Polygon APIs while wiring the live orchestrator's failover.

- **EST (winter) daily stamping AGREES.** 2026-01-05 → 2026-01-09, `1Day`, `adjustment=raw` / `adjusted=false`: Alpaca and Polygon both stamp every bar at **05:00Z** — 00:00 ET, i.e. both anchor a daily bar to ET midnight and both follow the DST shift (the earlier EDT sample was 04:00Z on both). So the `(instrument, timeframe, open_time)` primary key cannot take the same trading day as two rows across the vendor boundary in either season, and `getADV()` cannot double-count. Volume matched **exactly** on four of the five days and differed by 0.24% on the fifth (Alpaca lower on that day) — well inside the ~8% worst case recorded above.
- **Polygon free tier DOES serve hourly aggregates.** `range/1/hour`, 2026-08-10 → 2026-08-14: 80 bars, HTTP 200, no tier error. This mattered because the live tick path runs on `1h` bars — an equities fallback that could not serve them would be inert for the timeframe that matters. ⚠️ **Caveat, unresolved:** Polygon's hourly series runs 08:00Z–23:00Z, i.e. it **includes extended-hours bars**, where Alpaca's `1h` bars on the configured feed do not. So a fallback-served `1h` window can carry pre/post-market bars an Alpaca-served window would not. Detectable after the fact (`bars.source`) and not corrected anywhere today.

**Rejected as fallbacks:** CoinGecko — fails three ways (365-day window, 4-day granularity beyond it, and no volume column at all); Gemini — 1 year; TradingView — not a data source; **Yahoo — split-adjusted**, which breaks append-only caching. The Yahoo defect was found twice independently, on TSLA's 3:1 and AAPL's 4:1.

## What the exercise actually changed

Depth stopped being the discriminator. Every serious candidate has enough history; they separate on **licence, point-in-time correctness, and volume integrity** instead. The two disqualifications that mattered — Tiingo and Yahoo — were a licence clause and a corporate-action policy, not a data limit. The one that nearly slipped through — Alpaca crypto — had ten years of bars and a broken volume column.
