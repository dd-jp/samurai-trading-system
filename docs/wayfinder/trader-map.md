# Wayfinder Map: Trader (Stage 3)

**Status:** Complete — all 6 frontier decisions resolved. Spec: [docs/specs/trader-spec.md](../specs/trader-spec.md).

> Migrated from GitHub issue #27 (2026-07-13) when wayfinder moved to local docs. All Trader grilling is now local.

## Destination

Design the Trader layer — consumes the Debate Engine's `DebateResult` and emits a full order intent (bracket) for the Risk Manager to vet/modify.

## Notes

- Upstream: Debate Engine `DebateResult` (synthesis, position, confidence, contributions, disagreement_summary, open_items, converged, rounds_completed, latency_ms). See [debate-engine-spec.md](../specs/debate-engine-spec.md).
- Downstream: Risk Manager (Stage 4) vets/modifies the order intent.
- Grill one question at a time; wayfinder produces decisions, not code.

## Decisions so far

### Destination-level

- **Output = full order intent (bracket).** Fully-specified order (instrument, side, size, entry/limit, stop, target, TIF). Risk vets/modifies. Matches CONTEXT.md ("proposes a concrete action").
- **Architecture = mechanical backbone + cosine-similarity retrieval; NO Trader-side LLM.** LLM reasoning is already spent in the Debate Engine; a Trader LLM would duplicate it and re-add nondeterminism. The Trader is fully deterministic given its setup store — ideal for backtesting/PBO.
- **Sizing = conviction-scaled fractional risk with a volatility floor, never full Kelly.**
- **Scope = entries + exits as attached brackets.** On entry the Trader emits the full bracket; exits are mechanical (stop/target hit) or a later debate flipping direction. No separate continuous "should I exit?" loop.

### Resolved frontier

