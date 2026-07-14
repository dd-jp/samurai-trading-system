# Wayfinder Map: Transaction-Cost / Market-Impact Model + Backtest Harness

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/cost-model-backtest-spec.md](../specs/cost-model-backtest-spec.md).

> Load-bearing infrastructure, **not** one of the 6 pipeline stages. Treated as ONE component with two tightly-coupled parts: the **harness** drives replay; the **cost model** makes fills honest. This component is where MOST of the binding research constraints (docs 00/01/02) are enforced.

## Destination

Design the Transaction-Cost / Market-Impact model + Backtest Harness — the honesty layer under the whole pipeline. It provides (a) a **cost model** that turns an order into a pessimistic, realistic fill (spread + commission + slippage + √-law market impact), used by Execution's simulated broker adapter in backtest **and** paper; (b) a **replay harness** that runs the *exact live pipeline* forward over historical data via an injected clock — point-in-time, survivorship-free, no lookahead; and (c) a **validation library** (full metrics suite, walk-forward / CPCV, Deflated Sharpe, PBO, MinBTL guard, capacity-ceiling, config-trial log) that both the Feedback Loop and offline research call. Destination = docs/specs/cost-model-backtest-spec.md.

## Notes

- **Two seams, one component:** `CostModel.fill(request, marketState) -> Fill` and `Backtest.run(config, clock) -> BacktestReport`. One-seam-per-part, matching the one-seam-per-stage convention (Verdict `decide`, Risk `evaluate`, FL `runDailyCycle`).
- **Relationship with the Feedback Loop (Stage 6):** FL *owns the live validation cadence* (daily metrics, weekly/monthly revalidation) and the kill-threshold breach → alert + defensive auto-tighten flow, with the kill/rework decision reserved for the human. This component *owns the computational primitives* FL and offline research both invoke: the replay engine, the cost model, and the metric/DSR/PBO/walk-forward/CPCV/MinBTL computations. **Do not duplicate FL's cadence decisions — define the primitives it uses.** See [feedback-loop-spec.md](../specs/feedback-loop-spec.md).
- **Binding research constraints enforced HERE** (docs 00/01/02 — see [[research-constraints]]):
  - **Principle 1 (expectancy-first):** every trade must clear costs → the cost model has **no zero-cost path** (a non-zero spread+commission floor even on the most optimistic config; the backtest cannot manufacture a frictionless fill).
  - **Principle 2 (pessimistic cost modeling):** spread + commissions + slippage + market impact ∝ √(order size / liquidity). Backtests without this LIE.
  - **Principle 3 (overfitting is the central danger):** OOS / walk-forward / CPCV; Deflated Sharpe; **PBO ≤ 0.05**; MinBTL (~≤45 independent configs / 5yr); **log every config tried**; audit look-ahead like a security vuln; point-in-time + survivorship-free data.
  - **Principle 4 (full metrics suite together):** Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure — one library, reported together. Credible fingerprint: Sharpe ~1.5, maxDD ~20%, win ~50%, PF ~1.8, Calmar ~1.2. Sharpe > 3 non-HFT = red flag.
  - **Principle 7 (paper across ≥1 vol regime; capacity ceiling):** cost model shared by backtest **and** paper; capacity ceiling derived from the √-law impact.

## Decisions so far

### Architecture

- **Three-mode matrix makes "same code path" precise and pins where the cost model plugs in.** Every run is one of three modes differing only in three injected dependencies — clock, data source, broker adapter:

  | Mode | Clock | Data | Broker adapter |
  |------|-------|------|----------------|
  | `backtest` | simulated (stepped bar-by-bar) | historical store | **simulated** (uses cost model) |
  | `paper` | live wall-clock | live feed | **simulated** (uses cost model) |
  | `live` | live wall-clock | live feed | real (Kraken / IBKR) |

  The cost model is shared by **backtest and paper** (CONTEXT.md: paper = live data + simulated execution). **Real live fills are the calibration signal** for the cost model — the live-vs-modeled-cost divergence FL watches (docs 02 Stage 3 exit condition) is what tells us the model is honest.

- **Pipeline runs UNCHANGED.** The harness does not re-implement the tick loop; it drives the *same orchestrator the live system runs*, injecting `{clock, data services, broker adapter, mode}`. Only those swap. Analysts→Debate→Trader→Risk→Verdict→Execution→FL execute identically — this is what makes the backtest exercise real code, and why every stage was designed clock-blind and mode-flagged.

- **This component OWNS the simulated `Clock`** that every other stage injects for replay. All stages read "now" from it and filter `timestamp <= clock.now()`. Ownership was previously implicit across the stage specs; it lives here.

### Cost Model

