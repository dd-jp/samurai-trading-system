# Wayfinder Map: Analysts Layer (Stage 1)

**Status:** Complete — spec written at [docs/specs/analysts-spec.md](../specs/analysts-spec.md).

> Migrated from GitHub issue #22 (2026-07-13) when wayfinder moved to local docs. Detailed decisions live in the spec; this file is the map index.

## Destination

Design the Analysts layer — agents that consume Market Intelligence (news/sentiment) and Market Data Service (price/indicators) data and produce trading views (`AnalystView`) for the Debate Engine.

## Decisions so far (resolved frontier)

- **Role definitions & contracts** — primary+context input model (each analyst has a primary data scope plus a fixed context frame, all roles always see contemporaneous price/volume); fixed `AnalystView` output (role detail in free-text `key_points`); parallel-with-applicability-filtering (crypto = Technical + Sentiment; stocks = Technical + Fundamental + Sentiment); latency-tiered LLM usage; overlap allowed (defer to Debate Engine).
- **Failure handling** — role-dependent quorum (Technical + Fundamental mandatory, Sentiment optional); uniform single-retry; skip-the-tick on mandatory hard-block (no stale fallback); alert after 2 consecutive skips.
- **State management** — analysts stateless per tick (pure function of data + weight); rolling features supplied by upstream data services; trivial crash-restart; weights in shared SQLite owned by Feedback Loop, read by orchestrator at tick start, applied downstream in the Debate Engine (analysts weight-blind).
- **Backtesting replay** — same code path live vs replay; no-lookahead via injected clock at the data-service layer; historical store owned by data services (out of scope for analysts); input-hash response cache + cheap tier for bulk; temperature 0 for reproducibility.

## Frontier

All frontier decisions resolved. Map complete.

## Dependencies / out of scope

- **Market Data Service** — new Stage 0 component (OHLCV + indicators) surfaced here; needs its own map. Analysts depend on it, don't build it.
- Historical store for replay — owned by data services (Market Intelligence's is still open).
- Debate Engine mediation, Feedback Loop weight computation, self-learning / online training (excluded).
