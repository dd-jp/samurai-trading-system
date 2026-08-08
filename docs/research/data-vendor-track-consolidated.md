# Data Vendor Track — Consolidated

**Created:** 2026-08-08 (consolidation). Navigation + summary; individual docs remain authoritative (see `README.md`).

## Settled stack (2026-08-06, supersedes `03-`'s paid-Polygon recommendation)

| Asset | Primary | Fallback | Source doc |
|---|---|---|---|
| Equities history | **Alpaca free SIP** (`feed=sip&adjustment=raw`, 10.5y true unadjusted daily bars; only most recent 15 min withheld) | Polygon free | `free-equities-ohlcv-2026-08-06.md` |
| Crypto history | **Coinbase Exchange candles** (granularity 86400, paging loop) | Bitstamp | `free-crypto-ohlcv-2026-08-06.md` |
| Execution | Alpaca (paper MVP) | Kraken/Coinbase via ccxt (long-term); IBKR (equities) | ADR-0001 |

**Key corrections recorded in `03-`:** the IEX-only restriction applies to Alpaca's *real-time* feed only — historical SIP data IS served free (probed at 10.5y). Kraken's own OHLC REST endpoint is capped at 720 candles/pair — a hard blocker; ccxt is a pass-through, not a workaround. The Polygon paid-tier recommendation (and #157's $78/mo decision) is overturned by map #482.

## Vendor surfaces (reference)

- **Alpaca** (`alpaca-rest-api-surface-2026-07-29.md`): bars, quotes, crypto; SIP vs IEX; free tier depth.
- **Polygon/Massive** (`polygon-aggregates-api-2026-07-31.md`): aggregates surface; tiered history depth (free 2y, Starter 5y, Dev 10y, Adv 20y+ — pricing facts remain accurate as reference even though no longer driving the decision).
- **⚠️ Licensing caveat** (from `15-mi-source-licensing` §3): Massive's Businesses ToS derivative-works clause names "investment strategy" over "the Information" — attaches to the OHLCV aggregates already in use as fallback. David's call: re-read in full / written clarification / drop Massive bars for the Alpaca+Coinbase+Bitstamp stack already proven at £0.

## Free-stack fallback matrix (`free-ohlcv-fallback-sources-2026-08-06.md`)

Stage 2 now runs entirely on the free stack via `FreeStackAggregatesClient` (`STAGE2_SOURCE=free-stack`, opt-in; Polygon remains default for reproducibility). Verified coverage: SPY/QQQ/AAPL/TSLA 2662 bars each 2016-01-05 → 2026-08-06 (Alpaca); BTC-USD 3870 (Coinbase); ETH-USD 3730 from 2016-05-19 (Coinbase) — ETH's first bar bounds the effective window at 10.2 years. No lookahead: bars fetched once, deduped by open time, sorted ascending (verified reproducible at HEAD, commit `211f425` + review fixes #598).

## Open items

1. Massive OHLCV licensing ruling (collateral finding from MI licensing).
2. If the 12-instrument universe widens: verify free-stack coverage for IWM/EFA/EEM/TLT/IEF/GLD/DBC/VNQ/XLE before trusting the same sources.
