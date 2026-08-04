# Feedback Loop Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

The pipeline makes decisions but never learns from whether they were right. Analyst weights sit static, so a consistently-wrong lens keeps its say and a quietly-correct one never earns more; the cosine setup store fills with setups that have no outcomes attached; and no one is watching whether the strategy's live performance still resembles its backtest — the exact drift (edge decay, regime change, creeping overfitting) that turns a working system into a losing one silently.

The Feedback Loop (Stage 6) closes the loop. After execution, it attributes realized outcomes back to the analysts, adjusts weights (and, within strict guardrails, strategy parameters and risk thresholds), labels the setup store so the Trader's precedent retrieval has ground truth, and computes the full metrics suite plus periodic overfitting revalidation — alerting a human when the numbers say the edge may be gone. Per CONTEXT.md it tunes the system's dials; it never changes the underlying market model.

## Solution

The Feedback Loop is a **scheduled, bounded, deterministic** learner (not online, not a black box). Daily, it recomputes analyst weights via influence-weighted performance attribution over the day's closed trades, moving each weight a capped step toward its performance-implied level. It tunes all three dials CONTEXT.md names — weights, strategy params, risk thresholds — but under **asymmetric guardrails**: it may auto-*tighten* risk freely, while auto-*loosening* requires human approval, and every dial has human-set hard bounds. On each trade close it labels the setup store with the realized R-multiple. It reports the full metrics suite daily and runs walk-forward/PBO/DSR revalidation periodically; on a kill-threshold breach it alerts a human and defensively auto-tightens, but the kill/rework call is human. In backtest it evolves weights walk-forward, point-in-time, so out-of-sample distributions stay honest.

Key architectural decisions:
- **Daily batch, bounded step changes** — not online per-trade.
- **Adjusts all three dials, asymmetric guardrails** — auto-tighten free; loosen gated; hard human-set bounds; logged + reversible.
- **Influence-weighted attribution + shadow credit** — reward analysts by realized contribution; let quietly-correct ones recover.
- **Owns the setup store; event-driven R-labelling on trade close.**
- **Full metrics suite daily + periodic walk-forward/PBO/DSR; human owns kill.**
- **Walk-forward, point-in-time in backtest** — no lookahead-in-weights.
- **Never changes the market model** (CONTEXT.md invariant).

## User Stories

### Weight Adjustment

1. As the Feedback Loop, I want to recompute analyst weights daily from accumulated closed-trade outcomes, so that weighting reflects realized performance, not a static prior.
2. As the Feedback Loop, I want to attribute each trade's realized R to analysts by their debate influence, signed by stance-vs-outcome, so that analysts who drove good trades gain weight and those who drove bad ones lose it.
3. As the Feedback Loop, I want to give small shadow credit to right-but-low-influence analysts, so that a quietly-correct analyst can climb back.
4. As the Feedback Loop, I want to move each weight only a bounded step per cycle and keep weights floored/capped, so that no analyst swings wildly, drops to zero permanently, or dominates.
5. As the Debate Engine, I want to read the updated weights when applying them downstream, so that the debate reflects current analyst credibility.

### Parameter & Threshold Tuning (guardrailed)

6. As the Feedback Loop, I want to tune strategy parameters and risk thresholds within human-set hard floors/ceilings, so that the system adapts without escaping its guardrails.
7. As the Feedback Loop, I want to auto-tighten risk thresholds freely but require human approval to loosen any of them, so that the loop can never relax its own safety limits unsupervised.
8. As the operator, I want every adjustment logged and reversible, so that I can audit and roll back a bad tuning cycle.

### Outcome Labelling & Setup Store

9. As the Feedback Loop, I want to own the cosine setup store, so that the Trader's precedent retrieval has ground-truth outcomes.
10. As the Feedback Loop, I want to label each setup on trade close with R = realized_pnl_net ÷ (|entry − stop| × filled_size), joined by idempotency_key / debate_id, so that precedent labels are accurate and point-in-time.

### Metrics & Revalidation

11. As the operator, I want the full metrics suite (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure) reported together daily, so that no single number misleads me.
12. As the Feedback Loop, I want to run walk-forward / CPCV, Deflated Sharpe, and PBO periodically, so that I catch overfitting and edge decay as data accumulates.
13. As the Feedback Loop, I want to alert the human and defensively auto-tighten on a kill-threshold breach (PBO > 0.05, OOS/paper Sharpe < 0.5, DSR insignificant, live-vs-backtest divergence), so that a failing edge is flagged fast — while leaving the kill/rework decision to the human.

