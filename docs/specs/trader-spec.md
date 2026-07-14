# Trader Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Samurai's Debate Engine produces a conviction-scored synthesis of analyst views (`DebateResult`), but a synthesis is not a trade. Something has to turn "the system believes bullish with conviction 0.72, not fully converged" into a concrete, broker-ready order — with a size, an entry, a protective stop, a target, and a time-in-force — while accounting for what the portfolio already holds and what similar past setups actually returned.

The Trader (Stage 3) is that translation layer. It consumes the Debate Engine's output and emits a fully-specified order intent (a bracket) for the Risk Manager to vet and modify. It must be deterministic and auditable — every position size must be explainable and reproducible — because this is the stage where belief becomes financial exposure, and expectancy/overfitting discipline (CONTEXT.md) depends on it being backtestable without hidden nondeterminism.

## Solution

The Trader is a **deterministic, mechanical** stage: given a `DebateResult`, the current position state, and market data, it computes a single order-intent bracket (or decides not to trade). It does **no LLM reasoning** — that work is already spent in the Debate Engine. Position size is derived from a threshold-gated, conviction-scaled fractional-risk formula with an ATR-based stop and a volatility floor, then modulated by a **cosine-similarity retrieval** against a store of past setups and their realized outcomes, and haircut when the debate did not converge. All downward adjustments stack multiplicatively; if the result falls below a minimum viable position, the Trader skips the trade rather than placing dust.

Key architectural decisions:
- **Full order-intent (bracket) output** — instrument, side, size, entry/limit, stop, target, TIF as one broker-agnostic unit; Risk vets/modifies.
- **Mechanical backbone + cosine retrieval, NO Trader-side LLM** — deterministic given its inputs and setup store, so it is fully backtestable.
- **Conviction-scaled fractional sizing with a volatility floor, never full Kelly.**
- **Entries + exits as attached brackets** — no separate continuous exit loop; exits are mechanical (stop/target) or a later debate flipping direction.
- **Deterministic idempotency key** assigned by the Trader, so crash-restart/replay dedupes to exactly one order.
- **Position-aware** — reconciles the new debate against current holdings before acting.

## User Stories

### Input & Integration

1. As the Trader, I want to consume the Debate Engine's `DebateResult` (position, confidence, converged, open_items, contributions), so that I can translate belief into an order.
2. As the Trader, I want to read current market data (price, ATR/volatility, indicators) from the Market Data Service via an injected clock, so that my sizing reflects the regime at decision time and stays point-in-time correct in replay.
3. As the Trader, I want to read the current position/portfolio state from the shared store, so that I act with awareness of what is already held.
4. As the Trader, I want to read past-setup neighbors and their outcomes from the Feedback Loop's setup store, so that precedent can inform sizing.

### Sizing & Order Construction

5. As the Trader, I want to emit no entry when conviction is below a floor, so that low-edge debates never risk capital.
6. As the Trader, I want base fractional risk to scale linearly with conviction above the floor up to a hard per-trade cap, so that stronger belief takes proportionally more (bounded) risk.
7. As the Trader, I want position size derived from an ATR-based stop with a volatility floor, so that higher volatility automatically yields a smaller position for the same fractional risk and ultra-low vol can't inflate size absurdly.
8. As the Trader, I want to never use full Kelly and to scale risk down for fat-tailed asset classes (crypto more conservative than stocks), so that drawdowns stay within tolerance (CONTEXT.md; research: quarter-Kelly-or-less for fat-tailed markets).
9. As the Trader, I want to emit a full bracket (entry + stop + target + TIF), so that the exit is attached at entry and needs no separate loop.
10. As the Trader, I want to assign a deterministic idempotency key = hash(instrument + bar/timestamp), so that a re-run (crash-restart or replay) — including the Debate Engine re-running the debate from scratch — produces the same key and Execution dedupes to exactly one order.
11. As the Trader, I want to attach full metadata (provenance + sizing decomposition + cosine precedent summary) to the intent, so that Risk can trim intelligently and the audit log is self-explaining.

