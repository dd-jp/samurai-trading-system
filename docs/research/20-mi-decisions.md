# Market intelligence — the settled decisions

**Status:** Consolidated 2026-08-08. The decision layer for the MI track. Architecture detail lives in [`21-mi-ingestion-architecture.md`](21-mi-ingestion-architecture.md), contract terms in [`22-mi-source-licensing.md`](22-mi-source-licensing.md), the Polymarket study in [`23-polymarket-source.md`](23-polymarket-source.md).

## 1. WorldMonitor is parked

ADR-0002 was written against the 2026-07-22 handoff ([archived](archive/2026-07-22-worldmonitor-as-mi-source.md)), which recommended integrating WorldMonitor. The 2026-08-07 pricing and self-hosting research ([archived](archive/2026-08-07-live-news-sources-and-worldmonitor-value.md)) falsified its premises. Current, correct picture:

| Tier | Price | What it grants |
|---|---|---|
| Personal | $39.99/mo | No commercial grant |
| **Pro Business** | **$49.99/mo** | **Commercial grant — but MCP access, not REST/SDK** |
| API Starter | $99.99/mo | REST + SDK — the access shape ADR-0002 designed against |
| API Business | $299.99/mo | REST + redistribution rights |

The $49.99 tier is not missing a commercial grant — it has one. What it lacks is the *access shape* we need. Buying commercial rights at $49.99 still leaves us without REST, so the real entry price for the designed integration is **$99.99/mo**.

Two further corrections to the archived handoff: **CII is self-declared editorial** ("opinionated, not empirical", 8 methodology versions since May 2026), and **self-hosting is viable** — over REST, where the gateway fails open; not over MCP, which fails closed. The handoff's blanket "do NOT self-host" is wrong; self-hosting substitutes for the $99.99 tier, not the $49.99 one.

**Decision: stay parked.** Nothing makes CII newly necessary — it is warning-only and non-blocking in v1, and paper trading does not need it.

## 2. Deterministic ingestion is the architecture

The Grok retrieval defect is architectural, not a bug to patch: Nous `chat/completions` **cannot retrieve**, so it returns training-data recall; `grok-agent.ts:240-257` discards the result; the MI store ingests `[]` on every refresh. A writer exists that writes nothing.

The fix decouples retrieval from scoring — fetch structured records with stable IDs from deterministic sources, archive raw payloads append-only, then optionally score the *supplied text* with the existing Nous call. Confabulation collapses, `retrievalEvidence` becomes our own fetch log, and the whole thing replays for backtests. Full design in [`21-mi-ingestion-architecture.md`](21-mi-ingestion-architecture.md).

## 3. Source set for v1

- **Alpaca News** (ticker layer) — stable int64 IDs, url + content, history to 2015, crypto in-band, 200 req/min, **$0 on keys already held**.
- **GDELT raw 15-minute files** (macro layer) — MD5-checksummed archive back to 2015-02-18, redistribution permitted, $0. The DOC API is disqualified: 20+ minute timespan floor, 3-month window, IP blocking.
- **Official calendar spine** — BLS ICS, BEA JSON, FOMC, FRED/ALFRED first-prints for surprise computation.
- **Optional RSS fleet** — Bloomberg / BBC / CNBC / CoinDesk / CoinTelegraph / Fed / SEC. Forward-only, no backfill.
- **Polymarket prices** — adopted under #481; macro/event markets only. The BTC/ETH price ladders are **rejected**: they are priced off spot, so feeding them to the debate double-counts price.

## 4. Licensing verdicts (primary-source verified)

| Source | Verdict | Basis |
|---|---|---|
| Alpaca News | **KEEP** | T&C define news as licensed Content; no display or derived-data clause; 30-day notice only if made available *to others* |
| GDELT | **KEEP** | Cleanest licence in the set — unlimited commercial, redistribution allowed, citation + link required |
| Massive (ex-Polygon) news | **KILL** | Businesses ToS derivative-works clause enumerates "investment strategy" over "the Information" |
| Guardian | **KILL** | Commercial tier explicitly prices "sentiment analysis where content is not reproduced" — our exact use case |
| BBC | **UNVERIFIED** | Terms page 404s. Read before use |

This supersedes the earlier risk ratings in doc 21, which had Massive at MED and Guardian as usable.

## 5. Grok stays, bounded

LLM sentiment scoring over *supplied text* via the existing Nous grok-4.5 call keeps ADR-0009 intact. Retrieval evidence is our own fetch record. `x_search` (X/Twitter sentiment) is the only paid path at roughly $10–15 per 14 days, with login-walled citations — optional.

Retrieval costs $0 across every tier; LLM scoring fits inside the existing $50/14d cap (ADR-0008).

## Open items

1. **David's ruling: is Samurai "commercial"?** Private single-user, real money, for profit. On either answer v1 (Alpaca News + GDELT) is viable — if commercial, send Alpaca the 30-day notice, and Guardian is already dropped.
2. **Massive's derivative-works clause also touches the OHLCV bars already in live use** as a fallback. The only licensing finding that reaches shipped code. Options: re-read, seek written clarification, or drop Massive for the Alpaca + Coinbase + Bitstamp stack.
3. **New ADR if adopted** — "MI ingestion decouples retrieval from scoring", touching ADR-0002 and ADR-0009.
4. **MI spec revision** — the restart-clean in-memory store becomes an append-only SQLite archive; `retrievalEvidence` redefined.
5. **Wayfinder map before implementation** — fetcher set, archive schema, scoring policy, GDELT windowing.
6. **Verify before relying** — Alpaca/Massive display licensing for the dashboard, BLS ICS UID stability, FMP calendar free tier, Polymarket history retention depth.
7. **GDELT attribution** — dashboard footer plus docs; an acceptance criterion for the fetcher.