- **Interface: `CostModel.fill(request, marketState) -> Fill`.** Given a fill request (instrument, side, size, order type) + market state (mid, spread, liquidity proxy / ADV, volatility, timestamp, asset class), return a realistic fill price with a **transparent cost breakdown**. Deterministic given seed + inputs.
- **Fill price = mid, moved adversely by the sum of four components** (never favorably — pessimistic by construction):
  1. **Spread cost** — cross the (half-)spread; "price of immediacy" (Demsetz). Widens under volatility (crypto spreads blow out in stress).
  2. **Commission / fees** — taker fee (crypto) or per-share/flat commission (IBKR stocks). Chan's ~5 bps ex-commission reference for S&P names is the sanity anchor.
  3. **Slippage** — adverse offset from latency + price drift between signal and fill (crypto API latency ~100–200 ms). **Deterministic by default** (adverse offset ∝ volatility × latency); optional **seeded** stochastic mode for sensitivity runs. Never favorable.
  4. **Market impact** — **√-law**: `impact = k × volatility × √(size / ADV)` (Almgren-style). Super-linear erosion as size scales → this term *is* the capacity ceiling.
- **Asset-class parameterized, pessimistic defaults.** Crypto: wider spreads, taker fees, higher impact `k`, funding. Stocks: tighter spreads, commission schedule, market-hours. Config, but **the optimistic bound is still non-zero** (Principle 1).
- **Funding / borrow = a holding cost the harness applies during mark-to-market**, not part of `fill()` (which is execution-only). Crypto perpetual funding accrues per interval on open positions; keeps `fill()` single-responsibility.

### Backtest Harness

- **Interface: `Backtest.run(config, clock) -> BacktestReport`.** Steps the simulated clock over the window, driving the real pipeline each bar; the simulated broker adapter produces fills via the cost model; fills/positions land in a **backtest-scoped shared store** (same schema as live, isolated DB/namespace) so Risk's portfolio view, the Trader's cosine store, and FL all behave exactly as live.
- **Point-in-time + survivorship-free + no-lookahead, enforced below the pipeline.** No-lookahead is enforced at the data-service layer (already designed: services return only `timestamp <= clock.now()`); the harness's job is to (1) drive the clock monotonically, (2) require survivorship-free data (delisted/bankrupt instruments present in the historical universe), and (3) **audit look-ahead like a security vuln** — a lookahead-detection pass (e.g. assert no stage reads a store row timestamped after `clock.now()`; fail the run, don't warn).
- **FL walk-forward replays a point-in-time weight trajectory.** The harness reuses FL's daily-batch code path so weights/params evolve from only outcomes known before each T (no lookahead-in-weights) — already decided in [feedback-loop-map.md](./feedback-loop-map.md). The harness provides the replay; FL provides the adaptation logic.

### Validation Library (the primitives FL + research both call)

- **Full metrics suite — single library, reported together.** Computes Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew, kurtosis, turnover, exposure in one flat `MetricsSuite` (never one number in isolation). **This library OWNS the `MetricsSuite` type** and the computation; FL becomes a *caller* that recomposes it into its own nested `MetricsReport.daily` (cross-spec change below). Sharpe annualization respects serial correlation (Lo 2002 — no naive ×√N).
- **Walk-forward + CPCV engine.** A **split generator** yields train/test index sets: walk-forward (rolling IS/OOS) and Combinatorial Purged CV (López de Prado — multiple paths, **purge overlapping observations + embargo** to prevent leakage). The harness runs the pipeline per split and collects a **distribution** of OOS Sharpe ratios, not a single number.
- **Deflated Sharpe (DSR) + PBO + MinBTL — driven by a config-trial log.**
  - **DSR** deflates the observed Sharpe by the **number of distinct configs tried in the selection campaign**, sample length, and non-normality (skew/kurtosis).
  - **PBO** = probability the in-sample-best config underperforms the median OOS (via the CPCV path distribution). **Reject if PBO > 0.05.**
  - **MinBTL guard** = cap independent trials by data length (~45 / 5 yr). The harness **warns/blocks when the distinct-config count for the window exceeds MinBTL**.
- **Config-trial log — "log every config tried" — the trial-count discipline (LOAD-BEARING semantics).**
  - Stored in the **shared SQLite** as a `config_trials` table, keyed by **config hash** (hash of the full strategy/param/feature configuration).
  - **N = number of DISTINCT configs evaluated *for selection*** — NOT the number of runs. Re-running the same config adds **no** trial (dedup by hash). This is the trial count DSR/MinBTL deflate by.
  - **Revalidating an already-selected config never increments N.** FL's periodic revalidation is *monitoring one frozen, selected config* — it **reads** the selection-N and does **not** append a trial per revalidation. (If N were run-count, it would grow without bound and DSR/PBO/MinBTL would fail healthy strategies for reasons unrelated to overfitting — the spec would fight itself.)
  - **FL's bounded auto-tuning does NOT count as new trials** — the guardrail bounds (hard floors/ceilings) were themselves part of the validated config, so in-bounds adaptation is not a new selection search.