### Cosine Precedent

12. As the Trader, I want to embed each setup as a combined vector of debate features + market-regime features, so that I match "this kind of debate in this kind of market."
13. As the Trader, I want to retrieve the k nearest past setups above a similarity threshold whose trades have already closed as of the injected clock, so that precedent is real and free of lookahead.
14. As the Trader, I want to modulate size by a bounded multiplier (0.5×–1.5×) driven by the similarity-weighted mean R-multiple of those neighbors, so that setups that historically paid off get more size and those that didn't get less.
15. As the Trader, I want a conservative 0.75× default and a "no precedent" flag when there is no close neighbor, so that novel setups are sized cautiously and Risk is informed.
16. As the Trader, I want to write each new setup vector to the store, so that the Feedback Loop can later attach its realized outcome.

### Non-Convergence & Skip

17. As the Trader, I want to apply a fixed size haircut when the debate did not converge, so that unresolved disagreement is expressed as caution rather than a binary skip.
18. As the Trader, I want all downward adjustments (conviction scaling, non-converged haircut, cosine multiplier) to stack multiplicatively, so that penalties compound honestly.
19. As the Trader, I want to skip the trade when the resulting size falls below a minimum viable position (respecting broker minimum order size), so that I never place dust orders.

### Position Awareness

20. As the Trader, I want to emit a new entry bracket when no position is held, so that fresh signals open trades.
21. As the Trader, I want to hold (or bounded scale-in) when a same-direction debate arrives on a held asset, so that I don't churn or over-concentrate.
22. As the Trader, I want to emit an exit intent (flatten to zero) when an opposite-direction debate arrives on a held asset, so that I don't stay in a trade the system no longer believes in; the reversal entry, if still warranted, opens as a fresh `entry` on the next decision cycle when flat.
23. As the Trader, I want to hold (optionally tighten the stop) on a neutral or non-converged debate for a held asset, so that ambiguity doesn't force action.

### Determinism & Backtest

24. As the system, I want the Trader to run the same code path live and in replay, so that backtests exercise real behavior.
25. As the system, I want the cosine store queried point-in-time via the injected clock, so that backtests have no lookahead.
26. As the system, I want warm-up (empty store) handled naturally via the "no precedent" default, so that cold-start behavior is honest and reproducible.

## Implementation Decisions

### Module: Trader Core

**Responsibilities**
- Consume `DebateResult`; read market data, position state, and cosine neighbors (all via the injected clock).
- Reconcile the debate against current holdings (position-aware routing).
- Compute size (conviction scaling → ATR/vol sizing → non-converged haircut → cosine multiplier → min-viable-size skip).
- Construct the bracket, assign the idempotency key = hash(instrument + bar/timestamp), attach metadata.
- Write the setup vector to the store for later outcome labelling.
- Return the order intent, or null (no trade).

**Key Interfaces**

