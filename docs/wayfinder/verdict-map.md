# Wayfinder Map: Verdict (Stage 5)

**Status:** Complete — all frontier decisions resolved. Spec: [docs/specs/verdict-spec.md](../specs/verdict-spec.md).

## Destination

Design the Verdict stage — the final go/no-go after Risk approval, which triggers execution. Consumes Risk's approved `RiskDecision` (with the possibly-trimmed `OrderIntent`), applies final gates, and either fires the order (hands to Execution) or records a no-go. Destination = docs/specs/verdict-spec.md.

## Notes

- Upstream: Risk Manager `RiskDecision` (status: approved, order_intent, risk_snapshot). Only approved decisions reach Verdict. See [risk-manager-spec.md](../specs/risk-manager-spec.md).
- Downstream: Execution (places the order via the broker abstraction, using the Trader's idempotency key as the order ID).
- CONTEXT.md: "The final go/no-go decision after Risk approval. Triggers execution."
- Apply research constraints (docs 00/01/02): "tuition money" caution, human confirmation in early deployment, signals decay.

## Decisions so far

- **HITL gate = both automated + human-in-the-loop, configurable by deployment stage + trade flags.** An automated fire path plus a human-approval gate that engages for flagged trades (non-converged, no-precedent, near-limit, size above threshold) and during early deployment (paper / tiny-live). As confidence grows the gate opens toward full automation — implements the staged-deployment plan ("deploy small, monitor, scale") and tuition-money caution.
- **HITL timeout → no-go (skip).** Fail-safe is *don't trade*: a missed human approval means the opportunity passes (strictly safer than auto-firing unconfirmed), and the signal is likely stale by then anyway.
- **Final staleness + drift gate → no-go if stale.** Verdict re-checks against current market data (injected clock / Market Data Service): signal age ≤ a per-asset-class max-age (crypto tight, stocks looser, same philosophy as debate latency budgets), and current price hasn't drifted past the bracket's entry beyond a tolerance. Stale/drifted → no-go — the entry the Trader/Risk reasoned about no longer holds.

- **HITL gate mechanics.** Approval + notification via **Telegram and Discord** (both supported), posted to a dedicated **trade channel** (approvals + fill notifications). Telegram inline approve/reject buttons primary; email fallback; dashboard for history. The human is shown the **full decision context** — instrument, side, size, entry/stop/target, conviction, `converged`, cosine precedent summary, `risk_snapshot`, and which trigger engaged the gate. Automation level is a **per-asset-class dial** in the shared config, read at Verdict time: `manual` (every trade needs approval), `semi_auto` (only flagged trades: non-converged / no-precedent / near-limit / size-over-threshold), `auto` (none). This is the dial turned as the system earns trust through deployment stages. **Ops task:** provision the actual Telegram + Discord trade channel (not a wayfinder decision — flagged for implementation/setup).

- **Automated final checks** (at fire time): (1) **idempotency dedup** — check the shared store for an existing order/fill under this idempotency key (instrument+bar); if present → no-go (already acted this bar). (2) **Market-open check** (stocks) — closed + no extended-hours permission → no-go/queue; crypto skips. (3) **Final kill-switch / breaker re-check** at the moment of firing (state may have changed since Risk approved, esp. after HITL delay) → no-go if tripped.

- **Output contract to Execution.** Verdict is **decide-only** — it does not call the broker. Emits `VerdictDecision = { status: 'go'|'no_go', order (if go), no_go_reason (staleness/drift/timeout/dedup/market_closed/breaker/human_rejected), approval_path ('automated'|'human'|'human_timeout'), idempotency_key, timestamp }`. A thin **Execution** boundary consumes `go` decisions and places orders via the broker abstraction (idempotency key = order ID). Same gate-vs-actor separation as Risk; broker specifics (ccxt/IBKR, partial fills, retries) live entirely in Execution.

- **Determinism & backtest.** In backtest the HITL gate is **bypassed (auto-approved)** via the mode flag, but each decision records *"would have required human approval"* so a backtest can measure how often the gate would fire without a human. Staleness/drift checks run via the injected clock. Same code path live vs replay.

- **Logging / audit.** Every `VerdictDecision` — go *and* no-go, with reason and approval path — is logged with full context as the final audit record (CONTEXT.md "log every signal").

## Out of scope

- Risk gating (Stage 4 — Verdict trusts Risk's approval, only adds final gates).
- Execution / broker order placement, partial fills, idempotent order IDs (downstream).
- Feedback Loop (Stage 6).
