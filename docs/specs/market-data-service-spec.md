# Market Data Service Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

The pipeline has four components that all need price data, and each would otherwise reach for it differently: Analysts want historical OHLCV bars plus technical indicators; the Trader wants price, ATR/volatility and indicators for sizing; the Risk Manager wants current marks to compute mark-to-market equity; Verdict wants the current price and its timestamp to gate on staleness/drift. If each fetched and shaped price data itself, three things break at once: analysts would hold rolling state (violating the CONTEXT.md invariant that they are stateless pure functions), indicators would be computed inconsistently and non-reproducibly, and — worst — backtests would leak look-ahead information the moment any consumer touched a data source directly.

The research is unambiguous that this is the single most dangerous class of bug: doc 02 (Stage 1) says to "source point-in-time, survivorship-free data" and to "audit for look-ahead bias like a security vulnerability." A forming candle, a live price read during replay, or an indicator seeded from the wrong history length each manufactures a great backtest and a worthless live result (doc 00 §4). Centralizing all price access behind one clock-scoped service is how that audit is discharged once, for every consumer.

The Market Data Service (Stage 0, parallel to Market Intelligence) is that service. It serves bars, indicators, and marks behind a source abstraction, guarantees point-in-time / survivorship-free / no-lookahead reads via an injected clock, and owns deterministic indicator computation so analysts stay stateless.

## Solution

The Market Data Service is a **deterministic, clock-scoped data layer** (no LLM). An **ingestion** side normalizes crypto (ccxt WebSocket + REST) and stock (IBKR streaming + historical) sources into one persisted representation — an append-only bar cache and an upserted latest-mark table in the shared SQLite state store. A **serving** side answers three read methods (`getBars`, `getIndicator`, `getMark`), each scoped to an `asOf` timestamp resolved from the injected clock, returning only data known at or before `asOf`. Indicators are computed here, deterministically, and cached on an input hash. The same read code path runs live and in replay; the only source-aware branch (live mark-table vs backtest bar-derived mark) lives inside the data source.