```typescript
// Single test seam. Fully deterministic given its inputs + the (clock-scoped) stores.
interface Trader {
  decide(input: TraderInput): OrderIntent | null;   // null = skip / no-trade
}

interface TraderInput {
  trace_id: string;              // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  debate: DebateResult;          // from the Debate Engine. REQUIRES two additions to
                                 // the current DebateResult contract (see cross-spec note
                                 // below): a structured `direction: bullish|bearish|neutral`
                                 // (a mechanical Trader cannot derive `side` from the
                                 // free-text `position`), and a deterministic `debate_id`
                                 // (hash of debate inputs) for provenance/setup-store joins.
  clock: Clock;                  // wall-clock live, simulated T in replay
  marketData: MarketDataService; // price, ATR/vol, indicators (clock-scoped)
  positionState: PositionStore;  // shared SQLite position state (clock-scoped)
  setupStore: SetupStore;        // Feedback Loop-owned; neighbors + R outcomes
  equity: number;
}

// The bracket handed to the Risk Manager.
interface OrderIntent {
  idempotency_key: string;       // hash(instrument + bar/timestamp) — the market
                                 // decision coordinate. Deliberately NOT keyed on
                                 // debate_id: the Debate Engine re-runs debates from
                                 // scratch on crash (no persistence), so a debate id
                                 // is volatile; keying on (instrument + bar) keeps the
                                 // key stable across re-runs so Execution dedupes to one
                                 // fill (CONTEXT.md idempotency invariant).
  instrument: string;
  asset_class: 'crypto' | 'stocks';
  side: 'buy' | 'sell';
  intent_type: 'entry' | 'scale_in' | 'exit';   // a reversal is exit-then-fresh-entry,
                                                 // not a single zero-crossing bracket
  size: number;
  entry: number;                 // limit/entry price
  stop: number;
  target: number;
  time_in_force: string;
  decision_timestamp: Date;      // the bar/decision time (retained from the idempotency-key
                                 // hash input). Downstream (Verdict) needs it for the
                                 // signal-staleness gate; the hash alone doesn't expose it.
  metadata: OrderIntentMetadata;
}

interface OrderIntentMetadata {
  debate_id: string;
  conviction: number;
  converged: boolean;
  sizing: {
    base_risk_fraction: number;    // after conviction scaling
    conviction_multiplier: number;
    vol_floor_factor: number;      // effect of max(ATR, vol_floor)
    non_converged_haircut: number; // 1.0 if converged
    cosine_multiplier: number;     // 0.5–1.5, or 0.75 no-precedent default
  };
  cosine_precedent: {
    neighbor_count: number;
    weighted_mean_r: number | null;
    no_precedent: boolean;
  };
}

// The setup vector embedded for cosine retrieval (both debate + market features).
interface SetupVector {
  debate_features: number[];   // conviction, direction, converged, disagreement magnitude
  market_features: number[];   // volatility bucket, trend, key indicators at decision time
}
```

### Cross-Spec Requirement: DebateResult additions

The Trader consumes `DebateResult` and, being mechanical (no LLM), needs two fields the **current** Debate Engine contract does not provide (debate-engine-spec.md `DebateResult` = synthesis, position, confidence, contributions, disagreement_summary, open_items, converged, rounds_completed, latency_ms):