- **Capacity-ceiling estimation from the √-law impact.** The size at which marginal expectancy net of impact reaches zero (edge exhausted by impact). Reported in `BacktestReport` — "works at $50k, dead at $50M."

### Determinism

- **Same seed + injected clock ⇒ reproducible run.** Seed recorded in `BacktestReport`. Slippage stochastic mode draws from the seeded RNG only.
- **Conditional on the analyst response cache.** Trader / Debate / Risk / Verdict / FL are already deterministic (no LLM or mechanical). The Analysts are LLM — end-to-end reproducibility rests on the **analysts' temperature-0 + input-hash response cache** (analysts-spec). State this: determinism is guaranteed *given the analyst cache*, not asserted end-to-end over live LLM calls.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

1. **[NEW contract — modifies feedback-loop-spec] Metric/validation computation re-homes here.** FL currently *defines* a nested `MetricsReport` inline (`{ daily: {…10 fields…}, revalidation?: {walk_forward_sharpe_distribution, deflated_sharpe, pbo}, breaches: string[] }`) and lists `computeMetrics` + DSR/PBO/walk-forward in its own `FeedbackLoop` interface. Per this component's charter those computations are a **library owned here**. To avoid a same-name/different-shape collision, this component owns a **flat `MetricsSuite`** (the 10 metrics) + standalone DSR/PBO/walk-forward primitives, and FL **recomposes** them: FL's `MetricsReport.daily` **= this component's `MetricsSuite`**; FL's `.revalidation` **= the output of this component's walk-forward/DSR/PBO primitives**; FL's `.breaches` **stays FL-only** (breach detection is FL's cadence/threshold logic, not a harness primitive). feedback-loop-spec.md must be updated: keep FL's *cadence, breach-response, and human-owned-kill* decisions; delegate the *computation* to this library; FL's `computeMetrics` becomes a thin wrapper that calls `computeMetrics()`/DSR/PBO here and wraps the result in its nested shape.
2. **[NEW contract] The config-trial log (`config_trials`, keyed by config hash) is shared-SQLite infrastructure.** N = distinct configs evaluated for selection. FL's revalidation **reads** the frozen selection-N and must **not** append a trial per run; in-bounds FL auto-tuning is not a new trial. Offline research writes a trial row per *new distinct config* it evaluates. This table and its semantics must be adopted by feedback-loop-spec (revalidation) and any future research-tooling spec.
3. **[NEW contract — depends on Execution, uncharted] The simulated broker adapter is the cost-model injection point.** Execution (flagged uncharted by Verdict) must expose a **broker-adapter interface** with a `SimulatedBrokerAdapter` that calls `CostModel.fill()` (used in `backtest` + `paper`) and real Kraken/IBKR adapters (used in `live`). The cost model is injected into Execution's simulated adapter; Execution owns *how* a `go` becomes a fill, this component owns *what price* the simulated fill gets.
4. **[NEW contract] Fill records must persist the modeled cost breakdown.** Execution's fill schema (shared store) must carry `{spread_cost, commission, slippage, market_impact}` so FL's **live-vs-backtest cost divergence** check (docs 02 Stage 3) can compare modeled vs realized costs. Live fills record realized costs in the same shape.
5. **[Depends on — data layer] Historical stores must be survivorship-free + point-in-time.** The Market Data Service and Market Intelligence historical stores (both still unbuilt) must include delisted/bankrupt instruments and serve strictly `timestamp <= clock.now()`. This is a data-quality contract this component *depends on* but does not build; flag to those maps.
6. **[Depends on — orchestrator, uncharted] "Same code path" needs an orchestration seam.** The harness injects `{clock, data, broker, mode}` into *the same tick loop the live orchestrator runs*. There is no orchestrator map/spec yet — flag it as an explicit dependency (as Verdict flagged Execution). This component also **owns the simulated `Clock`** every stage injects.

## Out of scope

- **The strategy / market model itself** — the harness *evaluates* strategies; it does not contain one (CONTEXT.md invariant echoed across specs).
- **FL's cadence, breach-response, and kill/rework flow** — FL owns those; this component provides the primitives FL calls. No duplication.
- **Execution / broker order placement** — the real adapters, partial fills, retries, idempotent order IDs live in Execution (uncharted). This component defines the `CostModel.fill` seam the simulated adapter uses, not the adapter itself.
- **Live trade-channel alerting** (Telegram/Discord) — FL/Verdict own it; the harness returns reports, it does not message humans.
- **Data ingestion / sourcing** — the Market Data Service + Market Intelligence own the historical stores; this component consumes them and asserts their point-in-time / survivorship-free contract.
- **Exact numbers** — spread/impact coefficients, fee schedules, latency assumptions, MinBTL constants, PBO threshold value, capacity-ceiling parameters are config (pessimistic defaults documented in the spec).
