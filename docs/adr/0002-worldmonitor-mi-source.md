# ADR-0002: WorldMonitor as a Market Intelligence source — MIT SDK, no self-host, soft-signal CII

**Status:** Accepted
**Date:** 2026-07-23
**Owner:** David (Deepak)

## Context

[WorldMonitor](https://worldmonitor.app) is a geopolitical/macro intelligence platform (news convergence detection, prediction-market tracking, a per-country instability index) that overlaps and extends Samurai's Market Intelligence layer, which today runs two agents — DeepResearch (professional news) and Grok (social sentiment) — reconciled by a static 2-agent priority-rule Conflict Resolution Engine (`docs/specs/market-intelligence-spec.md`).

The research handoff at [docs/research/archive/2026-07-22-worldmonitor-as-mi-source.md](../research/archive/2026-07-22-worldmonitor-as-mi-source.md) identified two things worth taking from WorldMonitor:

1. **A third intelligence source** — geopolitical/regional signals Samurai's two existing agents don't cover — plus a **Country Instability Index (CII)** the Risk Manager could consume as macro context.
2. **A more sophisticated conflict-resolution algorithm** (`src/services/analysis-core.ts`, read for design purposes only) — n-source convergence, triangulation, and absence signals (market/prediction moving without news) — strictly more capable than Samurai's current 2-agent priority rules.

WorldMonitor's platform code is **AGPL-3.0-only**; its published npm SDK and REST API are **MIT-licensed**. This ADR's central constraint is keeping those two boundaries separate: consume the MIT-licensed access surface, never copy or self-host AGPL platform code.

This ADR synthesizes eight resolved wayfinder tickets on the [Integrate WorldMonitor as Market Intelligence source](https://github.com/dd-jp/samurai-trading-system/issues/169) map. Full detail for each decision lives in its ticket; this ADR gists and links, per wayfinder convention.

## Decision

**Adopt WorldMonitor as a third Market Intelligence source, consumed via its MIT SDK only, with CII as a Risk Manager soft signal — and replace the Conflict Resolution Engine with a generalized N-source convergence engine modeled on WorldMonitor's design.**

### 1. License boundary

Samurai embeds the `worldmonitor` npm SDK (MIT) or its REST API — never the AGPL platform source, never self-hosted. No WorldMonitor server code is copied into Samurai at any point. ([ToS review — #171](https://github.com/dd-jp/samurai-trading-system/issues/171))

### 2. Access tier and polling cadence

**Pro tier ($39.99/mo)**, on the condition that the WorldMonitor adapter polls on its **own decoupled cadence (5–15 min)**, independent of Samurai's trading-tick loop (5s crypto / 30s stocks) — WorldMonitor's own data doesn't change on a trading-tick clock, and per-tick polling would blow through every tier's quota. This also satisfies WorldMonitor's own **One-Shot Hydration** pattern: cache the polled result and serve it stale-tolerant between polls, rather than re-hydrating on every refresh. Real `tools/call` p99 latency is unmeasured (needs a paid key) but non-critical under decoupled polling — revisit only if a future design needs per-tick WorldMonitor queries. ([API quota + latency spike — #170](https://github.com/dd-jp/samurai-trading-system/issues/170))

### 3. ToS clearance

Commercial/trading API consumption is explicitly permitted. The ToS's Intelligence Disclaimer names trading specifically ("don't rely on the Service for trading decisions without independently verifying") — this is satisfied by design, since WorldMonitor enters Samurai only as one of several cross-verified soft signals, never a sole or hard-gating input (see §5, §6 below). ([ToS review — #171](https://github.com/dd-jp/samurai-trading-system/issues/171))

### 4. Single-maintainer risk

WorldMonitor is effectively a single-maintainer project. Mitigated structurally: it is one of three MI sources (degrades gracefully if it goes dormant) and sits behind the same `Agent`-interface abstraction as DeepResearch/Grok, so it can be swapped or dropped without touching downstream code.

### 5. Normalization

WorldMonitor items map cleanly onto Samurai's `IntelligenceItem` shape — confirmed by a throwaway SDK prototype, not just the documented schema. `sentiment` defaults to `0` (WorldMonitor doesn't classify per-item sentiment; Grok's overlay remains the sentiment source). One concrete type change required at implementation time: **`AgentIntelligence.agent_id` widens from `'deepresearch' | 'grok'` to include `'worldmonitor'`** — one uniform ingest path for all three sources, no separate ingest method. ([Prototype — #172](https://github.com/dd-jp/samurai-trading-system/issues/172))

### 6. CII is a soft signal only, not empirically validated

No historical CII time series exists at any WorldMonitor tier (its own trend detection only compares ~24h back) — so a drawdown-correlation backtest is not just unrun, it's **uncomputable** with data that exists today. CII enters the Risk Manager as an unvalidated soft warning, not a scaling input, until Samurai builds its own history. ([Correlation research — #173](https://github.com/dd-jp/samurai-trading-system/issues/173); forward-looking snapshot capture spun out as [#182](https://github.com/dd-jp/samurai-trading-system/issues/182))

CII policy detail (warning-only v1, static instrument→country mapping, advisory `RiskDecision` field, absolute-level trigger, unpinned config threshold, never overrides breakers) is recorded in `docs/specs/risk-manager-spec.md` — see [CII soft-signal policy grilling — #174](https://github.com/dd-jp/samurai-trading-system/issues/174).

### 7. Conflict Resolution Engine → N-source convergence engine (full replacement)

The existing 2-agent priority-rule engine is **replaced wholesale**, not run alongside a shadow copy — the old rules are the N=2 degenerate case of the new engine, which additionally detects n-source convergence, triangulation, and absence signals (prediction-market/market moves with no corresponding news) that the old design can't express. v1 reimplements only the stateless, per-cycle pieces (convergence, triangulation, absence signals, spatial clustering); cross-cycle trend detection is deferred pending a persisted-state design. Full data structures, signal/confidence formulas, and source taxonomy are recorded in `docs/specs/market-intelligence-spec.md`. ([Replace-or-extend grilling — #175](https://github.com/dd-jp/samurai-trading-system/issues/175); [reimplementation scope — #176](https://github.com/dd-jp/samurai-trading-system/issues/176))

### 8. Architecture patterns from WorldMonitor's CONCEPTS.md

Beyond the MI adapter itself, four of WorldMonitor's internal engineering patterns were evaluated against Samurai's broader design:
- **One-Shot Hydration** — already satisfied by the existing Market Data Service two-tier cache design; also the reason for the decoupled-polling requirement in §2 above.
- **The Lever Test** — recorded as a standing evaluation constraint for whenever cache-tier/Redis sizing work is eventually scoped; not itself a decision made now.
- **Shadow Measurement** — adopted, but scoped narrowly to the **broker-adapter switch** (Alpaca→ccxt for crypto, Alpaca→IBKR for stocks), not the paper→live capital graduation decision. Two-phase (replay captured orders first, then dual-submit real-time orders to the candidate's sandbox), gated by metrics-informed manual sign-off, independently per asset class.
- **Deferred-Shell Contract** — minor; applies to the web dashboard's live-updating tables, not the superseded CLI.

Full detail in [architecture-patterns grilling — #177](https://github.com/dd-jp/samurai-trading-system/issues/177). These affect `market-data-service-spec.md` and `execution-spec.md`, not just this MI adapter — actual spec-editing work tracked separately in [#183](https://github.com/dd-jp/samurai-trading-system/issues/183), since it's outside this map's MI-source destination.

## Consequences

**Code changes needed at implementation time** (not made by this ADR — this is a decision record, `/to-tickets` generates the implementation issues):
- New module `server/providers/market-intelligence/worldmonitor-adapter/` (client, normalizer, adapter, cii-consumer + tests).
- New module `server/providers/market-intelligence/convergence-engine/` replacing the existing Conflict Resolution Engine module wholesale (snapshot, signals, clustering, taxonomy + tests).
- `types.ts`: widen `AgentIntelligence.agent_id` to `'deepresearch' | 'grok' | 'worldmonitor'`.
- `RiskDecision` gains an advisory `warnings` / `macro_risk_flag` field for the CII signal.

**Specs updated by this ADR's synthesis:**
- `docs/specs/market-intelligence-spec.md` — WorldMonitor as third MI agent; Conflict Resolution Engine section replaced by the N-source convergence engine.
- `docs/specs/risk-manager-spec.md` — CII soft-signal policy section added.

**Deferred, tracked outside this map:**
- Cross-cycle trend detection reimplementation (needs new persisted, replay-reconstructable state) — future ticket once the stateless convergence engine ships and is proven out.
- CII/drawdown correlation — revisit once [#182](https://github.com/dd-jp/samurai-trading-system/issues/182)'s snapshot capture yields ~90 days of real history.
- Shadow Measurement / Lever Test / Deferred-Shell spec edits to `market-data-service-spec.md` and `execution-spec.md` — [#183](https://github.com/dd-jp/samurai-trading-system/issues/183).

**Superseded:** none — this is additive to the existing Market Intelligence and Risk Manager specs, not a reopening of the closed [Market Intelligence Implementation map (#52)](https://github.com/dd-jp/samurai-trading-system/issues/52).
