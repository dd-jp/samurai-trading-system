# Feedback Loop Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

> **[ADR-0013](../adr/0013-no-human-gate-anywhere.md) (2026-08-09) removed every remaining human gate.** Three changes to this spec, superseding the language below wherever it conflicts:
>
> 1. **Risk-threshold loosening applies without approval.** `loosen_pending_approval[]` is no longer a gate. Every dial change is applied, logged and reversible. *Implemented by [#736](https://github.com/dd-jp/samurai-trading-system/issues/736) — the field is removed from `DailyCycleResult` entirely, `DailyCycleInput.mode` with it (the gate was its only reader), and the port renamed `LoosenApprovalChannel` → `LoosenNotificationChannel` (`notifyLoosenApplied`), which announces an applied loosening instead of requesting one.*
> 2. **The hard bounds survive and are the control.** `human-set hard floors/ceilings` (story 6) and "hard bounds never crossed" stay, enforced in code — a loosening that would cross one is rejected, not queued. The surviving asymmetry is that loosening is bounded where tightening is free, not that one waits on a person.
> 3. **The kill/rework call is no longer human.** Under full automation nobody owns it. A kill-threshold breach must produce a mechanical response — defensive auto-tighten, and a halt if it persists — rather than an alert that waits for a decision.
>
> **Alerting must survive this.** `approvals: ApprovalChannel` (below) is one field doing two jobs — gated loosening *and* breach alerts. Only the first is removed. Under full automation the breach alert is the sole way an operator learns the edge died, so the notification half must be split out and kept.

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
3. ~~As the Feedback Loop, I want to give small shadow credit to right-but-low-influence analysts, so that a quietly-correct analyst can climb back.~~ **Retired 2026-08-05 ([#370](https://github.com/dd-jp/samurai-trading-system/issues/370))** — shadow credit existed to offset a low `influence_score`, and attribution no longer reads influence at all. See "Module: Weight Attribution".
4. As the Feedback Loop, I want to move each weight only a bounded step per cycle and keep weights floored/capped, so that no analyst swings wildly, drops to zero permanently, or dominates.
5. As the Debate Engine, I want to read the updated weights when applying them downstream, so that the debate reflects current analyst credibility.

### Parameter & Threshold Tuning (guardrailed)

6. As the Feedback Loop, I want to tune ~~strategy parameters and~~ risk thresholds within human-set hard floors/ceilings, so that the system adapts without escaping its guardrails. *(Amended 2026-08-17 — the `strategy_params` half of this story is **not live and is not scheduled**: it is dead at both ends by decision, no proposer writes one and the Trader reads a frozen `deps.config`. See "Phasing of the three dials" below. The story is kept rather than deleted so the asymmetry with weights and risk thresholds stays visible, but it must not be read as describing a mechanism that exists.)*
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
  // Split by #639 into two ports, then retargeted by #736: `breachAlerts:
  // BreachAlertChannel` (kill-line breach) and `loosen_notices:
  // LoosenNotificationChannel` (an APPLIED risk-threshold loosening). Neither
  // collects an answer.
  breach_alerts: BreachAlertChannel;
  loosen_notices: LoosenNotificationChannel;
  // No `mode`: it existed only to gate loosening outside backtest (#736).
}

interface DailyCycleResult {
  weight_updates: Record<string, { from: number; to: number }>;   // per analyst_id, bounded
  param_updates: Record<string, { from: number; to: number; direction: 'tighten' | 'loosen' }>;
  // `loosen_pending_approval: string[]` removed by #736 — nothing is pending.
  // An applied loosening appears in `param_updates` with direction 'loosen'.
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

- **Correctness-weighted:** attribute a closed trade's realized R to analysts by stance-vs-outcome — `agreement × R`, read from the debate log via `debate_id`. Winners' backers gain, losers' backers lose, at equal magnitude.
- ~~**Influence-weighted** … **Shadow credit** …~~ **Retired 2026-08-05 ([#370](https://github.com/dd-jp/samurai-trading-system/issues/370)).** Attribution scaled credit by `influence_score`, with a small shadow-credit top-up for right-but-low-influence analysts (story 3). Two findings retired both: `computeInfluenceScore` measures how often an analyst was **moved**, not how much it moved others, so it paid followers as drivers; and it is `0` for the single-round debates production produces, so the influence term contributed nothing and shadow credit silently carried the whole signal at a tenth of its magnitude. `influence_score` is still computed and logged as an observation of stance movement — re-arming it as a credit factor needs a formula that measures influence in the direction this module claims.
- **Bounded step** toward the performance-implied weight (e.g. realized hit-rate/expectancy), capped per daily cycle.
- **Floors/caps:** no analyst weight reaches 0 permanently or dominates.

#### Deliberately unscored components — what this module does NOT measure

Added 2026-08-05 ([#359](https://github.com/dd-jp/samurai-trading-system/issues/359)). Stated positively rather than left inferable: `influence_score` was removed from the credit formula the day before ([#370](https://github.com/dd-jp/samurai-trading-system/issues/370)), and the analyst-weight dial has no consumer applying it to a trading decision yet ([#377](https://github.com/dd-jp/samurai-trading-system/issues/377)) — so a reader arriving here cannot easily tell what this module claims to measure.

**The Feedback Loop scores analysts. It does not score debate machinery, and it does not score any component whose actions produce no closed trade.**

| Component | Why it is unscored |
| --- | --- |
| **Bull / Bear / Mediator personas** | `AnalystContribution` keys on `analyst_id`; personas carry no entry in it and never have. FL cannot see them. |
| **Risk Critic** (ADR-0003) | An LLM pass with trim-and-hard-reject authority that nothing scores. Its rejects, like the invalidation stage's, produce no `ClosedTrade`. |
| **`invalidation` stage** | See below. |

**Why the `invalidation` stage cannot be scored**, since it is the case most likely to be re-proposed: attribution reads exactly one input, the window's closed trades. The stage's only action is a Risk hard-reject, which short-circuits before Verdict and never fills. Every tick on which the stage *acted* is therefore invisible here by construction, and the ticks where it is visible are those on which it stayed silent — credit there would be credit for not acting. Folding it into a dial fails twice over besides: analyst-weight credit is `agreement × R` and requires a signed directional stance the stage deliberately has none of, and the risk-threshold flavour has no continuous dial to tune because the reject rule is a boolean over a non-empty breached list.

**Named reopening trigger — the one fact that would change this:** rejected intents acquiring **observable outcomes** (a counterfactual observer that carries a rejected intent through to a synthetic close). Until that exists, attribution for these components is not *unbuilt* — it is *unmeasurable*, and the distinction is what this entry exists to preserve.

**Known sample bias, accepted.** The invalidation gate removes from this module's attribution sample exactly the trades whose theses were already falsified — i.e. those most likely to lose — so the analyst most prone to breached-on-arrival theses is the one it shields most. Risk's other rejects censor the sample too, but on exposure caps, uncorrelated with thesis quality; this one is correlated by design. Magnitude is small while rejects stay rare. Convergence implications are [#402](https://github.com/dd-jp/samurai-trading-system/issues/402)'s.

### Module: Guardrailed Tuning

- Tunes analyst weights, strategy params, and risk thresholds — all within human-set hard floors/ceilings.
- **Asymmetric, but not by approval (ADR-0013 Decision 2, #736):** auto-tighten risk thresholds freely; auto-loosen applies too, bounded — capped at one `max_step`, clamped to the dial's `[floor, ceiling]`, and **refused in code** if it would cross a guarded threshold's hard bound (`server/shared/threshold-bounds.ts`, #638). Weights + strategy params tune freely within bounds. An applied loosening is announced on `LoosenNotificationChannel`; nothing waits on a reply.
- Every adjustment logged + reversible.
- **Consumers must read live from the store (cross-spec):** FL's tuning only takes effect if the Trader reads its strategy params, and the Risk Manager reads its thresholds, **from the mutable shared store at decision/eval time** — not from static config baked in at startup. Both specs describe these as "config, tuned in paper"; the cross-spec pass must confirm they read the live (FL-written) values. (Analyst weights already follow this pattern — orchestrator reads at tick start, #42.)

- **Phasing of the three dials (#433).** They are at different stages, and the difference is deliberate rather than an oversight:
  - **`analyst_weights`** — live at both ends since #371 (seeded at startup, stepped by the daily cycle, read at tick start).
  - **`risk_thresholds`** — live at both ends since #433. `RISK_THRESHOLD_KEYS` (`server/pipeline/risk-manager/risk-thresholds.ts`) fixes which key drives which `RiskConfig` field; the composition root seeds the table from the run's `RiskConfig`; `RiskManagerImpl.evaluate()` resolves the live values on every call. The keys are the six notional caps, all of which tighten by decreasing. `concentration.threshold`, `min_viable_size` and `cii_threshold` are deliberately excluded — see that module's doc for why each.
  - **`strategy_params`** — **dead at both ends, and left that way on purpose.** Nothing in the repo produces a `TuningProposal` for one, and `buildTraderStep` passes a frozen `deps.config` into `decide()`. Building a reader for a writer that does not exist would add a live-config path exercising nothing, on the stage that sizes positions. It becomes worth doing when a proposer exists; until then the Trader's static config is the honest description of the system.

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

#### The matched-control comparison (falsifier arm 2) — [#971](https://github.com/dd-jp/samurai-trading-system/issues/971), under [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) and [#913](https://github.com/dd-jp/samurai-trading-system/issues/913)

**The daily suite carries a second arm, not just the live one.** Every cycle FL measures the live arm and **falsifier arm 2** — same instruments, same exit rule ([ADR-0018](../adr/0018-intraday-thresholds-sizing-and-the-signal-bar.md) D3's neutral single bracket), same stop, **entry by indicator alone, no LLM** — and records both. This is the primary control CONTEXT.md's Key Constraints name; outside benchmarks (buy-and-hold and similar) are secondary and never replace it. **FL is the system of record for it** — the persisted, alerted and dashboarded comparison is FL's and no other stage may produce one, because a second *implementation* is a second thing that can drift out of match.

**One deliberately-retained exception, and it is not a second owner.** `yarn report:arms` (`server/tools/report-arm-comparison.ts`) recomputes the comparison ad hoc, and is kept. It is not a second implementation — it calls the same `buildArmComparison` FL calls, so the drift the paragraph above rules out cannot arise — and it answers a question FL cannot: an operator-named window, against an arbitrary store path, including a store whose orchestrator never ran an FL cycle and windows that predate the sample series. It is also the independent check on the persisted samples: if the command and the panel disagree over the same window, one of them is wrong, and two routes to the number are what make that discoverable at all. What it must never become is a *second* persisted or alerted comparison — it prints and exits, and the panel and the divergence alert read FL's row and nothing else.

**Return and drawdown are reported together, always. A return without its drawdown beside it is not a result.** `docs/research/12-edge-hypothesis-critique.md`'s **D4** rules out return-only comparison against a risk-targeted stream: an arm can buy return with leverage, and against a stream whose risk is being targeted the return column alone is not evidence of anything. Both columns are therefore **structurally required**, not conventionally reported — `ArmPerformance.max_drawdown_pct` is non-optional in the contract and `arm_comparison_samples`' per-arm columns are `NOT NULL`, so no row shape, wire shape, or panel branch exists that can present one arm's return without its drawdown. Trade counts accompany both, because a comparison over two trades is not a comparison.

**Both arms come out of ONE window query, never two.** Doc 12's gate 4: the window is computed once per cycle (`window_from` exclusive, `window_to` inclusive, default 30 days), applied to a single read of `closed_trades`, and partitioned by the `arm` column. Two separately-parameterised queries would silently drift by a bar boundary, and a comparison that is off by a bar is a comparison of two different periods.

**Why the control cannot accidentally differ from the live arm.** `analysts-spec.md`:163 records the guarantee, and FL depends on it: with the analyst layer deterministic, the control arm "becomes **the analyst layer's own output thresholded**, with no separate implementation to write and no risk of the control differing from the live arm by accident." The two arms therefore differ in exactly one place — whether the debate ran — which is what makes the comparison a test of the debate rather than a test of two codebases. If the analyst layer ever regains an LLM, this guarantee lapses and the control becomes a separate implementation that must be independently matched; that is a spec-level precondition of this module, not an implementation detail.

**Divergence is alerted through the existing trade channel.** When the control **dominates** the live arm — control return exceeds live return by more than the threshold **and** the control's max drawdown is no worse — FL posts to the human on the same trade-channel path the metrics reports and breach alerts already use. The threshold is `0.5` percentage points of return over the 30-day window, with a floor of **5 closed trades on each arm** before any verdict is issued at all. Below that floor the cycle records `diverged: false`, and that value is an **absent verdict, not a passing one** — a consumer of the sample may not read it as "the control did not dominate", because dominance was never evaluated. The floor is not on the wire today, so the dashboard panel states the rule instead of the stronger claim; surfacing it is [#982](https://github.com/dd-jp/samurai-trading-system/issues/982). The 0.5 pp comes from the LLM bill the debate has to earn back: ~£58/yr equities-only ([#840](https://github.com/dd-jp/samurai-trading-system/issues/840)) pro-rated over 30 days against the £1,000 book is ~0.48 pp, rounded to 0.5. It is deliberately **not** CLAUDE.md's "~0.55 pp of accuracy" figure, which is a different quantity (per-decision accuracy at position notional, not realized return at book level).

**A divergence alert tightens nothing.** It is a measurement, not a kill-line breach: the "auto-tighten" reflex above would shrink the **live** arm's sizing only, changing one arm mid-comparison and corrupting the match it was reacting to. Kill/rework stays human, and so does any response to divergence.

**One known asymmetry, carried in the alert text.** The control always trades — it converges by construction — while the live arm can decline to trade when the debate does not converge. A stretch in which the live arm simply traded less can therefore read as divergence. The alert says so, so the operator reads a trade-count gap as a trade-count gap.

**Cadence and persistence.** The comparison runs on FL's existing daily cycle — not a new schedule — and each cycle appends one row to `arm_comparison_samples` (`shared-sqlite-store-spec.md`). It is persisted rather than recomputed on read because the dashboard is a separate process, because FL owns the computation, and because the panel below shows a trend, which needs a series.

### Module: Determinism & Backtest

- Walk-forward: weights/params evolve daily from only outcomes known before each T (injected clock), producing a point-in-time trajectory the backtest replays. Never global-fit-and-apply-retroactively.
- Same code path live vs replay — literally so since #736: the cycle no longer takes a `mode` at all, because the only branch on it was the loosen gate that backtest bypassed.

## Testing Decisions

### What Makes a Good Test

- Test `runDailyCycle` / `onTradeClose` / `computeMetrics` at their seams with a mocked clock-scoped store.
- Attribution: a winning trade raises its backers' weights, a loser lowers them, bounded and floored. (Shadow credit retired — #370.)
- Guardrails: auto-tighten applies; auto-loosen applies too and is logged, announced and reversible (#736); a loosening past a hard bound is refused, writes no dial and appends no log row.
- Labelling: on close, the right setup gets the right R, joined correctly; no label before close (point-in-time).
- Metrics: full suite computed; a breach triggers alert + auto-tighten but not an automatic kill.
- Matched control: both arms come from one window read; a control that leads on return but with a worse drawdown is NOT divergence; under the per-arm trade floor no verdict is issued; a divergence alerts and persists but tightens no dial; every cycle persists a sample, including the zero-trade one.
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
Feedback Loop → trade channel (metrics reports, breach alerts, arm-divergence alerts,
                loosen-approval requests)
Feedback Loop → arm_comparison_samples (→ dashboard arm-comparison panel, read-only)
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
