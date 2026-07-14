# Wayfinder Map: Market Data Service (Stage 0)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/market-data-service-spec.md](../specs/market-data-service-spec.md).

## Destination

Design the Market Data Service — the Stage 0 data layer, parallel to Market Intelligence, that serves **price OHLCV bars + precomputed technical indicators** and **current/last marks** to the pipeline. It centralizes point-in-time indicator computation so analysts stay stateless, hides which data source (ccxt/Kraken for crypto, IBKR for stocks) is behind it, and guarantees survivorship-free, no-lookahead reads via an injected clock so backtest replay yields only data known before simulated time T. Destination = docs/specs/market-data-service-spec.md.

## Notes

- CONTEXT.md: "A dedicated Stage 0-level data layer, parallel to Market Intelligence, that serves price OHLCV plus precomputed technical indicators (moving averages, RSI, etc.) to analysts... Centralizes point-in-time indicator computation so analysts stay stateless. Needs its own wayfinder map before implementation."
- **Consumers already declared in existing specs** (this design must satisfy all of them; grep confirms the references):
  - **Analysts (Stage 1)** — `market_data: MarketDataService` for historical OHLCV bars + technical indicators; analyst is *clock-blind* (analysts-spec: "no-lookahead is enforced at the data-service layer via an injected clock"). Cache-on-input-hash + cheap bulk tier already decided by Analysts.
  - **Trader (Stage 3)** — `marketData: MarketDataService // price, ATR/vol, indicators (clock-scoped)` (trader-spec story 2). De-facto 4th consumer; served by the same `getBars`/`getIndicator` (ATR/vol is an indicator).
  - **Risk Manager (Stage 4)** — current marks (last price) for the `PortfolioView` mark-to-market (risk-manager-spec: "second consumer of the Market Data Service... its scope must include serving current/last price for mark-to-market, not just indicators"). ALSO consumes a realized-volatility **indicator**: the risk-manager-spec Circuit Breakers module has a per-asset-class *volatility halt* ("realized/implied volatility spikes abnormally above a baseline") whose baseline is not derivable from `PortfolioView` (equity/drawdown/exposure) — it needs `getIndicator`.
  - **Verdict (Stage 5)** — current price + timestamp for the staleness/drift gate (verdict-spec: `marketData: MarketDataService // current price for staleness/drift`).
- Apply research constraints (docs 00/01/02): **point-in-time, survivorship-free, no look-ahead** — Stage 1 of the deployment plan says "Audit for look-ahead bias like a security vulnerability." This service is where that audit is discharged for price data.
- Mirrors the mandatory **Broker Abstraction Layer** philosophy (CONTEXT.md): consumers see bars/marks/indicators; source code sees ccxt/IBKR API calls. Never mix them.

## Decisions so far (resolved frontier)

- **Data-source abstraction (mirrors the broker abstraction).** A `DataSource` port per asset class hides the origin: **crypto** = ccxt WebSocket (Kraken first, Coinbase Advanced swappable by config) for real-time ticker/trades + ccxt REST `fetchOHLCV` for historical backfill; **stocks** = IBKR TWS streaming + IBKR historical bars. Consumers depend only on the `MarketData` interface and never learn the source. Swapping Kraken→Coinbase is a config change, not a code change (techstack.md).

- **Ingestion/serving split unifies 24/7 crypto and market-hours stocks.** A background **ingestion** layer normalizes every source into one persisted representation (bars + latest mark); consumers **read uniformly from the store** via `getBars`/`getMark`/`getIndicator` regardless of source cadence. Crypto ingestion runs 24/7 (WebSocket subscriptions maintaining the latest mark and closing bars on period boundaries); stock ingestion streams during market hours and backfills via scheduled polling. The read API is identical across classes — the difference surfaces only as a data-freshness timestamp on each result (see staleness).

- **Indicators are service-owned, cached, deterministic.** Moving averages, RSI, ATR/volatility, etc. are computed here from the bar series, never inside analysts (preserves the CONTEXT.md invariant that analysts hold no rolling state). Each indicator value is a **pure function of `(instrument, indicator+params, lookback, asOf)`** — deterministic, reproducible across backtest runs. Uses a vetted TA implementation over the same close-time-filtered bar window the analyst would see.

- **Injected clock / point-in-time is the load-bearing decision.** Every read is scoped to an `asOf` timestamp resolved from the injected `Clock` (`asOf = clock.now()`; wall-clock live, simulated T in replay). Same code path live vs replay.
  - **Bars are filtered on CLOSE time, not open time.** ccxt/IBKR timestamp each candle at its *open*; a candle for `[t, t+Δ)` is only complete at `t+Δ`. `getBars(...asOf)` returns bars with `close_time = open_time + timeframe <= asOf`. The currently-forming candle is **never** returned as complete — that is the specific look-ahead hole doc 02 tells us to audit "like a security vulnerability."
  - **No-lookahead:** never return a bar/mark timestamped after `asOf`; never use whole-dataset statistics in preprocessing.
  - **Survivorship-free:** the bar store retains delisted/removed instruments; queries never filter to "instruments that still exist today."

