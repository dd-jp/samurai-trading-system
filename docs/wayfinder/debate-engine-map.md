# Wayfinder Map: Debate Engine (Stage 2)

**Status:** Complete — spec written at [docs/specs/debate-engine-spec.md](../specs/debate-engine-spec.md). Implementation epic tracked on GitHub (#40).

> Migrated from GitHub issue #1 (2026-07-13) when wayfinder moved to local docs. The detailed decisions live in the spec; this file is the map index.

## Destination

Design the Debate Engine — mediates conflicting analyst views before the Trader consolidates, producing a conviction-scored synthesis with per-analyst contributions and disagreement summaries.

## Decisions so far (resolved frontier)

- **Agent roles** — Bull/bear/moderator as separate personas, distinct from upstream Analysts.
- **Conviction score** — hybrid algorithm (disagreement inverse + evidence strength).
- **Contribution format** — structured fields + free-text rationale.
- **Upstream contract** — `AnalystView`: direction + confidence + key data points (minimal).
- **Downstream contract** — `DebateResult`: score + contributions + disagreement summary.
- **Round structure** — round-robin (bull → bear → moderator), hybrid termination, max 3 rounds.
- **Disagreement detection** — semantic conflict detection via LLM on free-text rationale.
- **Analyst failure handling** — hybrid timeout with majority quorum (≥50%).
- **State persistence** — none; re-run debates from scratch on crash (pre-trade, no money at risk).
- **Latency budget** — 15s crypto / 60s stocks, hard timeout (terminate early if exceeded).

## Frontier

All decisions resolved. Map complete. See spec for full detail.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

The Trader (Stage 3) consumes `DebateResult` and needs two additions the current contract lacks:

1. **`direction: bullish|bearish|neutral`** on `DebateResult` — a mechanical Trader maps this to order `side`; it cannot parse the free-text `position`. The mediator already determines direction; expose it structurally.
2. **Deterministic `debate_id`** = hash of debate inputs (instrument + bar + AnalystView set), stable across the no-persistence re-run-from-scratch (decision #10). **Load-bearing for THREE consumers** — it is non-optional and must be deterministic:
   - Trader/Verdict provenance.
   - Cosine setup-store join (Trader #45 / Feedback Loop).
   - **Feedback Loop → debate-log attribution join** (FL reads `AnalystContribution[]` from the debate log by `debate_id` at trade close).

Also required for the Feedback Loop: the **debate log** (story 20 — "log every debate… to tune weights in the Feedback Loop") is FL's persistent system-of-record for per-analyst attribution. This is NOT contradictory with the no-persistence decision (#10): operational debate *state* is ephemeral (re-run on crash); the debate *log* is a separate append-only analytics/audit record that IS persisted. The cross-spec pass must state both together.

Impact: **implementation ticket #24 (Domain Types & Contracts)** and the downstream-contract decision must include `direction` + deterministic `debate_id`, and the debate log must persist `AnalystContribution[]` keyed by `debate_id`. See [trader-map.md](./trader-map.md), [feedback-loop-map.md](./feedback-loop-map.md), and the specs' cross-spec notes.

## Out of scope

Analyst stage design, Trader consolidation, Risk management, Feedback Loop, LLM selection/prompt engineering.