*(Amendment 2026-09-10 (#1479): "crypto (ccxt WebSocket + REST) and stock (IBKR streaming + historical)" above is superseded — [#1151](https://github.com/dd-jp/samurai-trading-system/issues/1151) deleted `CcxtDataSource` and `IbkrDataSource` outright (crypto out of scope since ADR-0015's 2026-08-16 amendment; IBKR disqualified on cost, #906). The two vendors this service actually ingests from today are Alpaca (production) and the LSE mark source (kept, unreachable until #895/#1034 provision a vendor). Full restatement: "Amendment (2026-09-10): Source Stack After #1151" at the end of this document.)*

Key architectural decisions:
- **Source abstraction** — consumers see bars/marks/indicators; ccxt/IBKR specifics never leak (mirrors the Broker Abstraction Layer). *(Amendment 2026-09-10 (#1479): ccxt/IBKR were deleted by #1151; the abstraction now hides Alpaca and the LSE mark source instead — same property, different vendors.)*
- **Ingestion/serving split** — unifies 24/7 crypto and market-hours stocks behind one uniform read API.
- **Service-owned, deterministic, cached indicators** — analysts stay stateless.
- **Injected clock, close-time bar filtering** — the load-bearing no-lookahead guarantee.
- **`getMark`-from-bars in backtest** — the live mark table is never read in replay.
- **Two-tier cache** — input-hash response cache + a cheap bulk tier (persisted bars).
- **Staleness via `observed_at`** — the data-observation timestamp Verdict gates on.

## User Stories

### Bars & Indicators (Analysts, Trader)

1. As an Analyst, I want historical OHLCV bars for an instrument over a window as of the current tick, so that I can reason about price without holding rolling state myself.
2. As an Analyst, I want precomputed technical indicators (MA, RSI, etc.) for a window as of the tick, so that I stay a stateless pure function of my inputs.
3. As the Trader, I want price, ATR/volatility, and indicators as of the decision bar, so that my sizing reflects the regime at decision time.
4. As a consumer, I want indicators to be a deterministic pure function of `(instrument, indicator+params, lookback, asOf)`, so that backtest runs are byte-identical and reproducible.
5. As a consumer, I want bars filtered on close time, so that I never see the currently-forming candle and never get look-ahead on its close.

### Marks (Risk, Verdict)

6. As the Risk Manager, I want the current mark (last price) for each open-position instrument, so that the `PortfolioView` mark-to-market and exposure are accurate.
6b. As the Risk Manager, I want a realized-volatility indicator per asset class, so that my volatility-halt circuit breaker has a baseline to compare against.
7. As Verdict, I want the current price plus the timestamp it was observed, so that I can gate on drift and (optionally) reject a stale feed.
8. As Verdict/Risk, I want `getMark` to reflect only data known at `asOf`, so that mark-to-market and drift checks in replay contain no future price.

### Point-in-Time & Survivorship

9. As the system, I want every read scoped to an injected clock's `asOf`, so that live and replay share one code path and replay returns only data timestamped at or before simulated T.
10. As the system, I want the bar store to retain delisted/removed instruments, so that backtests are survivorship-free (never filtered to "instruments that exist today").
11. As the system, I want `getMark` in backtest to derive from the last completed bar, never the live mark table, so that replay cannot inject today's price into a historical mark-to-market.

### Sources & Ingestion

12. As the system, I want crypto (ccxt/Kraken), stock (IBKR), and the MVP Alpaca source hidden behind one `DataSource` port, so that consumers never learn the origin and Kraken→Coinbase (or Alpaca→ccxt/IBKR long-term) is a config change. *(Amendment 2026-09-10 (#1479): the ccxt/Kraken and IBKR arms named above were deleted by #1151 and are not coming back — crypto left scope 2026-08-16 (ADR-0015's amendment), IBKR was disqualified on cost (#906). The current, narrower claim is still true: `AlpacaDataSource` and `LseMarkDataSource` (`kind: 'lse'`) sit behind the same `DataSource` port, `createDataSource`'s `DataSourceConfig` union names both, and adding or swapping a vendor arm is a change to that union, never to a consumer. This is the property `source-factory.ts`'s header cites as "spec user story 12".)*
13. As the system, I want 24/7 crypto streaming and market-hours stock streaming+polling normalized into one representation, so that consumers read uniformly regardless of source cadence.

### Determinism & Caching

14. As a consumer, I want repeat reads within a tick served from an input-hash cache, so that the same query is not recomputed.
15. As the system, I want a cheap bulk tier (persisted bars) for backtest replay, so that reading thousands of sequential bars is cheap and not re-fetched per call.
16. As the system, I want the pinned lookback included in the indicator hash key, so that a recursive indicator (EMA/RSI) can never collide two different-history values under one key.

## Implementation Decisions

### Module: MarketData Serving Core

**Responsibilities**
- Answer `getBars` / `getIndicator` / `getMark`, each scoped to `asOf = clock.now()`.
- Enforce the point-in-time contract (close-time filtering; no data after `asOf`).
- Memoize on input hash; read the persisted bar cache as the bulk tier.
- Delegate source-specific behavior (live mark table vs backtest bar-derived mark, source fetches) to the injected `DataSource`.

**Key Interfaces**

```typescript
// The single test seam. Deterministic given inputs + clock; source is injected.
// Named MarketDataService to match the type the four consumer specs already inject.
interface MarketDataService {
  getBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  getIndicator(instrument: string, spec: IndicatorSpec, asOf: Date): Promise<IndicatorValue>;
  getMark(instrument: string, asOf: Date): Promise<Mark>;
}
// asOf is resolved by the service from the injected Clock (asOf = clock.now()).
// The analyst stays clock-blind: the SERVICE holds the clock; the explicit-asOf
// signature is the deterministic wiring/test form of the same thing.

interface BarWindow {
  timeframe: string;   // '1m' | '5m' | '1h' | '1d' ...
  lookback: number;    // count of bars (or duration) ending at asOf
}

interface Bar {
  instrument: string;
  timeframe: string;
  open_time: Date;     // source-native candle timestamp (period start)
  close_time: Date;    // open_time + timeframe — the point-in-time key
  open: number; high: number; low: number; close: number; volume: number;
  source: string;      // 'alpaca' | 'lse' ... (audit only; consumers ignore)
}

interface IndicatorSpec {
  indicator: string;             // 'sma' | 'ema' | 'rsi' | 'atr' ...
  params: Record<string, number>;
  lookback: number;              // PINNED warm-up length; part of the hash key
}

interface IndicatorValue {
  indicator: string;
  value: number;
  as_of_bar_close: Date;         // close_time of the last bar used
}

interface Mark {
  price: number;
  observed_at: Date;             // when the price was OBSERVED (not the request time):
                                 // last trade/quote time live; last completed bar's
                                 // close_time in backtest.
  source: string;
  asset_class: 'crypto' | 'stocks';
}

// Source abstraction — the ONLY place that knows a vendor's specifics, and
// the ONLY place that branches live vs backtest for marks. Serving/consumer
// path is source-blind.
interface DataSource {
  fetchBars(instrument: string, window: BarWindow, asOf: Date): Promise<Bar[]>;
  fetchMark(instrument: string, asOf: Date, mode: 'live' | 'backtest'): Promise<Mark>;
}
```

*(Amendment 2026-09-10 (#1479): the `Bar.source` example and the `DataSource` comment above previously read `'kraken' | 'ibkr'` / "ccxt/IBKR" — both deleted by #1151. Corrected in place since these are illustrative examples, not decisions; the `Bar` and `DataSource` interfaces themselves are unchanged. Current source values are `'alpaca'` and `'lse'`.)*

### Module: Point-in-Time Enforcement

- **Close-time filter.** `getBars(instrument, window, asOf)` returns only bars with `close_time <= asOf`, where `close_time = open_time + timeframe`. ccxt `fetchOHLCV` and IBKR both timestamp candles at their *open*; ingestion computes and stores `close_time`. A candle for `[t, t+Δ)` becomes visible only at `t+Δ`. The forming candle is never returned as complete. **This is the concrete discharge of doc 02's "audit for look-ahead bias like a security vulnerability."** *(Amendment 2026-09-10 (#1479): ccxt/IBKR are gone — #1151 deleted `CcxtDataSource`/`IbkrDataSource`. Alpaca and the LSE mark source both timestamp candles at open the same way; the close-time-filter invariant above is unchanged and applies to both.)*
- **No data after `asOf`** for any method; never use whole-dataset statistics in preprocessing.
- **Survivorship-free.** The bar store retains delisted instruments; no query filters on present-day existence.
- **Same code path live vs replay.** `asOf` is the only thing that changes; live `asOf = wall-clock now`, replay `asOf = simulated T`.

### Module: Marks (live vs backtest)

- **Live:** `getMark` reads the upserted `latest_mark` row (maintained by WebSocket/poll ingestion); `observed_at` = the last trade/quote time.
- **Backtest:** `getMark(instrument, asOf)` returns `close` of the last completed bar with `close_time <= asOf`; `observed_at` = that bar's `close_time`. The `latest_mark` table (a live artifact holding *today's* price) is **never** read in replay — reading it would inject a future price into Risk's `PortfolioView` (catastrophic lookahead).
- The live/backtest branch lives inside `DataSource.fetchMark(mode)`, so the serving layer and all consumers stay source-blind and mode-blind.

### Module: Indicators (service-owned, deterministic, cached)

- Computed here from the close-time-filtered bar window — never inside analysts (preserves the CONTEXT.md stateless-analyst invariant).
- **Pure function of `(instrument, indicator+params, lookback, asOf)`.** The `lookback` is pinned in `IndicatorSpec` and included in the cache key, because recursive indicators (EMA, RSI, ATR) depend on how far back they are seeded; the same `asOf` seeded from different history lengths diverges. Pinning makes the value — and therefore the hash cache — sound.
- Implemented over a vetted TA computation with fixed rounding; no floating nondeterminism.

### Module: Caching

- **Tier 1 — input-hash response cache.** Key = `hash(instrument, kind, window|spec, asOf)`. Serves repeat reads within a tick (matches the Analysts' "cache on input hash" decision). Deterministic `asOf` makes the key sound; in backtest the same `asOf` legitimately returns the cached value.
- **Tier 2 — cheap bulk tier.** The persisted `bars` table IS the bulk tier: backtest replay reads long sequential bar ranges cheaply from disk instead of recomputing or re-fetching per call. Indicators are memoized on the Tier-1 key.
- **WorldMonitor One-Shot Hydration cross-check (#177 resolution):** this two-tier design already satisfies the pattern — refresh-tick reads hit Tier-1/Tier-2, not the origin API, so there is no boot-hydration miss that silently manufactures origin traffic on every tick. No design change; documented here as a confirmed cross-check, not a new decision.
- **WorldMonitor Lever Test (standing constraint, #177 resolution):** whenever cache-tier/Redis sizing work is eventually scoped (still "not yet decided" — see Future Extensions), evaluate the proposal against egress ≈ origin-miss-count × payload-size before scoping it.

### Module: Ingestion & Sources

**SUPERSEDED 2026-09-10 by #1151 (restated in "Amendment (2026-09-10): Source Stack After #1151" at the end of this document):** the Crypto and Stocks bullets immediately below describe `CcxtDataSource` and `IbkrDataSource`, both deleted by #1151. Kept verbatim as the historical record of what this module originally specced — do not build against them. The current source stack is Alpaca (production) + LSE (kept, unreachable pending a vendor); see the corrected Alpaca bullet below and the Amendment section.

- **Crypto:** ccxt WebSocket (Kraken first; Coinbase Advanced swappable by config) maintains the latest mark and closes bars on period boundaries, 24/7; ccxt REST `fetchOHLCV` backfills history.
- **Stocks:** IBKR TWS streaming during market hours + scheduled historical polling/backfill.
- **Alpaca (MVP, ADR-0001):** a third `DataSource` implementation — Alpaca's market-data API supplies both historical bars (backfill) and streaming quotes/marks for the MVP execution universe (SPY/QQQ/AAPL/TSLA equities + the BTC-USD/ETH-USD pairs Alpaca supports). Alpaca is the first end-to-end path (ADR-0001): MVP paper trading runs Execution's Alpaca `BrokerAdapter` against this `DataSource`, before the longer-term ccxt/IBKR sources are needed. Normalizes into the same `Bar` / `latest_mark` representation as ccxt/IBKR — consumers never learn which source is live. *(Amendment 2026-09-10 (#1479): the ccxt/IBKR sources referenced above never arrived and now never will — #1151 deleted `CcxtDataSource`/`IbkrDataSource` outright (crypto out of scope since ADR-0015's 2026-08-16 amendment; IBKR disqualified on cost, #906). `AlpacaDataSource` is not "the MVP path ahead of" anything any more — with the LSE arm still unreachable pending a vendor (#895/#1034), it is the ONLY production `DataSource` today. It normalizes into the same `Bar`/`latest_mark` representation as `LseMarkDataSource`, its sole remaining sibling.)*
- **LSE (`LseMarkDataSource`, [#734](https://github.com/dd-jp/samurai-trading-system/issues/734)):** the fourth `DataSource` *(Amendment 2026-09-10 (#1479): second, not fourth — #1151 deleted the ccxt and IBKR arms)*, and the only one that serves the instruments Samurai actually holds. Under [ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md) the live equity universe is LSE-listed leveraged ETPs held in a Saxo Capital Markets UK GIA (ADR-0015's 2026-08-30 amendment; this line said "Trading 212 ISA" until [#946](https://github.com/dd-jp/samurai-trading-system/issues/946)), and `universe-selector-spec.md` splits each pool row into a `screening_instrument` (the **US underlying**, whose bars Alpaca serves — screening runs there because [#656](https://github.com/dd-jp/samurai-trading-system/issues/656) established there is no free LSE intraday history) and an `lse_ticker` (what is held and routed). The routing map binds over `lse_ticker` only. This source marks the second object, and refuses the first.

  It normalizes on the **LSE** session calendar, converts pence (`GBX`/`GBp`) to GBP — testing pence *before* pounds, since `'GBp'.toUpperCase() === 'GBP'` and the two differ by 100x — and takes its price from the **quote midpoint**, falling back to last trade only when one side of the book is missing. The midpoint is not a refinement: `docs/research/34-lse-mark-source-options.md` §3.3 measures print gaps exceeding `max_mark_age.stocks` (15 min) on 6 of the 11 pool lines, 65.5% of the session on `3AAP`, so a last-trade mark fails [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) on illiquidity alone regardless of vendor.

  Two refusals are structural rather than documented:

  - An instrument that is not an `lse_ticker` is rejected before any vendor call, and a `screening_instrument` is rejected with an error that names the substitution. **Marking an LSE ETP off its US underlying is not a fallback and must never be introduced as one** — the ETP is leveraged, differently denominated, and trades a different session; the proxy is good enough to *rank* candidates the evening before and nowhere near good enough to value a position or trigger a bracket. (Alpaca's free Basic tier also withholds the most recent ~15 minutes of SIP data, so the proxy could not carry a live mark even if the identity problem did not exist.)
  - A pool row whose declared currency is neither GBP nor a pence sub-unit is refused **at construction**, not on the first live read. Doc 34 §3.2 makes that the majority case — 8 of 11 rows declare `USD` — so this would otherwise be a mid-tick throw arriving after the orchestrator was up and possibly holding a position.

- **The vendor behind that source is an OPEN OWNER DECISION, and the seam is deliberately unfilled.** `LseMarkDataSource` takes its vendor as an injected port (`LseMarkClient`: `getBars`, `getLatestQuote`), and the composition root **refuses to boot** an LSE universe with no client rather than silently routing it to Alpaca. Doc 34 recommends **IBKR "LSE UK (L1)" at ~GBP 1/month non-professional** as the only retail-priced real-time LSE Level 1 feed with bid/ask, and records that **the Trading 212 API cannot serve a mark at all**: it has no quote endpoint, its one price field exists only for already-held instruments and carries no timestamp, and its API Terms 4.2(a) prohibit Algorithmic Trading as §11 defines it. That last point reached past this spec — it was a question about T212 as the execution venue, and [#666](https://github.com/dd-jp/samurai-trading-system/issues/666)'s planned bid/ask sampling on `demo.trading212.com/api/v0` rested on a premise those terms contradicted. [#896](https://github.com/dd-jp/samurai-trading-system/issues/896) (closed 2026-08-27) settled that question: T212 is barred outright and is no longer a candidate venue at all — the live venue is now a Saxo Capital Markets UK GIA (ADR-0015's 2026-08-30 amendment). The T212-specific mechanical facts above (no quote endpoint, no timestamped price field) are unaffected by that and remain part of why T212 was never a mark-vendor candidate either way; the mark-vendor choice itself is still open, tracked as [#895](https://github.com/dd-jp/samurai-trading-system/issues/895).

- Until a vendor is adopted, `latest_mark` still has no producer for `lse_ticker` rows on a live run, so [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) and [#640](https://github.com/dd-jp/samurai-trading-system/issues/640) are exercised **against fixtures only** — never yet against a real LSE mark. [#562](https://github.com/dd-jp/samurai-trading-system/issues/562) remains scoped to live-path failover for **bars** and does not carry this.

- All four sources *(Amendment 2026-09-10 (#1479): two, now — Alpaca and LSE; #1151 deleted the ccxt and IBKR arms)* normalize into the same `Bar` / `latest_mark` representation. The read API is identical across classes; the class difference surfaces only as `observed_at` freshness (a stock mark is legitimately old when the market is closed).

### Module: Persistence

- **`bars`** (instrument, timeframe, open_time, close_time, OHLCV, source) — append-only; the survivorship-free history AND the bulk tier.
- **`latest_mark`** (instrument, price, observed_at, asset_class, source) — one upserted row per instrument; read synchronously by Risk/Verdict. (`asset_class` added per [docs/specs/shared-sqlite-store-spec.md](shared-sqlite-store-spec.md) — the `Mark` interface below already declared it; this bullet had dropped it.)
- Both in the shared SQLite state store (CONTEXT.md Shared State Store). **Trade-off noted:** a high-write bar cache sharing the crash-critical positions DB risks single-writer lock contention; the documented scale valve is a separate SQLite file for the bar cache — not adopted in v1.

## Testing Decisions

### What Makes a Good Test

- Test at the three seam methods with a **mock clock** (drives `asOf`) and a **mock `DataSource`** (feeds fixture bars/marks). No LLM to mock.
- **Point-in-time test (the critical one):** no `getBars`/`getIndicator`/`getMark` call ever returns data with a timestamp > `asOf`; specifically, a bar whose `close_time == asOf` is included but the forming bar (`close_time > asOf`) is excluded.
- **Backtest-mark test:** with `mode: 'backtest'`, `getMark` returns the last completed bar's close and never touches `latest_mark`; assert the live mark table can hold a divergent "today" price without affecting the replay result.
- **Determinism test:** identical `(instrument, window/spec, asOf)` → byte-identical bars + indicator values across repeated calls and fresh instances.
- **Indicator warm-up test:** the same `asOf` with two different `lookback` values yields two distinct cache keys and values (no collision).
- **Survivorship test:** a delisted instrument still returns its historical bars for `asOf` within its listed life.
- **Staleness test:** `Mark.observed_at` equals the observation time (last trade/bar close), not the request time.

### Modules to Test

**Point-in-Time Enforcement** — close-time filtering; no data after `asOf`; survivorship retention.

**Marks** — live reads `latest_mark`; backtest derives from bars and ignores `latest_mark`; `observed_at` correctness.

**Indicators** — determinism; pinned-lookback hashing; correctness vs a reference computation.

**Caching** — Tier-1 hit on repeat within a tick; Tier-2 bulk sequential reads; key soundness under deterministic `asOf`.

### Prior Art

- No implementation yet. The injected-clock / same-code-path-live-vs-replay pattern mirrors the Analysts (#43 no-lookahead), Trader, Risk, and Verdict specs. The `DataSource` port mirrors the Broker Abstraction Layer. The input-hash + cheap-bulk-tier cache reuses the Analysts' decision verbatim.

## Out of Scope

**Market Intelligence** — news/sentiment (the parallel Stage 0 layer); does not serve price. Separate spec.

**Execution / broker order placement** — this service reads market data; it never places orders. Trading broker specifics (partial fills, retries, idempotent order IDs) live in Execution + the broker abstraction.

**Cost model** — spread/commission/market-impact modeling is a Stage 1 measurement-harness concern (doc 02); it consumes marks/bars but is not this service. Exception (cross-spec §OPEN-GAP-A, resolved-with-decision): this service exposes a **best-effort spread estimate** (from bid/ask where the source provides it, e.g. crypto ccxt quotes *(Amendment 2026-09-10 (#1479): ccxt is gone — #1151 deleted `CcxtDataSource`. The only arm implementing `fetchQuote`/bid-ask today is `LseMarkDataSource`, unreachable in production until #895/#1034 provision a vendor; `AlpacaDataSource` does not implement it. `getSpreadEstimate`/`getQuote` therefore return `null` for every production-reachable instrument right now.)*; null otherwise) and an **ADV helper** (aggregated from `bars` volume over the point-in-time window) — both consumed by `CostModel.fill`'s `MarketState`. The cost model owns the fallback spread model for instruments with no bid/ask (e.g. historical stock bars); this service never fabricates a spread it can't observe.

**Portfolio-accounting math** — Risk owns `PortfolioView`; this service only supplies the marks it consumes.

**Indicator/strategy selection** — which indicators an analyst requests is the Analysts' concern; this service computes whatever `IndicatorSpec` it is handed.

**Historical news/sentiment store** — owned by Market Intelligence's backtest work.

**Exact parameters** — timeframes, lookbacks, freshness bounds, retention windows, and cache sizes are config, tuned in paper trading.

## Further Notes

### Integration with Pipeline

```
                        ┌─ Analysts (getBars + getIndicator)
Alpaca / ccxt / IBKR ─►  │─ Trader   (getBars + getIndicator: price, ATR/vol)
      (DataSource)       │─ Risk     (getMark: mark-to-market price; getIndicator: volatility-halt baseline)
        ingestion ─►     └─ Verdict  (getMark: price + observed_at → drift/staleness)
        → bars + latest_mark (shared SQLite)  → serving (clock-scoped reads)
```

*(Amendment 2026-09-10 (#1479): the top-left label above reads "Alpaca / ccxt / IBKR" — #1151 deleted the ccxt and IBKR arms. The current, and only, production `DataSource` is Alpaca; LSE is the second implementation but is not yet reachable pending #895/#1034. Diagram kept as originally drawn per the append-only docs convention.)*

### Domain Glossary Alignment

Per CONTEXT.md:
- **Market Data Service** — "serves price OHLCV plus precomputed technical indicators... Centralizes point-in-time indicator computation so analysts stay stateless." This spec realizes that.
- **Broker Abstraction Layer** — the `DataSource` port applies the same "never mix strategy and source" discipline to data.
- **Shared State Store** — the `bars` + `latest_mark` tables are added here.
- **Portfolio-Accounting View** — consumes `getMark` for mark-to-market.

### Research-Constraint Alignment

The design is verified against docs 00/01/02: **point-in-time** (close-time-filtered `asOf` reads), **survivorship-free** (delisted instruments retained), and **no look-ahead** (forming candle excluded; live mark table never read in replay; whole-dataset stats forbidden). These are the exact Stage 1 harness requirements ("source point-in-time, survivorship-free data"; "audit for look-ahead bias like a security vulnerability") and are preconditions for the honest walk-forward / CPCV / DSR / PBO validation the deployment plan gates on.

### Future Extensions

- Separate SQLite file (or Postgres) for the bar cache if write contention appears (the documented scale valve).
- Additional sources behind the same `DataSource` port (more crypto exchanges; other stock brokers).
- Tick/order-book depth beyond OHLCV+mark, if a strategy family needs it.
- L2/quote-based marks for tighter drift gating.

## Resolved Decisions (Sources)

Wayfinder decisions for this component live in [docs/wayfinder/market-data-service-map.md](../wayfinder/market-data-service-map.md) (charted locally). Decisions synthesized here:

- **Source abstraction** — `DataSource` port hides ccxt/IBKR/Alpaca (mirrors the broker abstraction). *(Amendment 2026-09-10 (#1479): ccxt/IBKR were deleted by #1151; the port now hides Alpaca and LSE.)*
- **Ingestion/serving split** — 24/7 crypto + market-hours stocks normalized to one uniform read API.
- **Service-owned deterministic indicators** — pure function of `(instrument, indicator+params, lookback, asOf)`; analysts stay stateless.
- **Injected clock, close-time bar filtering** — the load-bearing no-lookahead guarantee.
- **`getMark`-from-bars in backtest** — live mark table never read in replay.
- **Two-tier cache** — input-hash response cache + cheap bulk (persisted bars); pinned lookback in the key.
- **Staleness via `observed_at`** — the data-observation timestamp Verdict gates on.
- **Persistence** — `bars` + `latest_mark` in the shared SQLite store (co-location contention trade-off noted).

**Cross-spec requirement:** the `MarketData` interface (`getBars` / `getIndicator` / `getMark`), the `Bar` / `BarWindow` / `IndicatorSpec` / `IndicatorValue` / `Mark` types, and the `bars` + `latest_mark` tables must land in the shared **Domain Types & Contracts** bucket (same bucket as `DebateResult` additions and `OrderIntent.decision_timestamp`). The Analysts, Trader, Risk, and Verdict specs' opaque `MarketDataService` references resolve to this interface. `Mark.observed_at` powers Verdict's **feed-staleness no-go** (`no_go_reason: 'stale_feed'`), which supplements — does not replace — Verdict's `decided_at` signal-age gate (`staleness`; **repointed from `decision_timestamp` to `decided_at` 2026-09-09 by [#1190](https://github.com/dd-jp/samurai-trading-system/issues/1190)** — see `verdict-spec.md`'s gate 1). **No longer optional, and no longer only described here:** [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) built it (`verdict-spec.md`'s `stale_feed` gate, 2a), closing cross-verify CV-6, which recorded that this sentence and the contracts registry had asserted the gate was live across three verification passes while neither the Verdict spec nor the code contained it. The same field also bounds the Risk Manager's valuation marks ([#640](https://github.com/dd-jp/samurai-trading-system/issues/640)) — see `risk-manager-spec.md` "Upstream Read Failure".

**Dependencies:** Alpaca market-data API (MVP source — historical bars + streaming quotes for SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD, per ADR-0001), ccxt + Kraken/Coinbase (long-term crypto source), IBKR TWS (long-term stock source), the shared SQLite state store (bar cache + latest mark). Consumed by Analysts, Trader, Risk, and Verdict. Ingestion connection provisioning (API keys, WebSocket subscriptions) is an ops/setup task, not part of this spec's logic.

*(Amendment 2026-09-10 (#1479): the ccxt + Kraken/Coinbase and IBKR TWS dependencies above are gone — #1151 deleted `CcxtDataSource`/`IbkrDataSource` (crypto out of scope since ADR-0015's 2026-08-16 amendment; IBKR disqualified on cost, #906). Current dependencies: the Alpaca market-data API (production, as above) and, once provisioned, an LSE Level 1 quote vendor for `LseMarkDataSource` (open owner decision, #895; LSEG Delayed Market Data registration, #1034) — see the LSE bullet above and the Amendment section below. The shared SQLite state store dependency and the "ops/setup task, not part of this spec's logic" provisioning clause are unchanged, including for the LSE vendor once one is chosen.)*

## Amendment (2026-09-10): Source Stack After #1151

Per David's 2026-09-08 ruling on [#1151](https://github.com/dd-jp/samurai-trading-system/issues/1151) (merged as [PR #1481](https://github.com/dd-jp/samurai-trading-system/pull/1481), commit `d258bc85`): `CcxtDataSource` and `IbkrDataSource` are **deleted, along with their tests** — crypto left Samurai's scope entirely on 2026-08-16 (ADR-0015's amendment), and IBKR was disqualified as a venue on cost (#906). This section is the append-only restatement the paragraphs above point to; those paragraphs are kept verbatim (per the docs convention) and each carries its own inline pointer here rather than being rewritten in place.

**The surviving source stack is two arms, not four:**

- **`AlpacaDataSource` (`kind: 'alpaca'`) — production, and today the ONLY reachable `DataSource`.** Serves historical bars and streaming quotes/marks for the MVP execution universe. Constructed via `createDataSource({ kind: 'alpaca', client, ... })` (`source-factory.ts`); `production/defaults.ts` resolves it through that factory as of #1151.
- **`LseMarkDataSource` (`kind: 'lse'`) — kept, unreachable in production until a vendor is provisioned.** Serves the LSE-listed leveraged ETPs Samurai actually holds (ADR-0016), normalizing session calendar, pence→GBP conversion, and quote-midpoint marks as described in the (unchanged, still-current) LSE bullet above. The composition root refuses to boot an LSE universe without an injected `LseMarkClient` rather than substituting Alpaca. Two tracking issues remain open: [#895](https://github.com/dd-jp/samurai-trading-system/issues/895) (choose and provision the real-time L1 vendor) and [#1034](https://github.com/dd-jp/samurai-trading-system/issues/1034) (register for LSEG Delayed Market Data) — both are Refs, not Closes, from this document and from #1151/#1481.
- Both arms are constructed exclusively through `createDataSource` (`server/providers/market-data-service/source-factory.ts`), whose `DataSourceConfig` union now carries only `'alpaca'` and `'lse'` as discriminants. Swapping or adding a vendor arm remains a config change to that union — the property user story 12 (above) describes, narrower than originally written but still true.

**What this means for the sections above, concretely:**

- "Source abstraction" (Solution, Key architectural decisions, Resolved Decisions) hides Alpaca/LSE, not ccxt/IBKR/Alpaca.
- The Ingestion & Sources module's Crypto and Stocks bullets describe deleted code; the Alpaca bullet is corrected in place; the LSE bullet is unchanged except its ordinal (second `DataSource`, not fourth) and the total-source count (two, not four).
- The best-effort spread estimate (Out of Scope, Cost model exception) has no crypto/ccxt arm to source bid/ask from any more; `LseMarkDataSource` is the only implementation of `fetchQuote`, and it is unreachable pending #895/#1034 — so `getSpreadEstimate`/`getQuote` return `null` for every production-reachable instrument today. The cost model's fallback spread model (volatility + per-asset-class model) is therefore load-bearing for every live/paper fill until an LSE vendor lands.
- Dependencies: the Alpaca market-data API (built, live) and an LSE Level 1 quote vendor (not yet chosen). No crypto or IBKR dependency remains.

**Not touched by this amendment:** `Mark.asset_class: 'crypto' | 'stocks'` (Key Interfaces) and "more crypto exchanges" (Future Extensions) are stale on the same crypto-out-of-scope grounds (ADR-0015's 2026-08-16 amendment) but predate #1151 and are outside this ticket's scope — left for a future pass. `cross-spec-contracts.md`'s GAP-G ("MDS's `DataSource` port only names ccxt/Kraken + IBKR; no Alpaca `DataSource`") is also pre-existing staleness (Alpaca was added well before #1151) and is left unmarked here for the same reason — resolving it means adjudicating whether to mark that gap FIXED, a separate decision from this restatement.
