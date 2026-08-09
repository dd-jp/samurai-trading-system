# Polymarket prediction-market odds as a Market Intelligence source

**Research asset for [#481](https://github.com/dd-jp/samurai-trading-system/issues/481)** — *Wayfinder: research — Polymarket prediction-market odds as an Analyst signal source*

- **Date:** 2026-08-06
- **All figures measured live** against the public Polymarket APIs at approximately `2026-08-06T22:56Z`. Prices move; the shape of the findings should outlive the numbers, the numbers themselves should not be quoted later as current.
- **Recommendation: adopt-with-caveats, narrowly scoped.** Ingest **macro/event** markets (Fed decisions, CPI prints, recession) as `type: 'news'` items for the **fundamental** analyst. **Reject** the crypto price-threshold ladders as a Market Intelligence source — they are priced off spot and would double-count price into the debate.

---

## 0. Two premise corrections before anything else

The ticket body was written before two things landed. Both change the question.

**1. Market Intelligence now has a writer.** The ticket says `sentiment-analyst.ts` returns `neutral / confidence 0.05` every tick because the store has no writer in production, citing `production.ts:1163`. That was true when [#436](https://github.com/dd-jp/samurai-trading-system/issues/436) was charted; it is not true now. [#464](https://github.com/dd-jp/samurai-trading-system/issues/464) built `GrokAgent` as the store's writer and `production.ts` wires it (`server/apps/orchestrator/production.ts:1288-1293`, `:1556-1593`), and [#463](https://github.com/dd-jp/samurai-trading-system/issues/463) added `NO_DATA_MARKER` so an empty store no longer reads as a considered neutral view. So Polymarket is a candidate **second** source, not the first one, and map #436's "build one ingestion path" is closed.

**2. There is no `market_intelligence` table, so `agent_id` is not a migration.** The `NousSentimentClient` header states that `source: 'twitter'` and the `grok` agent id "are persisted in `market_intelligence` rows and renaming them is a migration, not a rename." That is not the case. `MarketIntelligenceStore` is explicitly in-memory and restart-clean (`server/providers/market-intelligence/index.ts:69-70`, "No persistence (spec: restart-clean)"), and all 18 migrations define 27 tables, none of them `market_intelligence`. Widening `AgentIntelligence.agent_id` from `'deepresearch' | 'grok'` to include `'polymarket'` is a **type change only**. This materially lowers the integration cost estimated in the ticket.

A third correction, to the ticket's own "Out of scope" reasoning, is in §7.

---

## 1. Coverage and liquidity for the ADR-0001 universe

Method: Gamma `/public-search` per instrument, filtered to `closed == false`, then `/events?slug=` for full market ladders, then CLOB `/book` and `/midpoint` for the near-spot strike. All open-market figures below are USDC.

### Price-direction markets on the universe instruments

| Instrument | Nearest open price market | Horizon | Liquidity | Verdict |
|---|---|---|---|---|
| **BTC-USD** | `Bitcoin above ___ on August 7?` — 11-strike ladder, resolves `2026-08-07T16:00Z` | **17.1 h** | **$437,761** 24h volume, **$765,763** liquidity, spreads **0.001** | **Strong.** Also `What price will Bitcoin hit on August 6?` at 5.1 h, $161,471 24h volume |
| **ETH-USD** | `Ethereum above ___ on August 7?` — 11-strike ladder | **17.1 h** | $122,730 event volume, but per-strike 24h volume only **$100–$1,828**; per-strike liquidity $12k–$22k | **Thin.** The ladder exists; the individual strikes barely trade |
| **SPY** (as SPX) | `S&P 500 (SPX) Up or Down on August 7?` | 21.1 h | **$805 total volume** | **Noise.** Not usable |
| **QQQ** (as NDX) | none open | — | — | **Absent** |
| **AAPL** | none — no price market exists in any form | — | — | **Absent** |
| **TSLA** | none open | — | — | **Absent** |

Notes on the equities. Polymarket tracks the **indices** (SPX, NDX), not the ETFs Samurai trades — a basis question on top of everything else. The daily `Opens Up or Down` SPX series has run at $400k–$1M volume historically, so the series exists and is liquid *on some days*; on the day measured, the single open instance had $805 of volume. NDX had zero open events. For AAPL and TSLA, the only open markets are corporate-event contracts at a ~146-day horizon — `Will Apple release a foldable iPhone before 2027?` ($260,855), `Will Apple release iPhone 18 in 2026?` ($166,273), `Tesla and SpaceX merger officially announced by...?` ($1,020,006), `Will Tesla release Optimus by...?` ($106,214). A TSLA price series has existed before (`What will Tesla (TSLA) hit in November 2025`, $1.79M, closed) but is not running now.

**Coverage conclusion: crypto-only for price, and effectively BTC-only if you require the book to be real.**

### Macro and event markets — where the depth actually is

| Market | Horizon | Liquidity | Spreads |
|---|---|---|---|
| `Fed Decision in September?` (5 outcomes) | 40 d | **$16,397,075** volume, **$2,149,190** liquidity; 24h volume $193,612 / $391,807 / $406,599 on the three live outcomes | **0.001–0.01** |
| `Fed Decision in October?` | 83 d | $471,738 volume, $570,119 liquidity | 0.001–0.01 |
| `Fed Decision in December?` | 125 d | $50,324 volume, $444,290 liquidity | 0.001–0.01 |
| `July Inflation US - Annual` (12 outcomes) | **5.2 d** | $360,897 volume, $173,444 liquidity | 0.006–0.03 |
| `July Inflation US - Monthly` (9 outcomes) | 5.2 d | $150,244 volume, $54,371 liquidity | 0.001+ |
| `Core CPI MoM - July 2026` (7 outcomes) | 5.2 d | $100,294 volume, $53,208 liquidity | 0.001–0.007 |
| `Core CPI YoY - July 2026` (10 outcomes) | 5.2 d | $56,032 volume, $31,926 liquidity | 0.01–0.069 |
| `US recession by end of 2026?` | 177 d | $1,696,962 volume, $37,483 liquidity | 0.01 |
| `Government shutdown by October 1?` | 56 d | $4,123 volume | 0.03 |
| `U.K. Annual Inflation 2026` | 166 d | $43,033 volume | up to **0.298** — unusable |

This is the finding that matters. The macro book is **one to two orders of magnitude deeper** than anything on the universe instruments, with spreads an order of magnitude tighter, and it is exactly the class of input the `fundamental` analyst is missing.

---

## 2. Horizon fit against the analysts' 24 h window

Both consumers read a 24 h context window (`MI_CONTEXT_WINDOW_MS`, `sentiment-analyst.ts:20`, `fundamental-analyst.ts:20`), and the tick is 15 minutes under ADR-0008.

The concern that prediction markets resolve too far out to matter **does not bind**, but for a reason worth stating precisely: the MI window filters on `item.timestamp` — *when the observation was made* — not on when the underlying event resolves (`server/providers/market-intelligence/index.ts:98-125`). An item minted now, carrying a probability about a Fed decision 40 days out, is inside the 24 h window and reaches the debate.

What the horizon **does** determine is which analyst it belongs to. A 40-day-out Fed probability is regime context, not a timing signal. That is `fundamental`'s job (mandatory for stocks, and currently a constant), not `sentiment`'s and not the trader's. Scoped that way the horizon mismatch stops being a defect and becomes the reason for the routing.

---

## 3. Divergence value — the argument against the crypto ladders

This is where the recommendation splits.

The BTC ladder measured at 22:56Z prices as a clean CDF: `P(>$62,000) = 0.986`, `P(>$64,000) = 0.675`, `P(>$66,000) = 0.0225` — roughly 65% of the implied mass in a $64k–$66k band 17 hours out. That is internally coherent and well-arbitraged, which is precisely the problem: **a short-dated binary on an asset's own price is a deterministic function of that asset's spot and its short-dated volatility.** Arbitrageurs price it off the spot market; it does not have independent information about the spot market. Samurai's `technical-analyst` already reads bars for the same instrument. Routing the ladder into MI would present the debate with a restatement of price, dressed as an independent second opinion — and the Debate Engine sizes trades on the appearance of agreement between analysts. Double-counting price is worse than no signal.

One genuine exception, and it does not change the recommendation: the *dispersion* of the ladder is implied volatility, which realized vol from bars does not give you. That is a real addition — but it is a derived price indicator, so it belongs in the Market Data Service alongside the other indicators, not in Market Intelligence as a news or sentiment item. Out of scope here; noted in §8.

The macro markets are different in kind. `P(Fed holds in September)` is not derivable from SPY's price, or BTC's. It aggregates capital-weighted belief about an exogenous event that moves every asset in the universe. That is independent information, and it is the class of thing a fundamental analyst is supposed to weigh.

On the literature: prediction markets are well-established as calibrated aggregators for discrete political and event outcomes (the Iowa Electronic Markets line of work; Wolfers & Zitzewitz, *Prediction Markets*, JEP 2004, is the standard survey for prices-as-probabilities). I did **not** find, and am not claiming, evidence that prediction-market odds beat futures or options as predictors of *asset prices* — and the arbitrage argument above says we should not expect them to for instrument-specific contracts. Treat the adopt case as resting on the macro-input gap, not on a claimed edge.

---

## 4. Data shape → `IntelligenceItem`: four frictions

The ticket asks whether a probability maps cleanly onto the existing contract. **It does not map cleanly.** It maps workably, with a lossy step that must be chosen deliberately.

**(a) `sentiment: 1 | 0 | -1` discards the magnitude.** `IntelligenceItem.sentiment` is a three-valued int (`server/providers/market-intelligence/types.ts:40`). A 0.65 probability collapses to `1` and 0.51 collapses to `1` identically. The magnitude survives only if it is carried in `confidence`.

**(b) The level is the wrong quantity anyway; the *change* is the signal.** A Fed-cut probability parked at 0.485 for a week is not news. A move from 0.485 to 0.30 in a day is. Since CLOB `/prices-history` returns minute-granularity series for free (§5), computing a 24 h delta costs nothing. Proposed mapping:

```
p_now, p_24h_ago  = midpoint of the bullish outcome, now and 24h back
delta             = p_now - p_24h_ago
sentiment         = +1 if delta > 0.02, -1 if delta < -0.02, else 0
confidence        = clamp(|delta| * 5, 0.05, 0.95)      // 0.19 delta saturates
headline          = "Market-implied P(<outcome>) moved 0.485 -> 0.300 in 24h ($406,599 24h volume)"
```

This encodes the news rather than the standing level, avoids restating a static probability as a fresh opinion every tick, and puts the magnitude somewhere it survives.

**Which outcome counts as "bullish" is a human judgment and cannot come from the API.** A Fed cut is bullish for equities and crypto; a hot CPI print is bearish. Each tracked market needs a static annotation in a curated table. That table is the design work of this integration and should be reviewed rather than inferred.

**(c) `directionFrom` is an unweighted mean of signs.** Both analysts average `item.sentiment` across items (`sentiment-analyst.ts:28`, `fundamental-analyst.ts:26`), so three marginally-bullish items at `+1` outvote one overwhelming bearish item at `-1`. With news items this is tolerable because they are many and independent; with a handful of curated macro markets it is a real distortion. **Keep the tracked set small (6–10 series) and prefer one item per *event*, not one per outcome** — the Fed September event has 5 outcome markets, and emitting all five would let one event cast five votes.

**(d) `type: 'news' | 'sentiment'` — use `'news'`.** `getContext` splits on this field: `news` feeds the fundamental analyst, `social` feeds sentiment (`server/providers/market-intelligence/index.ts:118-119`, `fundamental-analyst.ts:66`, `sentiment-analyst.ts:72`). A market-implied macro probability is neither literally, but it is a capital-weighted read on fundamentals, and `fundamental` is the analyst that is both **mandatory for stocks** and currently returning a constant. `'news'` is the right bucket; `source: 'polymarket'`.

**(e) One more, not in the ticket: `getContext` filters by `asset_class`, not by instrument.** `AgentIntelligence` carries `asset_class` on the envelope (`types.ts:25`), and `getContext` filters on it alone. A macro item is relevant to *both* classes, so it must be ingested as two batches — one `crypto`, one `stocks` — or it will only ever reach half the debates. Conversely this means an instrument-specific item would leak across every instrument in its class, which is a second reason not to ingest per-instrument ladders.

---

## 5. Freshness, cadence and cost

Measured latencies, single unauthenticated calls from a UK residential connection:

| Call | Latency |
|---|---|
| Gamma `/events?slug=` | 167 ms |
| CLOB `/midpoint` | 92 ms |
| CLOB `/price` | 80 ms |
| CLOB `/book` | 80 ms |
| CLOB `/prices-history` (`interval=1d, fidelity=1`) | 162 ms, **1,441 points = one per minute** |

Data age: the near-spot BTC strike carried `updatedAt = 2026-08-06T22:52:20Z` against a query at 22:56Z — under 4 minutes. Price-history last points were 0.9–2.9 minutes old. The order book on that strike had 37 bid levels and 29 ask levels, $18,582 bid notional against $111,369 ask notional.

`interval=1w` with `fidelity=1` returns **HTTP 400**; long lookbacks need a coarser fidelity.

**Cost: £0, and no LLM call anywhere in the path.** Zero authentication, no key to provision, no rate to add to `MODEL_RATES`, nothing to meter. This is the sharpest contrast with the Grok path, whose entire design is shaped by ADR-0008's $50/14-day cap.

**It must not write to `llm_spend`.** `GrokAgent`'s spend-metering machinery (`spendCap`, `spendSink`, `stage: 'market_intelligence'`) exists because an LLM call costs money. A Polymarket fetch does not. Copying that scaffolding would put zero-cost rows in the cap's ledger and make the ledger harder to read, not safer.

**Cadence: 1 hour.** The Grok agent's 4 h bucket is derived from cost, not from information (`GROK_REFRESH_MS`, "1/6th of the analysts' 24h window"). Here cost is not the constraint, so pick the interval from staleness instead: a 1 h refresh bounds staleness at 1/24th of the window the analysts read. Published rate limits are Gamma 4,000 req/10 s and CLOB 9,000 req/10 s; with a curated list of 6–10 series, an hourly refresh is roughly 10–20 requests per hour against those ceilings — around four orders of magnitude of headroom. Keep the epoch-relative bucket-floor pattern from `GrokAgent` so replay lands on the same grid.

**A replay caveat worth recording.** `/prices-history` makes a *single market's* probability reconstructible point-in-time, so no-lookahead holds for a known market. But the API offers no as-of query for *which markets existed* on a past date, so the tracked set cannot be reconstructed historically. Backtest replay of this source is therefore partially lossy, which matters for the Backtesting Replay Store in `market-intelligence-spec.md`.

---

## 6. Integration surface

A new lightweight consumer at `src/market-intelligence/polymarket/`, mirroring `GrokAgent`'s shape — thin client for the wire, agent owning cadence and the store write — **minus** `spendCap` and `spendSink`, and plus a curated market table. It slots in as a second writer to the same `MarketIntelligenceStore` instance already constructed in `production.ts:1293`.

No Convergence Engine. The spec names one for merging sources, and with a second source there is now nominally something to merge — but the two write to disjoint buckets (`grok` → `social`, `polymarket` → `news`) and are consumed by different analysts, so there is no conflict to resolve. `MarketContext.conflicts` stays `[]`. State that as a deliberate v1 narrowing, the way #464 did, rather than leaving it implicit.

`agent_id` needs `'polymarket'` added to the union — a type change, no migration (§0).

---

## 7. Failure behaviour — the ticket's stated design is wrong by the repo's own standard

The ticket says: *"failure behavior (market not found → constant, same failure mode as today)."*

Reject that. The whole line of #463 → #474 → [#485](https://github.com/dd-jp/samurai-trading-system/issues/485) establishes that **"we could not look" must stay distinguishable from "we looked and saw nothing"**, and #485 exists precisely because that distinction was lost. Correct behaviour:

- Market not found, fetch failed, or `updatedAt` older than a staleness bound → **do not ingest**. The analysts then hit `NO_DATA_MARKER`, which is honest.
- **Never synthesise a neutral item.** A 0.5 probability written as `sentiment: 0` is indistinguishable downstream from a market that genuinely sits at even odds.
- Port #474's **fail-closed guard** in spirit: ingest only when the response carries evidence of a live market — a non-null `bestBid`/`bestAsk`, a spread inside a configured bound, and 24h volume above a floor. Several markets measured above (`U.K. Annual Inflation 2026` at a 0.298 spread, `Bitcoin ETF Flows` at 0.97) would be correctly rejected by that guard.

---

## 8. Recommendation

**Adopt with caveats, scoped as follows.**

**In scope for a follow-on implementation ticket:**
1. A Polymarket consumer ingesting a **curated set of 6–10 macro/event markets** (Fed decisions, CPI prints, recession) as `type: 'news'`, `source: 'polymarket'`, `agent_id: 'polymarket'`.
2. **24 h probability delta** as the signal, not the level (§4b), with a static per-market bullish-outcome annotation.
3. One item per **event**, not per outcome (§4c).
4. Ingested as two batches, `crypto` and `stocks` (§4e).
5. **1 h cadence**, epoch-floored bucket, no `llm_spend` metering (§5).
6. **Fail-closed**: no ingest on missing market, stale data, wide spread, or thin volume (§7).

**Explicitly rejected:**
- **The BTC/ETH price-threshold ladders as an MI source.** Priced off spot; would double-count price into the debate (§3). This is the recommendation's main negative finding, and it rejects the ticket's own framing of the opportunity.
- **Any equity coverage.** SPY/QQQ/AAPL/TSLA have no usable price markets (§1), and what exists is index-level, creating a basis mismatch on top.

**Out of scope, noted for later:** implied volatility derived from the strike ladder is a genuine addition that bars do not provide, but it is a derived price indicator and belongs in the Market Data Service, not Market Intelligence.

### This is not an answer to #485

[#485](https://github.com/dd-jp/samurai-trading-system/issues/485) is that `source: 'twitter'` items carry model training-recall into trade sizing with nothing searching X. It is tempting to read "free, retrieval-capable, zero-LLM source" as a rescue for that. It is not. Prediction-market odds are a **different signal**, not a crowd-sentiment substitute: adopting this would give `fundamental` a real input while leaving `sentiment` exactly as #485 describes it. #485 still needs its own decision among its three options. Keep the two separate.

### Sizing

One agent session. The bounded pieces are the curated market table (the actual design judgment), the client, the agent with its cadence bucket and fail-closed guard, and the `agent_id` union widening. No key provisioning, no migration, no spend plumbing.
