# Verdict Specification

**Status:** Draft (resolved wayfinder decisions synthesized)  
**Owner:** David (Deepak)  
**Date:** 2026-07-13

## Problem Statement

> **Read this before the rest of the document.** [ADR-0007](../adr/0007-fully-automatic-execution.md) (2026-08-06) set `automation_level` to `auto` for both asset classes **in paper and live**, so **no trade is ever routed to a human**. The human-in-the-loop material throughout this spec — the dial, the flag sources, `human_timeout`, the whole Telegram approval chain — is **retained and inert**. Where this document says Verdict "routes to a human", read it as "would route, if the dial could be moved off `auto`" — and **it cannot**: `assertAutomationLevelSupported` (`server/pipeline/verdict/index.ts`) **throws on every production boot** if either asset class is set to `manual` or `semi_auto`, because the gate is not merely unused but unsound (the freshness gates (staleness, feed staleness, drift) run before the approval `await` and are never re-checked, so an approval returning after a 15-minute `human_timeout` submits at a price older than `max_signal_age.crypto` allows). Re-enabling is therefore a **code change gated on async approval (#434)**, not a config edit. See "Staged-Deployment Alignment" below.

Risk has approved an order intent — but approval happened a moment ago, against a snapshot that may already be stale. Firing every Risk-approved order blindly ignores that signals decay between decision and execution. There needs to be one final, deliberate gate between "the system wants to trade" and "money moves."

*(The original framing added a second reason — that the first real-money trades deserve a human's eyes. ADR-0007 rejected it structurally, not on appetite: `Verdict.decide` awaits `approvals.requestApproval` **inside** the instrument pass, and `runTickPlan` ran instruments at `max_concurrent_instruments: 1` when ADR-0007 was decided (2026-08-06), so one trade awaiting a human tap blocked the whole universe for up to `human_timeout`. [#1013](https://github.com/dd-jp/samurai-trading-system/issues/1013) (2026-09-02) raised that to `6` in paper and live — at that width the same `await` blocks only the one instrument's worker, not the universe — but the gate stays unreachable regardless: `automation_level: auto` short-circuits it before the width matters, per ADR-0007's 2026-09-02 amendment. A human in this loop is a serialization point, not a safety net.)*

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
  mode: 'live' | 'paper' | 'backtest';   // backtest overrides gate 6's outcome to go once `approvals` answers (records
                                          // would_require_approval) rather than skipping the call — a throwing channel
                                          // still refuses; paper behaves like live. Widened 2026-08-17 (#644) to match
                                          // `execution-spec.md:103` and the code (`VerdictInput.mode`) — a two-way union
                                          // here lied about which environments the system runs in.
  approvals: ApprovalChannel;    // Telegram/Discord gate; backtest overrides its answer to go, not the call itself
}

interface VerdictDecision {
  status: 'go' | 'no_go';
  order: OrderIntent | null;             // present iff go
  no_go_reason: string | null;           // 'staleness'|'stale_feed'|'drift'|'timeout'|'dedup'
                                         // |'market_closed'|'breaker'|'human_rejected'
  approval_path: 'automated' | 'human' | 'human_timeout';
  would_require_approval: boolean;       // recorded even when bypassed in backtest
  idempotency_key: string;
  timestamp: Date;
}

interface VerdictConfig {
  automation_level: Record<'crypto' | 'stocks', 'manual' | 'semi_auto' | 'auto'>;
  max_signal_age: Record<'crypto' | 'stocks', number>;   // SIGNAL-age bound (decision_timestamp)
  max_mark_age: Record<'crypto' | 'stocks', number>;     // FEED-age bound (Mark.observed_at) — #641
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

**Naming convention (#1254).** Cite a gate by its `no_go_reason` name; treat a bare number as unsafe. This document used to number every gate as its own full integer, with no `2a`: when [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) inserted `stale_feed` ahead of `drift`, that scheme gave `stale_feed` "2" and pushed `drift` to "3" here. `server/pipeline/verdict/index.ts` instead gave the new gate a sub-number, `2a`, leaving `drift`=2 and `dedup`=3 where they already were — the `2a` convention is that file's alone. Neither ADR-0007 nor ADR-0014 mentions `stale_feed` or `2a`, and both agree with the code's scheme — but for different reasons, and only one of them is the never-renumbered case: ADR-0007's numbers (2026-08-06) genuinely predate #641, and survived because `2a` was chosen precisely so nothing after `drift` had to move; ADR-0014's Verdict gate numbers were written into its 2026-08-19 amendment, four days after #641 shipped `2a` (2026-08-15), against `server/pipeline/verdict/index.ts`'s scheme directly — its "Gates 2–6 are untouched" runs `drift` through the HITL gate, and its `market_closed` is gate 4, both of which the superseded scheme would number one higher. Same digit, opposite safety character (a deliberately-skipped price check vs. a dedup guard whose skip would let a repeated flatten double-submit) depending on which document a reader carried the number in from. **`server/pipeline/verdict/index.ts` is the numbering authority** — its `// Gate N:` comments sit on the gates in execution order, in the file that actually runs them; the parentheticals below match it (`2a` for the price sub-gate `stale_feed` inserted by #641, which is why the numbering isn't consecutive).

**The convention has exactly one exception, stated rather than left implicit.** The HITL gate (gate 6) has no `no_go_reason` of its own: it refuses with two, `timeout` and `human_rejected`, which name the *outcome* of the approval round-trip and not the gate. `hitl` is not a member of the union (`server/pipeline/verdict/types.ts`, `VerdictDecision.no_go_reason`) and must never be written as though it were. That one gate is therefore cited by **role** — "the HITL gate", unbackticked, with its number as the same ordinary parenthetical every other gate carries — everywhere in this repo. Every other gate is cited by its reason code:

Ordered; first failure short-circuits to `no_go`:
- **`staleness`** (gate 1) — signal age = `clock.now() − order.decision_timestamp`; if > `max_signal_age[asset_class]` → no-go. (`decision_timestamp` is a required field on `OrderIntent` — see cross-spec note below.)
   - **AMENDED 2026-08-19 by [#894](https://github.com/dd-jp/samurai-trading-system/issues/894): this gate is SKIPPED for any intent carrying `metadata.mandatory_flatten === true`** — the ADR-0014 mandatory flat-by-close exit, healthy feed or degraded one. The exemption is structural, not a widened tolerance: the flatten window opens `flatten_before_close_ms` before the session close while `decision_timestamp` carries the decision bar, so a flatten's signal age is structurally tens of minutes against a 15-minute `max_signal_age.stocks`, and this gate refused **every** flat-by-close exit. A mandatory flatten acts on the clock, not on the opinion whose age this gate bounds, so how old that opinion is cannot be a reason to hold the lot overnight. The marker is set at the single Trader site that constructs an exit intent (`buildFlattenExit`, `trader/decide.ts` — the only production-code site that constructs one) and only for `exit_reason: 'flatten'`, so every entry and both discretionary exits (`signal_decay`, `direction_flip`) stay bounded here exactly as before. The smoke harness's `exitPathOrder` (`server/apps/orchestrator/smoke-run.ts`) is a second producer of an exit intent Verdict sees, driven through the real `VerdictImpl` by `exitPathVerdict`; it builds `exit_reason: 'flatten'` with neither marker, which is benign — the intent carries neither marker, so no gate is skipped by exemption; it reaches `go` in the harness because its bracket is non-zero, its `decision_timestamp` is fresh, its asset class is crypto so gate 4 (market-open) does not apply, and the harness config widens `max_mark_age` to 24h for the fixture's one frozen mark (`EXIT_PATH_VERDICT_CONFIG`, `server/apps/orchestrator/smoke-run.ts`) rather than `stale_feed` clearing on the mark's own merits. The claim above is about production code's exemption markers, not about every caller of `decide` reaching `go` by the same route. [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md)'s 2026-08-19 amendment rules on this and exempts the flatten from **this gate only** — that amendment is implemented but records itself as **pending David's ratification**, and if he rules otherwise the code changes with the ruling.
- **`stale_feed`** (gate 2a) — `clock.now() − mark.observed_at` > `max_mark_age[asset_class]`, **or `observed_at` ahead of `clock.now()`** → no-go. Resolved by [#641](https://github.com/dd-jp/samurai-trading-system/issues/641) (implement, not delete), which closes cross-verify finding CV-6: `market-data-service-spec.md` and the contracts registry §3 described this gate as live across three verification passes while `verdict-spec.md` had no mention of it and the code had no check.
   - **Not the same gate as `staleness`**, which is why both exist. `staleness` bounds how long ago **we decided** (`decision_timestamp`); `stale_feed` bounds how long ago **the market last spoke** (`observed_at`). A signal decided four seconds ago against a mark last observed at yesterday's close passes `staleness` cleanly — that trade is what `stale_feed` stops. Neither gate implies the other.
   - **Ordered before `drift`, on the same fetched `mark`.** A stale mark does not weaken the drift comparison, it breaks it both ways: a price frozen at the bracket's entry passes a gate meant to measure live movement, and one frozen far from it fires `drift` naming the wrong cause. This ordering means a recorded `drift` always refers to real movement.
   - **A future `observed_at` fails too**, rather than reading as maximally fresh. It means this process's clock and the venue's disagree, and every other time comparison in the pass — signal age, the flatten window, the bar coordinate — is computed against the clock just caught being wrong.
   - **Per asset class** because the classes genuinely differ: crypto prints continuously and minutes of silence are anomalous, while ADR-0016's LSE leveraged ETPs are thin enough to go minutes between prints inside a normal session. A single bound would either fire constantly on equities or never fire on crypto. Both values are UNSOURCED at time of writing — no measurement bounds inter-print gaps on the live universe, and the soak is what produces that distribution.
- **`drift`** (gate 2) — |current price − entry| > `entry * drift_tolerance_pct[asset_class]` → no-go. **Fractional, not an absolute price distance** ([#381](https://github.com/dd-jp/samurai-trading-system/issues/381)): an absolute bound cannot be set correctly for more than one instrument at once, and its failure is asymmetric — a value sized for a six-figure BTC-USD is a multiple of a $200 equity, so the gate can never fire and an arbitrarily stale bracket executes. Per-asset-class *absolute* values were rejected for the same reason one level down: SPY and a $20 name cannot share a dollar bound either. A non-positive `entry` fails closed (`drift`) rather than computing a zero or inverted tolerance.
   - **AMENDED 2026-08-19 by [#826](https://github.com/dd-jp/samurai-trading-system/issues/826): `stale_feed` and `drift` are SKIPPED, together, for an intent carrying `metadata.unpriced_exit === true`.** That flag is set by one producer only — the Trader, on the ADR-0014 mandatory flat-by-close exit (`exit_reason: 'flatten'`), and only when the instrument's own mark could not be read at all (`readExitPrice`, `trader/decide.ts`). Such an intent carries `entry`/`stop`/`target` of zero by construction, so `drift`'s non-positive-`entry` fail-closed above would `no_go` it — undoing the Trader's degradation one stage later and leaving a leveraged ETP ([ADR-0016](../adr/0016-universe-leveraged-etps-ungated.md)) open through the close, the same shape of defect [#841](https://github.com/dd-jp/samurai-trading-system/issues/841) closed one stage earlier at Risk. Both gates measure the same thing — whether the recorded bracket price still holds — and a market flatten submits no price to compare against (`submitFlatten` reads none), so on this one intent they are not weakened, they are inapplicable. Verdict does **not** re-read the mark on that branch: the read is what stalled, and paying its retry budget again would cost the tick that is trying to get flat. `dedup`, `market_closed`, `breaker` and the HITL gate all still run — but **`staleness` does not**, and this bullet claimed it did until #1254 corrected it. `unpriced_exit` is reachable only on `readExitPrice`'s `exit_reason: 'flatten'` branch, and `exit_reason: 'flatten'` alone is what sets `mandatory_flatten` at that same Trader site, so **every `unpriced_exit` intent is by construction also a `mandatory_flatten`** and gate 1's #894 exemption above applies to it too. The implication runs that way only — a flatten whose mark read SUCCEEDED carries `mandatory_flatten` without `unpriced_exit`, skips `staleness` alone, and is gated on price exactly as before. So an `unpriced_exit` intent skips **three** gates — `staleness`, `stale_feed` and `drift` — not the two this amendment removes. The degradation is never silent — the Trader logs at `error` and posts `ExitValuationDegradedAlertChannel` under its own `trader` seam. Every entry, and both discretionary exits (`signal_decay`, `direction_flip`), reach these gates unchanged.
- **`dedup`** (gate 3) — idempotency: existing order/fill for this key in the store → no-go.
- **`market_closed`** (gate 4) — market-open (stocks) — closed + no extended-hours → no-go.
- **`breaker`** (gate 5) — fire-time kill-switch / breaker re-check — tripped → no-go.
- **HITL gate** (gate 6) — if engaged by automation level + flags: human rejects → no-go (`human_rejected`); timeout → no-go (`timeout`); approves → go.
- Otherwise → **go**.

### Module: Human-in-the-Loop

- **Automation dial** per asset class: `manual` (all trades), `semi_auto` (flagged only), `auto` (none). **Set to `auto` for both classes since [ADR-0007](../adr/0007-fully-automatic-execution.md), in paper and live — the flag sources below are therefore inert, because `shouldEngageHitl` short-circuits on the dial before they are consulted.** **Flag sources** (each resolves to a concrete field): non-converged = `order.metadata.converged === false`; no-precedent = `order.metadata.cosine_precedent.no_precedent`; size-over = `order.size > flag_thresholds.size_over`; **near-limit = `risk_decision.modifications != null`** (the trade was trimmed to fit a cap).
- **Channels:** Telegram (inline approve/reject) + Discord, posted to a dedicated **trade channel**; email fallback; dashboard for history. Fills and no-gos also posted there. **Discord half is unbuilt ([#1154](https://github.com/dd-jp/samurai-trading-system/issues/1154)):** only `TelegramChannel` is implemented and wired at the composition root; no `DiscordClient` implementation and no `DISCORD_*` env var exist anywhere, so provisioning Discord means building the adapter and its transport, not just supplying credentials. This bullet's "Telegram + Discord" otherwise still states the spec's intent, unchanged.
- **Context shown:** instrument, side, size, entry/stop/target, conviction, `converged`, cosine precedent summary, `risk_snapshot`, and which trigger engaged the gate.
- **Timeout → no-go.** Fail-safe.
- **Ops task (not a design decision):** provision the actual Telegram + Discord trade channel.
- **Callback authn/authz (ticket #207 — decided, not open; amended per #272):** an inbound approve/reject must not be trusted on receipt alone: under the live polling transport the threat is a button pressed by the wrong person or in the wrong chat, otherwise indistinguishable from David's own response on the live-money control gate. Two of #207's originally named threats are re-scoped by that transport: a spoofed webhook hit applies only to a future webhook transport (polling has no inbound endpoint to spoof), and a stolen bot token cannot forge `callback_query.from.id` (Telegram attests the presser) — its blast radius under polling is availability (stealing the single-consumer `getUpdates` stream, spamming the channel), which fails closed to timeout, not approval forgery.
  - **Sole working access control.** Under the **Telegram polling transport** (the live transport — see `docs/specs/transport-layer-spec.md`), the **sole working access control over *who* may approve** is `callback_query.from.id` checked against a configured allowlist, `TELEGRAM_ALLOWED_USER_IDS`: only a callback whose `from.id` is in that allowlist can resolve a pending approval. (The correlation token below is also load-bearing, but it scopes *which* pending request a callback can resolve, not who may resolve it — the two are orthogonal, and only the allowlist is an identity check.) A `TELEGRAM_ALLOWED_USER_IDS` misconfiguration that is **permissive or wrong** (an over-broad list or the wrong id — the only permissive shapes that can survive the boot-time validation below, which rejects wildcards outright) is a **critical exposure**: it removes the only real gate on who can approve a live-money trade, not merely a redundant layer. An **empty or unset** allowlist is different — no `from.id` can ever match, so it fails closed (no approval ever resolves → every pending request times out → `no_go`) rather than opening access. That's not a security exposure, but it is an operational hazard the system must not discover at runtime.
  - **Boot-time validation, and what it actually gates (corrected 2026-08-17, #644).** `TELEGRAM_ALLOWED_USER_IDS` is required whenever `SAMURAI_ALERTS=telegram` (`transport-layer-spec.md`'s Shared Conventions), fails startup when unset or empty, and — covering the direction that would open the gate rather than close it — rejects any entry that doesn't parse as a **Telegram numeric user id in the accepted range 1 ≤ id ≤ 2^53 − 1** (`Number.MAX_SAFE_INTEGER`), which subsumes wildcard or sentinel entries like `*`. Both bounds are load-bearing: ids routinely exceed the 32-bit signed range, so a 32-bit parse would reject valid ids at startup; a negative value is a group/chat id, not a user id; and a value above 2^53 − 1 must be rejected rather than parsed — a JS `Number` parse of such a value rounds silently and would then never match at runtime. This was originally written as arming "the live approval gate," which ADR-0007/ADR-0013 have since made structurally unreachable (see the note at the top of this document) — so as of today the validation gates nothing live. It stays required regardless, because `TelegramBotApiClient` is the *only* in-repo `TelegramClient` and validates the allowlist unconditionally in its constructor (`allowlist.ts`), and that same client is what the heartbeat and escalation alerts (#322, CV-14) actually use — the requirement rides along with real alerting traffic, not with HITL. **This is not the same as "required only if an approval transport is ever re-armed"** (the wording an earlier pass proposed): re-arming would additionally require `assertAutomationLevelSupported` to stop refusing a non-`auto` `automation_level` and the still-unbuilt approval poll loop (#275's remaining half) — two code changes, not a config flip — so there is no live conditional state today under which this requirement could correctly be dropped. A malformed, non-numeric, out-of-range, or negative id is as much a sign of a broken config as an empty one, and letting it through to be silently unmatched at runtime (rather than caught at startup) is the same discover-it-live hazard this validation exists to prevent — for the allowlist's real job now, which is not letting a broken config lie dormant until the day HITL is wired back in.
  - **Wrong-chat threat / correlation token.** The "message from the wrong chat" threat named above is **not** handled by this allowlist — `from.id` identifies the presser, not the chat the button was pressed in — it is handled by the **correlation token**: per `transport-layer-spec.md`'s `TelegramClient` module, each approval request mints an opaque per-button token embedded only in the message actually sent to the configured trade channel, and a `callback_query` can only resolve a pending approval if its `callback_data` carries that exact token (128-bit CSPRNG-random — see `transport-layer-spec.md`'s Correlation bullet for the entropy floor and why it can't lean on per-request expiry); a button pressed in any other chat the bot occupies carries no valid token and is a no-op regardless of `from.id`.
  - **Why not `chat.id`.** `chat.id` is deliberately **not** part of the check (see `transport-layer-spec.md`'s `TelegramClient` module for the rationale): the trade channel is a group/channel, so `chat.id` is shared by every member and cannot serve as a per-user identity check, and it adds no scope guarantee the correlation token does not already provide — the token is unique per pending request, required by the resolution path itself (an unmatched or expired token is a no-op — see `transport-layer-spec.md`'s inbound-flow steps 2–3), and only ever present in the one message it was minted for.
  - **HMAC seam status.** `SignedApprovalChannel`'s **shared-secret HMAC-SHA256** check remains in the code path as a **dormant, transport-agnostic seam**: the callback carries a signature computed over the request's stable identifier (`trace_id` + `order_intent.idempotency_key`) plus the claimed outcome, under a pre-shared secret supplied by the callback receiver at verification time (config/ops-provisioned, never stored in the repo or held by the channel object itself); verification is timing-safe and never throws on malformed input; no separate nonce/expiry scheme is needed since the signed `trace_id` is a fresh per-tick correlation ID and a resolved pending entry is removed immediately. Under Telegram polling the same process both constructs and verifies the signature in a bot-polling round trip, so the check attests nothing about the remote caller and can fail only via an in-process bug — secret rotation or code drift (e.g. payload canonicalization changing in a deploy) between send and callback; see "Mid-flight secret rotation or code drift" below — it is **not defense-in-depth today**, and describing it that way would overstate it; identity work is done entirely by the `from.id` allowlist above. It becomes load-bearing only if a future **webhook-based** channel (e.g. Discord) is added, where a request genuinely arrives from outside the process and an unforgeable signature would matter.
  - **Cross-spec supersession.** The framing above supersedes the "defense-in-depth plumbing" / "transport-agnostic seam and defense-in-depth" wording that previously appeared in `transport-layer-spec.md`'s `TelegramClient` module (its inbound-flow step 3, and its amendment note) — both reconciled in the same amendment, so the two specs don't diverge on the same mechanism.
  - **HMAC secret boot-time validation.** **Fail startup if the configured HMAC secret is missing or empty**, and the verifier must reject an empty/missing secret at construction rather than quietly accepting one — the same fail-startup discipline as `TELEGRAM_ALLOWED_USER_IDS` above (see that bullet's 2026-08-17 correction on what it actually gates today), and one uniform rule rather than gating the check behind the not-yet-built webhook transport. The precise rationale: under polling the same process signs and verifies with the same configured secret, so a *static* misconfiguration — even an empty key — signs and verifies consistently and passes (HMAC with an empty key does not fail); boot validation exists because an empty secret is a broken config that becomes a real exposure the day a webhook transport goes live, not because it would fail verification today.
  - **Mid-flight secret rotation or code drift.** The runtime failures the HMAC check can actually produce under polling are in-process bugs that change one side of the round trip between send and callback: secret rotation or config reload while approvals are in flight, or code drift (e.g. a deploy changing payload canonicalization). Any of these fails verification on every in-flight callback, which never resolves and times out, indistinguishable from a genuine human non-response. Boot-time validation cannot catch these; they are covered by "Dead-gate detection" below.
  - **Resolution on any verification failure.** A callback that fails either check (allowlist or HMAC) never resolves the pending approval; it falls through to the request's own `timeout_ms` expiry (`no_go_reason: 'timeout'`), the same fail-safe as a genuine non-response. Failures are silent only with respect to resolution — observability is specified per failure mode in the next two bullets, because the two carry different severity under polling.
  - **Observability — allowlist failure (security signal, alertable).** A failed `from.id` allowlist check is a genuine security signal — an unauthorized party attempting to resolve a live-money approval. It must be logged as a structured audit entry (channel, failure reason, **offending `from.id`**, `chat.id`, a **truncated prefix of the callback's correlation token (first 8 hex chars — never the full token**, which is a live bearer capability until the request times out; persisting it would let anyone with log access resolve the approval, undercutting the 128-bit unguessability argument) plus the `trace_id` it maps to when known — populated via a **best-effort read-only lookup** of the correlation-token map at rejection-logging time (the allowlist check runs before token recovery in the inbound flow, so this lookup is logging-only: it must never resolve, consume, or expire the pending entry, and the field is simply absent when the token doesn't match) — and timestamp) and metered as a distinct, alertable event, separate from a genuine timeout. The `from.id` is required in the entry because it's the field that lets ops attribute and block a repeat prober.
  - **Observability — HMAC failure (debug log, not an attack alert).** A failed HMAC check under Telegram polling cannot indicate a forgery (see "HMAC seam status" above) — log it for debugging, but do not alert at the same "possible attack" severity as an allowlist failure, or the alert trains itself to fire on bugs rather than forgeries and gets ignored. This reverses once a webhook transport exists: an HMAC failure there becomes the real security signal.
  - **Dead-gate detection.** Demoting HMAC failures to debug-no-alert, combined with a timeout being indistinguishable from a genuine human non-response, would make a post-boot secret break (rotation, config reload, or any other bug that starts failing every HMAC check) operationally invisible: every approval quietly times out and nothing pages anyone. To close that gap, alert on the **aggregate approval-timeout rate** — a sustained spike in `no_go_reason: 'timeout'` across pending approvals (as distinct from a single expected human non-response) — so a dead gate is caught by an ops signal even though no individual failure is itself alertable at that severity. As with the repeated-rejection alert in `transport-layer-spec.md`, the exact rate threshold is an implementation detail, not decided here.
  - See `server/pipeline/verdict/notifications/approval-callback-verifier.ts` (verify/sign) and `server/pipeline/verdict/notifications/verified-approval-channel.ts` (`SignedApprovalChannel`, the concrete `ApprovalChannel` enforcing this).

### Module: Determinism & Backtest

- Same code path live vs replay; all reads point-in-time via the injected clock.
- In `backtest` mode, gate 6's outcome is overridden to `go` once the injected `ApprovalChannel` answers — not before; a channel that throws instead of answering still refuses — and `would_require_approval` is recorded regardless, so a backtest measures gate-engagement frequency without a human.

## Testing Decisions

### What Makes a Good Test

- Test at `Verdict.decide(input)`: given an approved `RiskDecision` + mocked market data / store / breakers / config + mock clock, assert on the `VerdictDecision`.
- Cover each gate's no-go path and the full-pass go path.
- Cover HITL: approve → go, reject → no-go, timeout → no-go, and automation-level routing (manual/semi_auto/auto; flagged vs unflagged in semi_auto).
- Cover backtest's outcome override (gate 6 -> `go` once `approvals` answers) with `would_require_approval` recorded.
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

> **SUPERSEDED 2026-08-06 by [ADR-0007](../adr/0007-fully-automatic-execution.md).** The staging below is no longer what the system does. `automation_level` is `auto` for both asset classes in **paper and live**, so the HITL gate (6) is unreachable and no trade is ever routed to a human.
>
> The reason is structural, not a change of appetite: `Verdict.decide` *awaits* `approvals.requestApproval` **inside** the instrument pass, and `runTickPlan` ran instruments at `max_concurrent_instruments: 1` at the time this was decided. One trade awaiting a human tap therefore blocked the entire universe for up to `human_timeout`. **[#1013](https://github.com/dd-jp/samurai-trading-system/issues/1013) (2026-09-02) raised the width to `6`** in paper and live, so the same `await` no longer blocks the entire universe — only the one instrument's worker. That does not reopen this section's conclusion: `automation_level: auto` makes the HITL gate (6) unreachable regardless of width (ADR-0007's 2026-09-02 amendment), so there is no live await to serialize on at any concurrency setting. A human in this loop is a serialization point, not a safety net — read as the reason `auto` was chosen, not as a live constraint the choice still depends on.
>
> The dial, the flag plumbing, `human_timeout` and the whole Telegram approval chain are **retained and inert**.
>
> **Turning it back is no longer a config edit — the code refuses.** An earlier revision of this paragraph said it was, and that was wrong: a comment guards nothing, and the dial is a config value flipped by someone who has not read the comment. `assertAutomationLevelSupported` (`server/pipeline/verdict/index.ts`) now **throws at production boot** whenever either asset class is `manual` or `semi_auto`, naming the reason and the blocking ticket. Both engaging levels are covered, not just `semi_auto` — `manual` reaches the same `await` through the same two already-evaluated gates. Unlike an in-branch re-check this is not a guard on an unreachable path (#430): it runs on every boot.
>
> The reason it refuses: the three freshness gates (staleness, feed staleness, drift) run *before* the HITL gate and are never re-evaluated after it, so an approval returning after `human_timeout` (15 min) submits at a price last checked longer ago than `max_signal_age.crypto` (5 min) permits — a gate that reads as a freshness guarantee is not one. ADR-0007 records async approval (Verdict returns `pending`; a poller resumes it) as the only version worth building, which also removes the human from the instrument pass — the actual reason the gate was dropped. **Land [#434](https://github.com/dd-jp/samurai-trading-system/issues/434) before re-enabling anything here.**
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
