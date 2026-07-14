# Wayfinder Map: Feedback Loop (Stage 6)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/feedback-loop-spec.md](../specs/feedback-loop-spec.md).

## Destination

Design the Feedback Loop — post-execution review. Compares predicted vs actual outcomes, adjusts analyst weights / strategy parameters / risk thresholds (bounded), owns the cosine setup store + R-multiple outcome labels, and computes the full metrics suite + periodic overfitting revalidation. Per CONTEXT.md: "does NOT change the underlying market model." Destination = docs/specs/feedback-loop-spec.md.

## Notes

- Reads realized outcomes from the shared store (fills/positions written by Execution) + the portfolio-accounting view.
- Writes: analyst weights (read by the Debate Engine when applying weights), strategy params, risk thresholds, and setup-store R-labels.
- Apply research constraints (docs 00/01/02): full metrics suite together, PBO≤0.05 / DSR / walk-forward, edges decay → periodic revalidation. See [[research-constraints]].

## Decisions so far

- **Cadence = batch/periodic, bounded step changes, DAILY.** Weights/params recomputed daily from accumulated realized outcomes; capped per-cycle change (no wild swings from one trade). Not online per-trade (that overfits to noise).
- **Scope = all three** (analyst weights + strategy parameters + risk thresholds), per CONTEXT.md — but with asymmetric guardrails (below).
- **Tuning guardrails (asymmetric):** FL may **auto-tighten** risk thresholds freely (stricter is always safe); **auto-loosening requires human approval** via the trade channel (never unsupervised). Every tunable param/threshold has **human-set hard floors/ceilings** the loop can't cross. All adjustments **bounded per daily cycle**, **logged + reversible**. Weights + strategy params (which don't relax guardrails) tune freely within bounds; risk-threshold *loosening* is gated.
- **Credit assignment = influence-weighted performance attribution.** Attribute each closed trade's realized R to analysts by their debate `influence_score`, signed by stance-vs-outcome (drove a winner → gain weight; drove a loser → lose weight). Accumulate over the daily batch, move each weight a bounded step toward its performance-implied level. **Small "shadow" credit** for right-but-low-influence analysts so a quietly-correct one can climb back. Weights floored/capped (none → 0 permanently or dominance).
- **Metrics & revalidation:** **Daily** — full metrics suite reported together (Sharpe, Sortino, Calmar, max drawdown, profit factor, expectancy, skew/kurtosis, turnover, exposure). **Weekly/monthly** — heavier revalidation (walk-forward / CPCV, Deflated Sharpe, PBO). **On a kill-threshold breach** (PBO > 0.05, OOS/paper Sharpe < 0.5, DSR insignificant, live-vs-backtest divergence): **alert the human** (trade channel) + **defensively auto-tighten** (drop automation toward manual, shrink sizing); the **kill/rework decision is human**, not automatic.
- **Setup store & outcome labelling:** FL owns the cosine setup store. **Event-driven labelling on trade close** — compute `R = realized PnL ÷ initial risk`, label the matching setup (joined by idempotency key / `debate_id`). Separate from the daily weight batch; store in the shared SQLite. Point-in-time preserved (a setup's R-label exists only after its trade closes — the "closed-outcome-only" rule the Trader's cosine retrieval relies on).
- **Determinism & backtest:** walk-forward via the same daily-batch logic, driven by the injected clock — weights/params evolve from only outcomes known before each point T, producing a **point-in-time weight trajectory** the backtest replays forward. Never global-fit weights applied retroactively (lookahead-in-weights). Same code path live vs replay; makes walk-forward/CPCV distributions honest.

## Frontier

All frontier decisions resolved. Map complete.

## Cross-spec reconciliation required (flag for the all-specs verification pass)

- **Attribution source = the debate log, joined by `debate_id`.** FL needs `AnalystContribution[]` (influence_score, stance) at trade close, but the Debate Engine is no-persistence (#10), so `DebateResult` isn't retained and `OrderIntent`/setup store don't carry it. Source is the Debate Engine **debate log** (story 20). Resolves cleanly: operational debate state is ephemeral; the debate log is a separate append-only persisted record. `debate_id` is thus **load-bearing for three consumers** (provenance, setup-store join, FL attribution join) — non-optional + deterministic.
- **Trade record must persist the entry bracket** (entry, stop, size) + `debate_id`, so `R = |entry−stop|×size` and the attribution join are computable at close (possibly days later).
- **Trader/Risk must read tunable params/thresholds live from the shared store** at decision/eval time (not static startup config), or FL's tuning writes into the void. Analyst weights already do this (#42).

## Out of scope

- The underlying market model / strategy core (CONTEXT.md invariant — FL adjusts weights/params/thresholds, not the model).
- Execution, order placement (FL reads outcomes, doesn't trade).
- The backtest harness / cost model itself (separate uncharted component — FL consumes it and owns the validation metrics, but the harness is its own chart).