- **`getMark` derives from the bar store in backtest — never the live latest-mark table.** The latest-mark table is a *live* artifact (upserted by WebSocket/poll ingestion; it holds *today's* price). Reading it in replay would inject a live price into a historical mark-to-market — catastrophic lookahead in Risk's `PortfolioView`. Resolution: **live** `getMark` reads the latest-mark table; **backtest** `getMark(instrument, asOf)` returns the close of the last completed bar `<= asOf`, with `observed_at = that bar's close_time`. The branch lives inside the `DataSource`, so the serving/consumer path stays identical ("same code path").

- **Two-tier caching: input-hash response cache + cheap bulk tier.** (a) Hot memoized cache keyed on `hash(instrument, kind, window|indicator+params+lookback, asOf)` for repeat reads within a tick (matches the Analysts' "cache on input hash" decision; deterministic `asOf` makes the key sound). (b) **Cheap bulk tier** = the persisted bar cache in the shared store: backtest replay reads thousands of sequential bars cheaply from disk instead of recomputing/refetching per call. Indicator results are memoized on the same hash. The pinned `lookback` is part of the key so a recursive indicator (EMA/RSI) can't collide two different-history values under one key.

- **Staleness semantics: expose the data-observation timestamp.** `getMark` returns `{ price, observed_at, source, asset_class }` where **`observed_at` is when the price was actually observed** (last trade/quote time, or last completed bar's close in backtest) — NOT the request time. This is exactly the "current price + timestamp" Verdict asked for: Verdict keeps its existing signal-age gate on `OrderIntent.decision_timestamp`, and MAY additionally reject on a stale feed via `observed_at` (e.g. crypto WebSocket dropped, or stock market closed makes a mark legitimately old). `getBars` results similarly carry the latest bar's `close_time`.

- **Persistence: bar cache + latest-mark table in the shared SQLite state store.** Two tables: **`bars`** (instrument, timeframe, open_time, close_time, OHLCV, source) — append-only, the survivorship-free historical store AND the cheap bulk tier; **`latest_mark`** (instrument, price, observed_at, source) — one upserted row per instrument, read synchronously by Risk/Verdict. Co-located with durable trading state per CONTEXT.md's Shared State Store. (Trade-off noted: a high-write bar cache sharing the crash-critical positions DB invites single-writer lock contention; a separate SQLite file for the bar cache is the documented scale valve if contention appears — not adopted in v1.)

- **Output contracts (the single test seam).** One `MarketDataService` interface (named to match the type the four consumer specs already inject), clock-scoped:
  - `getBars(instrument, window, asOf): Bar[]` — Analysts + Trader (close-time-filtered OHLCV).
  - `getIndicator(instrument, spec, asOf): IndicatorValue` — Analysts + Trader (spec pins indicator, params, lookback; ATR/vol is just an indicator) + Risk (volatility-halt baseline).
  - `getMark(instrument, asOf): Mark` — Risk (mark-to-market `price`) + Verdict (`price` + `observed_at`).
  The analyst stays **clock-blind**: the *service* holds/receives the injected `Clock` and resolves `asOf = clock.now()`; the explicit-`asOf` signature is the deterministic wiring/test form. "Clock-blind analyst" and "explicit asOf seam" are the same thing viewed from two sides — not a contradiction.

- **Backtest determinism.** Same code path live vs replay; all reads point-in-time via the injected clock; close-time bar filtering; pinned-lookback indicator hashing; `getMark`-from-bars in backtest. Given identical fixtures + `asOf`, every read is byte-identical across runs — a precondition for honest walk-forward / CPCV distributions (docs 00/01/02).

## Frontier

All frontier decisions resolved. Map complete. See spec for full detail.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

The four consumer specs already declare a `MarketDataService` dependency but treat it as opaque. This map finalizes its shape; the following additions must land in the shared **Domain Types & Contracts** bucket (same bucket as the `DebateResult` / `OrderIntent.decision_timestamp` reconciliations):

1. **`MarketDataService` interface finalized** with `getBars(instrument, window, asOf)`, `getIndicator(instrument, spec, asOf)`, `getMark(instrument, asOf)`. This is the exact type name the Analysts, Trader, Verdict (`marketData: MarketDataService`) and Risk specs already inject — their opaque references resolve to this interface. `window = { timeframe, lookback }` (count of bars or duration); `spec = { indicator, params, lookback }`. **Risk is confirmed a consumer of `getIndicator` as well as `getMark`** (volatility-halt baseline) — the risk-manager-spec Circuit Breakers module requires it.

2. **`Mark` type exposes `observed_at`** (data-observation timestamp), plus `price`, `source`, `asset_class`. Risk uses `price` for mark-to-market; Verdict uses `price` for drift and `observed_at` for an OPTIONAL new **feed-staleness no-go** (`no_go_reason: 'stale_feed'`). Recommended addition to verdict-spec — it does NOT replace Verdict's existing `decision_timestamp` signal-age gate; it adds a data-freshness check using the timestamp Verdict already said it needs ("current price + timestamp").

3. **`Bar` type** = `{ instrument, timeframe, open_time, close_time, open, high, low, close, volume, source }`. Point-in-time contract: consumers receive only bars with `close_time <= asOf`.

4. **Shared State Store schema gains two tables** — `bars` (append-only bar cache + survivorship-free history + bulk tier) and `latest_mark` (upserted current marks). Add to the state-store schema alongside positions/weights/setup-store. Flag the co-location contention trade-off for the state-store owner.

## Out of scope

- **Market Intelligence** (news/sentiment) — the parallel Stage 0 layer; does NOT serve price (CONTEXT.md). Separate map/spec.
- **Execution / broker order placement** — the Market Data Service reads market data; it never places orders. Broker specifics for *trading* live in Execution + the broker abstraction.
- **The cost model** (spread/commission/market-impact) — a separate Stage 1 measurement-harness concern (docs 02); it consumes marks/bars but is not this service.
- **Historical news/sentiment store** — owned by Market Intelligence's backtest work (still open there).
- **Strategy/indicator selection** — which indicators an analyst asks for is the Analysts' concern; this service computes whatever spec it is handed.
- **Portfolio-accounting math** — Risk owns `PortfolioView`; this service only supplies the marks it consumes.
