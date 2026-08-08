# Data vendors — the settled stack

**Status:** Consolidated 2026-08-08. The decision layer. Probe evidence lives in [`31-free-ohlcv-evidence.md`](31-free-ohlcv-evidence.md), endpoint detail in [`32-vendor-api-reference.md`](32-vendor-api-reference.md).

**The whole historical-data stack runs at £0.** This supersedes the paid-Polygon recommendation and the $78/mo decision built on it (#157, overturned by map #482).

## The stack

| Asset | Primary | Fallback | Cost |
|---|---|---|---|
| Equities history | **Alpaca free Basic**, `feed=sip&adjustment=raw` — 10.5y of true unadjusted daily bars, only the most recent 15 min withheld | Polygon free tier, `adjusted=false` | £0 |
| Crypto history | **Coinbase Exchange candles**, granularity 86400 with a paging loop | Bitstamp `/api/v2/ohlc` | £0 |
| Execution | Alpaca (paper MVP) | ccxt → Kraken/Coinbase; IBKR for equities (ADR-0001) | — |

Verified coverage: SPY/QQQ/AAPL/TSLA **2662 bars each, 2016-01-04 → 2026-08-05**; BTC-USD 3870 from 2015-07-20; ETH-USD **3730 from 2016-05-18**. ETH's first bar is what bounds the effective common window at **10.2 years**. Stage 2 runs on this stack via `FreeStackAggregatesClient` (`STAGE2_SOURCE=free-stack`, opt-in; Polygon stays default for reproducibility). No lookahead — bars fetched once, deduped by open time, sorted ascending.

## The premise that cost us

**#157's equities decision rested on a false premise: that Alpaca's free tier is IEX-only.** That restriction applies to the *real-time* feed only. Historical SIP data **is** served on the free Basic tier, probed at 10.5 years of true unadjusted daily bars. The trap is that `feed=iex` does not error — it silently returns a shallow ~5-year archive. Pin `feed=sip`.

Second correction: **Kraken's OHLC endpoint is hard-capped at 720 candles per pair.** ccxt is a pass-through, not a workaround.

## Polygon paid tiers — kept as reference only

Free 2 years EOD at 5 calls/min; Starter 5 years (15-min delayed); higher tiers 10 and 20+ years. These facts remain accurate; they simply no longer drive a decision. Polygon's role is now the equities *fallback*, on the free key already provisioned.

> ⚠️ **That fallback role has a hard dependency.** Polygon-free is only valid in an increment-only capacity, which requires the persistent-`dbPath` and skip-covered-window fix. **That fix does not exist yet** — `run-stage2.ts` passes no `dbPath`, so the store is `:memory:`. Until it lands, equities failover is wrong.

## Licensing exposure

⚠️ Massive's (ex-Polygon) Businesses ToS carries a derivative-works clause enumerating "investment strategy" over "the Information", and it attaches to **the OHLCV aggregates already in live use as the equities fallback**. This is the only licensing finding that reaches shipped code. David's call: re-read in full, seek written clarification, or drop Massive bars for the Alpaca + Coinbase + Bitstamp stack already proven at £0. See [`22-mi-source-licensing.md`](22-mi-source-licensing.md) §3.

## Open items

1. **Massive OHLCV licensing ruling** (above).
2. **The persistent-`dbPath` fix** before relying on Polygon failover.
3. **If the universe widens to 12**, verify free-stack coverage for IWM/EFA/EEM/TLT/IEF/GLD/DBC/VNQ/XLE before trusting the same sources.
