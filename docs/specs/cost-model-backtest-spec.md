# Transaction-Cost / Market-Impact Model + Backtest Harness Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

> Load-bearing infrastructure, **not** one of the 6 pipeline stages. ONE component, two tightly-coupled parts: the **harness** drives replay; the **cost model** makes fills honest. This is where MOST of the binding research constraints (docs 00/01/02) are enforced. Wayfinder map: [docs/wayfinder/cost-model-backtest-map.md](../wayfinder/cost-model-backtest-map.md).

## Problem Statement

Every other stage was built to be deterministic, clock-blind, and mode-flagged — for one reason: so the system can be replayed honestly against history before it touches real money. But "replay honestly" is exactly the part that is easy to fake and catastrophic to get wrong. A backtest with optimistic fills manufactures an edge that evaporates live; a backtest that lets a strategy peek at future data manufactures an edge that never existed; a research campaign that tries a thousand configurations and reports the best one manufactures an edge from pure noise. The research (docs 00/01/02) is blunt: **backtests without realistic costs LIE, and overfitting is the central danger.** Uptime never creates edge — it amplifies the sign of whatever expectancy survives costs.

This component is the honesty layer. It has two tightly-coupled parts. The **cost model** turns any order into a pessimistic, realistic fill — spread + commission + slippage + √-law market impact — so no simulated trade is cheaper than reality. The **backtest harness** runs the *exact live pipeline* forward over point-in-time, survivorship-free history via an injected clock, produces fills through the cost model, and computes the full metrics suite plus the overfitting defences (walk-forward / CPCV, Deflated Sharpe, PBO, MinBTL) — logging every configuration tried so the trial count that deflates those metrics is real. It is the library the Feedback Loop and offline research both call; it is where "expectancy > 0 before any live money" is proven or disproven.

## Solution

The component is organized around a **three-mode matrix** and **two seams**.

The matrix makes "same code path" precise: every run differs only in three injected dependencies.

| Mode | Clock | Data | Broker adapter |
|------|-------|------|----------------|
| `backtest` | simulated (stepped bar-by-bar) | historical store | **simulated** (cost model) |
| `paper` | live wall-clock | live feed | **simulated** (cost model) |
| `live` | live wall-clock | live feed | real (Kraken / IBKR) |

The cost model is shared by **backtest and paper**; **real live fills are the calibration signal** that keeps it honest (the live-vs-modeled cost divergence FL watches).

The two seams:
- **`CostModel.fill(request, marketState) -> CostModelResult`** — deterministic, pessimistic fill with a transparent cost breakdown (spread + commission + slippage + √-law impact). Injected into Execution's simulated broker adapter, which maps the result onto Execution's persisted `Fill` record (`price`/`qty`/`cost_breakdown` — see execution-spec.md).
- **`Backtest.run(config, clock) -> BacktestReport`** — drives the *same orchestrator the live system runs* over the window (pipeline unchanged; only clock/data/broker swap), enforcing point-in-time / survivorship-free / no-lookahead, and returns the full metrics suite + walk-forward/CPCV distribution + DSR + PBO + MinBTL verdict + capacity ceiling.

A **validation library** underneath both seams owns the computational primitives (metrics suite, split generator, DSR, PBO, MinBTL guard, capacity ceiling, config-trial log). **The Feedback Loop and offline research are callers of this library — FL owns the live *cadence* and ~~the kill/rework *decision*~~; this component owns the *computation*.** *(Amended 2026-09-08 — [ADR-0013](../adr/0013-no-human-gate-anywhere.md) Decision 3: nobody owns a kill/rework decision under full automation. A kill-threshold breach must produce a mechanical response instead; FL's breach path (`server/pipeline/feedback-loop/metrics.ts`) alerts and defensively auto-tightens, with no halt-on-persistence implemented there yet. This component's boundary is unchanged — it owns the computation FL calls, not the response.)*

Key architectural decisions:
- **Three-mode matrix; cost model shared by backtest + paper** — live fills calibrate it.
- **Pipeline runs unchanged** — harness injects `{clock, data, broker, mode}` into the live orchestrator; this component **owns the simulated `Clock`** every stage injects.
- **Cost model has no zero-cost path** — a non-zero spread+commission floor even on the most optimistic config (Principle 1, structural).
- **√-law market impact** — `impact = k × volatility × √(size / ADV)`; this term *is* the capacity ceiling.
- **Point-in-time, survivorship-free, no-lookahead audited like a security vuln** — a failed lookahead check fails the run, it does not warn.
- **Metrics suite reported together** — single flat `MetricsSuite`, never one number.
- **Config-trial log keyed by config hash; N = distinct configs evaluated for selection** — re-runs and revalidations do NOT increment N.
- **Determinism = seed + clock, given the analyst response cache.**

## User Stories

### Cost Model

