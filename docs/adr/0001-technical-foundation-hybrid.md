# ADR-0001: Technical Foundation — Hybrid (Alpaca/pybroker MVP over a dual-target broker abstraction)

**Status:** Accepted
**Date:** 2026-07-13
**Owner:** David (Deepak)

## Context

Two source-of-truth documents existed and disagreed:

1. **The original vision** — `~/Documents/Obsidian/Ideas/Samurai — Multi-Agent Trading System.md` and `~/trading-system/SAMURAI-HANDOFF.md` (both 2026-07-09). Stocks-first, **paper on Alpaca → live on Freetrade/Trading212**, built by **reusing three existing Python repos** at `~/trading-system/` (`swarm-trader`, `sentient-trader`, `pybroker`), LangGraph + Supabase JSONB + Redis, **pybroker for backtest evaluation only**.
2. **The greenfield brief** the specs were built from — `CLAUDE.md` + `docs/trading-agent-handover.md`. Crypto-first, **Kraken/Coinbase (ccxt) + IBKR**, TypeScript, custom everything, shared SQLite.

The **stage architecture matched** across both (6 stages, adversarial debate, independent risk gate, per-analyst feedback attribution, full audit trail). Only the **technical foundation** (broker, language, rebuild-vs-reuse, backtest engine, state/audit store) had drifted — and the drift was never recorded as a decision. All 6 pipeline stages plus Market Intelligence, Market Data Service, Execution, and the cost-model/backtest harness had already been specced against the greenfield assumptions.

The three base repos and the `/tmp/{swarm,sentient,pybroker}-analysis.md` reports still exist on disk.

## Decision

**Hybrid.** Keep the stage architecture and all existing specs; retarget the technical foundation as follows:

- **MVP path:** **Alpaca paper trading** for execution + **pybroker for backtest evaluation** (eval only — pybroker's `exec_fn` is a synchronous per-bar loop and cannot host seconds-to-minutes LLM debate; verified in the base-repo analysis).
- **Long-term:** **crypto + stocks via ccxt (Kraken/Coinbase) + IBKR**, reached through the **mandatory broker abstraction layer**. The abstraction is **dual-target from day one**: an Alpaca adapter for the MVP and ccxt/IBKR adapters for the long-term path. Strategy/spec code never learns which broker it is talking to.
- **Reuse posture:** **mine the three repos for patterns, no hard dependency.** Fork/adapt useful pieces (swarm-trader Alpaca integration + fan-out, sentient-trader deterministic decision rules + position-sizing/ATR/bracket math + JSONB audit spine, pybroker eval metrics + walkforward split) but do not take a build-time dependency on those codebases.
- **Language:** **TypeScript** (resolved 2026-07-14 — see Open Questions below). No hard dependency on the Python repos follows from the reuse posture above, so there was no cross-language runtime to preserve by choosing Python.
- **State/audit:** keep the **shared SQLite state store** as the spine. The sentient-trader JSONB audit schema is a pattern to mine, not a required Supabase/Redis dependency.

## Consequences

**Specs that need reconciliation (fold into the cross-spec verification pass):**

- **Execution spec / broker abstraction** — must present as **dual-target**: `BrokerAdapter` gains an **Alpaca adapter** (MVP) alongside the already-specced ccxt/IBKR + Simulated adapters. Bracket + OCO semantics must hold on Alpaca (native bracket support) as well as ccxt (emulated).
- **Cost-model / backtest harness spec** — the **backtest/eval engine is pybroker** (mine `src/eval.py` metrics + `src/strategy.py` walkforward), not a fully-custom harness. The **transaction-cost / market-impact model remains ours** (pybroker's fill model is not pessimistic enough for the √-law impact requirement in research principle 2) and is injected into the eval path. Keep the injected-clock / point-in-time / survivorship-free discipline; pybroker is the executor of walkforward/CPCV, our cost model makes its fills honest, and the Feedback Loop owns the live metric cadence.
- **CLAUDE.md Broker Plan** — updated to name Alpaca (MVP) + Freetrade/Trading212 (live-equities future) alongside ccxt/IBKR, all behind the abstraction. Crypto-first-in-paper vs Alpaca-stocks-first is reconciled: **Alpaca paper is the first end-to-end path** (simplest paper setup, the vision's default universe SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD), with ccxt/IBKR bolted on after the architecture is proven.
- **Definition of Done (Paper MVP)** — adopt the vision's 8-point DoD; it is compatible with our specs.

**Preserved:** every stage spec's domain logic, the accumulated cross-spec contracts (`ClosedTrade` defined by Execution; `filled_size`; `MarketDataService` interface; `Mark.observed_at`; `bars`/`latest_mark` tables; `debate_id` load-bearing for three consumers; entry-bracket persistence for R computation), and all research constraints (docs 00/01/02).

## Open Questions — RESOLVED (2026-07-14)

1. **Language: TypeScript core.** The reuse posture is already "mine for patterns, no hard build dependency" — there is no cross-language runtime to preserve by choosing Python. Every spec written so far uses TS interface syntax. David's own background (Lead Web Developer, React/TypeScript) makes TS the path of least friction to actually ship. Python repos remain pattern references only, read during implementation, not imported.
2. **Debate substrate: reimplement, don't depend on LangGraph.** Port the adversarial bull/bear/moderator *pattern* sentient-trader proved out (multi-round, per-analyst contribution tracking) into a TS state machine / lightweight agent-loop — not its LangGraph/Python runtime. Consistent with #1 and the no-hard-dependency reuse posture.

## Superseded documents

This ADR is the canonical technical-foundation decision. It supersedes the conflicting infra choices in:

- `~/Documents/Obsidian/Ideas/Samurai — Multi-Agent Trading System.md` (architecture still valid; infra now per this ADR)
- `~/trading-system/SAMURAI-HANDOFF.md` (same)
- `docs/trading-agent-handover.md` (greenfield-only infra now superseded by the hybrid)
