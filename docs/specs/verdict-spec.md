# Verdict Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

> **Read this before the rest of the document.** [ADR-0007](../adr/0007-fully-automatic-execution.md) (2026-08-06) set `automation_level` to `auto` for both asset classes **in paper and live**, so **no trade is ever routed to a human**. The human-in-the-loop material throughout this spec — the dial, the flag sources, `human_timeout`, the whole Telegram approval chain — is **retained and inert**. Where this document says Verdict "routes to a human", read it as "would route, if the dial could be moved off `auto`" — and **it cannot**: `assertAutomationLevelSupported` (`src/verdict/index.ts`) **throws on every production boot** if either asset class is set to `manual` or `semi_auto`, because the gate is not merely unused but unsound (gates 1 and 2 run before the approval `await` and are never re-checked, so an approval returning after a 15-minute `human_timeout` submits at a price older than `max_signal_age.crypto` allows). Re-enabling is therefore a **code change gated on async approval (#434)**, not a config edit. See "Staged-Deployment Alignment" below.

Risk has approved an order intent — but approval happened a moment ago, against a snapshot that may already be stale. Firing every Risk-approved order blindly ignores that signals decay between decision and execution. There needs to be one final, deliberate gate between "the system wants to trade" and "money moves."

*(The original framing added a second reason — that the first real-money trades deserve a human's eyes. ADR-0007 rejected it structurally, not on appetite: `Verdict.decide` awaits `approvals.requestApproval` **inside** the instrument pass, and `runTickPlan` runs instruments at `max_concurrent_instruments: 1`, so one trade awaiting a human tap blocks the whole universe for up to `human_timeout`. A human in this loop is a serialization point, not a safety net.)*

The Verdict stage (Stage 5) is that gate. It takes Risk's approved `RiskDecision`, applies a last round of freshness and safety checks, and emits a final go/no-go. Only a `go` reaches Execution. The human-approval path exists in the code and is unreachable at the shipped dial setting.

## Solution

Verdict is a **deterministic decision gate** (no LLM, no broker calls). Given a Risk-approved intent plus current market data and config, it runs: a **staleness/drift** check and three **automated final checks** (idempotency dedup, market-open, fire-time kill-switch/breaker re-check). A **human-in-the-loop approval** gate via Telegram/Discord sits behind those as a per-asset-class dial (`manual`/`semi_auto`/`auto`) — **set to `auto` for both classes since ADR-0007, so it never fires**. Any failed gate produces a `no_go` with a reason; a passed gate produces a `go` carrying the order to a thin Execution boundary. Every decision is logged.

Key architectural decisions:
- **Final go/no-go gate; decide-only** — Verdict never calls the broker; a thin Execution boundary acts on `go`.
- **Fully automatic since ADR-0007** — `automation_level: auto` for crypto and stocks, paper and live. The circuit breakers, not a human, are the only stop.
- **Human-in-the-loop, configurable by deployment stage + trade flags** — timeout → no-go (fail-safe). **Built, tested, and inert**; `shouldEngageHitl` short-circuits on the dial before any flag source is consulted.
- **Staleness + drift gate** — no-go if the signal aged out or price drifted past the entry.
- **Three automated final checks** — idempotency dedup, market-open (stocks), fire-time breaker/kill-switch re-check.
- **Telegram + Discord trade channel** for notifications (and for approvals, if the dial is ever moved).
- **Deterministic / backtestable** — HITL bypassed-but-recorded in backtest (and now bypassed in live too, by the dial).

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

**Stories 10–13 are built and inert since [ADR-0007](../adr/0007-fully-automatic-execution.md).** They are retained as the record of what the approval chain does, not as a description of live behaviour — the dial is `auto` for both classes, and story 10's "configurable per asset class" is now false in the only direction that matters: `assertAutomationLevelSupported` throws at boot on any non-`auto` value.

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
  drift_tolerance_pct: Record<'crypto' | 'stocks', number>; // max price drift from entry,
                                                          // as a FRACTION of entry (#381)
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
2. **Drift** — |current price − entry| > `entry * drift_tolerance_pct[asset_class]` → no-go (`drift`). **Fractional, not an absolute price distance** ([#381](https://github.com/dd-jp/samurai-trading-system/issues/381)): an absolute bound cannot be set correctly for more than one instrument at once, and its failure is asymmetric — a value sized for a six-figure BTC-USD is a multiple of a $200 equity, so the gate can never fire and an arbitrarily stale bracket executes. Per-asset-class *absolute* values were rejected for the same reason one level down: SPY and a $20 name cannot share a dollar bound either. A non-positive `entry` fails closed (`drift`) rather than computing a zero or inverted tolerance.
3. **Idempotency dedup** — existing order/fill for this key in the store → no-go (`dedup`).
4. **Market-open** (stocks) — closed + no extended-hours → no-go (`market_closed`).
5. **Fire-time kill-switch / breaker re-check** — tripped → no-go (`breaker`).
6. **HITL gate** (if engaged by automation level + flags) — human rejects → no-go (`human_rejected`); timeout → no-go (`timeout`); approves → go.
7. Otherwise → **go**.

### Module: Human-in-the-Loop

- **Automation dial** per asset class: `manual` (all trades), `semi_auto` (flagged only), `auto` (none). **Set to `auto` for both classes since [ADR-0007](../adr/0007-fully-automatic-execution.md), in paper and live — the flag sources below are therefore inert, because `shouldEngageHitl` short-circuits on the dial before they are consulted.** **Flag sources** (each resolves to a concrete field): non-converged = `order.metadata.converged === false`; no-precedent = `order.metadata.cosine_precedent.no_precedent`; size-over = `order.size > flag_thresholds.size_over`; **near-limit = `risk_decision.modifications != null`** (the trade was trimmed to fit a cap).
- **Channels:** Telegram (inline approve/reject) + Discord, posted to a dedicated **trade channel**; email fallback; dashboard for history. Fills and no-gos also posted there.
- **Context shown:** instrument, side, size, entry/stop/target, conviction, `converged`, cosine precedent summary, `risk_snapshot`, and which trigger engaged the gate.
- **Timeout → no-go.** Fail-safe.
- **Ops task (not a design decision):** provision the actual Telegram + Discord trade channel.
- **Callback authn/authz (ticket #207 — decided, not open; amended per #272):** an inbound approve/reject must not be trusted on receipt alone: under the live polling transport the threat is a button pressed by the wrong person or in the wrong chat, otherwise indistinguishable from David's own response on the live-money control gate. Two of #207's originally named threats are re-scoped by that transport: a spoofed webhook hit applies only to a future webhook transport (polling has no inbound endpoint to spoof), and a stolen bot token cannot forge `callback_query.from.id` (Telegram attests the presser) — its blast radius under polling is availability (stealing the single-consumer `getUpdates` stream, spamming the channel), which fails closed to timeout, not approval forgery.
  - **Sole working access control.** Under the **Telegram polling transport** (the live transport — see `docs/specs/transport-layer-spec.md`), the **sole working access control over *who* may approve** is `callback_query.from.id` checked against a configured allowlist, `TELEGRAM_ALLOWED_USER_IDS`: only a callback whose `from.id` is in that allowlist can resolve a pending approval. (The correlation token below is also load-bearing, but it scopes *which* pending request a callback can resolve, not who may resolve it — the two are orthogonal, and only the allowlist is an identity check.) A `TELEGRAM_ALLOWED_USER_IDS` misconfiguration that is **permissive or wrong** (an over-broad list or the wrong id — the only permissive shapes that can survive the boot-time validation below, which rejects wildcards outright) is a **critical exposure**: it removes the only real gate on who can approve a live-money trade, not merely a redundant layer. An **empty or unset** allowlist is different — no `from.id` can ever match, so it fails closed (no approval ever resolves → every pending request times out → `no_go`) rather than opening access. That's not a security exposure, but it is an operational hazard the system must not discover at runtime.
  - **Boot-time validation.** Refuse to arm the live approval gate (fail startup) when `TELEGRAM_ALLOWED_USER_IDS` is unset or empty. Also cover the direction that actually opens the gate rather than closing it, with a single rule: reject any entry that doesn't parse as a **Telegram numeric user id in the accepted range 1 ≤ id ≤ 2^53 − 1** (`Number.MAX_SAFE_INTEGER`) — this subsumes wildcard or sentinel entries like `*`, which fail the numeric parse. Both bounds are load-bearing: ids routinely exceed the 32-bit signed range, so a 32-bit parse would reject valid ids at startup; a negative value is a group/chat id, not a user id; and a value above 2^53 − 1 must be rejected rather than parsed — a JS `Number` parse of such a value rounds silently and would then never match at runtime. A malformed, non-numeric, out-of-range, or negative id is as much a sign of a broken config as an empty one, and letting it through to be silently unmatched at runtime (rather than caught at startup) is the same discover-it-live hazard this validation exists to prevent.
  - **Wrong-chat threat / correlation token.** The "message from the wrong chat" threat named above is **not** handled by this allowlist — `from.id` identifies the presser, not the chat the button was pressed in — it is handled by the **correlation token**: per `transport-layer-spec.md`'s `TelegramClient` module, each approval request mints an opaque per-button token embedded only in the message actually sent to the configured trade channel, and a `callback_query` can only resolve a pending approval if its `callback_data` carries that exact token (128-bit CSPRNG-random — see `transport-layer-spec.md`'s Correlation bullet for the entropy floor and why it can't lean on per-request expiry); a button pressed in any other chat the bot occupies carries no valid token and is a no-op regardless of `from.id`.
  - **Why not `chat.id`.** `chat.id` is deliberately **not** part of the check (see `transport-layer-spec.md`'s `TelegramClient` module for the rationale): the trade channel is a group/channel, so `chat.id` is shared by every member and cannot serve as a per-user identity check, and it adds no scope guarantee the correlation token does not already provide — the token is unique per pending request, required by the resolution path itself (an unmatched or expired token is a no-op — see `transport-layer-spec.md`'s inbound-flow steps 2–3), and only ever present in the one message it was minted for.
  - **HMAC seam status.** `SignedApprovalChannel`'s **shared-secret HMAC-SHA256** check remains in the code path as a **dormant, transport-agnostic seam**: the callback carries a signature computed over the request's stable identifier (`trace_id` + `order_intent.idempotency_key`) plus the claimed outcome, under a pre-shared secret supplied by the callback receiver at verification time (config/ops-provisioned, never stored in the repo or held by the channel object itself); verification is timing-safe and never throws on malformed input; no separate nonce/expiry scheme is needed since the signed `trace_id` is a fresh per-tick correlation ID and a resolved pending entry is removed immediately. Under Telegram polling the same process both constructs and verifies the signature in a bot-polling round trip, so the check attests nothing about the remote caller and can fail only via an in-process bug — secret rotation or code drift (e.g. payload canonicalization changing in a deploy) between send and callback; see "Mid-flight secret rotation or code drift" below — it is **not defense-in-depth today**, and describing it that way would overstate it; identity work is done entirely by the `from.id` allowlist above. It becomes load-bearing only if a future **webhook-based** channel (e.g. Discord) is added, where a request genuinely arrives from outside the process and an unforgeable signature would matter.
  - **Cross-spec supersession.** The framing above supersedes the "defense-in-depth plumbing" / "transport-agnostic seam and defense-in-depth" wording that previously appeared in `transport-layer-spec.md`'s `TelegramClient` module (its inbound-flow step 3, and its amendment note) — both reconciled in the same amendment, so the two specs don't diverge on the same mechanism.
  - **HMAC secret boot-time validation.** **Refuse to arm the live approval gate (fail startup) if the configured HMAC secret is missing or empty**, and the verifier must reject an empty/missing secret at construction rather than quietly accepting one — the same fail-startup discipline as `TELEGRAM_ALLOWED_USER_IDS`, and one uniform rule rather than gating the check behind the not-yet-built webhook transport. The precise rationale: under polling the same process signs and verifies with the same configured secret, so a *static* misconfiguration — even an empty key — signs and verifies consistently and passes (HMAC with an empty key does not fail); boot validation exists because an empty secret is a broken config that becomes a real exposure the day a webhook transport goes live, not because it would fail verification today.
  - **Mid-flight secret rotation or code drift.** The runtime failures the HMAC check can actually produce under polling are in-process bugs that change one side of the round trip between send and callback: secret rotation or config reload while approvals are in flight, or code drift (e.g. a deploy changing payload canonicalization). Any of these fails verification on every in-flight callback, which never resolves and times out, indistinguishable from a genuine human non-response. Boot-time validation cannot catch these; they are covered by "Dead-gate detection" below.
  - **Resolution on any verification failure.** A callback that fails either check (allowlist or HMAC) never resolves the pending approval; it falls through to the request's own `timeout_ms` expiry (`no_go_reason: 'timeout'`), the same fail-safe as a genuine non-response. Failures are silent only with respect to resolution — observability is specified per failure mode in the next two bullets, because the two carry different severity under polling.
  - **Observability — allowlist failure (security signal, alertable).** A failed `from.id` allowlist check is a genuine security signal — an unauthorized party attempting to resolve a live-money approval. It must be logged as a structured audit entry (channel, failure reason, **offending `from.id`**, `chat.id`, a **truncated prefix of the callback's correlation token (first 8 hex chars — never the full token**, which is a live bearer capability until the request times out; persisting it would let anyone with log access resolve the approval, undercutting the 128-bit unguessability argument) plus the `trace_id` it maps to when known — populated via a **best-effort read-only lookup** of the correlation-token map at rejection-logging time (the allowlist check runs before token recovery in the inbound flow, so this lookup is logging-only: it must never resolve, consume, or expire the pending entry, and the field is simply absent when the token doesn't match) — and timestamp) and metered as a distinct, alertable event, separate from a genuine timeout. The `from.id` is required in the entry because it's the field that lets ops attribute and block a repeat prober.
  - **Observability — HMAC failure (debug log, not an attack alert).** A failed HMAC check under Telegram polling cannot indicate a forgery (see "HMAC seam status" above) — log it for debugging, but do not alert at the same "possible attack" severity as an allowlist failure, or the alert trains itself to fire on bugs rather than forgeries and gets ignored. This reverses once a webhook transport exists: an HMAC failure there becomes the real security signal.
  - **Dead-gate detection.** Demoting HMAC failures to debug-no-alert, combined with a timeout being indistinguishable from a genuine human non-response, would make a post-boot secret break (rotation, config reload, or any other bug that starts failing every HMAC check) operationally invisible: every approval quietly times out and nothing pages anyone. To close that gap, alert on the **aggregate approval-timeout rate** — a sustained spike in `no_go_reason: 'timeout'` across pending approvals (as distinct from a single expected human non-response) — so a dead gate is caught by an ops signal even though no individual failure is itself alertable at that severity. As with the repeated-rejection alert in `transport-layer-spec.md`, the exact rate threshold is an implementation detail, not decided here.
  - See `src/verdict/notifications/approval-callback-verifier.ts` (verify/sign) and `src/verdict/notifications/verified-approval-channel.ts` (`SignedApprovalChannel`, the concrete `ApprovalChannel` enforcing this).

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

> **SUPERSEDED 2026-08-06 by [ADR-0007](../adr/0007-fully-automatic-execution.md).** The staging below is no longer what the system does. `automation_level` is `auto` for both asset classes in **paper and live**, so gate 6 is unreachable and no trade is ever routed to a human.
>
> The reason is structural, not a change of appetite: `Verdict.decide` *awaits* `approvals.requestApproval` **inside** the instrument pass, and `runTickPlan` runs instruments at `max_concurrent_instruments: 1`. One trade awaiting a human tap therefore blocks the entire universe for up to `human_timeout`. A human in this loop is a serialization point, not a safety net.
>
> The dial, the flag plumbing, `human_timeout` and the whole Telegram approval chain are **retained and inert**.
>
> **Turning it back is no longer a config edit — the code refuses.** An earlier revision of this paragraph said it was, and that was wrong: a comment guards nothing, and the dial is a config value flipped by someone who has not read the comment. `assertAutomationLevelSupported` (`src/verdict/index.ts`) now **throws at production boot** whenever either asset class is `manual` or `semi_auto`, naming the reason and the blocking ticket. Both engaging levels are covered, not just `semi_auto` — `manual` reaches the same `await` through the same two already-evaluated gates. Unlike an in-branch re-check this is not a guard on an unreachable path (#430): it runs on every boot.
>
> The reason it refuses: gates 1 (staleness) and 2 (drift) run *before* gate 6 and are never re-evaluated after it, so an approval returning after `human_timeout` (15 min) submits at a price last checked longer ago than `max_signal_age.crypto` (5 min) permits — a gate that reads as a freshness guarantee is not one. ADR-0007 records async approval (Verdict returns `pending`; a poller resumes it) as the only version worth building, which also removes the human from the instrument pass — the actual reason the gate was dropped. **Land [#434](https://github.com/dd-jp/samurai-trading-system/issues/434) before re-enabling anything here.**
>
> **What replaces the gate:** nothing. The circuit breakers are now the only stop, which makes #384, #375 and #333 the live-go gate — see ADR-0007 "Consequences".

The paragraph this replaces, retained for provenance: *the automation dial operationalizes the research's staged-deployment plan: start `manual` (human confirms every real-money trade during paper / tiny-live), move to `semi_auto` (only risky trades interrupt), then `auto` once live KPIs hold and trust is earned. The "tuition money" first-live trades get a human's eyes by construction.*

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
