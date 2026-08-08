# Market Intelligence Track — Consolidated

**Created:** 2026-08-08 (consolidation). Navigation + summary layer; individual docs remain authoritative (see `README.md`).

## Decision arc

1. **WorldMonitor (ADR-0002) is parked.** `04-worldmonitor-as-mi-source.md` (2026-07-22) recommended integrating it; `13-live-news-sources-and-worldmonitor-value-2026-08-07.md` falsified its premises: the $49.99 tier is MCP-only/Personal (no commercial grant), the SDK/REST access ADR-0002 designed against starts at $99.99/mo, CII is self-declared editorial ("opinionated, not empirical", 8 methodology versions since May 2026), and self-hosting works only over REST (fails open), not MCP (fails closed). Recommendation: stay parked; nothing makes CII newly necessary (v1 warning-only, non-blocking, paper trading doesn't need it).
2. **Deterministic ingestion is the architecture** (`14-mi-layer-alternatives-2026-08-07.md`): decouple retrieval from scoring. The Grok defect is architectural (Nous `chat/completions` cannot retrieve — training-data recall; `grok-agent.ts:240-257` discards everything; the MI store ingests `[]` every refresh). Fix: fetch structured records with stable IDs from deterministic sources, archive raw payloads append-only, optionally score the supplied text with the existing Nous call. Confabulation collapses; `retrievalEvidence` becomes our own fetch log; replayable for backtests.
3. **Source set (v1):** Alpaca News (ticker; stable int64 IDs, url+content, history to 2015, crypto in-band, $0, 200 req/min) + GDELT raw 15-min files (macro; MD5-checksummed archive back to 2015-02-18, redistribution-permitted ToS, $0; the DOC API is disqualified — 20+ min timespan floor, 3-month window, IP blocking) + official calendar spine (BLS ICS, BEA JSON, FOMC, FRED/ALFRED first-prints for surprise computation) + optional RSS fleet (Bloomberg/BBC/CNBC/CoinDesk/CoinTelegraph/Fed/SEC — forward-only, no backfill) + Polymarket prices (already adopted #481, read access unrestricted).
4. **Licensing (primary-source verified, `15-mi-source-licensing`):** Alpaca News **KEEP** (personal/non-commercial clause; no display or derived-data restriction; 30-day notice only if made available to others — single-operator localhost console has no "others"). GDELT **KEEP** — cleanest licence in the set (unlimited commercial, redistribution allowed, citation+link required). **Massive (ex-Polygon) KILL** for news — Businesses ToS derivative-works clause names "investment strategy" over "the Information". **Guardian KILL** — commercial tier explicitly prices "sentiment analysis where content is not reproduced" (our exact use case); feeds are personal/non-commercial. BBC UNVERIFIED (terms page 404), read before use. RSS fleet pushed back, not forward.
5. **One decision for David:** does Samurai count as "commercial" use (private single-user, real-money-for-profit)? On either answer v1 = Alpaca News + GDELT is viable. If "commercial": send Alpaca the 30-day notice (cheap), Guardian already dropped. **Collateral finding:** Massive's derivative-works clause also touches the OHLCV bars already in use as a fallback — flagged, David's call (re-read / written clarification / drop for the Alpaca+Coinbase+Bitstamp stack).
6. **Grok/LLM sentiment stays but is bounded:** scoring over supplied text via existing Nous grok-4.5 call keeps ADR-0009 intact; retrieval evidence = our own fetch record; x_search (X/Twitter sentiment) is the only paid path (~$10-15/14d), login-walled citations, optional.

## Architecture (recommended, from doc 14 §6)

```
tick → fetchers (deterministic, per 15-min bucket):
        A: Alpaca News REST (universe symbols)
        B: GDELT lastupdate.txt → GKG/export filter
        C: calendar spine (BLS/BEA/FOMC/ALFRED, daily)
        D: RSS fleet (guid dedup, own fetched_at)
        E: Polymarket prices (#481)
        → raw archive — NEW SQLite tables, append-only, keyed (source, native_id), stamped ingested_at
        → normalizer → IntelligenceItem (evidence = archive row)
        → (optional, budget-capped) Nous grok-4.5 scores SUPPLIED TEXT → sentiment
        → MarketContext.news / .social → analysts
```

- Backtest replay reads the archive on the same bucket grid — no vendor re-query, no lookahead.
- In-memory `MarketIntelligenceStore` → read-through view over the archive; "restart-clean" in MI spec is obsoleted (needs spec revision + new ADR).
- GDELT transport note: use `https://storage.googleapis.com/data.gdeltproject.org/...` (canonical host fails cert verification — it's a GCS bucket behind a vanity CNAME; plain HTTP lets MITM forge both payloads and their MD5s).
- GDELT signal must be windowed (rolling 1-4h counts/tone), never per-tick point reads (thin/bursty matches).
- Cost: retrieval $0 across all tiers; LLM scoring inside existing $50/14d cap; only x_search is paid (~$10-15/14d).

## Open items (actionable frontier)

1. New ADR if adopted: "MI ingestion decouples retrieval from scoring" (touches ADR-0002, ADR-0009).
2. MI spec revision: restart-clean in-memory store → append-only SQLite archive; `retrievalEvidence` redefined.
3. Wayfinder map before implementation (fetcher set, archive schema, scoring policy, GDELT windowing).
4. Verify before relying: Alpaca/Massive display licensing (dashboard), BLS ICS UID stability, FMP calendar free tier, Polymarket history retention depth.
5. David's ruling: commercial vs personal; Massive OHLCV exposure.
6. GDELT attribution: dashboard footer + docs (acceptance criterion for the fetcher).