1. **`direction: 'bullish' | 'bearish' | 'neutral'`** — the structured signal the Trader maps to `side`. Without it, deriving side from the free-text `position` would require an LLM (which the Trader deliberately omits). The mediator already knows the direction; it just needs to be exposed structurally.
2. **`debate_id: string`, deterministic** = hash of the debate's inputs (instrument + bar + the AnalystView set). Must be stable across the Debate Engine's re-run-from-scratch (no-persistence, #10), so it is a reliable provenance/setup-store join key. (It is NOT used in the idempotency key — that keys on instrument + bar.)

**This must be reconciled into the Debate Engine spec and its implementation tickets (#24 Domain Types & Contracts) during the cross-spec verification pass — do not build the Trader on an unstated contract.** Recorded in both wayfinder maps.

### Module: Side Derivation

- `side` comes from `debate.direction`: `bullish → buy`, `bearish → sell`, `neutral → no entry` (no directional edge to act on).

### Module: Position Sizing

- **Conviction → base risk (threshold-gated linear):** below a conviction floor (~0.5–0.6) → no entry; above it, `base_risk_fraction` scales linearly to a hard `max_risk_per_trade` cap at conviction 1.0.
- **Volatility (ATR stop + vol floor):** `stop_distance = k × max(ATR, vol_floor)`; `size = (equity × risk_fraction) / stop_distance`. Higher vol → wider stop → smaller size automatically; `vol_floor` bounds size from below in ultra-low vol.
- **Never full Kelly** — `max_risk_per_trade` is a small fraction, well under Kelly (research: full Kelly implies 50–80% drawdowns).
- **Asset-class risk scaling (fat-tail discipline):** an `asset_class_risk_multiplier` scales `max_risk_per_trade` down for fat-tailed markets — **crypto is sized more conservatively than stocks** (research: fat-tailed markets warrant quarter-Kelly or less). So the same conviction yields a smaller crypto position than an equivalent stock position. The exact multipliers are config, tuned in paper trading.
- **Caps ownership:** the Trader enforces only its per-trade `max_risk_per_trade` (asset-class-scaled) and the cosine multiplier bound. Portfolio + asset-class exposure caps and drawdown circuit breakers are the Risk Manager's (Stage 4) — not duplicated here.

### Module: Cosine Precedent Retrieval

- **Setup vector** = combined debate features + market-regime features (see `SetupVector`).
- **Store owned by the Feedback Loop (Stage 6);** Trader writes the setup at decision time and reads neighbors at decision time. Part of the shared SQLite store family.
- **Outcome label = R-multiple** (realized PnL ÷ initial risk).
- **Retrieval:** k nearest by cosine similarity, restricted to setups above a minimum similarity threshold AND already closed with a known outcome as of the injected clock (point-in-time — a still-open setup has no label yet).
- **Multiplier:** bounded 0.5×–1.5×, a function of the similarity-weighted mean R of the neighbors (positive → up, negative → down, near-zero → 1.0×).
- **No close neighbor** (below min count above threshold) → 0.75× default + `no_precedent` flag.

### Module: Non-Convergence & Skip Policy

- `converged: false` → apply a fixed `non_converged_haircut` (e.g. 0.5×), still subject to the conviction floor (non-converged + mediocre conviction → skipped).
- **Multiplicative stacking:** `size = base_risk(conviction) × non_converged_haircut × cosine_multiplier` (via ATR sizing).
- **Minimum-viable-position skip:** if the result falls below a min notional / min risk threshold (respecting broker minimum order size), return null (skip) rather than a dust order.

### Module: Position Awareness

Routing against `positionState`, producing `intent_type`:
- No position + directional debate → `entry`.
- Holding, same direction → hold (return null) or bounded `scale_in` if conviction rose materially (bounded by exposure — Risk enforces the hard cap).
- Holding, opposite direction → `exit` (flatten to zero). A reversal is not a single zero-crossing bracket; if the opposite side is still warranted, it opens as a fresh `entry` on the next cycle when flat. This keeps every `OrderIntent` a single-side bracket and spares Risk/Execution from reasoning about zero-crossings.
- Holding + neutral/`converged: false` → hold; optionally tighten the stop.

### Module: Determinism & Replay

- Same code path live vs replay; only the data/clock source differs. The Trader has no LLM and no hidden state, so it is deterministic given its inputs and the clock-scoped stores.
- The cosine store is queried point-in-time via the injected clock (closed-outcome-only rule above), reusing the analysts' #43 no-lookahead discipline.
- **Warm-up:** an empty/sparse store at cold-start yields "no precedent" 0.75× defaults naturally — no special-casing. Optionally exclude the warm-up window when *evaluating the cosine layer's* contribution, though those trades still count toward overall PnL/PBO.

## Testing Decisions

### What Makes a Good Test

- Test at the `Trader.decide(input)` seam: given a `DebateResult` + mocked stores/market data + mock clock, assert on the returned `OrderIntent` (or null).
- Mock the Market Data Service, position store, and setup store — the sizing/routing/skip logic is what's under test; the Trader has no LLM to mock.
- Determinism test: identical input → identical `OrderIntent` (including idempotency key) across runs.
- Point-in-time test: the setup store, driven by a mock clock, never returns a neighbor whose trade closed after T.

### Modules to Test

**Trader Core / Sizing**
- Conviction floor (below → null; above → linear scaling to cap).
- ATR/vol sizing (`max(ATR, vol_floor)` behavior; higher vol → smaller size).
- Multiplicative stacking and the min-viable-size skip (dust → null).
- Never exceeds `max_risk_per_trade`.

**Cosine Precedent**
- Threshold + closed-only + point-in-time retrieval.
- Similarity-weighted-R → bounded multiplier (0.5×–1.5×).
- No-precedent → 0.75× + flag.

**Position Awareness**
- Each routing case produces the correct `intent_type` (entry / scale_in / exit / flip / hold-null).

**Determinism & Idempotency**
- Same input → same idempotency key and same intent.

### Prior Art

- No implementation yet. Mock-clock and injected-clock patterns mirror the Analysts and Market Intelligence specs. Deterministic-output assertions replace the LLM-mock patterns used in the Debate Engine spec (the Trader has no LLM).

## Out of Scope

**Risk Management (Stage 4)** — position-size caps, portfolio/asset-class exposure limits, drawdown circuit breakers, and the vet/modify of the Trader's intent. The Trader hands over a bracket + metadata; Risk decides what the portfolio permits.

**Verdict & Execution** — the go/no-go and actual order placement (including expanding the bracket into broker-native multi-leg orders via the broker abstraction, and using the idempotency key as the order ID) are downstream.

**Feedback Loop (Stage 6)** — owns the setup store and computes the R-multiple outcomes. The Trader reads/writes the store but does not build it or label outcomes.

**Market Data Service** — supplies price/OHLCV + indicators; its implementation is a separate Stage 0 component.

**LLM reasoning** — deliberately excluded from the Trader (already spent in the Debate Engine). Adding a Trader LLM would duplicate work and break determinism.

**Exact parameter values** — conviction floor, `max_risk_per_trade`, ATR `k`, `vol_floor`, similarity threshold, k, and the multiplier curve are config, tuned in paper trading; not fixed here.

## Further Notes

### Integration with Pipeline

```
Debate Engine → Trader → Risk Manager → Verdict → Execution
              (this spec)
Feedback Loop ←──────────────────────────────────── (writes outcomes)
   │  owns the setup store (cosine precedent) + analyst weights
   └─ Trader reads neighbors / writes setup vectors
```

### Domain Glossary Alignment

Per CONTEXT.md:
- **Trader**: "consolidates analyst views and proposes a concrete action (entry, exit, size, instrument). Operates AFTER debate, not before."
- **Idempotent Order**: "when submitted multiple times (due to retry), results in exactly one fill." — satisfied by the Trader-assigned deterministic key.
- **Feedback Loop**: "adjusts analyst weights, strategy parameters, risk thresholds." — owns the setup store the cosine layer reads.

### Why the Trader Is Deterministic

Concentrating LLM reasoning in the Debate Engine and keeping the Trader mechanical means the entire belief→exposure translation is reproducible: the same debate in the same regime with the same precedent always yields the same order. That is what makes expectancy and Probability of Backtest Overfitting (CONTEXT.md) measurable — a nondeterministic Trader would blur every backtest.

### Future Extensions

- Richer setup embeddings (order-book / microstructure features).
- Learned (rather than hand-tuned) mapping from neighbor R-distribution to the size multiplier — deferred; would reintroduce a training loop and must respect PBO discipline.
- Multi-instrument / portfolio-construction awareness (currently per-instrument; portfolio caps live in Risk).

## Resolved Decisions (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/trader-map.md](../wayfinder/trader-map.md) (charted locally; migrated from the former GitHub issue #27). Decisions synthesized here:

- **Order-intent contract** — single bracket object; broker-abstraction expands to native multi-leg at Execution; Trader-assigned deterministic idempotency key; full metadata (provenance + sizing decomposition + cosine precedent summary).
- **Position/portfolio state** — shared persistent SQLite store reconciled vs broker; Trader is position-aware.
- **Position sizing** — threshold-gated linear conviction→risk; ATR stop with `max(ATR, vol_floor)`; per-trade cap only (portfolio caps → Risk); never full Kelly.
- **Non-converged policy** — fixed haircut + conviction floor; multiplicative stacking; min-viable-size skip.
- **Cosine retrieval** — combined debate+market setup vector; Feedback-Loop-owned store; R-multiple labels; point-in-time closed-only retrieval; bounded similarity-weighted-R multiplier; 0.75× no-precedent default.
- **Backtest determinism** — same code path live vs replay; point-in-time via injected clock; natural warm-up handling.

**Downstream dependency:** the cosine setup store is owned by the Feedback Loop (Stage 6), still to be charted; the Trader depends on it but does not build it.