### Determinism & Backtest

14. As the system, I want weights to evolve walk-forward and point-in-time in backtest, so that out-of-sample metrics are honest (no lookahead-in-weights).
15. As the system, I want the Feedback Loop to run the same code path live and in replay, so that backtests exercise real adaptation.

## Implementation Decisions

### Module: Feedback Loop Core (scheduled)

**Responsibilities**
- Daily: recompute weights (attribution), tune params/thresholds within guardrails, emit adjustments.
- On trade close: label the setup store.
- Daily/periodic: compute metrics + revalidation; alert + auto-tighten on breach.

**Key Interfaces**

```typescript
// Primary seam: the daily batch cycle. Deterministic given the clock-scoped store.
interface FeedbackLoop {
  runDailyCycle(input: FeedbackInput): DailyCycleResult;
  // trace_id here (not on FeedbackInput/runDailyCycle) because onTradeClose is the one FL
  // entry point that correlates to a single tick's trace — it fires per closed trade, and the
  // caller (Execution, on the tick that processes the close fill) supplies the trace_id of
  // THAT closing tick. runDailyCycle/computeMetrics run on a daily batch cycle spanning many
  // ticks/trace_ids, so a single cross-cutting trace_id doesn't apply there.
  onTradeClose(trade: ClosedTrade, trace_id: string, input: FeedbackInput): void;   // event-driven labelling
  computeMetrics(input: FeedbackInput): MetricsReport;
}

interface FeedbackInput {
  clock: Clock;                 // wall-clock live, simulated T in replay
  store: SharedStore;           // positions/fills, weights, params, thresholds, setup store
  debate_log: DebateLog;        // append-only record of every debate (inputs/rounds/output
                                // incl. AnalystContribution[]), keyed by debate_id — FL's
                                // system-of-record for attribution (distinct from ephemeral
                                // operational debate state, which is no-persistence per #10)
  portfolio: PortfolioView;     // equity/drawdown/exposure (accounting view)
  config: FeedbackConfig;       // step caps, hard floors/ceilings, kill thresholds, cadences
  approvals: ApprovalChannel;   // for gated risk-threshold loosening + breach alerts
  mode: 'live' | 'backtest';
}

interface DailyCycleResult {
  weight_updates: Record<string, { from: number; to: number }>;   // per analyst_id, bounded
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  loosen_pending_approval: string[];   // risk-threshold loosenings awaiting human OK
  applied: boolean;
}

interface MetricsReport {
  daily: MetricsSuite;          // = the flat MetricsSuite OWNED by the cost-model/backtest
                                // validation library (Sharpe, Sortino, Calmar, max_drawdown,
                                // profit_factor, expectancy, skew, kurtosis, turnover, exposure).
                                // FL RECOMPOSES — it does not reimplement the math.
                                // See docs/specs/cost-model-backtest-spec.md (owner).
  revalidation?: {              // periodic (weekly/monthly) — the library's DSR/PBO/walk-forward
                                // OUTPUT, recomposed here (not reimplemented). Owner: cost-model.
    walk_forward_sharpe_distribution: number[];
    deflated_sharpe: number; pbo: number;
  };
  breaches: string[];           // FL-only. e.g. 'pbo_over_0.05', 'oos_sharpe_under_0.5'
  not_evaluated: string[];      // Kill-lines that could NOT be checked this run, so "did not
                                // breach" is never read as "was checked and passed" (#327).
                                // Two routine causes: no `revalidation` snapshot (every
                                // non-revalidation day) makes the three snapshot-gated lines
                                // un-runnable; `backtest_reference_sharpe <= 0` leaves
                                // live_backtest_divergence_over_max inert. Empty = all four ran.
}
```

**`ClosedTrade` is adopted, not defined here (cross-spec — freeze §4).** `ClosedTrade` (used by `onTradeClose`) is **DEFINED in [execution-spec.md](execution-spec.md)** — Execution is the SOLE writer. FL adopts these exact fields and does not redefine the type: `entry`, `stop`, `filled_size`, `realized_pnl_net` (net of fees), `debate_id`, `idempotency_key`, `asset_class`, `side`, `opened_at`, `closed_at`, `close_reason`. FL's R-multiple is computed from these: **`R = realized_pnl_net ÷ (|entry − stop| × filled_size)`** — always `filled_size`, never requested size (freeze §4).

