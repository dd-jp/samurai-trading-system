# Market Intelligence Layer Alternatives — Deterministic, Validatable News Ingestion

**Date:** 2026-08-07
**Question (David):** What other ways/options exist for the market-intelligence layer? Come up with a smart solution that fetches current affairs and global news. The Grok solution seems sub-par, non-deterministic, and has no validation.
**Status:** Research finding. Adopting any of it needs a new ADR (touches ADR-0002 and ADR-0009) plus MI spec revision — this document does not change a decision.
**Method:** Three parallel research agents against primary sources (official API docs, live probes from this host, source reads), synthesized with `docs/research/13-live-news-sources-and-worldmonitor-value-2026-08-07.md` (referenced, not redone) and the current code baseline.

---

## 0. Verdict

1. **The Grok defect is architectural, not a model choice.** `NousSentimentClient` calls `chat/completions`, which cannot retrieve — it returns training-data recall. The #485 gate therefore discards every item (`grok-agent.ts:240-257`); the MI store ingests `[]` on every refresh. Swapping models behind the same endpoint fixes nothing.
2. **The smart solution is to decouple retrieval from scoring.** Fetch news as *structured records with stable IDs* from deterministic sources; archive raw payloads append-only; optionally score the *supplied text* with the existing Nous Grok call. Confabulation collapses (the model classifies text it was handed, not recalling), `retrievalEvidence` becomes our own fetch log — first-class true — and the whole layer becomes replayable for backtests. No ADR-0009 exception needed: a search/news key is a data-vendor key like Alpaca or Polygon, not an LLM provider.
3. **Ticker layer: Alpaca News API wins outright** — stable int64 IDs, real URLs + full content, history to 2015, crypto in the same feed, 200 req/min, keys already held, $0. Fallback: Polygon/Massive news (key held, 2y, free per-ticker sentiment with reasoning). Confirms doc 13 §2 with the API surface now verified.
4. **Macro layer: GDELT raw 15-min files are the backbone** — stable IDs, MD5-checksummed archive back to 2015-02-18 (a vendor-side no-lookahead replay store, unique in this space), redistribution-permitted ToS, $0, cadence exactly matching our tick. The GDELT **DOC API is disqualified** (live-verified: >20-min timespan floor, 3-month window, opaque IP blocking).
5. **Official calendar spine is the highest-determinism signal found anywhere:** BLS ICS + BEA JSON release schedules (with times, ~18 months forward), FOMC calendar, FRED/ALFRED vintages with first-print-only output for backtest surprise computation. All free.
6. **Determinism is a property of our ingestion discipline, not of any source.** Every source except GDELT and ALFRED requires our own append-only snapshot store to be replayable. That store must exist in SQLite — the current MI store is an in-memory array (`market-intelligence/index.ts:69`), restart-clean by spec; this research obsoletes that spec choice.
7. **If X/Twitter crowd sentiment is specifically required** (what `source: 'twitter'` promises), the only path is xAI `/v1/responses` + `x_search` — the pre-ADR-0009 client seam (#474/#485 option 3). ~$10–15/14d, but citations are login-walled X URLs: weakly validatable, never replayable. Secondary option, not the primary architecture.

---

## 1. Baseline — what is broken today

- `NousSentimentClient` hard-codes `retrievalEvidence: false` (`nous-sentiment-client.ts:176`) because Nous proxies `chat/completions` only. The header records that the #474 client HAD a working `POST /v1/responses` + `x_search` path before the ADR-0009 single-provider cutover dropped it.
- `GrokAgent.refresh` discards all items without evidence (`grok-agent.ts:240-257`). Measured 2026-08-06: the model natively returns `{"items":[]}` anyway (`nous-config.ts:76-86`).
- Store is a plain in-memory array; no DB table; restart loses everything (spec: restart-clean).
- Net: fundamental and sentiment analysts read empty `news`/`social` on every tick; crypto debates run 1 real analyst of 2, equities 1 of 3.
- Cadence math used throughout: 6 assets × 6 refreshes/day = **36 calls/day = 504 per 14d**.

## 2. Cross-cutting design principle

Archive raw payloads at ingest, keyed `(source, native_id)`, stamped with our own `ingested_at`. Replay reads the archive, never re-queries the vendor. This single decision makes the layer deterministic even when providers revise items (Alpaca items carry `updated_at` and sort by update date — upstream mutation is real). The refresh-bucket grid (`floorToRefreshBucket`, epoch-floored) is already the right replay alignment.

---

## 3. Layer A — Ticker/company news

Verified against primary docs (full detail in agent report; key rows):

| Source | Stable ID | Evidence | Replay | Quota @96/day | Cost | Licensing risk |
|---|---|---|---|---|---|---|
| **Alpaca News** (primary) | ✅ int64 | ✅ url + full content | ✅ to 2015, `created_at` filter | ✅ 200/min | $0, keys held | LOW-MED (beta terms; display seemingly intended) |
| **Polygon/Massive news** (fallback) | ✅ | ✅ `article_url` + per-ticker sentiment with `sentiment_reasoning` | ✅ 2y free, `published_utc.lte` | ✅ 5/min | $0, key held | MED (ToS unread; **updated hourly** — staleness ok for fallback) |
| Finnhub company-news (tertiary) | ✅ | ✅ | ⚠️ 1y free | ✅ 60/min | $0 | MED (news-sentiment endpoint is premium) |
| Marketaux | ✅ uuid | ✅ | ❌ history paid-only | ⚠️ 100/day, no headroom | $0 | MED |
| Alpha Vantage | ❌ none (live-verified) | ✅ | ⚠️ ~2022+ | ❌ 25/day | $0 | LOW |
| Tiingo news | ✅ + `crawlDate` (best PIT semantics) | ✅ | ❌ 3mo free | ✅ | $0 | **FATAL — "Internal Use Only", no display; dashboard exists** |
| NewsAPI.org | — | ✅ | ❌ 1mo | ⚠️ + 24h delay | $0 | **FATAL — license bans production incl. internal** |
| EODHD | ❌ | ✅ | ⚠️ 1y | ❌ one 6-symbol poll ≈ 35 call-units vs 20/day | $0 | MED |

**Alpaca News surface (verified):** `GET https://data.alpaca.markets/v1beta1/news`, same key headers as bars; `symbols=AAPL,TSLA,BTCUSD` (crypto in-band); `start`/`end` RFC-3339; items carry `id` (int64), `headline`, `summary`, `content` (opt-in), `symbols[]`, `source`, `url`, `created_at`/`updated_at`. WebSocket `wss://stream.data.alpaca.markets/v1beta1/news` exists; REST poll per 15-min tick is sufficient at our cadence. History to 2015 (Benzinga wire) gives lookahead-safe backtest replay via `created_at <= t`.

**Open item before wiring dashboard display:** read the Alpaca market-data agreement + Massive ToS for Benzinga display clauses — endpoint docs are silent; the blog's "build custom news widgets" intent is suggestive, not contractual.

---

## 4. Layer B — Macro / global news

### 4.1 GDELT — raw files, not the API

- **DOC 2.0 API: disqualified for production** (live-verified 2026-08-07): `timespan=15min/16min/20min` all return "Timespan is too short"; a ~6-request exploratory burst triggered an IP block still active 30+ min later; searches only a rolling 3-month window (no replay).
- **Raw 15-min files: the actual product.** Poll `http://data.gdeltproject.org/gdeltv2/lastupdate.txt` (three lines: size, md5, url). `masterfilelist.txt` enumerates every batch with MD5 back to `20150218230000` — 11.5 years of checksummed 15-minute files, directly downloadable.
- **Stable IDs and built-in no-lookahead:** Events rows carry `GlobalEventID` + `DATEADDED` = batch timestamp; GKG rows carry `GKGRECORDID` = `<batch>-<counter>` + `DocumentIdentifier` (source URL). A record in file `20260807070000` is exactly "what GDELT knew at 07:00 UTC".
- **Filtering:** GKG `V2Themes` machine-codes `ECON_BITCOIN`, `ECON_INTEREST`, `EPU_POLICY` etc. — structured, not keyword-only. Live sample: English GKG batch = 881 records, 3.8 MB/tick English-only (~360 MB/day). Narrow-topic counts are thin and bursty (2/881 matched `Federal Reserve|bitcoin` in one batch) — **window the signal (rolling 1–4h counts/tone), never per-tick point reads**.
- **Tone (`V2Tone`): frozen-deterministic, not recomputable.** Immutable in the archive (exact replay) but GDELT-internal scoring that drifts across their pipeline versions. Treat as a vendor feature column.
- **ToS:** unlimited commercial use, attribution required, redistribution allowed. $0.
- Web NGrams 3.0 noted and set aside: ~34 GB/day — wrong weight class for the trading MacBook.

### 4.2 Official calendar spine (deterministic scheduled events)

- **BLS ICS** (`bls.gov/schedule/news_release/bls.ics`): VEVENTs with times (US-Eastern), ~18 months forward. Derive own ID from (name, DTSTART); snapshot daily.
- **BEA JSON** (`apps.bea.gov/API/signup/release_dates.json`): ISO-8601 UTC with time, ~18 months forward.
- **FRED/ALFRED** (free key): `series/observations` with `realtime_*` returns data *as known then*; `output_type=4` = **initial prints only** — backtest surprise computation without revision contamination. Gap: release time-of-day not in the API; vintages are date-granular — gate on known release times.
- **FOMC:** HTML calendar page (annual scrape); Fed/BoE/ECB press RSS feeds all live.
- **Dead at $0:** Finnhub calendar (premium now), Trading Economics (no free plan; $199/mo — only replayable-consensus product anywhere), investpy (Cloudflare-dead). **Structural gap: no free consensus/forecast source.** Accept it — event time + actual + prior covers surprise direction via ALFRED first prints.

### 4.3 RSS fleet (forward-only)

Live-verified 2026-08-07: **Bloomberg feeds still public** (`feeds.bloomberg.com/markets/news.rss`, stable story IDs, 8-min-fresh); BBC, Guardian, CNBC (browser UA required), MarketWatch, CoinDesk, CoinTelegraph, Fed, SEC all alive with stable guids. Reuters dead (2020), AP no official RSS, FT alive but 8-item window, Investing.com worst-in-class (no guid, timezone-less pubDate — avoid).

- Dedup key: `(feed_id, guid)`, fallback `(feed_id, sha256(normalized_link))`. Event clock = our `fetched_at` (pubDate is optional and gets rewritten). Zero historical backfill — archive raw XML from day one; backtest history starts at go-live.
- From WorldMonitor's open fleet (`koala73/worldmonitor`): steal the per-feed failure cooldown and the missing-pubDate-excludes-item rule; do **not** copy title-similarity clustering as identity (title edits move cluster identity — anti-deterministic). Their pattern for dead feeds: Google News site-search RSS proxy (`news.google.com/rss/search?q=site:reuters.com+markets+when:1d`).
- ToS gray: syndication feeds, internal non-redistributed signal extraction is ecosystem norm but not affirmatively licensed (Guardian explicitly prices sentiment analysis commercially).

### 4.4 Polymarket (already adopted, #481)

Confirmed keyless read access; Gamma 4,000 req/10s; `/prices-history` takes `startTs`/`endTs` — right replay shape; **new:** batch prices-history endpoint exists; UK geoblock now documented as order-placement-only — read access unrestricted. Caveats stand: retention depth undocumented; snapshot the tracked-market set forward-only.

---

## 5. If an LLM stays in the loop — retrieval-backed options

| Option | Evidence shape | Per-item pub dates | Raw docs storable | Replayable | X sentiment | Gateway | Est. 14d cost |
|---|---|---|---|---|---|---|---|
| **Search API + local scoring** (recommended) | our own fetch log | ✅ | ✅ | ✅ | No | keeps Nous for LLM | **~$0 retrieval + existing token spend** |
| xAI `/v1/responses` + `x_search` | `citations` + `url_citation` annotations | No | No | No | **Yes (only option)** | direct xAI or OpenRouter `/v1/responses`; NOT Nous | $10–15 |
| Perplexity Sonar | `search_results[{url,date,snippet}]` — best structural citations | ✅ | snippets only | partial | No | any HTTP client; NOT Nous | $3–4 |
| Anthropic web_search | citations + `web_search_requests` count | `page_age` | ❌ encrypted | No | No | Claude API; NOT Nous/Bedrock | $8–13 |
| OpenAI web_search | `url_citation` + sources list | No | No | No | No | Responses API | $8–12 |

- **Search retrieval free tiers cover our cadence:** Brave Search API news endpoint ($5 free credit/mo ≥ 504 calls/14d ≈ $2.52), Tavily (1,000 free credits/mo; drop to 5 refreshes/day to stay inside), Exa ($10 free/mo). Bing News API retired 2025-08-11 — off the table.
- **Scoring over supplied text via the existing Nous grok-4.5 chat/completions call** keeps ADR-0009 intact and meters through the existing `llm_spend` `stage: 'market_intelligence'` seam. The #485 gate passes by construction: retrieval evidence is our own fetch record.
- xAI note: old "Live Search" `search_parameters` on chat/completions is no longer documented; the surface is now server-side tools on `/v1/responses` only (`web_search`, `x_search` with `from_date`/`to_date`). $5/1k tool calls + $2/$6 per M tokens on grok-4.5.

---

## 6. Recommended architecture

```
        ┌────────────────────────────────────────────────┐
tick →  │  Fetchers (deterministic, per 15-min bucket)   │
        │  A: Alpaca News REST (universe symbols)        │
        │  B: GDELT lastupdate.txt → GKG/export filter   │
        │  C: Calendar spine (BLS/BEA/FOMC/ALFRED, daily)│
        │  D: RSS fleet (guid dedup, own fetched_at)     │
        │  E: Polymarket prices (already adopted #481)   │
        └───────────────┬────────────────────────────────┘
                        ▼
        raw archive — NEW SQLite tables, append-only,
        keyed (source, native_id), stamped ingested_at
                        ▼
        normalizer → IntelligenceItem (evidence = archive row)
                        ▼  (optional, budget-capped)
        Nous grok-4.5 scores SUPPLIED TEXT → sentiment
                        ▼
        MarketContext.news / .social → analysts
```

- Backtest replay reads the archive (and GDELT's own archive pre-go-live) on the same bucket grid — no vendor re-query, no lookahead.
- The in-memory `MarketIntelligenceStore` becomes a read-through view over the archive; "restart-clean" in the MI spec is obsoleted by this design and needs a spec revision.
- Storage stays SQLite (consistent with ADR-0001 and the market-data answer of 2026-08-07: separate SQLite file is the documented scale valve; Postgres only if multi-process write contention appears).

**Cost summary:** retrieval $0 across all tiers (Alpaca/GDELT/calendars/RSS/Polymarket free; Brave/Tavily inside free credit if search-style queries are wanted). LLM scoring = existing grok-4.5 spend, already inside the $50/14d cap. The only paid path in this document is x_search (~$10–15/14d) — optional, X-crowd signal only.

---

## 7. Follow-ups this document creates

1. **New ADR** if adopted: "MI ingestion decouples retrieval from scoring" — touches ADR-0002 (WorldMonitor stays parked; GDELT+calendars now cover the macro layer better than CII for $0) and ADR-0009 (no exception needed for the primary path; an exception IS needed if x_search is wanted).
2. **MI spec revision:** restart-clean in-memory store → append-only SQLite archive; `retrievalEvidence` redefined as archive-row provenance.
3. **Wayfinder map** before implementation (Standing Pipeline Rule 1): fetcher set, archive schema, scoring policy, GDELT windowing are decisions to grill.
4. **Verify before relying:** Alpaca/Massive display licensing (dashboard); BLS ICS UID stability; FMP calendar free-tier access; Polymarket history retention depth; GDELT DOC API true floor (irrelevant if raw-file path adopted).
5. Doc 13's "Alpaca News is the biggest free win" recommendation is confirmed and now has the verified API surface behind it.