1. As Execution's simulated broker adapter, I want to call `CostModel.fill(request, marketState)` and get a realistic fill price with a cost breakdown, so that backtest and paper fills are never cheaper than reality.
2. As the cost model, I want to move the fill price adversely by spread + commission + slippage + √-law market impact (never favorably), so that costs are pessimistic by construction.
3. As the cost model, I want market impact to scale with √(order size / liquidity), so that scaling capital erodes edge super-linearly and the capacity ceiling is real.
4. As the cost model, I want asset-class-parameterized pessimistic defaults (stocks commission schedule / market-hours, with a Saxo-venue override for LSE ETP economics — `CostConfig.venues`, `server/tools/backtest/types.ts:162`), so that each venue's real frictions are modeled. *(Amendment (#1178): this story previously also asked for crypto funding — crypto left scope 2026-08-16, ADR-0015's amendment. It does not need to ask for daily-reset decay: ADR-0016 dismisses it on the flat-by-close premise ("Daily-reset decay does not apply. It punishes holding leveraged ETPs across sessions; a flat-by-close strategy never holds one overnight," ADR-0014), and doc 18 agreed at the time. Two real gaps were open when this amendment landed — the flat-by-close premise's edge cases (unfilled `DayOrder` expiry, #1215; a stop/target miss; a flatten shortfall), unmeasured rather than unspecced, and TER, genuinely unaddressed anywhere in this repo — both tracked as [#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434) rather than folded in here. **Amendment (#1434, 2026-09-15): both gaps are now measured, not open.** [`docs/research/60-leveraged-etp-ter-and-overnight-decay-exposure.md`](../research/60-leveraged-etp-ter-and-overnight-decay-exposure.md) fetches per-row TER-and-financing cost at ADR-0018 D5 sizes (small relative to Saxo's 16 bps commission and the #1548 bar-restatement scale — record, not model) and measures the flat-by-close premise's edge cases: #1389's flatten-window shortfall falsified the "never holds one overnight" premise on 6 of 9 control lots (fix since shipped, residual bounded and alerted), and #1215 remains genuinely unmeasured, open, with no incident data either way. ADR-0016's [2026-09-15 amendment](../adr/0016-universe-leveraged-etps-ungated.md) corrects the premise while preserving the no-`CostModel`-change conclusion. This story's premise above ("ADR-0016 dismisses it... and doc 18 agrees") is superseded by that correction — the dismissal now rests on overnight gap risk being second-order over a single reset, not on the position never being held overnight at all; no `CostModel` change follows regardless, so this story is otherwise unaffected.)*
5. As the system, I want even the most optimistic cost config to apply a non-zero spread+commission floor, so that no backtest can manufacture a frictionless fill (expectancy-first, structurally enforced).
6. As the cost model, I want to be deterministic given seed + inputs (slippage stochastic only in an opt-in seeded mode), so that fills are reproducible.

### Backtest Harness

7. As a researcher, I want `Backtest.run(config, clock)` to drive the exact live pipeline forward over historical data, so that the backtest exercises real code, not a re-implementation.
8. As the system, I want backtest/paper/live to differ only in the injected clock, data source, and broker adapter, so that "same code path" is literally true.
9. As the harness, I want to require survivorship-free data (delisted/bankrupt instruments present), so that I don't test only on today's winners.
10. As the harness, I want to audit look-ahead like a security vulnerability — fail the run if any stage reads a store row timestamped after `clock.now()` — so that no strategy peeks at the future.
11. As the harness, I want FL's daily-batch weight/param adaptation to replay point-in-time (weights evolve only from outcomes known before each T), so that walk-forward metrics have no lookahead-in-weights.
12. As the system, I want the same seed + injected clock to reproduce a run exactly (given the analyst response cache), so that results are auditable and re-runnable.

### Validation Library

13. As the operator, I want the full metrics suite (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew, kurtosis, turnover, exposure) computed together in one report, so that no single number misleads me.
14. As a researcher, I want a split generator for walk-forward and Combinatorial Purged Cross-Validation (with purge + embargo), so that I get a *distribution* of out-of-sample Sharpe ratios, not a single path.
15. As a researcher, I want the Deflated Sharpe Ratio computed from the number of distinct configs tried, sample length, and non-normality, so that my Sharpe is honest about how hard I searched.
16. As a researcher, I want the Probability of Backtest Overfitting computed from the CPCV distribution and a **reject-if-PBO > 0.05** verdict, so that overfit strategies are caught.
17. As a researcher, I want a MinBTL guard that warns/blocks when the distinct-config count for the data window exceeds the limit (~45 / 5 yr), so that I don't out-search my data.
18. As the system, I want every configuration tried logged to `config_trials` keyed by config hash, so that the trial count that deflates DSR/MinBTL is real and re-runs don't inflate it.
19. As a researcher, I want a capacity-ceiling estimate derived from the √-law impact, so that I know the size at which the edge is exhausted by impact.

### Relationship with the Feedback Loop

20. As the Feedback Loop, I want to call this component's `MetricsSuite` computation and DSR/PBO/walk-forward primitives (recomposing them into my own nested `MetricsReport`), so that I don't re-implement them and my live metrics match backtest metrics exactly.
21. As the Feedback Loop, I want revalidating an already-selected config to **read** the frozen selection-N and **not** append a new trial, so that periodic monitoring never inflates the trial count and kills a healthy strategy by construction.

## Implementation Decisions

### Module: Cost Model

**Responsibilities**
- Turn a fill request + market state into a pessimistic realistic `CostModelResult` with a transparent cost breakdown, which the Simulated adapter maps onto Execution's persisted `Fill`.
- Own the four cost components; guarantee the non-zero floor and the adverse-only direction.

**Key Interface**

