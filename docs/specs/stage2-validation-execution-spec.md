# Stage 2 Validation Execution Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-07-28

> This is not a 13th pipeline component. It is a one-time (repeatable) **research execution** that proves the already-built cost-model/backtest harness — `overfitting.ts`, `metrics.ts`, `cost-model.ts` (117/117 tests passing, formulas independently reviewed 2026-07-21) — actually catches a real edge/non-edge correctly, by running it for real against a mechanical proxy strategy over real historical data. Wayfinder map: [#154](../../issues/154).

## Problem Statement

`docs/research/02-staged-deployment-plan.md`'s Stage 2 ("Validate against overfitting") has an explicit kill line: out-of-sample Sharpe < 0.5, PBO > 0.05, or an insignificant Deflated Sharpe Ratio means rework or abandon the strategy, and **do not proceed to Stage 3.** The validation *machinery* for this gate is built and unit-tested (`docs/specs/cost-model-backtest-spec.md`'s Validation Library: `computeMetrics`, `generateSplits`, DSR, PBO, MinBTL), but it has never been run against a real strategy over real history. Meanwhile the Production Composition Root (ADR-0004, wayfinder map #224) is about to wire the live pipeline into an actual paper run — which means Stage 3 is starting before Stage 2's gate has ever produced a verdict. This spec closes that gap: it is what makes Stage 2 real rather than theoretical.

Validating with the live LLM debate pipeline is explicitly out of scope here — an LLM-in-the-loop backtest is slow, costly, and conflates "does the harness work" with "is the debate pipeline any good," two different questions. Wayfinder map #154 resolved six decisions needed to run the harness for real against a **mechanical, rule-based proxy strategy** instead: this spec synthesizes those decisions into an executable plan.

## Solution

A one-time (re-runnable) **validation execution**: ingest real historical OHLCV for the MVP universe, run a mechanical proxy strategy through the existing backtest harness across a small grid of parameter configurations, and score every configuration through the existing walk-forward/DSR/PBO/MinBTL machinery. The output is a pass/fail verdict against Stage 2's kill line — not new pipeline code.

Four pieces, each already decided by map #154's child tickets:

- **Data (#155, #157):** Polygon.io/Massive as the historical OHLCV vendor for both asset classes (Alpaca and Kraken/ccxt are confirmed unsuitable for multi-year history — Alpaca's free tier is IEX-only, Kraken's OHLC REST endpoint hard-caps at 720 candles). Stored as a separate, research-only local dataset (Parquet or a scratch SQLite file), **not** the shared store's `bars` table — that table doesn't exist yet, and this execution isn't blocked on it. Requires a Polygon/Massive API key to be provisioned before ingestion (an ops/setup task, not a design decision).
- **Strategy (#156):** a dual-SMA crossover (fast=10, slow=30) with ATR-sized stop/target (2×/3×, `atrWindow`=14), long and short. Entry is **level-based** ("still trending" — enter whenever flat and the trend already favors a direction), not edge-triggered on the crossover event itself; David's explicit call, with the plan to dry-run in paper trading and revert to edge-triggered momentum-on-reversal if the level-based rule doesn't pay.
- **Replay driver (#158):** a new module, `replay-driver.ts`, living in `cost-model-backtest` alongside `eval-executor.ts` (not a new component). It steps the proxy strategy's signal through historical bars, routes every fill through `CostModel.fill` (not an assumed exact stop/target execution through a gap), and hand-constructs `ClosedTrade`/`Fill` records to implement `ReplayTradeSource`/`ReplayTimeline`. Signal-exits bypass `BrokerAdapter` (it has no flatten/cancel method) and call `CostModel.fill` directly. **This validation pass bypasses Trader/Risk/Verdict entirely** — the proxy strategy stands in for the whole pipeline (not just Analysts/Debate), because the point is to prove the harness's honesty (costs, no-lookahead, overfitting defenses), not to exercise the live gate sequence.
- **Trial design (#159, #160):** a 12-config grid — `fastWindow` ∈ {10, 20} × `slowWindow` ∈ {30, 50} × a risk:reward preset varying `atrStopMult`/`atrTargetMult` together ∈ {(2×, 3×), (1.5×, 2×), (3×, 4×)} — with `atrWindow` and `allowShort` held fixed. A 5-year data window (capped by #157's Polygon Stocks Starter tier) permits up to 45 independent trials under MinBTL; N=12 is comfortably under that cap, leaving headroom rather than searching right up to the limit. Walk-forward split: 5 folds, `barMs` = 1 day (matches the daily-bar-cadence grid), `embargo` = 50 bars (sized to the largest `slowWindow`, 50, in the grid).

Key architectural decisions:
- **Mechanical proxy, not the live pipeline** — this validates the harness's correctness, not the LLM debate's edge. Comparing LLM-debate performance against this baseline is an explicit, separate, later question (Stage 3/paper-trading territory).
- **Replay driver bypasses the full gate sequence, not just Analysts/Debate** — a deliberate scope choice: the proxy strategy is a complete stand-in, and the driver's `ClosedTrade`/`Fill` construction is contained entirely to this backtest-only path (it never touches `execution-spec.md`'s live write path).
- **Separate research-only data store** — decouples this execution from the (not-yet-charted) shared-store schema effort; migrate later if/when a real `bars` table exists.
- **N stays well under the MinBTL cap** — 12 trials against a 45-trial ceiling, so a marginal DSR/PBO result isn't itself in question because of trial-count pressure.
- **CPCV scoring is out of scope** — `eval-executor.ts`'s `testRangeOf` already documents this as a known, deferred gap (the exposure denominator can't handle disjoint test ranges yet). The staged-deployment research doc treats CPCV as "if feasible," so walk-forward alone satisfies Stage 2's exit condition.

## User Stories

### Data Ingestion

1. As the validation execution, I want real historical OHLCV for SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD from Polygon.io/Massive, so that the replay runs over real market history rather than fixtures.
2. As the validation execution, I want the ingested data stored in a separate, research-only local dataset (Parquet or scratch SQLite), so that this execution is not blocked on the shared store's `bars` table, which doesn't exist yet.
3. As David, I want the ingestion to cover a 5-year window (the depth available at the Polygon Stocks Starter / Currencies Starter tier), so that the MinBTL trial cap (~45) is computed against a real, not assumed, sample length.

### Mechanical Proxy Strategy

4. As the replay driver, I want a deterministic dual-SMA-crossover strategy (fast/slow windows, ATR-sized stop/target, long+short) standing in for the live pipeline, so that Stage 2 validates the harness against a strategy with a known, inspectable rule rather than an opaque LLM debate.
5. As the mechanical strategy, I want to enter whenever flat and the trend already favors a direction (level-based), not only on the crossover event itself, so that the rule matches David's chosen shape rather than a stricter edge-triggered variant that wasn't asked for.

### Replay Driver

6. As the replay driver, I want to step the proxy strategy through the ingested historical bars and route every fill through `CostModel.fill`, so that no simulated trade in this validation is cheaper than reality (the same honesty guarantee the live harness provides).
7. As the replay driver, I want signal-driven exits to call `CostModel.fill` directly (bypassing `BrokerAdapter`, which has no flatten/cancel method), so that an exit is priced honestly without requiring a broker-adapter capability that doesn't exist.
8. As the replay driver, I want to bypass Trader/Risk/Verdict entirely for this validation pass, so that the proxy strategy is judged as a complete substitute for the pipeline, not partially gated by live-pipeline logic this execution isn't testing.
9. As the replay driver, I want to implement `ReplayTradeSource`/`ReplayTimeline` (the ports `eval-executor.ts` already expects), so that the existing, unit-tested eval executor can score this run without any changes to its own code.

### Trial Execution

10. As the validation execution, I want to run all 12 grid configurations (`fastWindow` × `slowWindow` × risk:reward preset) through the harness and log each in `ConfigTrialLog` by its config hash, so that N is real and DSR/PBO/MinBTL deflate against an honest trial count.
11. As the validation execution, I want each configuration scored via `EvalExecutor.evaluate` with a 5-fold walk-forward split (`barMs`=1 day, `embargo`=50 bars), so that every configuration's out-of-sample metrics come from the same split discipline.
12. As David, I want the full metrics suite (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew, kurtosis, turnover, exposure) reported per configuration, both whole-window and per-split, so that no single number is judged in isolation (Stage 2's own discipline).

### Verdict

13. As David, I want the Deflated Sharpe Ratio, PBO, and MinBTL verdict computed for the full 12-trial run, so that Stage 2's kill line (OOS Sharpe < 0.5, PBO > 0.05, insignificant DSR) can be checked against a real result.
14. As David, I want the verdict recorded (pass, or kill/rework per the staged-deployment plan's decision thresholds), so that the decision to proceed to Stage 3 — already underway via the Production Composition Root (ADR-0004) — rests on a real Stage 2 result rather than an assumed one.

## Implementation Decisions

### Module: Historical Data Ingestion

**Responsibilities**
- Ingest OHLCV bars for the MVP universe from Polygon.io/Massive over a 5-year window.
- Persist to a separate, research-only local dataset.

**Key Interfaces**

```typescript
// Research-only store, NOT the shared store's `bars` table.
interface Stage2HistoricalStore {
  ingest(symbol: string, window: DateRange): Promise<void>;
  bars(symbol: string, window: DateRange): Promise<Bar[]>;
}
```

- Requires a Polygon/Massive API key provisioned before first ingestion (Stocks Starter + Currencies Starter tiers, per #157) — an ops/setup task, tracked as its own implementation-ticket acceptance criterion, not designed further here.
- This store implements the `ReplayTimeline` and (via the replay driver) the historical-bar side of `InstrumentRegistry.membershipDuring` for the survivorship-free assertion the harness already runs (`universe.ts`).
- Point-in-time / no-lookahead discipline applies identically to this data: the harness's existing `LookaheadAuditor` seam wraps it the same as any other injected data source.

### Module: Mechanical Proxy Strategy

**Responsibilities**
- Produce a deterministic long/short/flat signal from OHLCV, with ATR-sized stop/target levels.

**Key Interfaces**

```typescript
interface ProxyStrategyConfig {
  fastWindow: number;   // 10 | 20
  slowWindow: number;   // 30 | 50
  atrWindow: number;    // 14, fixed
  atrStopMult: number;  // 1.5 | 2 | 3, paired with atrTargetMult
  atrTargetMult: number; // 2 | 3 | 4, paired with atrStopMult
  allowShort: boolean;  // true, fixed
}

interface ProxySignal {
  direction: 'long' | 'short' | 'flat';
  stop: number;
  target: number;
}
```

- Level-based entry: whenever flat, enter in the direction the SMA crossover currently favors (fast above slow → long-favoring; fast below slow → short-favoring), not only at the crossover event itself.
- Stop/target computed from the ATR at entry, scaled by the config's paired multipliers.
- Deliberately the *only* strategy logic this spec introduces — no attempt to make it competitive with the live debate pipeline; it exists purely as a known, inspectable substrate for validating the harness.

### Module: Replay Driver (`cost-model-backtest/replay-driver.ts`)

**Responsibilities**
- Step the proxy strategy through the ingested historical bars.
- Route every fill through `CostModel.fill`.
- Produce `ClosedTrade`/`Fill` records implementing `ReplayTradeSource`.

**Key Interfaces**

```typescript
// Implements the ports eval-executor.ts already expects (eval-types.ts) —
// no changes to eval-executor.ts itself.
interface ReplayDriver {
  run(config: ProxyStrategyConfig, window: DateRange): Promise<{
    trades: ReplayTradeSource;   // closedTrades() / fills(), per eval-types.ts
    timeline: ReplayTimeline;    // barTimestamps(), per types.ts
  }>;
}
```

- Bypasses `BrokerAdapter`, Trader, Risk, and Verdict entirely — this is a backtest-only path, contained to `cost-model-backtest`, and never touches the live execution write path (`execution-spec.md`'s `ExecutionStore`).
- Entries and signal-exits both call `CostModel.fill(request, marketState)` directly rather than assuming an order fills exactly at its stop/target level through a gap — the same pessimistic-fill discipline the live harness already enforces.
- Hand-constructs `ClosedTrade`/`Fill` records (with `Fill.cost_breakdown` populated from `CostModelResult`, mirroring the Simulated adapter) so `eval-executor.ts`'s `assertCostModelPriced` check (which reads `Fill.cost_breakdown` to confirm the cost model — not an assumed price — priced every fill) passes without special-casing this path.
- Asserts survivorship-freeness via the existing `universe.ts` seam before the first bar, same as any other backtest run.

### Module: Trial Execution

**Responsibilities**
- Run all 12 grid configurations through the replay driver and `EvalExecutor`.
- Log every configuration in `ConfigTrialLog`.

**Key Interfaces**

Uses existing seams unchanged: `ConfigTrialLog.recordTrial(config_hash, result)`, `EvalExecutor.evaluate(options)` (`eval-types.ts`), `generateSplits(window, 'walk_forward', { barMs: 86_400_000, embargo: 50 })` (`splits.ts`).

- Grid: `fastWindow` ∈ {10, 20} × `slowWindow` ∈ {30, 50} × risk:reward preset ∈ {(2×, 3×), (1.5×, 2×), (3×, 4×)} = 12 distinct `config_hash` values, `atrWindow`=14 and `allowShort`=true fixed across all 12.
- Each trial calls `ConfigTrialLog.recordTrial` exactly once for selection — a re-run of the same config is a no-op for N, per the log's existing dedup-by-hash contract; this execution does not re-run a config once selected.
- `EvalOptions.periodsPerYear` = 252 for the stock-instrument configs, 365 for the crypto-instrument configs — the two asset classes are evaluated as separate `EvalReport`s (mixing them into one return series would misannualize both).

### Module: Verdict

**Responsibilities**
- Compute DSR, PBO, MinBTL over the 12 logged trials.
- Record the pass/kill result against Stage 2's kill line.

**Key Interfaces**

Uses existing seams unchanged: `overfitting.ts`'s DSR/PBO/MinBTL functions, `ConfigTrialLog.distinctTrialCount()` as N.

- MinBTL check: N=12 against a limit computed from the 5-year window (~45 at the reference 1.0 annual Sharpe target) — expected to report `exceeded: false` given the built-in headroom.
- PBO check: reject if `pbo > 0.05` (the spec's hard kill line, unchanged from `overfitting.ts`'s `PBO_REJECT_THRESHOLD`).
- Result recorded as a written verdict (pass → proceed with Stage 3 as already underway via ADR-0004; kill/rework → back to Stage 2 per the staged-deployment plan, and the in-flight Production Composition Root work should be flagged, not silently continued past a failed gate).

## Testing Decisions

- **Replay driver seam:** `ReplayDriver.run(config, window)` — given fake historical bars and a fake `CostModel`, assert the produced `ClosedTrade`/`Fill` records match the injected fill prices exactly (no drift from an assumed stop/target fill), and that `Fill.cost_breakdown` is always populated (the `assertCostModelPriced` precondition).
- **Grid-generation test:** asserts the 12 configs are exactly the documented cross-product (`fastWindow` × `slowWindow` × the three paired risk:reward presets), with `atrWindow`/`allowShort` fixed — a regression guard against silently adding or dropping a config, which would change N without anyone noticing.
- **No new tests for `overfitting.ts`/`metrics.ts`/`cost-model.ts` themselves** — those are already 117/117 tested and independently reviewed (map #154's note); this execution is a consumer of them, not a re-verification.
- Good tests here assert the replay driver's wiring/fill discipline, not the proxy strategy's trading performance — the strategy's actual Sharpe is the *output* of running the tests, not something to hard-code and assert against.
- Prior art: the same seam-testing discipline as `cost-model-backtest-spec.md`'s own testing decisions (fakes for injected dependencies, assert on outputs/side-effects).

## Out of Scope

- **CPCV scoring** — `eval-executor.ts` already defers this (the exposure denominator can't handle disjoint test ranges yet); not this spec's job to extend `TradeSeries` to carry multiple sample ranges. Walk-forward alone satisfies Stage 2's exit condition per the staged-deployment research doc.

  **Amended 2026-08-05 (#406).** Walk-forward alone turned out *not* to satisfy the exit condition: it produces 5 anchored folds, and the kill line's PBO term needs the symmetric partition `pbo()` is defined over, so PBO was uncomputable on every run. A `cscv` split scheme was added — purged 6-fold, one group held out at a time — and `runTrialGrid` scores it as an opt-in second pass. This does *not* reverse the exclusion above: the reason CPCV is out of scope is the disjoint-test-range exposure denominator, and CSCV's single contiguous test range per fold never meets it. CPCV scoring remains deferred, and `TradeSeries` is unchanged.
- **Comparing LLM-debate performance against the mechanical baseline** — a separate question for later (Stage 3/paper-trading territory), not part of proving the harness works.
- **Stage 3/4 (paper trading launch, live capital deployment)** — covered by ADR-0004 and wayfinder map #224, not here.
- **Shared SQLite store schema design** — a separate, not-yet-charted effort; this execution's data store is intentionally decoupled from it.
- **Making the mechanical proxy strategy profitable or sophisticated** — it exists solely to validate the harness, not to be a strategy candidate in its own right.
- **A second/alternate mechanical strategy for a more robust read** — map #154 flagged this as an open question and left it unresolved; this spec proceeds with the single dual-SMA strategy and treats a second strategy as a future addition if the single-strategy result is ambiguous.

## Further Notes

Wayfinder decisions for this execution live in issue [#154](../../issues/154) and its six resolved child tickets (#155-#160). This spec is the direct synthesis of that map's "Decisions so far," per its own closing comment: "Next step (not yet started): synthesize these decisions into `docs/specs/stage2-validation-execution-spec.md` via `/to-spec`, then implement."

**Sequencing note relative to ADR-0004 / wayfinder map #224.** The Production Composition Root work (tickets #234-#238) is already underway and does not block on this spec, nor vice versa — they were charted independently. But the staged-deployment plan's own discipline says Stage 2's gate should pass *before* Stage 3 (paper trading) starts. This spec does not re-sequence that work; it surfaces the gap so `/to-tickets` and prioritization can account for it explicitly (e.g. by racing to a verdict before the Production Composition Root's first live paper tick, or by treating that ticket's target date as later than this validation's, rather than the two proceeding in silent parallel with no accounted relationship).

Ready for `/to-tickets`.
