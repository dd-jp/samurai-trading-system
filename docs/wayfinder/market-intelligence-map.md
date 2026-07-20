# Wayfinder Map: Market Intelligence (Stage 0)

**Status:** Complete — spec written at [docs/specs/market-intelligence-spec.md](../specs/market-intelligence-spec.md).

> Migrated from GitHub issue #12 (2026-07-13) when wayfinder moved to local docs. Detailed decisions live in the spec; this file is the map index.

## Destination

Design the Market Intelligence stage — the **news/sentiment half** of the Stage 0 data layer. Resolve what data to collect, from where, in what format, how often, where to store it, and how Analysts consume it. (Price/OHLCV + technical indicators are a separate concern — the **Market Data Service**; see [market-data-service-map.md](./market-data-service-map.md) once charted.)

## Decisions so far (resolved frontier)

- **Data sources** — DeepResearch agent (Bloomberg, Reuters, SEC EDGAR, earnings) + Grok agent (Twitter/X, Reddit, Telegram/Discord).
- **Agent output / data contract** — `AgentIntelligence` / `IntelligenceItem` upstream; `MarketContext` / `ConflictResolution` downstream.
- **Data format & schema** — normalized UTC timestamps, asset-class tagging, entity extraction.
- **Update frequency & cadence** — 5s crypto, 30s stocks (market hours), per-source cadence.
- **Storage strategy & retention** — no persistence, restart cleanly, raw feeds ephemeral.
- **API contracts with analysts** — pull (`getContext`) and push (`subscribe`) delivery patterns.
- **Error handling & failure modes** — agent failures handled gracefully (retry/backoff/degrade), system never blocks.
- **Data quality & validation** — schema validation, required fields, value ranges.
- **Conflict resolution** (map-level decision, no dedicated ticket) — DeepResearch wins on high-impact news; Grok wins on viral narratives > 2σ.
- **Backtesting data requirements** (resolved 2026-07-20) — see "Backtesting replay store" decisions below.

## Backtesting replay store (frontier resolution — 2026-07-20)

1. **What gets stored** — both raw agent outputs AND normalized `IntelligenceItem`s. Raw enables re-normalization if the schema evolves; normalized enables fast replay without re-running the normalization pipeline.
2. **Who owns the store** — a new standalone replay service. Records live MI outputs during normal operation; serves historical IntelligenceItems on demand during backtest. Clean separation from the MI layer (which remains persistence-free per its spec).
3. **Capture mechanism** — push. MI writes to the replay store as a sidecar after normalizing each batch. Simple, no gaps. MI gains a write dependency to the external store (acceptable — the store is a separate component MI pushes to, not one it owns).
4. **Storage technology** — SQLite. Consistent with existing architecture (analyst weights, tuning store), single-file, zero new deps, handles the read pattern (point queries by timestamp range).
5. **Replay query interface** — cursor/iterator. The replay service exposes a cursor that pulls IntelligenceItems sequentially as the simulated clock advances. Memory-efficient for long backtests.
6. **Cursor bridging to getContext()** — `ReplayContext` wraps the cursor and implements the same `getContext()` contract the live MI layer exposes. The Orchestrator swaps the live MI backing for a `ReplayContext` when `mode='backtest'`. Same code path preserved — the Analysts layer is unaware whether it's live or replay.
7. **Retention** — fixed 90-day window. Auto-purge old records. Keeps the store small and predictable. Limits backtest horizon to accumulated history (acceptable — the system accumulates over time; older regimes weren't recorded).
8. **What's replayed** — IntelligenceItems only. `MarketContext` is re-assembled on replay, exercising the full MI code path including conflict resolution. A bug in conflict resolution surfaces in backtest. Requires conflict resolution to be deterministic given the same inputs (it is — a function of items + clock).

## Frontier — still open

All frontier decisions resolved. Map complete.

## Out of scope

- Price/OHLCV + technical indicators → Market Data Service (separate Stage 0 component).
- Analyst implementation, Debate Engine coordination, live execution.