```typescript
// Seam 1. Deterministic given seed + inputs. Injected into Execution's simulated broker adapter.
// Returns CostModelResult — an internal computation result, NOT Execution's persisted `Fill`
// record (execution-spec.md). The Simulated adapter maps this onto Execution's `Fill` (see below).
interface CostModel {
  fill(request: FillRequest, marketState: MarketState): CostModelResult;
  // Capacity ceiling: the size at which marginal expectancy net of impact → 0.
  capacityCeiling(marketState: MarketState, edgePerUnit: number): number;
}

interface FillRequest {
  instrument: string;
  side: 'buy' | 'sell';
  size: number;                       // absolute units
  order_type: 'market' | 'limit';
  limit_price?: number;
  idempotency_key: string;            // for dedup / join to the order intent
}

interface MarketState {
  mid: number;                        // mid price at the bar
  spread: number;                     // best-effort bid/ask spread estimate from MDS; cost model
                                      // fallback-models it from volatility when no bid/ask (OPEN-GAP-A)
  adv: number;                        // liquidity proxy from MDS ADV helper (bars-volume aggregation)
  volatility: number;                 // e.g. ATR or realized vol at the bar
  asset_class: 'crypto' | 'stocks';
  timestamp: Date;                    // = clock.now(); must be <= now (point-in-time)
}

// Distinct type name to avoid colliding with Execution's persisted `Fill` (execution-spec.md),
// which uses different field names (price/qty vs fill_price/filled_size) and is the sole
// persisted record. The Simulated adapter (this interface's one caller) maps this result onto
// Execution's `Fill` as: Fill.price = fill_price, Fill.qty = filled_size,
// Fill.cost_breakdown = cost_breakdown. `seed`, when present, is logged alongside but is not
// an Execution `Fill` field.
interface CostModelResult {
  fill_price: number;                 // mid moved adversely by the components below
  filled_size: number;                // may be < requested size in principle (server/tools/backtest/types.ts:87); the model
                                       // always fills the full request — partial fills are a real-broker
                                       // concern that lives in Execution (see "Execution / broker order
                                       // placement" below), not something this component mandates
  cost_breakdown: {                   // transparent; mapped onto Execution's Fill.cost_breakdown
    spread_cost: number;
    commission: number;
    slippage: number;
    market_impact: number;            // √-law term
  };
  seed?: number;                      // recorded when slippage stochastic mode is on
}
```

**Fill-price construction (pessimistic, adverse-only)**

`fill_price = mid + sign(side) × (half_spread + slippage + market_impact)`, plus `commission` booked separately. `sign(side)` is `+1` for buy, `−1` for sell — the price always moves **against** the order.

