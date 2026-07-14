# Verdict Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

Risk has approved an order intent — but approval happened a moment ago, against a snapshot that may already be stale, by a system that (early in its life) has not yet earned the right to commit real money unsupervised. Firing every Risk-approved order blindly ignores two realities: signals decay between decision and execution, and the first real-money trades deserve a human's eyes. There needs to be one final, deliberate gate between "the system wants to trade" and "money moves."

The Verdict stage (Stage 5) is that gate. It takes Risk's approved `RiskDecision`, applies a last round of freshness and safety checks, optionally routes the trade to a human for approval (configurable by deployment stage), and emits a final go/no-go. Only a `go` reaches Execution. It is where the staged-deployment discipline ("deploy small, confirm, then scale") and the "tuition money" caution live.

## Solution

Verdict is a **deterministic decision gate** (no LLM, no broker calls). Given a Risk-approved intent plus current market data and config, it runs: a **staleness/drift** check, three **automated final checks** (idempotency dedup, market-open, fire-time kill-switch/breaker re-check), and — for flagged trades or early deployment stages — a **human-in-the-loop approval** gate via Telegram/Discord. Any failed gate produces a `no_go` with a reason; a passed gate (auto or human-approved) produces a `go` carrying the order to a thin Execution boundary. The human gate is a per-asset-class dial (`manual`/`semi_auto`/`auto`) turned as the system earns trust. Every decision is logged.

Key architectural decisions:
- **Final go/no-go gate; decide-only** — Verdict never calls the broker; a thin Execution boundary acts on `go`.
- **Human-in-the-loop, configurable by deployment stage + trade flags** — timeout → no-go (fail-safe).
- **Staleness + drift gate** — no-go if the signal aged out or price drifted past the entry.
- **Three automated final checks** — idempotency dedup, market-open (stocks), fire-time breaker/kill-switch re-check.
- **Telegram + Discord trade channel** for approvals + notifications.
- **Deterministic / backtestable** — HITL bypassed-but-recorded in backtest.

## User Stories

### Final Gate & Output

1. As the Verdict stage, I want to consume Risk's approved `RiskDecision`, so that I make the final call on a vetted intent.
2. As the Verdict stage, I want to emit a `VerdictDecision` (go/no-go + order + reason + approval path), so that Execution and the audit log have a complete final record.
3. As the Verdict stage, I want to decide only and never call the broker, so that broker specifics stay isolated in Execution.
4. As the system, I want only `go` decisions to reach Execution, so that no-go trades never place orders.

### Freshness

5. As the Verdict stage, I want to reject a signal older than a per-asset-class max-age, so that I never fire on a decayed signal (crypto tight, stocks looser).
6. As the Verdict stage, I want to reject when current price has drifted past the bracket's entry beyond a tolerance, so that I don't fire on an entry that no longer holds.

### Automated Final Checks

7. As the Verdict stage, I want to dedup against existing orders/fills for this idempotency key, so that I never double-fire on the same instrument+bar across restarts/retries.
8. As the Verdict stage, I want to reject stock orders when the market is closed (no extended-hours permission), so that I don't queue invalid orders.
9. As the Verdict stage, I want to re-check the kill-switch and breaker state at fire time, so that state changes since Risk approved (especially after HITL delay) still block the trade.

### Human-in-the-Loop

10. As the operator, I want a human-approval gate configurable per asset class (manual/semi_auto/auto), so that I can require approval in early deployment and open up as trust grows.
11. As the operator, I want the gate to engage for flagged trades (non-converged, no-precedent, near-limit, size over threshold) in semi_auto, so that only risky trades interrupt me.
12. As the operator, I want approval requests via Telegram and Discord in a dedicated trade channel with full context, so that I can decide on the spot.
13. As the system, I want a human non-response to time out to no-go, so that a missed approval safely skips the trade.
14. As the operator, I want fills and no-gos also posted to the trade channel, so that I have live visibility.

### Determinism & Audit

15. As the system, I want Verdict to run the same code path live and in replay, so that backtests exercise real gating.
16. As the system, I want the HITL gate bypassed-but-recorded in backtest, so that I can measure how often it would fire without a human.
17. As the system, I want every `VerdictDecision` logged with full context, so that every final decision is auditable.

## Implementation Decisions

### Module: Verdict Core