### Module: Weight Attribution

**Source of the per-analyst breakdown (cross-spec — advisor-caught).** Attribution needs `AnalystContribution[]` (`influence_score`, `final_position`) at trade close — but the Debate Engine is deliberately no-persistence (#10), so `DebateResult` isn't retained, and neither `OrderIntent.metadata` nor the numeric setup store carries the contributions. The source is the Debate Engine's **debate log** (debate-engine-spec story 20: "log every debate — inputs, rounds, output — to tune weights in the Feedback Loop"), joined to the closed trade by **`debate_id`**. This is not contradictory with #10: operational debate *state* is ephemeral (re-run from scratch on crash), while the debate *log* is a separate append-only analytics/audit record that IS persisted as FL's system-of-record for attribution. `debate_id` must therefore be present on the trade record and deterministic across a debate re-run (see the cross-spec reconciliation note).

- **Influence-weighted:** attribute a closed trade's realized R to analysts by their debate `influence_score` (read from the debate log via `debate_id`), signed by stance-vs-outcome. Winners' drivers gain, losers' drivers lose.
- **Shadow credit:** small credit to right-but-low-influence analysts (stance matched outcome though they didn't sway the debate).
- **Bounded step** toward the performance-implied weight (e.g. realized hit-rate/expectancy), capped per daily cycle.
- **Floors/caps:** no analyst weight reaches 0 permanently or dominates.

### Module: Guardrailed Tuning

- Tunes analyst weights, strategy params, and risk thresholds — all within human-set hard floors/ceilings.
- **Asymmetric:** auto-tighten risk thresholds freely; auto-loosen requires human approval via the trade channel (queued in `loosen_pending_approval`). Weights + strategy params tune freely within bounds.
- Every adjustment logged + reversible.
- **Consumers must read live from the store (cross-spec):** FL's tuning only takes effect if the Trader reads its strategy params, and the Risk Manager reads its thresholds, **from the mutable shared store at decision/eval time** — not from static config baked in at startup. Both specs describe these as "config, tuned in paper"; the cross-spec pass must confirm they read the live (FL-written) values. (Analyst weights already follow this pattern — orchestrator reads at tick start, #42.)

### Module: Setup Store Labelling

- Event-driven on trade close: `R = realized_pnl_net ÷ (|entry − stop| × filled_size)`, label the matching setup (join by `idempotency_key` / `debate_id`). All operands are read from the `ClosedTrade` record Execution writes (freeze §4) — `filled_size`, never requested size.
- **Requires the entry bracket to be recoverable at close:** `initial risk = |entry − stop| × filled_size`. The `ClosedTrade` record (owned/written by Execution) persists the entry bracket (`entry`, `stop`, `filled_size`) alongside `debate_id`, so R is computable when the trade closes (possibly days later for stocks). (Same persistence requirement flagged for the debate-log join above.)
- Separate from the daily weight batch; store in the shared SQLite. Point-in-time preserved (label exists only after close).

### Module: Metrics & Revalidation

- **Daily:** full metrics suite together.
- **Weekly/monthly:** walk-forward / CPCV, Deflated Sharpe, PBO.
- **On breach:** alert the human (trade channel) + defensively auto-tighten (drop automation toward manual, shrink sizing). Kill/rework is human.
- **`config_trials` semantics (cross-spec — freeze §5):** FL revalidation monitors one frozen, already-selected config. It **reads** the frozen distinct-config N (keyed by config hash, owned by the cost-model/backtest validation library) that DSR/PBO/MinBTL deflate by — it **never appends** a trial. FL's in-bounds auto-tuning (weights/params/thresholds within guardrails) is NOT a new selection trial and must not increment N. (Treating N as run-count would make DSR/PBO/MinBTL kill healthy strategies by construction.)
- **This is read-only at the API level, not just semantically.** `config_trials.config_hash` is the table's `PRIMARY KEY` and `recordTrial` upserts on conflict (per [#179](https://github.com/dd-jp/samurai-trading-system/issues/179) and `shared-sqlite-store-spec.md`) — a call to `recordTrial` during revalidation would silently overwrite `recorded_at` and look indistinguishable from a fresh trial recording, not a read. FL's revalidation path must query `config_trials` directly (`SELECT ... WHERE config_hash = ?`) and must **never** call `recordTrial`. This is caller discipline, not something the schema enforces — get this wrong and DSR/PBO/MinBTL silently corrupt without any error.
- Depends on the backtest harness / cost model (separate uncharted component) for the honest historical inputs.

### Module: Determinism & Backtest

- Walk-forward: weights/params evolve daily from only outcomes known before each T (injected clock), producing a point-in-time trajectory the backtest replays. Never global-fit-and-apply-retroactively.
- Same code path live vs replay; risk-threshold-loosening approvals auto-handled in backtest (like Verdict's HITL bypass), recorded.

## Testing Decisions

### What Makes a Good Test

- Test `runDailyCycle` / `onTradeClose` / `computeMetrics` at their seams with a mocked clock-scoped store.
- Attribution: a winning trade raises its drivers' weights, a loser lowers them, bounded and floored; shadow credit applies to right-but-low-influence analysts.
- Guardrails: auto-tighten applies; auto-loosen queues for approval and does not apply without it; hard bounds never crossed.
- Labelling: on close, the right setup gets the right R, joined correctly; no label before close (point-in-time).
- Metrics: full suite computed; a breach triggers alert + auto-tighten but not an automatic kill.
- Determinism: walk-forward weight trajectory is reproducible and uses no future data.

### Modules to Test

**Weight Attribution**, **Guardrailed Tuning**, **Setup Store Labelling**, **Metrics & Revalidation**, **Determinism** — as above.

### Prior Art

- No implementation yet. Injected-clock / mode-flag / injected-ApprovalChannel patterns mirror Verdict and Risk. Point-in-time / walk-forward discipline mirrors the Analysts and Trader backtest decisions.

## Out of Scope

**The underlying market model / strategy core** — CONTEXT.md invariant: FL adjusts weights/params/thresholds, never the model.

**Execution & trading** — FL reads outcomes; it never places orders.

**The backtest harness / cost model** — a separate uncharted component FL consumes for honest historical inputs; FL owns the *validation metrics*, not the harness itself.

**Auto-kill** — killing/reworking the strategy is a human decision; FL only detects, alerts, and defensively tightens.

**Exact values** — step caps, floors/ceilings, kill thresholds, and cadences are config.

## Further Notes

### Integration with Pipeline

```
Execution → shared store (fills/outcomes) → Feedback Loop
Feedback Loop → analyst weights (→ Debate Engine), strategy params (→ Trader),
                risk thresholds (→ Risk, loosening gated), setup-store R-labels (→ Trader cosine)
Feedback Loop → trade channel (metrics reports, breach alerts, loosen-approval requests)
```

### Domain Glossary Alignment

Per CONTEXT.md:
- **Feedback Loop**: "Post-execution review. Compares predicted outcome vs actual. Adjusts analyst weights, strategy parameters, risk thresholds. Does NOT change the underlying market model."
- **Overfitting / PBO**: the periodic revalidation operationalizes "kill if PBO > 0.05."

### Research Alignment (docs 00/01/02)

- Full metrics suite reported together; credible fingerprint (Sharpe ~1.5, maxDD ~20%, PF ~1.8) as reference, Sharpe > 3 as red flag.
- Periodic re-run of overfitting validation as data accumulates (edges decay).
- Bounded adaptation, not self-learning; never relaxes its own guardrails unsupervised.

### Future Extensions

- Auto-tuning of the loosen-gated thresholds once trust is established (with its own validation).
- Regime detection to condition weights on market regime.
- Per-strategy feedback once multiple strategies run.

## Resolved Decisions (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/feedback-loop-map.md](../wayfinder/feedback-loop-map.md) (charted locally). Decisions synthesized here: cadence (daily batch, bounded), scope (all three, asymmetric guardrails), credit assignment (influence-weighted + shadow credit), metrics & revalidation (daily suite + periodic walk-forward/PBO/DSR, human-owned kill), setup-store labelling (event-driven on close), determinism (walk-forward point-in-time).

**Dependencies:** the shared store + portfolio-accounting view; the trade channel (approvals/alerts); the Debate Engine (reads weights), Trader (reads params + setup store), Risk (reads thresholds); and the backtest harness / cost model (uncharted) for honest validation inputs.