- **Order-intent contract to Risk (was #47).**
  - Single bracket object; the broker-abstraction layer expands it to broker-native multi-leg orders (OCO on Kraken, bracket on IBKR) at Execution — contract stays broker-agnostic.
  - Trader assigns a **deterministic idempotency key** = hash(`debate_id` + instrument + bar/timestamp). Same debate → same key → crash-restart/replay dedupes to one order (CONTEXT.md idempotency). Execution uses it as the idempotent order ID.
  - Intent carries **full metadata**: order fields + provenance (`debate_id`, conviction, `converged`) + sizing decomposition (base risk fraction, conviction multiplier, vol-floor factor, cosine multiplier) + cosine precedent summary (neighbor count + aggregate win/loss, or "no precedent" flag).

- **Position & portfolio state ownership (was #48).**
  - **Shared persistent SQLite position store**, reconciled against the broker as source of truth, readable by all stages, Execution writes fills. Can be the same DB as analyst weights (#42, Analysts). Satisfies crash-restart-must-not-lose-positions invariant.
  - Trader is **position-aware**, reconciling new debate direction vs current holding: no position → entry; holding same direction → hold or bounded scale-in (bound = exposure caps); holding opposite → exit/flip; holding + neutral/`converged:false` → hold, maybe tighten stop. Re-debating is the Debate Engine's job.

- **Position sizing formula (was #46).**
  - Conviction → risk: **threshold-gated linear** — no entry below a conviction floor (~0.5–0.6); above it, base risk scales linearly to a hard `max_risk_per_trade` cap at conviction 1.0.
  - Volatility: **risk-based sizing off an ATR stop with a vol floor** — `stop_distance = k × max(ATR, vol_floor)`; `size = (equity × risk_fraction) / stop_distance`. Higher vol → wider stop → smaller size automatically; `vol_floor` prevents absurd sizing in ultra-low vol.
  - Caps: Trader enforces **only its per-trade `max_risk_per_trade` bound + the cosine multiplier bound (0.5×–1.5×)**. Portfolio + asset-class exposure caps and drawdown circuit breakers belong to the **Risk Manager (Stage 4)** — no duplication.
  - **Asset-class risk scaling (from research docs 00/01/02):** `max_risk_per_trade` is scaled down for fat-tailed markets — **crypto sized more conservatively than stocks** (research: quarter-Kelly-or-less for fat-tailed markets). Same conviction → smaller crypto position. Multipliers are config.

- **Non-converged debate policy (was #44).**
  - `converged: false` → apply a fixed size **haircut** (e.g. 0.5×), *and still* enforce the conviction floor. A non-converged debate with mediocre conviction falls below the floor and is skipped; a non-converged-but-high-conviction one trades small. Caution is expressed via size, not a binary skip (the Debate Engine deliberately surfaces `open_items` rather than blocking).
  - **All downward adjustments stack multiplicatively**: `size = base_risk(conviction) × non_converged_haircut × cosine_multiplier` (via ATR sizing). If the result falls below a **minimum-viable-position** threshold (min notional / min risk, respecting broker minimum order size), the Trader **skips the trade** rather than placing a dust order. No arbitrary cap on total reduction — "too many strikes" naturally resolves to no-trade.

- **Cosine-similarity retrieval design (was #45).**
  - **Setup vector = both combined:** debate features (conviction, direction, `converged`, disagreement magnitude) + market-regime features (volatility bucket, trend, key indicator values at decision time). Matching captures "this kind of debate in this kind of market."
  - **Store owned by the Feedback Loop (Stage 6)** — it already computes post-execution outcomes. The Trader writes the setup vector at decision time and reads neighbors at decision time; it does not own the store. Part of the shared SQLite store family (#48).
  - **Outcome label = R-multiple** (realized PnL ÷ initial risk), not binary win/loss — richer and directly usable to weight neighbors.
  - **Retrieval:** k nearest by cosine similarity, restricted to setups **above a minimum similarity threshold** AND whose trades have **already closed with a known outcome as of the injected clock** (point-in-time; a still-open setup has no R label yet — no lookahead).
  - **Multiplier:** `cosine_multiplier` (bounded 0.5×–1.5×) = function of the similarity-weighted mean R of those neighbors — positive → toward 1.5×, negative → toward 0.5×, near-zero → 1.0×.
  - **No close neighbor** (fewer than a min count above the threshold) → default **0.75×** and set the "no precedent" flag in the intent metadata (Risk sees it). Not an auto-skip — the multiplicative min-viable-size rule (#44) handles compounding.

- **Backtest determinism (was #49).**
  - The Trader is already fully deterministic (mechanical + cosine, no LLM). **Same code path live vs replay**, differing only in the data/clock source.
  - The cosine store is queried **point-in-time via the injected clock** (only setups closed with known outcomes at simulated time T — enforced by the #45 retrieval rule), reusing the #43 no-lookahead discipline.
  - **Warm-up period:** early in a backtest (or live cold-start) the setup store is empty/sparse, so most decisions hit the "no precedent" 0.75× default. This is acceptable and honest; no special-casing needed. (Optionally exclude the warm-up window from performance stats when evaluating the cosine contribution.)

## Cross-spec reconciliation required (flag for the all-specs verification pass)

The Trader consumes `DebateResult` but the **current** Debate Engine contract is missing two fields a mechanical (no-LLM) Trader needs:

1. **`direction: bullish|bearish|neutral`** on `DebateResult` — the structured signal the Trader maps to `side`. Free-text `position` would require an LLM to parse.
2. **Deterministic `debate_id`** (hash of debate inputs: instrument + bar + AnalystView set) — stable across the Debate Engine's re-run-from-scratch (#10), usable as a provenance / setup-store join key.

Also: the Trader's **idempotency key = hash(instrument + bar/timestamp)**, NOT debate_id (which is volatile across re-runs). Must be reconciled into the Debate Engine spec + impl ticket #24 (Domain Types & Contracts). Recorded in [debate-engine-map.md](./debate-engine-map.md) too.

3. **`OrderIntent.decision_timestamp`** (Trader output) — the bar/decision time, retained as a field (the idempotency hash consumes it but doesn't expose it). The **Verdict** staleness gate needs it (`signal age = now − decision_timestamp`). Same Domain-Types reconciliation bucket. (Advisor-caught during Verdict charting.)

## Out of scope

Risk Manager gating/caps (Stage 4), Verdict (Stage 5), Execution/order placement (idempotent orders live at Execution), Feedback Loop weight/outcome logic (Stage 6 — Trader reads the setup store, doesn't build it).