**Responsibilities**
- Consume the approved `RiskDecision`; read current market data, config, and breaker/kill state via the injected clock.
- Run the gate sequence: staleness/drift → automated final checks → HITL (if engaged).
- Emit a `VerdictDecision`; log it; forward `go` to Execution.

**Key Interfaces**

```typescript
// Single test seam. Deterministic given inputs; HITL is injected (auto in backtest).
interface Verdict {
  decide(input: VerdictInput): Promise<VerdictDecision>;
}

interface VerdictInput {
  trace_id: string;              // cross-cutting correlation ID, threaded from the Orchestrator's tick — not business data
  risk_decision: RiskDecision;   // approved only
  clock: Clock;                  // wall-clock live, simulated T in replay
  marketData: MarketDataService; // current price for staleness/drift (clock-scoped)
  positionStore: PositionStore;  // idempotency dedup
  breakers: BreakerState;        // fire-time re-check
  config: VerdictConfig;         // per-asset-class automation level + thresholds
  mode: 'live' | 'backtest';     // backtest bypasses HITL (records would-require-approval)
  approvals: ApprovalChannel;    // Telegram/Discord gate (no-op auto-approve in backtest)
}

interface VerdictDecision {
  status: 'go' | 'no_go';
  order: OrderIntent | null;             // present iff go
  no_go_reason: string | null;           // 'staleness'|'drift'|'timeout'|'dedup'
                                         // |'market_closed'|'breaker'|'human_rejected'
  approval_path: 'automated' | 'human' | 'human_timeout';
  would_require_approval: boolean;       // recorded even when bypassed in backtest
  idempotency_key: string;
  timestamp: Date;
}

interface VerdictConfig {
  automation_level: Record<'crypto' | 'stocks', 'manual' | 'semi_auto' | 'auto'>;
  max_signal_age: Record<'crypto' | 'stocks', number>;   // staleness bound
  drift_tolerance: number;                                // max price drift from entry
  human_timeout: number;                                  // → no-go on expiry
  flag_thresholds: {                                      // what "flagged" means in semi_auto
    size_over: number;
    // non-converged / no-precedent / near-limit read from intent metadata + risk_snapshot
  };
}
```

### Module: Gate Sequence

Ordered; first failure short-circuits to `no_go`:
1. **Staleness** — signal age = `clock.now() − order.decision_timestamp`; if > `max_signal_age[asset_class]` → no-go (`staleness`). (`decision_timestamp` is a required field on `OrderIntent` — see cross-spec note below.)
2. **Drift** — |current price − entry| > `drift_tolerance` → no-go (`drift`).
3. **Idempotency dedup** — existing order/fill for this key in the store → no-go (`dedup`).
4. **Market-open** (stocks) — closed + no extended-hours → no-go (`market_closed`).
5. **Fire-time kill-switch / breaker re-check** — tripped → no-go (`breaker`).
6. **HITL gate** (if engaged by automation level + flags) — human rejects → no-go (`human_rejected`); timeout → no-go (`timeout`); approves → go.
7. Otherwise → **go**.

### Module: Human-in-the-Loop

- **Automation dial** per asset class: `manual` (all trades), `semi_auto` (flagged only), `auto` (none). **Flag sources** (each resolves to a concrete field): non-converged = `order.metadata.converged === false`; no-precedent = `order.metadata.cosine_precedent.no_precedent`; size-over = `order.size > flag_thresholds.size_over`; **near-limit = `risk_decision.modifications != null`** (the trade was trimmed to fit a cap).
- **Channels:** Telegram (inline approve/reject) + Discord, posted to a dedicated **trade channel**; email fallback; dashboard for history. Fills and no-gos also posted there.
- **Context shown:** instrument, side, size, entry/stop/target, conviction, `converged`, cosine precedent summary, `risk_snapshot`, and which trigger engaged the gate.
- **Timeout → no-go.** Fail-safe.
- **Ops task (not a design decision):** provision the actual Telegram + Discord trade channel.

### Module: Determinism & Backtest

- Same code path live vs replay; all reads point-in-time via the injected clock.
- In `backtest` mode the `ApprovalChannel` is a no-op auto-approve, but `would_require_approval` is still computed and recorded — so a backtest measures gate-engagement frequency without a human.

## Testing Decisions

### What Makes a Good Test

