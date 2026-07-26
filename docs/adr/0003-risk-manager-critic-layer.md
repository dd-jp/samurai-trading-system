# ADR-0003: Risk Manager gains a single red-team critic — replay-from-log, trim/reject authority

**Status:** Accepted
**Date:** 2026-07-26
**Owner:** David (Deepak)

## Context

[docs/research/05-tradingagents-risk-debate-finding.md](../research/05-tradingagents-risk-debate-finding.md) flagged that TradingAgents (TauricResearch) implements its Risk Management stage as a second LLM debate — three personas (aggressive/neutral/conservative) deliberate before a Portfolio Manager makes the final call. Samurai's Risk Manager (Stage 4) is currently fully mechanical and deterministic: an ordered check pipeline (circuit breakers → per-trade cap → per-asset/asset-class caps → portfolio gross exposure → concentration → min-viable-size) that only trims or hard-rejects, never increases risk (`risk-manager-spec.md`'s monotonic risk-reducing invariant).

This ADR synthesizes the resolved wayfinder ticket [Risk Manager: 3-persona risk debate (advisory) vs mechanical-only — #186](https://github.com/dd-jp/samurai-trading-system/issues/186), grilled against the research finding's five open questions.

**Correction made during grilling:** the finding's framing assumed the concentration check was still static v1 buckets — the actual blind spot it should have cited is narrower. [Risk Manager v2: dynamic correlation-matrix concentration check — #50](https://github.com/dd-jp/samurai-trading-system/issues/50) already shipped (`src/risk-manager/correlation.ts` — point-in-time Pearson correlation over trailing returns), so quantitative correlation risk is already covered. The residual gap is purely narrative/qualitative risk no formula encodes (e.g., several open positions quietly leveraged to the same macro catalyst this week, with no shared price history yet to trip the correlation check).

## Decision

**Add a single red-team risk critic to Stage 4, replay-from-log, with trim-and-hard-reject authority — not a 3-persona debate, not observational-only.**

### 1. Scope of the blind spot

Real but narrow: purely narrative/qualitative risk. Correlation, exposure, and drawdown risk are already covered mechanically (including the #50 dynamic-correlation upgrade) — this layer exists only to catch what those formulas structurally cannot express.

### 2. Determinism shape: replay-from-log, not observational-only

`risk-manager-spec.md` stories 19–20 require the same code path live and in replay, and Stage 2's PBO/DSR/MinBTL statistics are only meaningful if replay is reproducible. A live LLM call inside the replayed path is disqualified outright — this is a determinism constraint, not a cost one. The critic's output is persisted keyed by `debate_id` (already a PK on both `debate_log` and `cosine_setups`, see [Shared SQLite Store — #162](https://github.com/dd-jp/samurai-trading-system/issues/162)); backtests replay the logged output instead of re-calling the LLM. Purely-observational (log-only, never enters the decision path) was considered and rejected — it would defeat the reason to build this at all, since the goal is to catch narrative risk *before* a bad trade ships, not just annotate it afterward.

### 3. Authority: trim + hard-reject

The research finding's own framing ("modulate conviction vs veto") is architecturally unreachable from Stage 4: conviction is produced upstream in the Debate Engine and consumed by the Trader before Risk ever sees the `OrderIntent` — a Stage 4 layer cannot reach backward into Stage 3 without breaking the pipeline's one-directional flow. The actions actually available at Stage 4 are trim, hard-reject, or log-only. Per the monotonic risk-reducing invariant, a veto is the *safe* direction — it's strictly more conservative than a trim, and no different in kind from what a circuit breaker or exposure cap already does. The critic is added as another item in the existing ordered check pipeline with the same authority as the mechanical checks, not a separate gate.

### 4. Persona count: 1 red-team critic, not 3

TradingAgents' three-persona structure earns its cost from adversarial tension between competing viewpoints — but Samurai's Debate Engine (Stage 3) already runs that structure (bull/bear/mediator) upstream. A second full 3-way debate in Stage 4 risks diminishing returns for tripled LLM cost and latency, on top of a blind spot (§1) that's already scoped narrow. One adversarial "what am I missing" pass matches the actual size of the gap. A single critic also keeps the replay-from-log obligation (§2) to one persisted output per gated trade instead of three plus a facilitator synthesis.

### 5. Trigger: every gated trade, single-pass, no rebuttal round

The critic runs on every `OrderIntent` reaching Stage 4, not only ones the mechanical checks already flagged — a crowded-narrative trade can pass every quantitative check cleanly, which is precisely the scenario this layer exists to catch. No rebuttal round: if one adversarial pass doesn't catch the risk, a second round of the same critic arguing with itself is unlikely to either, and reintroducing multi-round cost is what picking 1 critic over 3 personas (§4) was meant to avoid.

## Consequences

- **`risk-manager-spec.md`** gains a new module (working name: risk critic) inserted into the ordered check pipeline, consuming the `OrderIntent` plus a to-be-specced context bundle (market intelligence context, portfolio view), emitting a trim/reject/pass verdict with reasoning text, logged to the shared store keyed by `debate_id`.
- **Cost/latency**: one additional LLM call per gated trade, live and in paper trading. Not incurred during backtest replay (reads the logged output instead).
- **Not yet decided** (deferred to implementation tickets under `/to-tickets`): the critic's exact prompt/context contract, what happens on a critic API failure (fail-open vs fail-closed — likely fail-open given the mechanical checks remain the safety net regardless), and whether/how its verdict is surfaced in the dashboard.
- **Preserved:** the monotonic risk-reducing invariant, the mechanical checks' existing authority and ordering, and the backtest-determinism guarantee (CONTEXT.md; research docs 00/01/02) — the critic never becomes the sizing authority; final size/stop/caps stay computed by the existing deterministic pipeline.

## Superseded / informs

Updates [docs/specs/risk-manager-spec.md](../specs/risk-manager-spec.md) with the resolved answer to the debate-layer question the spec previously left open (via [docs/research/05-tradingagents-risk-debate-finding.md](../research/05-tradingagents-risk-debate-finding.md)).
