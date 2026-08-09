# ADR-0013 — No human gate anywhere: breaker re-arm and risk-threshold loosening go automatic

- **Status:** Accepted
- **Date:** 2026-08-09
- **Decided by:** David
- **Amends:** [ADR-0007](0007-fully-automatic-execution.md) — extends "no human approval gate" from the trade path to every remaining human gate in the system
- **Related:** [#634](https://github.com/dd-jp/samurai-trading-system/issues/634) (the breaker threshold that trips inside the strategy's pre-accepted drawdown), [`docs/research/10-edge-hypothesis.md`](../research/10-edge-hypothesis.md), [`docs/reviews/spec-research-alignment-2026-08-09.md`](../reviews/spec-research-alignment-2026-08-09.md) F5

## Context

ADR-0007 removed the human from the **trade approval** path and its reasoning was deliberately structural, not a preference:

> A human in this loop is a **serialization point**, not a safety net. That is a property of where the await sits, not of how attentive the operator is.

That argument is about a blocking `await` inside the instrument pass. **It does not transfer to the two human gates that survived it**, because neither blocks anything:

| Gate | Blocking? | What removing it does |
| --- | --- | --- |
| Trade approval (`verdict-spec.md`) | Yes — up to `human_timeout` × every instrument on a shared clock | Already removed by ADR-0007 |
| Hard breaker **manual re-arm** (`risk-manager-spec.md:51`, `:173`, `:230`) | No — the system simply stays halted | The system resumes trading itself after a max-drawdown halt |
| Risk-threshold **auto-loosen approval** (`feedback-loop-spec.md:39`, `:155`) | No — an async queue, `loosen_pending_approval[]` | The Feedback Loop can widen its own risk limits unsupervised |

So each needs its own justification. ADR-0007's cannot be reused, and this ADR does not pretend otherwise.

### Why the breaker's manual re-arm goes

This one has a direct argument from the edge hypothesis, not merely from convenience. `docs/research/10-edge-hypothesis.md` states the *purpose* of the machinery:

> the machinery that makes holding through a −23% drawdown **automatic rather than a decision won against oneself at the worst moment**

A hard breaker that halts at ~20–25% and then waits for a human re-arm reintroduces exactly that decision, at exactly that moment. Worse, the threshold sits **inside** the −23% drawdown the strategy pre-accepts (#634), so it is expected to fire on a normal path, not an exceptional one — and every firing would need a human to clear it.

The narrow cost is real and worth stating: breakers **halt new entries, never exits** (`risk-manager-spec.md:15`), so nothing liquidates at the bottom. What a halt suppresses is the *re-entry* leg — a premium harvest that de-levers into a drawdown depends on levering back in as volatility falls. A manual re-arm turns that recovery into a human action taken at the point of maximum discomfort.

### Why the loosen-approval goes, and what does *not* go with it

The gate is asynchronous, so no serialization argument applies. It goes because under ADR-0007 there is no operator in any decision path, and a queue that nobody drains is not a control — it is a permanently-stuck dial that reads as governed. `loosen_pending_approval[]` under full automation is the repo's dominant defect shape: a mechanism that looks enforced and enforces nothing.

**The hard bounds survive, and this is load-bearing.** `feedback-loop-spec.md:38` specifies tuning "within human-set hard floors/ceilings" and `:190` says "hard bounds never crossed." Those are not approvals — they are static limits set once, out of band, and enforced in code. What this ADR removes is the **per-change gate on loosening within those bounds**. What it keeps is the bounds themselves.

> **Stated assumption.** "No approvals" is read as removing every *gate that waits on a person*, not as removing the static limits a person configured in advance. Without that reading there is no floor of any kind under a live-money risk dial, and the system becomes unspecified rather than automatic. If the bounds were also meant to go, that is a one-sentence widening of this ADR — but it must be explicit, because it is a materially larger decision than the one recorded here.

## Decision

**No gate anywhere in the system waits on a human — in paper or live.**

1. **The hard drawdown breaker and the kill-switch auto-re-arm in every mode.** The re-arm policy that `risk-manager-spec.md:173` currently makes mode-dependent (`manual` in live, configurable in backtest) becomes one policy in all three modes. The re-arm condition is mechanical and must be specified with the threshold work in #634 — this ADR settles *that* it is automatic, not *what* the condition is.
2. **The Feedback Loop applies risk-threshold loosening without approval, clamped to the hard bounds.** `loosen_pending_approval[]` is removed as a gate. Every dial change — tighten or loosen — is applied, logged and reversible, and **rejected in code if it would cross a hard bound**. The asymmetry that survives is not approval-vs-no-approval; it is that loosening is bounded where tightening is free.
3. **The kill/rework call is no longer "human."** `feedback-loop-spec.md:15`/`:174` and `cross-spec-contracts.md:53` say the human owns kill. Under full automation nobody does. A kill-threshold breach must produce a **mechanical response** — defensive auto-tighten, and a halt if the breach persists — not an alert that waits for a decision.

### What must NOT be removed: alerting

`feedback-loop-spec.md:91` is one field doing two jobs:

```ts
approvals: ApprovalChannel;   // for gated risk-threshold loosening + breach alerts
```

`ApprovalChannel` is a single type (`server/pipeline/verdict/types.ts:44`, `requestApproval`). Removing the field to kill the loosen gate would kill **breach alerting with it** — and under full automation that alert is the only way an operator ever learns the edge died. Splitting the two concerns is mandatory: the *approval* half goes, the *notification* half stays and becomes more important, not less.

This is the same class of defect ADR-0007 guarded against when it replaced the auto-approving default with a throwing one: a control that reads as present while doing nothing.

## Consequences

### The thresholds are now the only thing left, and they are still config

ADR-0007 said "the breakers are now the only stop." This ADR goes further: **the numeric thresholds are now the only stop**, because nothing re-arms by hand and nothing gates a loosening.

That makes an old MEDIUM finding load-bearing. The 2026-07-28 cross-verify pass, GAP-6:

> circuit-breaker / anti-overfitting kill-line thresholds are specced as tunable config in two places, not fixed constants, contradicting the binding research constraint that these must be fixed

`cost-model-backtest-spec.md` still lists "the PBO threshold value" as config, and `risk-manager-spec.md` says "all caps and breaker thresholds are config, tuned in paper trading; not fixed here." With the loosen-gate gone, **a config edit is now the entire distance between the running system and an arbitrary risk limit.** The clamp GAP-6 asks for — config values hard-limited in code so no setting can cross the research-mandated line — is a precondition of this ADR being safe, not a tidiness item. It is filed as a blocker on the live path.

### Live-go preconditions inherited from ADR-0007 still stand

ADR-0007 named three kill-lines that cannot fire (#384, #375, #333) and two absent capabilities (`submitFlatten`/`cancel`/`getOpenPositions`; per-decision operator visibility, #307). **None of them are relaxed by this ADR and all of them get sharper**, because the human path they were implicitly backstopped by is now gone in full rather than in part.

### Loose end closed

ADR-0007 left `TELEGRAM_ALLOWED_USER_IDS` validated at boot for a gate that could no longer fire. With approvals gone system-wide, the allowlist has no approval to authorise. The transport itself stays — it is the alerting path. The requirement should be relaxed from "required at boot" to "required only if an approval transport is ever re-armed."

Correspondingly, the 2026-07-26 pass's MEDIUM security finding on `ApprovalChannel` authn/authz is **moot for approvals** and **live for alerting**: nothing authorises a decision any more, but the channel still carries operator-facing information.

## Alternatives considered

- **Keep manual re-arm as a "real" stop while removing everything else.** Rejected: it is the one gate that fires precisely when the strategy says to hold, and #634 shows it is expected to fire on a normal path. A stop that must be cleared by hand on an expected path is an availability failure, not a safety feature.
- **Keep the loosen queue and drain it on a schedule.** Rejected: a scheduled auto-drain *is* automatic approval, with an extra step that makes it look supervised. If the answer is always "apply", the bound is the control and the queue is theatre.
- **Remove the hard bounds too.** Not decided here — see the stated assumption above. It would leave no floor under a live-money dial, and needs its own explicit call.
