# ADR-0007 — Fully automatic execution: no human approval gate, paper or live

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decided by:** David
- **Supersedes:** verdict-spec.md "Notes & Rationale" — the `manual` → `semi_auto` → `auto` staging
- **Related:** [#275](https://github.com/dd-jp/samurai-trading-system/issues/275) (built the Telegram approval transport), [#384](https://github.com/dd-jp/samurai-trading-system/issues/384), [#375](https://github.com/dd-jp/samurai-trading-system/issues/375), [#333](https://github.com/dd-jp/samurai-trading-system/issues/333) (the breakers that must work now that this gate does not exist)

> **Amended by [ADR-0013](0013-no-human-gate-anywhere.md) (2026-08-09).** This ADR removed the human from the **trade approval** path only. ADR-0013 extends the same posture to the two human gates that survived it — the hard breaker's **manual re-arm** and the Feedback Loop's **risk-threshold loosening approval** — so no gate anywhere waits on a person. It does so on separate reasoning: the serialization argument below applies to a blocking `await` in the instrument pass and does not carry to either of those, since neither blocks anything. ADR-0013 also keeps the Feedback Loop's static hard bounds, which are limits rather than approvals, and requires that breach **alerting** survive the removal of the approval channel it currently shares a field with.
>
> **Amended 2026-09-02 — [#1013](https://github.com/dd-jp/samurai-trading-system/issues/1013) raised `max_concurrent_instruments` from 1 to 6.** See the amendment at the bottom of this document: the premise the serialization argument below was measured against has changed, but the decision (no human gate) still holds — for a different, sufficient reason (`automation_level: auto` already makes the gate unreachable regardless of width), not because the original width-1 argument was wrong when made.

## Context

verdict-spec.md's Human-in-the-Loop module specifies a per-asset-class
`automation_level` dial — `manual` / `semi_auto` / `auto` — as the staged
deployment control, with the spec's own rationale: *"start `manual` (human
confirms every real-money trade during paper / tiny-live), move to `semi_auto`
…, then `auto` once live KPIs hold and trust is earned."* The profile shipped
at `manual`.

That gate has never actually run. The composition root fell back to
`ConsoleApprovalChannel`, which auto-approves and logs a `warn` saying no human
reviewed the trade, so `manual` bought an exercised code path and an audit
trail of machine consent — not consent. Wiring the real transport was #275's
remaining half; the parts (`SignedApprovalChannel`, `TelegramApprovalGateway`,
`approval-callback-verifier`, `allowlist`, `correlation-tokens`) are all built
and unit-tested, and nothing constructs the chain.

The question was therefore live: finish wiring it, or decide against it.

### What made the decision, and it is structural rather than a preference

> **`max_concurrent_instruments` is no longer 1 — see the 2026-09-02 amendment
> at the bottom of this document.** The width figure below is what the
> decision was measured against at the time; it is not what the system runs
> today, and the amendment explains why the decision does not depend on it.

`VerdictImpl.decide` **awaits** `approvals.requestApproval` inside the
instrument pass (gate 6, `server/pipeline/verdict/index.ts`). `runTickPlan` runs
instruments at `max_concurrent_instruments`, which is **1**
(`server/apps/orchestrator/tick-loop.ts`; `production.ts` documents why raising it is
not free). `human_timeout` was 15 minutes.

Composing those three: **one trade awaiting a human tap blocks every other
instrument in the universe for up to 15 minutes.** With six instruments on a
single shared clock, one un-answered notification costs the whole universe a
full cycle — and at the soak's 15-minute cadence (ADR-0008) that is one cycle
per un-answered tap, on every instrument, not just the one in question.

A human in this loop is a **serialization point**, not a safety net. That is a
property of where the await sits, not of how attentive the operator is.

A second, smaller finding pointed the same way. Gates 1 (staleness) and 2
(drift) evaluate *before* gate 6 and are never re-evaluated after it, so an
approved trade could submit at a price checked up to `human_timeout` earlier —
`max_signal_age.crypto` is 5 minutes, and a 15-minute-old approval sails past
it because the gate that bounds staleness already ran. Making `semi_auto` sound
would have meant re-checking both gates post-approval, i.e. more machinery on
the path being removed.

## Decision

**`automation_level: { crypto: 'auto', stocks: 'auto' }`, in paper AND live.**
No trade is ever routed to a human.

Consequences at the code level:

- `shouldEngageHitl` short-circuits to `false` on the dial before `isFlagged`
  is consulted, so gate 6 is unreachable and `ProductionConfig.approvals` is
  never called.
- `flag_thresholds` and `human_timeout` are inert by construction. They are
  **kept**, along with the flag plumbing and the whole Telegram chain, so that
  turning the dial back is a config edit rather than a re-implementation.
- The composition root's default approval channel is now
  `UnwiredApprovalChannel`, which **throws** if gate 6 is ever reached, in
  place of `ConsoleApprovalChannel`, which auto-approved. If someone sets
  `manual` or `semi_auto` without wiring a transport, that must fail loudly
  rather than fabricate consent — an auto-approving default is a gate that
  reads as enforced while enforcing nothing, this repo's dominant defect shape.
- Unlike `ConsoleApprovalChannel`, the new default **constructs in `live`**.
  Refusing there would block a live start over a gate that never fires.

## Consequences

### The breakers are now the only stop, and three of them do not work

This is the whole cost of the decision, and it is not hypothetical:

| Gap | Effect |
| --- | --- |
| [#384](https://github.com/dd-jp/samurai-trading-system/issues/384) | Three of four kill-lines can never fire — nothing produces `DailyMetricsSample.revalidation`. |
| [#375](https://github.com/dd-jp/samurai-trading-system/issues/375) | The fourth (divergence) has no persisted backtest Sharpe, so it is inert. |
| [#333](https://github.com/dd-jp/samurai-trading-system/issues/333) | In `live`, a daily PnL figure that cannot be computed — any restart after the session boundary — leaves the daily-loss breaker unenforced for the rest of the session. |

**These three are the live-go gate for a fully automatic system.** None of them
blocks the paper soak, where the daily figure is seeded from a mid-session base
and the breaker stays live throughout. `paperStartingProfile` refuses `live`
outright and now names these three in its refusal message.

Two capabilities that were "live-only niceties" while a human held the gate are
sharper now, because there is no longer any manual intervention path at all:

- `BrokerAdapter.submitFlatten` / `cancel` / `getOpenPositions` are specced in
  execution-spec.md and absent from the code — no cancellation, no forced
  liquidation, no kill switch.
- Per-decision operator visibility. `NotifyingVerdict` exists with zero
  callers ([#307](https://github.com/dd-jp/samurai-trading-system/issues/307));
  it is now the *only* way an operator sees what the bot decided, rather than a
  cosmetic duplicate of the log. Its ticket is scoped as a refactor and needs
  re-framing as a control.

### What is enforced, and where

`yarn smoke` injects no `approvals`, so it takes the throwing default. A
passing smoke run is therefore positive evidence that the `auto` dial
short-circuits before any approval is requested — on the real composition root
rather than in a unit test. Verified 2026-08-06: `verdict: go` with
`approval_path: "automated"`, `would_require_approval: false`.

### Loose end

`TELEGRAM_ALLOWED_USER_IDS` is still validated as a required environment
variable at boot when `SAMURAI_ALERTS=telegram`, for a gate that can no longer
fire. Either relax it or document why it stays.

## Alternatives considered

- **Wire Telegram and run `semi_auto`.** Rejected on the serialization
  argument above. It would also have required a post-approval re-check of
  gates 1 and 2 to be sound.
- **Wire Telegram, keep `manual`.** Same problem, worse: every trade blocks the
  universe, not just flagged ones.
- **Async approval** — Verdict returns `pending`, the intent persists, and a
  separate poller resumes it, so no human ever blocks the loop. This is the
  design that would make human-in-the-loop compatible with a serial tick
  runner. Not pursued because the decision was to remove the human, not to
  re-plumb around them; recorded here because it is the only version of
  `semi_auto` worth building if the dial is ever turned back.

## Amendment — 2026-09-02: `max_concurrent_instruments` is now 6, not 1 — the conclusion still holds

- **Prompted by:** [#1013](https://github.com/dd-jp/samurai-trading-system/issues/1013) / PR [#1018](https://github.com/dd-jp/samurai-trading-system/issues/1018), which set `maxConcurrentInstruments` to an explicit `6` in paper and live (`server/apps/orchestrator/paper-profile.ts`), replacing the implicit `?? 1` fallback this ADR's serialization argument was measured against.
- **Answers:** whether the load-bearing premise above — "`runTickPlan` runs instruments at `max_concurrent_instruments`, which is **1**" — changing to 6 reopens the question this ADR decided.

**The premise changed. The conclusion does not depend on it, and did not need to.**

At width 1, a single trade awaiting a human tap blocked EVERY other instrument in the universe for up to `human_timeout` — the whole run serialized behind one un-answered notification. At width 6, `VerdictImpl.decide`'s `await approvals.requestApproval` still blocks only the ONE worker holding that instrument's pass; the other five instruments' workers are unaffected. At width ≥ universe size — today's `DEFAULT_UNIVERSE` is 4, below the width of 6 — every instrument already gets its own worker in the same pass, so a pending approval blocks no *other* instrument at all; the specific "blocks every other instrument" arithmetic this ADR argued from would only bind again if the universe grew past the width (see the `maxConcurrentInstruments` field comment in `paper-profile.ts` and the #895/#1019 tripwire it points to).

**That does not reopen the question, because the decision was never conditional on the width being exactly 1.** `automation_level: { crypto: 'auto', stocks: 'auto' }` (`paper-profile.ts`) makes `shouldEngageHitl` short-circuit to `false` before `isFlagged` is ever consulted — gate 6 is unreachable, `approvals.requestApproval` is never called, at ANY concurrency width. The serialization argument above explains *why* `auto` was chosen over `manual`/`semi_auto` in the first place; it is not a runtime condition the `auto` decision continues to depend on once made. A future width change (up or down) cannot, by itself, make gate 6 reachable again — only a config edit to `automation_level` can, and `assertAutomationLevelSupported` (`server/pipeline/verdict/index.ts`) throws at production boot if that edit is made without also landing async approval (#434), per verdict-spec.md's "Staged-Deployment Alignment" section.

The second, smaller finding this ADR made — that gates 1 and 2 run before gate 6 and are never re-checked after it, so an approval could submit against a stale snapshot — is also unaffected by width: it was about the ORDER of gates within one instrument's pass, not about how many instruments run concurrently.

**Unchanged by this amendment:** the decision (`automation_level: auto`, no human gate anywhere), the breaker-only stop posture, and everything under "Consequences" above. The only correction is to the width figure the serialization argument cites, which is now historical context for why `auto` was chosen rather than a live constraint the choice still rests on.