1. **Spread cost** — cross the half-spread; the "price of immediacy" (Demsetz). `spread` in `MarketState` is expected to widen under volatility (crypto spreads blow out in stress), so this term is regime-sensitive.
   - **Spread sourcing — OPEN-GAP-A resolution (hybrid).** OHLCV bars carry no bid/ask, so `MarketState.spread` is sourced **best-effort** and the cost model never assumes a clean spread: (a) the **Market Data Service best-effort exposes a spread *estimate*** where the source provides bid/ask *(Amendment 2026-09-10 (#1479): not crypto ccxt quotes — that arm was deleted by #1151. The only bid/ask-capable arm today is the LSE mark source, unreachable pending #895/#1034; see `market-data-service-spec.md`'s Amendment section)*; (b) where no bid/ask is available (historical stock bars), the **cost model fallback-models the spread from `volatility` + a per-asset-class spread model**, so a fill always has a non-zero spread term. Because the fallback lives in the cost model, `spread` is effectively best-effort / nullable at the cost-model input. `MarketState.adv` is sourced from an **MDS ADV helper** aggregating `bars` volume over the point-in-time window. This adds a dependency on the Market Data Service (spread-estimate output + ADV helper) — see Dependencies. (Cross-spec §OPEN-GAP-A, resolved-with-decision.)
2. **Commission** — taker fee (crypto) or per-share/flat commission (IBKR), or a flat rate on notional for the live venue (Saxo: 0.08% per side with no per-order minimum, measured on the live GIA 2026-09-14 — see [#1311](https://github.com/dd-jp/samurai-trading-system/issues/1311#issuecomment-5668017278) and ADR-0015's 2026-09-14 amendment). Chan's ~5 bps ex-commission for S&P names is the sanity anchor for the stock defaults.
3. **Slippage** — adverse offset from latency + drift between signal and fill (crypto API latency ~100–200 ms). **Deterministic by default** (`slippage ∝ volatility × latency`); **opt-in seeded stochastic mode** for sensitivity runs. Never favorable.
4. **Market impact — √-law** — `market_impact = k × volatility × √(size / adv)` (Almgren-style). Super-linear in size; this term *is* the capacity ceiling (`capacityCeiling` inverts it: the size at which impact eats the per-unit edge).

**No zero-cost path (Principle 1, structural):** the most optimistic config still applies a non-zero `half_spread + commission` floor. A frictionless fill is not representable.

**A holding cost is not part of `fill()`.** `fill()` is execution-only; any per-interval holding cost on an open position would apply during mark-to-market, in the harness, keeping `fill()` single-responsibility. *(Amendment (#1178): this used to name crypto perpetual funding and stock borrow — both dead with crypto out of scope (ADR-0015's 2026-08-16 amendment) and neither ever built, `types.ts` has no accrual function. It is not the leveraged-ETP holding cost either: daily-reset decay was considered and dismissed by ADR-0016 on the flat-by-close premise (a position is never held overnight, ADR-0014) as that ADR then stood. Two real gaps were open when this amendment landed — that premise's edge cases (unfilled `DayOrder` expiry, #1215; a stop/target miss; a flatten shortfall), unmeasured rather than unspecced, and TER, genuinely unaddressed anywhere in this repo — both tracked as [#1434](https://github.com/dd-jp/samurai-trading-system/issues/1434) rather than folded in here. **Amendment (#1434, 2026-09-15): both gaps are now measured.** ADR-0016's flat-by-close premise turned out to be empirically false — [#1389](https://github.com/dd-jp/samurai-trading-system/issues/1389) recorded 6 of 9 control-arm lots carrying overnight with no flatten intent ever produced — but [`docs/research/60-leveraged-etp-ter-and-overnight-decay-exposure.md`](../research/60-leveraged-etp-ter-and-overnight-decay-exposure.md) and ADR-0016's [2026-09-15 amendment](../adr/0016-universe-leveraged-etps-ungated.md) find the actual hazard an edge-case carry is exposed to is the underlying's overnight gap risk levered 3x (owned by #1389, fix shipped, and #1215, open) rather than daily-reset decay, which stays second-order over the one-or-two-session carries the mechanism failures actually produce. TER (and the larger margin-financing cost it under-names for the two Leverage-Shares-structured rows) is measured per row at ADR-0018 D5 sizes and found small relative to Saxo's 16 bps commission and the #1548 bar-restatement scale. Neither measurement adds a `CostModel` seam — both land on "record", not "model" — so this paragraph's structural claim (holding cost is not part of `fill()`) is unchanged; only the "never held overnight" / "genuinely unaddressed" premises above are corrected.)*

### Module: Backtest Harness

**Responsibilities**
- Drive the *same orchestrator the live system runs* over the window, injecting `{clock, data, broker adapter, mode}`.
- Own the simulated `Clock`; step it monotonically bar-by-bar.
- Enforce point-in-time / survivorship-free / no-lookahead. *(Amendment (#1178): this line previously also said "apply holding costs (funding/borrow) at mark-to-market" — `eval-executor.ts` applies no such thing; funding/borrow were crypto/margin concerns that never got built and are now out of scope. See the "holding cost" note above for the real gap this exposes.)*
- Assemble the `BacktestReport` via the validation library.

**Key Interface**

> **SUPERSEDED (2026-09-09) — `Backtest` and `BacktestConfig` deleted, #1156.** No composition
> root ever constructed `BacktestHarness`, the one `Backtest` implementation, so neither interface
> exists in the tree any more. `BacktestReport` below is unaffected — `trial-execution.ts` remains
> its one real writer, still filling only the #88 subset this section describes.

```typescript
// Seam 2. Deterministic given seed + clock (and the analyst response cache).
interface Backtest {
  run(config: BacktestConfig, clock: Clock): BacktestReport;
}

interface BacktestConfig {
  config_hash: string;                 // hash of the full strategy/param/feature config;
                                       // the config_trials key and DSR/MinBTL trial identity
  window: { start: Date; end: Date };
  universe: string[];                  // survivorship-free (delisted names included)
  cost_config: CostConfig;             // asset-class pessimistic params (non-zero floor)
  seed: number;                        // reproducibility
  validation?: {                       // optional: run walk-forward / CPCV
    scheme: 'walk_forward' | 'cpcv';
    embargo: number;                   // bars purged around each test fold (CPCV)
  };
}

interface BacktestReport {
  config_hash: string;
  seed: number;
  metrics: MetricsSuite;               // full suite (owned by the validation library)
  walk_forward?: {
    oos_sharpe_distribution: number[]; // one per path/fold
    deflated_sharpe: number;
    pbo: number;                       // reject if > 0.05
    minbtl: { limit: number; distinct_configs: number; exceeded: boolean };
  };
  capacity_ceiling: number;            // from the √-law impact
  lookahead_audit: 'passed' | 'failed';// a failure fails the run
  // No `invalidation_replay` field (restated 2026-09-03 after #994's fold — see
  // "The replay property is a byte-identical decision, not an attestation" below).
  // The standalone `invalidation` stage this field was specced for (added to this
  // interface 2026-09-02 per docs/reviews/devils-advocate-spec-cross-verify-2026-09-02.md
  // GAP-E) was declined that same day; its cold-window inertness has nothing to attest
  // to, since conditions now ride the same verdict the backtest already replays either
  // way. `server/tools/backtest/types.ts`'s real `BacktestReport` has no such field.
}
```

**The simulated `Clock`** is owned here and matches the interface every stage already injects (`clock.now()`); in `backtest` it is the stepped simulated time T, in `paper`/`live` the wall-clock.

**Backtest-scoped shared store:** fills/positions land in an isolated DB/namespace with the *same schema* as live, so Risk's portfolio view, the Trader's cosine store, and FL behave exactly as live.

**No-lookahead audit (security-vuln posture):** no-lookahead is primarily enforced below the pipeline (data services return only `timestamp <= clock.now()`); the harness adds an assertion pass — if any stage reads a store row timestamped after `clock.now()`, the run **fails** (`lookahead_audit: 'failed'`), it does not warn.

**FL walk-forward replay:** the harness reuses FL's daily-batch code path so weights/params evolve from only outcomes known before each T — a point-in-time weight trajectory, never global-fit-and-applied-retroactively. The harness provides the replay engine; FL provides the adaptation logic (feedback-loop-spec).

### Module: Validation Library

**Responsibilities** — own the computational primitives FL and offline research both call.

> **SUPERSEDED (2026-08-06) — the executor is TypeScript, in-tree, not pybroker.** The paragraph
> below is retained as the original design rationale, but it no longer describes the code. There is
> no pybroker dependency and no Python anywhere in the repo; ADR-0001 resolved the language to
> TypeScript. The split generation, eval metrics and overfitting tests were built natively —
> `server/tools/backtest/eval-executor.ts`, `splits.ts`, `metrics.ts`, `overfitting.ts` — and have
> since produced real Stage 2 verdicts (see `stage2-verdict.ts`). What the paragraph gets *right*
> and what still holds: pybroker could never host the tick loop, and `CostModel.fill` remains the
> single fill authority. See `docs/reviews/triage-2026-08-06.md` F-10.

**~~Backtest/eval executor — pybroker (ADR-0001).~~ SUPERSEDED 2026-08-06 — the executor is the in-tree TypeScript `eval-executor.ts`; no pybroker dependency and no Python exist in this repo. Read "pybroker" below as "the eval executor", and do not derive an implementation ticket that adds a Python dependency.** The walkforward/CPCV split generation and eval-metric computation are executed via **pybroker** (mine `src/eval.py` eval metrics + `src/strategy.py` walkforward-split patterns), not a fully-custom harness. pybroker is the executor of the **eval/validation layer only** — it runs the splits and computes eval metrics over the trades the orchestrator produces. It does **NOT** host the pipeline tick loop: its synchronous per-bar `exec_fn` cannot host the seconds-to-minutes LLM debate (verified in the base-repo analysis), so the harness + live orchestrator keep the simulated `Clock` and drive the pipeline unchanged (see Backtest Harness above). Crucially, **the transaction-cost / market-impact model stays ours** and is **injected into the pybroker eval path**: pybroker's built-in fill model is not pessimistic enough for the √-law market-impact requirement (Principle 2), so `CostModel.fill` remains the single fill authority (one implementation → live metrics == backtest metrics, cross-spec §5) and pybroker consumes it rather than its own fills. FL owns the live metric *cadence*; this component (via pybroker) owns the computation. <!-- cite-exempt: foreign — the two Python paths on this line are pybroker's own tree, a different repository; they are not expected to exist here -->

> **Further SUPERSEDED (2026-09-09) — the harness that "keeps the simulated `Clock` and drives
> the pipeline unchanged" no longer exists.** #1156 deleted `BacktestHarness`: no composition root
> ever constructed it, and no open issue depended on wiring it. Stage 2 runs `ReplayDriver` +
> the proxy-strategy signal instead, which does not drive the live pipeline at all — see
> `ReplayDriver`'s import-list test, which refuses by construction to import the Trader, Risk
> Manager or Verdict.

**Key Interface**

```typescript
interface ValidationLibrary {
  // OWNED HERE. FL recomposes these into its nested MetricsReport (cross-spec change below):
  //   FL.MetricsReport.daily = this MetricsSuite; .revalidation = DSR/PBO/walk-forward output;
  //   .breaches stays FL-only.
  computeMetrics(returns: ReturnSeries, trades: TradeSeries): MetricsSuite;

  // Split generation → a distribution of OOS Sharpe, not a single path.
  generateSplits(window: DateRange, scheme: 'walk_forward' | 'cpcv', embargo: number): Split[];

  deflatedSharpe(sharpe: number, n_distinct_configs: number, sampleLen: number,
                 skew: number, kurtosis: number): number;
  pbo(oosDistribution: number[]): number;                 // reject if > 0.05
  minbtl(window: DateRange): { limit: number };            // ~45 / 5yr

  // Config-trial log (shared SQLite). N = DISTINCT configs evaluated for selection.
  recordTrial(config_hash: string, result: BacktestReport): void;   // dedups by hash
  distinctTrialCount(): number;                                     // = N for DSR/MinBTL
}

interface MetricsSuite {                  // reported together — never one number
                                          // (= FL's MetricsReport.daily; see cross-spec #1)
  sharpe: number;      // annualized respecting serial correlation (Lo 2002; no naive ×√N)
  sortino: number;
  calmar: number;
  max_drawdown: number;
  profit_factor: number;
  expectancy: number;                     // (P_win×AvgWin) − (P_loss×AvgLoss) − costs
  skew: number;
  kurtosis: number;
  turnover: number;
  exposure: number;
}
```

**Config-trial log — the trial-count discipline (load-bearing):**
- Stored in the **shared SQLite** as `config_trials`, keyed by **config hash**.
- **N = number of DISTINCT configs evaluated *for selection*** — not the number of runs. Re-running the same config adds **no** trial (dedup by hash). N is what DSR and MinBTL deflate by.
- **Revalidating an already-selected config never increments N** — FL's periodic revalidation *monitors one frozen, selected config*; it **reads** the selection-N and does not append a trial. (If N were run-count it would grow without bound and DSR/PBO/MinBTL would fail healthy strategies for reasons unrelated to overfitting — the spec would fight itself.)
- **This is read-only at the API level, not just semantically.** `config_hash` is `config_trials`' `PRIMARY KEY` and `recordTrial` upserts on conflict (per [#179](https://github.com/dd-jp/samurai-trading-system/issues/179) and `shared-sqlite-store-spec.md`) — a `recordTrial` call during revalidation would silently overwrite `recorded_at` and be indistinguishable from a genuine new trial. FL's revalidation path must read `config_trials` directly (`SELECT ... WHERE config_hash = ?`) and must **never** call `recordTrial`. The schema does not enforce this — it is caller discipline, and violating it silently corrupts DSR/PBO/MinBTL with no error raised.
- **FL's bounded auto-tuning is NOT a new trial** — the guardrail bounds were part of the validated config, so in-bounds adaptation is not a new selection search.
- **Offline research writes one trial row per new distinct config** it evaluates for selection.

**DSR / PBO / MinBTL:**
- **DSR** deflates the observed Sharpe by N (distinct configs), sample length, and non-normality (skew/kurtosis).
- **PBO** = probability the in-sample-best config underperforms the median OOS across CPCV paths. **Reject if PBO > 0.05.**
- **MinBTL** caps independent trials by data length (~45 / 5 yr); the report flags `exceeded` when `distinct_configs > limit`.

**Capacity ceiling:** `CostModel.capacityCeiling` inverts the √-law impact — the size at which marginal expectancy net of impact reaches zero. Surfaced in `BacktestReport.capacity_ceiling`.

### Module: Determinism

- **Seed + injected clock ⇒ reproducible run.** Seed recorded in `BacktestReport`; slippage stochastic mode draws only from the seeded RNG.
- **Conditional on the analyst response cache.** Trader / Debate / Risk / Verdict / FL are already deterministic. The Analysts are LLM; end-to-end reproducibility rests on the **analysts' temperature-0 + input-hash response cache** (analysts-spec). Determinism is guaranteed *given the analyst cache*, not asserted over live LLM calls.
- **Invalidation conditions replay with the Risk Critic's verdict; there is no separate stage and no separate replay port (restated 2026-09-03 after #994's fold).** The five bullets this replaces described a standalone `invalidation` stage (2026-08-05, [Wayfinder: Devil's Advocate](https://github.com/dd-jp/samurai-trading-system/issues/291); devils-advocate-spec.md) with its own `InvalidationEmissionSource` replay port. David declined that stage 2026-09-02 and #994 folded the mechanism into the Risk Critic instead, per `risk-manager-spec.md`'s "Module: Risk Critic — the invalidation fold" and cross-spec-contracts.md §8:
  - **The `backtest` producer replays the persisted `EvaluatedCondition[]` from `risk_critic_log` and does not re-evaluate.** This is a deliberate deviation from `devils-advocate-spec.md`'s split-by-nondeterminism-source design (emission replayed, evaluation re-run): under the fold the persisted unit is the whole *verdict*, ADR-0003 §2 already makes the verdict replay-from-log, and re-running evaluation would require handing the backtest producer the Market Data Service it deliberately holds none of. `ReplayRiskCriticProducer` holds no LLM client, so "no live call in a replayed path" is structural, not a runtime check.
  - **Lookup is by `debate_id`, not `(instrument, bar_timestamp)`** — the same key `risk_critic_log` already uses for the prose verdict; there is no separate coordinate and no `invalidation_log` to look it up in.
  - **A row with no persisted conditions — pre-fold, or a persisted list that fails shape validation on read — replays as `no_conditions`.** This is the *same* code path the live run uses for "nothing checkable came out," not a distinct `unavailable` marker: the prose verdict replays with the authority it always had, so historical backtest results are unchanged by the fold.
  - **The replay property is a byte-identical decision, not an attestation.** There is no `BacktestReport.invalidation_replay` field — that belonged to the declined stage's cold-window inertness, which no longer applies (conditions ride the same verdict the backtest already replays either way). #997's acceptance criterion instead states the invariant directly: a replayed decision is identical in status, size and `binding_constraint` to the one the live run reached; `reasons` gains exactly one `no_conditions` line where the live run had none, and is not otherwise byte-identical.
  - **A validator or evaluator fix does not retroactively apply to already-logged post-fold rows** — only newly-emitted conditions get corrected behaviour. This is the cost of replaying the verdict rather than re-running the validator, recorded here rather than left to be discovered.
  - The Risk Critic step still only runs on the `BacktestHarness` path — Stage-2's `ReplayDriver` refuses by construction to import the Trader, Risk Manager, or Verdict, enforced by a test over its import list. *(SUPERSEDED 2026-09-09 — #1156 deleted `BacktestHarness`: no composition root ever constructed it. The Risk Critic replay path this bullet describes now runs on no path at all; `ReplayDriver`'s refusal to import the Risk Manager stands as before.)*

## Testing Decisions

### What Makes a Good Test

- Test `CostModel.fill` at its seam: a given request + market state yields the expected adverse fill price and cost breakdown; the fill is **never** better than mid ± half-spread; scaling `size` scales impact by √; the optimistic config still charges a non-zero floor.
- Test `Backtest.run` at its seam: a scripted historical dataset + mock clock yields a deterministic `BacktestReport`; same seed → identical report.
- **No-lookahead:** a strategy rigged to read a future-timestamped row causes `lookahead_audit: 'failed'` and the run fails.
- **Survivorship:** a universe missing delisted names is rejected/flagged.
- **Trial-count semantics (load-bearing):** re-running the same `config_hash` does not increment `distinctTrialCount`; a revalidation run does not append a trial; two genuinely different configs increment N by exactly 2.
- **DSR/PBO/MinBTL:** a known synthetic overfit case yields PBO > 0.05 and is rejected; DSR falls as N rises for a fixed Sharpe; MinBTL flags `exceeded` past the limit.
- **Metrics:** the full suite is computed together; Sharpe annualization respects serial correlation (no naive ×√N).
- **Capacity ceiling:** a higher-impact `k` yields a lower ceiling.
- **FL walk-forward replay:** the point-in-time weight trajectory is reproducible and uses no future data.

### Modules to Test

**Cost Model**, **Backtest Harness**, **Validation Library** (metrics, splits, DSR/PBO/MinBTL, config-trial log), **Determinism** — as above.

### Prior Art

- No implementation yet. Injected-clock / mode-flag patterns mirror Analysts, Risk, Trader, Verdict, FL. The point-in-time / walk-forward discipline mirrors the Trader and FL backtest decisions. This component *owns* the simulated `Clock` those stages inject.

## Out of Scope

**The strategy / market model itself** — the harness evaluates strategies; it does not contain one (CONTEXT.md invariant).

**FL's cadence, breach-response, and kill/rework flow** — FL owns the live cadence and ~~the kill decision~~; this component provides the primitives FL calls. No duplication of cadence logic here. *(Amended 2026-08-09 by [ADR-0013](../adr/0013-no-human-gate-anywhere.md): the kill is no longer "human-owned". Nothing about this component's ownership boundary changes — only the actor on FL's side of it.)* *(Amended 2026-09-08 — "kill decision" reworded to "breach response": ADR-0013 Decision 3 means nobody owns a kill/rework decision under full automation. FL's breach response today is alert + defensive auto-tighten (`server/pipeline/feedback-loop/metrics.ts`); no halt-on-persistence is implemented yet.)*

**Execution / broker order placement** — the real Kraken/IBKR adapters, partial fills, retries, and idempotent order IDs live in Execution (uncharted). This component defines the `CostModel.fill` seam the **simulated** adapter uses, not the adapter itself.

**Live trade-channel alerting** — FL and Verdict own Telegram/Discord; the harness returns reports, it does not message humans.

**Data ingestion / sourcing** — the Market Data Service + Market Intelligence own the historical stores; this component consumes them and asserts their point-in-time / survivorship-free contract.

**Exact values** — spread/impact coefficients, fee schedules, latency assumptions, the MinBTL constant, and capacity-ceiling parameters are config, with pessimistic defaults. **The PBO threshold is the exception, and is not free config:** `CONTEXT.md` states 0.05 as a bright line ("Kill if PBO > 0.05") and this spec's own body says "Reject if PBO > 0.05" as a fixed rule. It remains a config *value*, but bounded by an in-code table that **refuses** anything above 0.05 at load and on every write rather than silently coercing it (#638). The bound and the reasoning are recorded once in [cross-spec-contracts.md §9](cross-spec-contracts.md), not restated per spec.

## Further Notes

### Integration with Pipeline

```
Backtest.run(config, clock)
  └─ drives the SAME orchestrator the live system runs, mode='backtest':
       simulated Clock (owned here) → Analysts → Debate → Trader → Risk → Verdict
        → Execution[SimulatedBrokerAdapter → CostModel.fill] → backtest-scoped shared store
        → Feedback Loop (walk-forward, point-in-time) 
  └─ Validation Library → MetricsSuite + walk-forward/CPCV distribution + DSR + PBO + MinBTL
                          + capacity ceiling → BacktestReport

Feedback Loop (live)  → calls this component's computeMetrics + DSR/PBO/walk-forward primitives
                        (FL owns cadence + breach response; this component owns the computation)
Execution (paper/backtest) → SimulatedBrokerAdapter → CostModel.fill (cost model shared)
Execution (live) → real Kraken/IBKR adapter (no cost model; real fills calibrate the model)
```

*(Amended 2026-09-08 — "kill decision" reworded to "breach response": [ADR-0013](../adr/0013-no-human-gate-anywhere.md) Decision 3 means nobody owns a kill/rework decision under full automation. FL's breach response today is alert + defensive auto-tighten (`server/pipeline/feedback-loop/metrics.ts`); no halt-on-persistence is implemented yet.)*

### Backtest/Eval Executor — pybroker (ADR-0001) — SUPERSEDED

> **This section is history, not the design.** The executor was built in TypeScript, in-tree
> (`server/tools/backtest/eval-executor.ts`, `splits.ts`, `metrics.ts`, `overfitting.ts`); no
> pybroker dependency exists. The bullets below survive only where they describe *constraints*
> (no tick-loop hosting, `CostModel.fill` as sole fill authority, cadence staying with FL) — those
> held and are implemented. Read "pybroker" as "the eval executor" throughout.
> See `docs/reviews/triage-2026-08-06.md` F-10.

~~Per ADR-0001, the backtest/eval **executor is pybroker**, not a fully-custom harness:~~ **Superseded — the executor is the in-tree TypeScript `eval-executor.ts`.** The bullets below survive only as constraints, all of which still hold:
- **Mined, not depended-on.** Fork/adapt pybroker's eval-metrics (`src/eval.py`) and walkforward-split (`src/strategy.py`) patterns; no build-time dependency on the base repo (ADR-0001 reuse posture). <!-- cite-exempt: foreign — pybroker's tree, mined not depended on; these paths are in the base repo, never in ours -->
- **Executor of the eval/validation layer only.** pybroker executes the walkforward/CPCV splits and eval-metric computation over the trades the orchestrator produces. It is **not** the tick-loop host — its synchronous per-bar `exec_fn` cannot host the LLM debate, so the harness + live orchestrator retain the simulated `Clock` and drive the pipeline; the point-in-time / survivorship-free / no-lookahead discipline is unchanged. *(SUPERSEDED 2026-09-09 — #1156 deleted `BacktestHarness`; no code plays the "harness + live orchestrator drive the pipeline" role this bullet describes any more.)*
- **Our cost model is injected into pybroker's eval path.** pybroker's own fill model is bypassed — it is not pessimistic enough for the √-law market-impact requirement (Principle 2). `CostModel.fill` stays the single fill authority (Execution's `SimulatedBrokerAdapter` calls it; pybroker consumes those fills), preserving live == backtest metrics (cross-spec §5).
- **Cadence stays with FL.** pybroker/this component owns the walkforward/CPCV + metric *computation*; the Feedback Loop owns the live metric *cadence* ~~and the kill/rework decision~~. *(Amended 2026-09-08 — [ADR-0013](../adr/0013-no-human-gate-anywhere.md) Decision 3: nobody owns the kill/rework decision under full automation. FL's breach path alerts and defensively auto-tightens on a kill-threshold breach (`server/pipeline/feedback-loop/metrics.ts`), with no halt-on-persistence implemented yet. This component's boundary is unchanged.)*

### Domain Glossary Alignment

Per CONTEXT.md:
- **Expectancy**: `E[trade] = (P_win×Avg_win) − (P_loss×Avg_loss) − Costs` — the cost model supplies the `Costs` term; the metrics suite reports expectancy. The no-zero-cost floor enforces "expectancy > 0 before any live money" structurally.
- **Overfitting / PBO**: this component computes PBO and enforces the "kill if PBO > 0.05" line as a `reject` verdict.
- **Paper Trading**: "live market data, simulated execution" = the `paper` mode row (live clock/data + simulated broker + cost model).
- **Idempotent Order**: `FillRequest.idempotency_key` carries the Trader's key through to the simulated fill.

### Research Alignment (docs 00/01/02)

- **Principle 1** — expectancy-first: no zero-cost path; expectancy in the suite.
- **Principle 2** — pessimistic costs: spread + commission + slippage + √-law impact, adverse-only.
- **Principle 3** — overfitting: walk-forward/CPCV, DSR, PBO ≤ 0.05, MinBTL, log-every-config (distinct-config N), look-ahead audited like a vuln, point-in-time + survivorship-free.
- **Principle 4** — full suite together; Sharpe respects serial correlation (Lo 2002); credible fingerprint (Sharpe ~1.5, maxDD ~20%, PF ~1.8, Calmar ~1.2) as reference; Sharpe > 3 non-HFT = red flag.
- **Principle 7** — paper across ≥1 vol regime (paper mode shares the cost model); capacity ceiling from √-law impact.

### Future Extensions

- Order-book-level / almgren-chriss optimal-execution impact model (beyond the closed-form √-law).
- Auto-calibration of cost-model parameters from accumulated live fills (closing the model-vs-reality loop the FL divergence check surfaces).
- Multi-strategy / portfolio-level CPCV once multiple strategies run.
- A research CLI/notebook front-end over the validation library (its own spec).

## Resolved Decisions (Sources)

Wayfinder decisions for this component live in [docs/wayfinder/cost-model-backtest-map.md](../wayfinder/cost-model-backtest-map.md) (charted locally). Decisions synthesized here: three-mode matrix; two seams (`CostModel.fill`, `Backtest.run`); cost model (four components, √-law impact, no zero-cost floor, holding cost kept out of `fill()`, determinism); harness (pipeline-unchanged, owns simulated Clock, point-in-time / survivorship-free / no-lookahead audited as a vuln, FL walk-forward replay); validation library (full suite together, walk-forward/CPCV split generator, DSR/PBO/MinBTL, config-trial log with distinct-config N, capacity ceiling); determinism (seed + clock, given analyst cache).

**NEW cross-spec contracts other specs must adopt:**
1. **feedback-loop-spec** — metric/validation computation re-homes here. This component owns a flat `MetricsSuite` + DSR/PBO/walk-forward primitives; FL **recomposes** them into its existing nested `MetricsReport` (`.daily` = `MetricsSuite`; `.revalidation` = DSR/PBO/walk-forward output; `.breaches` stays FL-only). FL keeps cadence + breach-response + ~~human-owned kill~~; it delegates the computation. *(Amended 2026-09-08 — [ADR-0013](../adr/0013-no-human-gate-anywhere.md) Decision 3: kill is no longer human-owned; nobody owns it under full automation, and a breach must produce a mechanical response — FL's breach path alerts and defensively auto-tightens (`server/pipeline/feedback-loop/metrics.ts`), with no halt-on-persistence implemented yet.)* (Avoids a same-name/different-shape collision with FL's inline `MetricsReport`.)
2. **config-trial log** (`config_trials`, keyed by config hash; N = distinct configs for selection) is shared-SQLite infrastructure; FL revalidation reads frozen selection-N and does not append; in-bounds FL auto-tuning is not a new trial.
3. **Execution (uncharted)** — must expose a broker-adapter interface with a `SimulatedBrokerAdapter` that calls `CostModel.fill()` (backtest + paper).
4. **Fill record** — Execution's persisted `Fill` gains an optional `cost_breakdown?: {spread_cost, commission, slippage, market_impact}` field, populated on Simulated-adapter fills (mapped from `CostModel.fill`'s `CostModelResult`) and left undefined on real broker fills — for FL's live-vs-backtest cost divergence check (see GAP-F, execution-spec.md).
5. **Data layer (Market Data Service + Market Intelligence)** — historical stores must be survivorship-free + strictly point-in-time (`timestamp <= clock.now()`).
6. **Orchestrator (uncharted)** — the harness injects `{clock, data, broker, mode}` into the same tick loop the live orchestrator runs; this component owns the simulated `Clock`.

**Dependencies:** the shared SQLite store (backtest-scoped + `config_trials`); the Market Data Service + Market Intelligence historical stores (point-in-time / survivorship-free) — **MDS must additionally expose a best-effort spread estimate (from bid/ask where available) and an ADV helper (bars-volume aggregation) for `MarketState`, per OPEN-GAP-A**; Execution (simulated broker adapter — uncharted); the live orchestrator / tick loop (uncharted); the Feedback Loop (caller of the validation library; provides the walk-forward adaptation logic the harness replays); the Analysts' temperature-0 + response cache (for end-to-end determinism).
