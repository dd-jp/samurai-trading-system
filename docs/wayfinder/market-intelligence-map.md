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

## Frontier — still open

- **Backtesting data requirements** — historical news/sentiment store + replay service. The live layer is made replay-*compatible* (injected clock) only; the store is a separate concern. This owns the historical store that the Analysts layer's backtest replay depends on. **Not yet resolved.**

## Out of scope

- Price/OHLCV + technical indicators → Market Data Service (separate Stage 0 component).
- Analyst implementation, Debate Engine coordination, live execution.
