# Wayfinder Map: Risk Manager (Stage 4)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/risk-manager-spec.md](../specs/risk-manager-spec.md).

## Destination

Design the Risk Manager — the gate between Trader and Verdict. Consumes the Trader's `OrderIntent`, applies position-size caps, portfolio/asset-class exposure limits, and drawdown circuit breakers, and outputs a risk-adjusted decision for the Verdict stage. Destination = docs/specs/risk-manager-spec.md.

## Notes

- Upstream: Trader `OrderIntent` (bracket + sizing decomposition + cosine precedent metadata). See [trader-spec.md](../specs/trader-spec.md).
- Downstream: Verdict (Stage 5) — final go/no-go.
- The Trader deliberately deferred portfolio + asset-class exposure caps and drawdown circuit breakers to this stage (trader-spec.md).
- CONTEXT.md: "Gate between Trader and Verdict. Applies position-size caps, max drawdown circuit breakers, portfolio exposure limits. Can override Trader's recommendation with a hard 'no.'"
- Grill one question at a time; wayfinder produces decisions, not code.

## Decisions so far

- **Output = modify-and-reject, monotonic risk-reducing.** Risk outputs a decision that is either approved (optionally with a *reduced* size or *tightened* stop) or hard-rejected with a reason. It never increases size or loosens a stop — it can only ever reduce risk. Trim-to-fit for soft cap breaches; hard reject for tripped breakers / drawdown limits.
- **Architecture = fully mechanical, deterministic, NO LLM.** Every check is arithmetic against limits — reproducible and backtestable, which matters most for risk controls under stress.
- **Circuit breakers:** halt **new entries + scale-ins**, but **never block exits** (exits reduce risk; blocking traps you in losers). **Tiered** — per-asset-class breaker halts new entries for that class; portfolio-level breaker (total drawdown / daily loss) halts all new entries. **Reset:** soft breakers (daily loss) auto-reset next session; the hard max-drawdown breaker requires **manual re-arm** (human decides to resume after a major loss — "tuition money" caution + dead-man's-switch philosophy).

- **Limit set & precedence.** Ordered check pipeline (each step trims or hard-rejects; exits skip all entry gates and always pass):
  1. **Circuit-breaker gate** — hard-reject new entries if any breaker tripped (fail fast).
  2. **Per-trade size cap** — trim to `max_position_size`.
  3. **Per-asset exposure cap** — trim so total exposure to this instrument ≤ limit.
  4. **Per-asset-class exposure cap** — trim so crypto/stocks bucket ≤ limit.
  5. **Portfolio gross exposure cap** — trim so total gross ≤ limit.
  6. **Concentration check** — **v1: static concentration buckets** (assets grouped into predefined correlated groups, e.g. "large-cap crypto", "US tech", with a per-bucket exposure cap). Mechanical, deterministic, no rolling stats. Dynamic correlation-matrix upgrade deferred to **v2** — GitHub backlog ticket #50.
  7. **Min-viable-size re-check** — if trimming pushed size below viable, reject (no dust).
  Order rationale: breakers first, then trims narrowest→broadest, then concentration, then a final min-size sanity reject. Monotonic — each step only reduces risk.

- **Risk state & data sources.** Risk reads a **portfolio-accounting view over the shared SQLite store** (the same store holding positions/weights). Execution writes fills/positions; a small accounting module computes equity = cash + mark-to-market of open positions, drawdown = peak-to-trough of the equity curve, and notional exposure = size × current mark. Risk reads this **synchronously** — deliberately off the Feedback Loop's slower async tuning path (never make a risk check wait on a learning loop). (New component: portfolio-accounting module — added to CONTEXT.md.)
  - **Price-source dependency (advisor-caught):** mark-to-market needs *current* prices, which positions (entry price) + fills (execution price) do not provide. The accounting module must also read current marks (last price) from the **Market Data Service**. This makes Risk a **second consumer of the Market Data Service** (alongside Analysts' indicators) — its map/scope must include serving current/last price, not just indicators. Realized components (round-trip PnL, consecutive losses) come from fills alone; only unrealized mark-to-market needs the price feed.

- **Output contract to Verdict.** `RiskDecision = { status: 'approved'|'rejected', order_intent (possibly trimmed; present if approved), modifications (original vs final size/stop), binding_constraint (which check bound/killed it, e.g. 'per_asset_class_cap' / 'circuit_breaker:portfolio_drawdown'), reasons (machine tags + human text), risk_snapshot (current exposure, drawdown state, armed breakers) }`. **Rejected intents terminate at Risk** (logged with reason — CONTEXT.md "log every signal"); **only approved decisions flow to Verdict** (Verdict is the final go/no-go on tradeable proposals, not a re-review of rejects). The `RiskDecision` is the audit artifact either way.

- **Breaker thresholds & definitions.** Three breaker metrics, all from the portfolio-accounting view:
  - **Daily-loss %** (soft, auto-reset next session) — cumulative realized+unrealized PnL since session start, at portfolio level and per-asset-class (feeds the tiered scope).
  - **Peak-to-trough drawdown %** (hard, manual re-arm) — the max-drawdown breaker; align to CONTEXT.md's ~20–25% target.
  - **Max consecutive losses** (soft, cool-off) — N losing trades in a row → pause new entries, auto-reset after cool-off / next session.
  - **Volatility halt** (soft, per-asset-class) — pause new entries when realized/implied volatility spikes abnormally above a baseline (research docs 00/01/02 list "volatility halts" as a circuit breaker). Complements the Trader's vol-floor *sizing* with a hard *entry halt* in extreme regimes.
  - **Latency/error halt** (operational) — folded into the kill-switch path: repeated execution errors or stale data trip the halt-new-entries state (research: "latency/error triggers").
  **Session boundary:** UTC day for crypto (24/7), market-day for stocks. Exact % thresholds are config, tuned in paper trading.

- **Backtest determinism.** Same code path live vs replay; point-in-time state (position store + accounting view) via the injected clock (reuse #43 discipline). **Mode flag** for the hard breaker's re-arm: live = manual re-arm (human); backtest/replay = a configurable **auto-re-arm policy** (re-arm after drawdown recovers above a threshold, or after N days) so a backtest doesn't halt forever on first max-DD hit. The re-arm policy is reported with backtest results.

- **Exit & kill-switch handling.** **Exits pass through Risk verbatim** — never blocked by entry gates/breakers, never modified (an exit already reduces risk; nothing to tighten). **Kill-switch** (manual or dead-man's) → global halt on new entries + scale-ins (same as a portfolio hard breaker), manual re-arm. **Forced liquidation is OUT of Risk's scope** — Risk is a decision *gate*, not an *actor*; on kill it stops all new risk, and a separate emergency/kill module (or Execution) handles flattening if desired.

## Out of scope

- Trader sizing (Stage 3 — Risk only reduces, never re-derives).
- Verdict go/no-go (Stage 5) and Execution.
- Feedback Loop weight/threshold tuning (Stage 6) — Risk reads thresholds/state, doesn't compute the tuning.
