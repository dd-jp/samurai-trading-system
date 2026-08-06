# Analysts Specification

**Status:** Draft (resolved wayfinder tickets synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Samurai needs to turn raw market data into structured trading views before any debate, trade, or risk decision can happen. Different lenses on the market — price/indicator momentum, company fundamentals, crowd sentiment — each catch signal the others miss, and each is blind in ways the others are not. Feeding a single monolithic "analysis" into the pipeline would bury that diversity and lose the disagreement that the Debate Engine exists to mediate.

The Analysts layer (Stage 1) is where each lens produces its own independent view. It sits between the data services (Market Intelligence for news/sentiment, the Market Data Service for price/indicators) and the Debate Engine. Its job is to run the right analysts for a given asset, in parallel, resiliently, and hand a clean set of `AnalystView` objects downstream — without the caller ever knowing whether it is a live tick or a backtest replay.

## Solution

For each trading signal, the Analysts layer runs a set of role-specific analyst personas (technical, fundamental, sentiment) in parallel, filtered by what applies to the asset class. Each analyst pulls its primary data plus a fixed context frame from the data services, reasons over it with an LLM tiered to its latency budget, and emits a fixed-shape `AnalystView` (direction + confidence + free-text key points). The layer enforces a role-dependent quorum, handles individual analyst failures without stalling the pipeline, and produces exactly the `AnalystView[]` the Debate Engine's upstream contract expects.

Key architectural decisions:
- **Stateless analysts** — each analyst is a pure function of its inputs (data + weight); it holds no memory across ticks, so crash-restart is trivial and backtest replay reuses the live code path unchanged.
- **Primary + context input model** — every analyst has a primary data scope plus a fixed context frame (all roles always see contemporaneous price/volume), to prevent blind spots while keeping clear primary ownership.
- **Fixed `AnalystView` output** — no per-role typed fields; role-specific detail lives in free-text `key_points`, keeping the Debate Engine role-agnostic.
- **Parallel-with-applicability-filtering execution** — crypto runs Technical + Sentiment (no Fundamental — no earnings/SEC data exists for crypto); stocks run all three. Analysts are independent lenses with no sequencing between them.
- **Role-dependent quorum** — Technical and Fundamental are mandatory; Sentiment is optional. A mandatory analyst failing (after one retry) skips the whole tick; an optional analyst failing just shrinks the set.
- **Tiered LLM usage** — cheap/fast models for Technical and Sentiment (tight crypto latency), a stronger/slower reasoning model for Fundamental (stocks-only, looser budget).
- **Injected clock for replay** — no-lookahead is enforced at the data-service layer via an injected clock; the analyst is clock-blind and behaves identically live vs. replay.
- **Weight-blind views** — analysts emit raw views; analyst weights live in a shared SQLite store owned by the Feedback Loop and are applied downstream in the Debate Engine, not inside the analyst.

## User Stories

### Input & Data Access

1. As an Analyst, I want to pull my primary data scope from the data services, so that I can reason over the signal I specialize in.
2. As a Technical analyst, I want price and indicators as my primary data plus last-N-candles and volume as a fixed context frame, so that my reading is grounded in recent price action.
3. As a Fundamental analyst, I want earnings/SEC filings/news as my primary data plus the contemporaneous price reaction as context, so that I do not analyze an earnings surprise blind to how price already moved.
4. As a Sentiment analyst, I want social signals as my primary data plus contemporaneous price/volume as context, so that I can normalize crowd sentiment against actual market movement.
5. As an Analyst, I want my rolling/windowed features (moving averages, RSI, sentiment baselines) supplied by the upstream data services, so that I stay stateless and never compute or cache them myself.
6. As the Analysts layer, I want to read price/indicator data from the Market Data Service and news/sentiment data from Market Intelligence, so that each analyst gets the right source for its lens.

### Execution & Applicability

7. As the Analysts layer, I want to run all applicable analysts for a signal in parallel, so that total latency is bounded by the slowest analyst, not their sum.
8. As the Analysts layer, I want to run Technical + Sentiment for crypto signals and skip Fundamental, so that I do not invoke an analyst for which no data (earnings/SEC filings) exists.
9. As the Analysts layer, I want to run Technical + Fundamental + Sentiment for stock signals, so that stocks get the full analytical panel.
10. As the Analysts layer, I want analysts to be independent with no sequencing or dependency between them, so that each is a clean independent lens on the same signal.
11. As the Analysts layer, I want to report the actual analyst count per signal (2 for crypto, 3 for stocks) so that the Debate Engine's quorum math accounts for the variable count.

### Reasoning & Output

12. As an Analyst, I want to reason over my inputs with an LLM tiered to my latency budget, so that fast paths stay fast and nuanced paths get deeper reasoning.
13. As a Technical or Sentiment analyst, I want to use a cheap/fast model, so that I fit the crypto path's tight per-analyst latency budget (~2s).
14. As a Fundamental analyst, I want to use a stronger/slower reasoning model, so that I can do deeper earnings analysis within the stocks path's looser budget (~5s per analyst).
15. As an Analyst, I want to emit the fixed `AnalystView` shape (direction, confidence, key_points, timestamp), so that the Debate Engine stays role-agnostic.
16. As an Analyst, I want to put role-specific detail in free-text `key_points`, so that I convey evidence without forcing typed per-role fields onto downstream consumers.
17. As an Analyst, I want to emit a raw, weight-blind view, so that weighting stays a downstream (Debate Engine) concern and the Feedback Loop can retune weights without touching me.

### Failure Handling & Resilience

18. As the Analysts layer, I want to enforce a role-dependent quorum (Technical + Fundamental mandatory, Sentiment optional) by skipping the tick when a mandatory lens is missing, so that I only emit views when the essential lenses are present.
19. As the Analysts layer, I want to retry a failing analyst exactly once with a short timeout before giving up, so that transient blips are absorbed without retry storms.
20. As the Analysts layer, I want to treat malformed/unparseable analyst output identically to a timeout or error, so that I maintain one failure path (differing only in the logged reason).
21. As the Analysts layer, I want to skip the entire tick when a mandatory analyst fails even after retry, so that I never feed the Debate Engine a stale or missing essential lens.
22. As the Analysts layer, I want to proceed with the reduced set when an optional analyst fails, so that a flaky sentiment feed never blocks a trade.
23. As the Analysts layer, I want to never fall back to a stale view for a mandatory analyst, so that I avoid a confidently-wrong signal (a worse failure than a missed cycle).
24. As the operator, I want every analyst failure logged, so that I have visibility into input quality.
25. As the operator, I want an active alert only after 2 consecutive skipped ticks, so that isolated blips stay quiet but systemic breakage (bad API key, upstream outage) reaches me.

### State & Restart

26. As an Analyst, I want to hold no state between ticks, so that crash-restart requires no recovery — I just resume on the next tick with fresh data.
27. As the Analysts orchestrator, I want to read analyst weights from a shared SQLite store at tick start and pass them through to the Debate Engine, so that the Feedback Loop can adjust them, they survive a crash-restart, and analysts stay weight-blind.

### Backtesting & Replay

28. As the Analysts layer, I want backtest replay to reuse the exact same analyst code path as live, so that backtests exercise real code with no behavioral drift.
29. As an Analyst, I want to be clock-blind, so that I cannot tell a live tick from a replayed one — the only difference is the data source.
30. As the system, I want no-lookahead enforced by an injected clock at the data-service layer, so that during replay the services only return data timestamped at or before the simulated time T.
31. As the system, I want a response cache keyed by (analyst, input-snapshot hash), so that re-running a historical window (param sweeps, debugging) hits the cache instead of paying for LLM calls again.
32. As the system, I want backtest runs to use a cheap model tier for bulk iteration and a premium tier for final validation, so that I can iterate cheaply and validate faithfully.
33. As the system, I want replay to force LLM temperature 0 (or fixed seed), so that backtests are reproducible and PBO/overfitting metrics remain meaningful.

## Implementation Decisions

### Module: Analyst Orchestrator

**Responsibilities**
- Accept a trading signal, resolve the applicable analyst set by asset class, and run those analysts in parallel.
- Provide each analyst its clock, data-service handles, and current weight at invocation.
- Enforce the single-retry policy and role-dependent quorum.
- Decide skip-the-tick (mandatory failure) vs. proceed-with-reduced-set (optional failure).
- Track consecutive skipped ticks and fire the alert on 2 in a row.
- Return the `AnalystView[]` payload for the Debate Engine, annotated with the actual analyst count.

**Key Interfaces**

```typescript
// Output contract (consumed by the Debate Engine — fixed AnalystView shape,
// already defined by the Debate Engine's upstream contract)
interface AnalystView {
  trace_id: string;          // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  analyst_id: string;
  analyst_type: string;      // "technical" | "fundamental" | "sentiment"
  direction: Direction;      // bullish | bearish | neutral
  confidence: number;        // 0.0 - 1.0
  key_points: string[];      // role-specific evidence, free-text
  timestamp: Date;
}

// A single analyst persona: a pure function of its inputs.
interface Analyst {
  analyst_type: string;
  applies_to(asset_class: AssetClass): boolean;   // crypto | stocks
  role: "mandatory" | "optional";
  run(input: AnalystInput): Promise<AnalystView>;
}

// What the orchestrator assembles for each analyst per tick. Note: no weight
// here — the analyst is weight-blind (weights are applied downstream in the
// Debate Engine, not inside the analyst).
interface AnalystInput {
  trace_id: string;         // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  signal: Signal;            // asset, asset_class, etc.
  clock: Clock;             // wall-clock live, simulated T in replay
  // Data-service handles resolve "now" from the injected clock and filter
  // to timestamp <= clock.now(), enforcing no-lookahead below the analyst.
  market_intelligence: MarketIntelligence;   // news/sentiment (getContext)
  market_data: MarketDataService;            // OHLCV + technical indicators
}

// Orchestrator entry point (the single test seam).
interface AnalystOrchestrator {
  runAnalysts(signal: Signal): Promise<AnalystRunResult>;
}

interface AnalystRunResult {
  views: AnalystView[];        // one per successful applicable analyst
  weights: Record<string, number>; // analyst_id -> weight, read from the shared
                                    // store at tick start, passed through for the
                                    // Debate Engine to apply (analysts never see it)
  analyst_count: number;       // 2 for crypto, 3 for stocks (before failures)
  skipped: boolean;            // true if a mandatory analyst failed the tick
  failures: AnalystFailure[];  // logged failures this tick (reason-tagged)
}
```

### Module: Analyst Roles & Input Model

**Primary + context per role** (from #23). Each analyst owns a primary data scope and always receives a fixed context frame:

- **Technical** — primary: price/indicators (from Market Data Service); context: last-N-candles + volume (always). Mandatory. Cheap/fast LLM tier.
- **Fundamental** — primary: earnings/SEC filings/news (from Market Intelligence); context: contemporaneous price reaction (always). Mandatory. Stronger/slower LLM tier. Stocks-only.
- **Sentiment** — primary: social signals (from Market Intelligence); context: contemporaneous price/volume, to normalize (always). Optional. Cheap/fast LLM tier.

> **Status against code, and what ADR-0009 constrains.** The LLM tiering above is **unbuilt** — `src/analysts/` is pure rule-based logic today and makes no LLM call (see "Prompt Injection Mitigation" below). When it is built, it does not get to pick a provider: [ADR-0009](../adr/0009-single-provider-nous.md) routes **all** LLM traffic through Nous, so a tier here becomes a new entry in `NOUS_ROLES` and `DEFAULT_NOUS_MODELS` (`src/shared/llm/nous-config.ts`), resolved via `NOUS_<ROLE>_MODEL` → `NOUS_MODEL`, with the model priced in `MODEL_RATES` — an unpriced model is refused at startup because its calls record a null cost and [ADR-0008](../adr/0008-llm-spend-cap.md)'s cap sums nulls as zero. `NOUS_ROLES` is `['debate', 'sentiment']` today; neither is an analyst role. Note also that the cheap-tier assumption is not free: the ADR-0009 bake-off found the cheap tiers are cheap partly because they are queued, and tail latency, not median, is what a per-analyst budget has to survive.

The context frames deliberately overlap (all three see price/volume). Overlap is allowed and expected — no de-duplication in Stage 1. Conflicting-but-overlapping conclusions are exactly what the Debate Engine's semantic disagreement detection exists to mediate.

**Prompt Injection Mitigation — forward-looking convention** (#208)

Today, `src/analysts/` (`fundamental-analyst.ts`, `sentiment-analyst.ts`, `technical-analyst.ts`) is pure mechanical/rule-based logic — none of it makes an LLM call or constructs an LLM prompt from ingested free text (news, filings, social signals). There is no prompt-construction code here to retrofit as of this ticket.

Fundamental and Sentiment analysts consume free text sourced from Market Intelligence (news, social signals) that could carry the same kind of injected content described in issue #208 (e.g. a headline engineered to look like an instruction). Any future code in this component that constructs an LLM prompt from that ingested free text MUST delimit it using the same tagged-untrusted-block convention implemented in the Debate Engine's `src/debate-engine/personas.ts` (see debate-engine-spec.md "Prompt Injection Mitigation"): wrap ingested text in a tagged block (e.g. `<untrusted_analyst_data>...</untrusted_analyst_data>`) preceded by an explicit "treat as data, not instructions" preamble, with the real output-format instruction kept outside and separate from that block. This requirement gates shipping any such prompt-construction code, not a later cleanup pass.

### Module: Execution & Applicability

- **Crypto**: Technical + Sentiment run in parallel; Fundamental is skipped (no earnings/SEC data exists for crypto). Analyst count = 2.
- **Stocks**: Technical + Fundamental + Sentiment run in parallel. Analyst count = 3.
- Analysts are independent — no sequencing or dependency between them within a signal.
- The orchestrator reports `analyst_count` so the Debate Engine's ≥50% quorum math accounts for the variable count (2 crypto / 3 stocks).

### Module: Failure Handling

**Failure modes** (all treated identically, differing only in logged reason): timeout, error, malformed/unparseable output (schema-validation failure).

**Policy** (from #41):
1. Uniform single bounded retry with a short timeout for any failing analyst, regardless of role.
2. After the retry is exhausted:
   - **Mandatory analyst** (Technical, Fundamental) → hard-block: **skip the entire tick**. No stale-view fallback, no partial debate.
   - **Optional analyst** (Sentiment) → proceed with the reduced set; the debate runs without it.
3. Every failure is logged with its reason. An active alert fires only after **2 consecutive skipped ticks**; a single isolated skip is log-only.

**Rationale** — a stale mandatory view risks a confidently-wrong technical/fundamental read, a worse failure than missing one cycle; this matches the project's safety-over-uptime posture for live money.

**Relationship to the Debate Engine's ≥50% quorum.** The role-dependent skip is the *operative* gate and it lives in the Analysts layer: if a mandatory analyst fails, the tick is skipped and the Debate Engine is never invoked. Stage 1 does **not** build a separate ≥50% quorum enforcer — that gate stays in the Debate Engine (ticket #25, under epic #40) as an independent downstream safety check. In practice any tick Stage 1 passes through already satisfies ≥50% (crypto: 1-of-2 if optional Sentiment drops = 50%; stocks: 2-of-3 if Sentiment drops = 67%), so the two gates are complementary, not duplicated. The orchestrator reports `analyst_count` (2 crypto / 3 stocks) precisely so the Debate Engine's ≥50% math accounts for the variable count.

### Module: State Management

**Decision: analysts are stateless per tick** (from #42). Each analyst is a pure function: `(data + weight) -> view`. It holds no memory across ticks.

- **Rolling/windowed features** (moving averages, RSI, sentiment baselines) are supplied by upstream data services, never computed or held inside the analyst. Market Intelligence serves news/sentiment; the Market Data Service serves OHLCV + technical indicators.
- **Crash-restart is trivial** — analysts persist nothing and simply resume on the next tick. (The crash-restart invariant in CLAUDE.md concerns open positions, satisfied here by holding no state.)
- **Analyst weights** live in a shared persistent SQLite store, owned by the Feedback Loop (Stage 6). The **orchestrator** reads the weights map at tick start and passes it through in `AnalystRunResult.weights` for the Debate Engine to apply. Analysts themselves never receive or see weight — they stay stateless and weight-blind.
- **Weights are applied downstream** in the Debate Engine — the analyst emits a raw, weight-blind view, consistent with CONTEXT.md ("produces a view, not a recommendation").

### Module: Backtesting Replay

**Decision: same code path, clock-driven, cached** (from #43).

- Replay reuses the exact live analyst code path. The analyst is clock-blind; the only difference between live and replay is the data source (live feed vs. historical store).
- **No-lookahead** is enforced by an **injected clock at the data-service layer**. Both Market Intelligence and the Market Data Service read "now" from the injected clock and filter `timestamp <= clock.now()`. In replay the clock is the simulated time T.
- **The historical data store is out of scope for the Analysts layer** — it is owned by the data services (the Market Data Service persists OHLCV natively; Market Intelligence's historical store is the still-open ticket #21). Stage 1 depends on replayable data services but does not build the store.
- **LLM replay cost** is handled by a response cache keyed by `(analyst, input-snapshot hash)`: real LLM calls on the first pass, cache hits on re-runs. This pairs with the tiered LLM decision — a cheap model tier for bulk backtest iteration, a premium tier for final validation.
- **Reproducibility** — replay forces LLM temperature 0 (or a fixed seed) so a cache-cold re-run matches a cache-warm one, keeping PBO/overfitting metrics meaningful. Live mode may keep normal temperature.

## Testing Decisions

### What Makes a Good Test

- Test external behavior at the orchestrator seam (`runAnalysts(signal) -> AnalystRunResult`), not internal implementation.
- Mock the two data services (Market Intelligence, Market Data Service) and the LLM — the orchestration logic (applicability, parallelism, retry, quorum, skip/alert) is what's under test.
- Test failure modes explicitly: mandatory analyst fails → tick skipped; optional analyst fails → reduced set proceeds; malformed output treated as failure.
- Test the alert threshold: one skip is silent, two consecutive skips fire an alert.
- Use an injected mock clock to test no-lookahead: replayed data-service reads never return data timestamped after `clock.now()`.
- Test determinism: temperature-0 replay with a warm cache reproduces a cold-cache run's views.

### Modules to Test

**Analyst Orchestrator**
- Applicability filtering (crypto → Technical + Sentiment; stocks → all three; `analyst_count` correct).
- Parallel execution (total latency bounded by slowest analyst, not the sum).
- Single-retry policy (fails once, retries once, then gives up).
- Role-dependent quorum (mandatory failure skips tick; optional failure proceeds).
- No stale fallback for mandatory analysts.
- Consecutive-skip tracking and the 2-in-a-row alert.

**Analyst Roles & Input Model**
- Correct primary + context frame assembled per role.
- Output conforms to the fixed `AnalystView` shape (types, confidence in 0–1, role-specific detail only in `key_points`).
- Views are weight-blind (weight input does not alter the emitted view shape/content path).

**Backtesting Replay**
- Same code path exercised live and in replay (no divergence).
- No-lookahead via injected clock (data services filter `timestamp <= clock.now()`).
- Response cache keyed by input-snapshot hash (re-run hits cache, makes no new LLM call).
- Temperature-0 reproducibility.

### Prior Art

- No test infrastructure exists yet — this is pre-implementation.
- LLM mock patterns mirror the Debate Engine spec: deterministic responses for orchestration testing, randomized for integration testing.
- Time-based testing uses a mock clock (already anticipated by the Market Intelligence spec) to simulate time windows and replay without real delays.

## Out of Scope

**Signal Production (out of scope, flagged dependency)**

This spec consumes `Signal{asset, asset_class}` via `runAnalysts(signal)` but does not produce it. Market scanning / universe selection / scheduling — the "idea generation" half of Stage 1 (per CONTEXT.md and the vision's DoD #1: "Analyst scan runs on schedule, produces ideas for configurable universe") — is NOT part of this spec. **Ownership resolved 2026-08-07:** universe selection is owned by the **Universe Selector** ([universe-selector-spec.md](universe-selector-spec.md), wayfinder map [#397](../../issues/397)) — an out-of-session job that ranks a candidate pool and writes a watchlist; scheduling and per-tick `Signal` emission stay with the Orchestrator. The sentence below describing it as unowned records the pre-2026-08-07 state. It most likely belongs to the uncharted **Orchestrator** (see docs/specs/cross-spec-contracts.md OPEN-GAP-D), which would run a scheduled scan over the configured universe (default SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD per ADR-0001) and emit one `Signal` per instrument per tick, invoking `runAnalysts(signal)` for each. This spec deliberately does not design the scanner itself — this note exists only to name the dependency and its likely home so it isn't silently lost.

**Data Service Implementation**

How Market Intelligence and the Market Data Service fetch, normalize, and store data is out of scope. The Analysts layer consumes their interfaces (`getContext`, OHLCV/indicator queries) but does not build them. The Market Data Service itself is a new Stage 0-level component surfaced during #42 and needs its own wayfinder map before implementation.

**Historical Data Storage for Replay**

The historical store that feeds replayed data is owned by the data services, not analysts. Market Intelligence's backtesting replay store is specced in market-intelligence-spec.md (**Module: Backtesting Replay Store**) — a standalone replay service that captures live MI outputs (raw + normalized IntelligenceItems) via push sidecar writes to SQLite, and serves them through a `ReplayContext` that implements the same `getContext()` contract the Analysts layer already consumes. The Orchestrator swaps the live MI backing for a `ReplayContext` when `mode='backtest'`; analysts are unaware of the swap (story 29: clock-blind, same code path).

**Debate Engine**

How views are mediated, how disagreements are detected, and how analyst weights are applied is the Debate Engine's concern (see debate-engine-spec.md). This spec produces the `AnalystView[]` input; it does not consume it.

**Feedback Loop Weight Adjustment**

The Analysts layer reads weights from the shared store; how the Feedback Loop computes and writes them post-execution is out of scope.

**Self-Learning / Online Model Training**

Analysts are static (rule-driven + LLM reasoning); they do not self-retrain. The only adaptation in the system is Feedback-Loop weight tuning, which is bounded and does not change the underlying market model (per CONTEXT.md). Autonomous model retraining / RL is deliberately excluded — it would undermine the "economically explainable edge" and PBO-discipline invariants.

**Conviction Score & Confidence Calibration**

How an analyst arrives at its `confidence` value (calibration, prompt engineering) is an implementation detail. This spec fixes the output shape, not the reasoning internals.

**LLM Selection & Prompt Engineering**

Which exact models fill the cheap/fast and stronger/slower tiers, prompt design, and the per-call cost ceiling are implementation details (the cost ceiling is explicitly deferred until real usage data exists).

## Further Notes

### Integration with Pipeline

The Analysts layer sits between the data services and the Debate Engine:

```
Market Intelligence  ┐
                     ├─→ Analysts → Debate Engine → Trader → Risk Manager → Verdict → Execution
Market Data Service  ┘   (this spec)
```

The Feedback Loop closes the loop by writing analyst weights (read at tick start) back into the shared SQLite store.

### Domain Glossary Alignment

Per CONTEXT.md:
- **Analyst**: "An agent persona that examines market data through a specific lens. Multiple analysts run in parallel. Each produces a view, not a recommendation. Stateless per tick — holds no memory across ticks. A pure function of its inputs."
- **Market Data Service**: "A dedicated Stage 0-level data layer, parallel to Market Intelligence, that serves price OHLCV plus precomputed technical indicators to analysts."
- **Debate Engine**: "Mediates between conflicting analyst views before the Trader consolidates."

### Asset-Class Analyst Counts

The variable analyst count (2 for crypto, 3 for stocks) is not incidental — it drives the Debate Engine's quorum threshold. Crypto's ≥50% quorum of 2 means both analysts effectively matter; stocks' ≥50% of 3 tolerates one optional (Sentiment) dropout. This is why Fundamental is mandatory on the stocks path but simply absent (not "failed") on the crypto path.

### Latency Tiering Rationale

LLM tiering is driven by the latency budget, not just task complexity. Technical and Sentiment run on the crypto path's tight ~2s/analyst budget, so both use cheap/fast models. Fundamental runs only on the stocks path (looser ~5s/analyst budget), so it can afford a stronger reasoning model for nuanced earnings analysis.

### Backtest Cost Model

A long replay window makes thousands of analyst invocations. Without mitigation that is thousands of LLM calls. The input-hash response cache makes re-runs (param sweeps, debugging) near-free, and the cheap model tier keeps first-pass bulk iteration affordable; premium models are reserved for the final validation run. Temperature-0 replay makes all of this reproducible.

### Future Extensions

Potential enhancements (not in this spec):
- Additional analyst lenses (macro, options flow, on-chain) added to the applicability matrix.
- Per-analyst confidence calibration tuned from Feedback-Loop outcome data.
- Adaptive analyst set selection (turn a lens off when it has shown no edge for an asset class).

## Resolved Issues (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/analysts-map.md](../wayfinder/analysts-map.md) (migrated from GitHub issue #22). Decisions synthesized here:

- **Analyst role definitions and contracts** — primary+context input model, fixed `AnalystView` output, parallel-with-applicability-filtering execution, latency-tiered LLM usage, overlap allowed (defer to Debate Engine).
- **Analyst failure handling** — role-dependent quorum (Technical + Fundamental mandatory, Sentiment optional), uniform single-retry, skip-the-tick on mandatory hard-block (no stale fallback), alert after 2 consecutive skips.
- **Analyst state management** — stateless analysts (pure function of data + weight), upstream data services supply rolling features, trivial crash-restart, weights in shared SQLite owned by the Feedback Loop and applied downstream.
- **Backtesting replay** — same code path live vs. replay, no-lookahead via injected clock at the data-service layer, historical store owned by data services, input-hash response cache + cheap tier for bulk, temperature-0 for reproducibility.

Dependencies on other stages:
- **Market Data Service** — new Stage 0-level component (OHLCV + technical indicators) surfaced during state-management grilling; needs its own wayfinder map. The Analysts layer depends on it but does not build it.
- **Market Intelligence backtesting store** — still-open frontier item on the Market Intelligence map; owns the historical news/sentiment store the analysts' replay depends on.
- **Signal production (scanning/scheduling)** — unowned; see Out of Scope note above and cross-spec-contracts.md OPEN-GAP-D. Likely Orchestrator territory, not yet charted.

All Stage 1 map frontiers resolved. Map is complete.