- Test at `Verdict.decide(input)`: given an approved `RiskDecision` + mocked market data / store / breakers / config + mock clock, assert on the `VerdictDecision`.
- Cover each gate's no-go path and the full-pass go path.
- Cover HITL: approve → go, reject → no-go, timeout → no-go, and automation-level routing (manual/semi_auto/auto; flagged vs unflagged in semi_auto).
- Cover backtest auto-approve with `would_require_approval` recorded.
- No LLM to mock; assert deterministic outputs (with the injected approval channel controlling HITL outcomes).

### Modules to Test

**Gate Sequence** — each gate blocks with the right `no_go_reason`; ordering short-circuits correctly; full pass → go.

**HITL** — automation-level dial routing; flag detection in semi_auto; timeout → no-go; approve/reject paths; channel messages contain full context.

**Determinism** — same input → same decision; backtest bypass records `would_require_approval`.

### Prior Art

- No implementation yet. Injected-clock and mode-flag patterns mirror Risk and the Trader. The injected `ApprovalChannel` mirrors how other stages inject their side-effecting dependencies for deterministic testing.

## Out of Scope

**Risk gating (Stage 4)** — Verdict trusts Risk's approval and only adds final gates; it does not re-run Risk's checks (beyond the fire-time breaker re-check).

**Execution** — order placement, broker abstraction (ccxt/IBKR), partial fills, retries, and using the idempotency key as the order ID are all downstream. Verdict emits a `go`; Execution acts.

**Feedback Loop (Stage 6)** — outcome tracking and tuning.

**Channel provisioning** — creating/configuring the actual Telegram + Discord trade channel is an ops/setup task, not part of this spec's logic.

**Exact thresholds** — max signal age, drift tolerance, human timeout, flag thresholds, and automation levels are config, tuned per deployment stage.

## Further Notes

### Integration with Pipeline

```
Risk Manager → Verdict → Execution → Broker
             (this spec)   (thin actor: broker abstraction)
Verdict → Telegram/Discord trade channel (approvals + fill/no-go notifications)
```

### Domain Glossary Alignment

Per CONTEXT.md:
- **Verdict**: "The final go/no-go decision after Risk approval. Triggers execution."
- **Dead-Man's Switch**: the Telegram/Discord alerting infra Verdict reuses for the trade channel.
- **Idempotent Order**: the dedup check + idempotency key ensure exactly one fill.

### Staged-Deployment Alignment

The automation dial operationalizes the research's staged-deployment plan: start `manual` (human confirms every real-money trade during paper / tiny-live), move to `semi_auto` (only risky trades interrupt), then `auto` once live KPIs hold and trust is earned. The "tuition money" first-live trades get a human's eyes by construction.

### Future Extensions

- Approval SLAs / escalation (nudge, then escalate channel) before timeout.
- Per-strategy automation dials once multiple strategies run.
- Batched approvals for rapid-fire crypto signals.

## Resolved Decisions (Sources)

Wayfinder decisions for this stage live in [docs/wayfinder/verdict-map.md](../wayfinder/verdict-map.md) (charted locally). Decisions synthesized here:

- **Authority & output** — final go/no-go, decide-only, `VerdictDecision` to a thin Execution boundary.
- **HITL gate** — both automated + human, per-asset-class automation dial (manual/semi_auto/auto), engages on flags + deployment stage; timeout → no-go.
- **Staleness + drift gate** — no-go if signal aged out or price drifted past entry.
- **Automated final checks** — idempotency dedup, market-open (stocks), fire-time breaker/kill-switch re-check.
- **Channels** — Telegram + Discord dedicated trade channel; full context; fills/no-gos posted too.
- **Determinism & backtest** — same code path; HITL bypassed-but-recorded in backtest.
- **Logging** — every `VerdictDecision` logged with full context.

**Cross-spec requirement:** the staleness gate needs `OrderIntent.decision_timestamp` (the bar/decision time) — a field the Trader must expose (added to trader-spec.md; same Domain-Types reconciliation bucket as the `DebateResult` additions). Without it, signal age is uncomputable.

**Dependencies:** the Market Data Service (current price for staleness/drift — another consumer, still unbuilt); the shared store (idempotency dedup); the Telegram/Discord trade channel (ops setup); **Execution** (thin actor, downstream — itself uncharted: it writes fills to the shared store, consumes the idempotency key for dedup, expands the bracket to broker-native, and acts on `go`; needs its own chart before `/to-tickets`, alongside the Market Data Service and the cost model).
