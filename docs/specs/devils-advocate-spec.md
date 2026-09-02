# Devil's Advocate — Thesis Invalidation Stage Specification

**Status:** Draft (resolved wayfinder decisions synthesized)
**Owner:** David (Deepak)
**Date:** 2026-08-05
**Wayfinder map:** [Wayfinder: Devil's Advocate — thesis invalidation layer placement](https://github.com/dd-jp/samurai-trading-system/issues/291) (closed 2026-08-05, all nine decision tickets resolved)

## Problem Statement

The pipeline is good at building a case and bad at noticing when the case has already collapsed. Analysts emit directional reads, the Debate Engine synthesizes them into a thesis, and the Trader sizes an intent against that thesis's conviction. Nothing between those stages asks the one question that separates a considered position from a confident one: **what would have to be true for this to be wrong, and is any of it already true?**

The Bear persona is the closest thing the system has, and the [prototype](../prototypes/devils-advocate-btc-thesis-2026-08-04.md) showed its insights are near-identical to a Devil's Advocate's. But the Bear emits `{stance, rationale}` — prose. Prose cannot be checked against a price feed, cannot be evaluated at entry, cannot be stored as a falsifiable claim, and cannot be counted later. A pessimistic paragraph and a list of checkable conditions contain the same insight and have entirely different consequences.

The concrete failure this stage exists to prevent: an intent is formed against a thesis whose stated premise **has already failed by the time the order would be placed**. The debate ran on bars up to T; the Trader sized against a synthesis that said "price above SMA(14) with RSI confirming"; and at the moment of decision, price is below SMA(14). Nothing in the current pipeline notices. Risk's mechanical checks are about exposure and drawdown, not about whether the reason for the trade still holds.

## Solution

A **seventh stage of the decision chain, named `invalidation`**, sitting between `trader` and `risk`, that runs only when the Trader has produced an actionable `entry` or `scale_in` intent. Per `orchestrator-spec.md`'s 2026-08-16 tick/decision split, this is a **decision-path stage**: it runs at most once per debate bar, not on every `τ`-interval tick — the two cadences are decoupled, and the decision cadence is strictly the less frequent of the two. It reads the debate's thesis and the intent, and emits an **invalidation checklist**: 3-5 typed, machine-checkable conditions under which the thesis is falsified, each bound to a service that already exists.

The stage then **evaluates its own conditions against live data at emit time** and hands the result to the Risk Manager. Any condition **already breached** as the intent is formed means the thesis was falsified before the trade was placed, and Risk hard-rejects. Unbreached conditions are advisory: persisted, surfaced, and given no effect on the outcome.

The load-bearing property: **the LLM names what to check; deterministic code does the checking.** A model cannot hallucinate a breach — it can only propose a condition, and a validator rejects malformed ones before Risk ever sees the list. The teeth rest on measured data, not on model opinion.

Key architectural decisions, each traceable to a resolved decision ticket:

- **A standalone stage, not an analyst role and not a merged Bear persona** — its output is a typed union, and an analyst must return `AnalystView` ([#338](https://github.com/dd-jp/samurai-trading-system/issues/338), [#336](https://github.com/dd-jp/samurai-trading-system/issues/336)).
- **Conditional on an actionable intent** — reuses the Trader's existing actionability gate rather than duplicating `conviction_floor` ([#337](https://github.com/dd-jp/samurai-trading-system/issues/337)).
- **Structure is the value** — a distinct contract precisely because the *insight* duplicates the Bear ([#334](https://github.com/dd-jp/samurai-trading-system/issues/334)).
- **Predicates only, no model-assigned weights or severity** ([#336](https://github.com/dd-jp/samurai-trading-system/issues/336)).
- **Risk enforces via a hard-reject on already-breached-at-entry, through the ADR-0003 seam** — the LLM call happens outside `evaluate()`, which stays pure and deterministic given its inputs ([#339](https://github.com/dd-jp/samurai-trading-system/issues/339)).
- **A deterministic validator, not a model-tier purchase** ([#340](https://github.com/dd-jp/samurai-trading-system/issues/340)).
- **Replay splits by nondeterminism source** — the emission replays from log, the evaluation re-runs ([#365](https://github.com/dd-jp/samurai-trading-system/issues/365)).
- **Fail-open on pass failure**, matching `RiskCriticVerdict` ([#339](https://github.com/dd-jp/samurai-trading-system/issues/339)).
- **Outside Feedback Loop attribution entirely** — a Risk reject produces no `ClosedTrade`, so the stage's actions are invisible to attribution by construction ([#359](https://github.com/dd-jp/samurai-trading-system/issues/359)).

## User Stories

### Trigger & Placement

1. As the Orchestrator, I want the `invalidation` stage to run between `trader` and `risk`, so that it sees a formed intent and its output reaches Risk in the same pass.
2. As the Orchestrator, I want the stage to run **only** when the Trader returned an `entry` or `scale_in` intent, so that no LLM spend is incurred on holds, no-trades, or exits.
3. As the Orchestrator, I want the stage skipped entirely on an `exit` intent, so that the system never blocks its own way out of a position.
4. As the Orchestrator, I want `CurrentTick.stage` to report `'invalidation'` while the stage runs, so that a stalled pass is diagnosable at the right stage.
5. As the system, I want the stage to be unable to terminate the decision pass itself, so that every trade-killing decision passes through Risk's ordered, composable check pipeline.

### Thesis Input

6. As the invalidation stage, I want to read the debate's `synthesis`, `position`, `disagreement_summary` and `open_items`, so that I attack the thesis the system actually formed rather than one I inferred from telemetry.
7. As the invalidation stage, I want to read the `OrderIntent` (side, entry, stop, target, size), so that my conditions are coherent with the position actually proposed.
8. As the invalidation stage, I want to restate the thesis in my own words as `thesis_restated`, so that a human reviewing a reject can see whether I understood what I was attacking.
9. As the invalidation stage, I want to record `thesis_source` as either a `debate_id` or null, so that the record says which input situation actually occurred without the contract assuming a placement.

### Emitted Conditions

10. As the invalidation stage, I want to emit 3-5 conditions, so that the checklist is specific enough to be useful and short enough to be read.
11. As the invalidation stage, I want each condition typed as a discriminated union over services that exist today, so that the service-binding rule is enforced by the type system rather than by a prompt instruction the model may ignore.
12. As the invalidation stage, I want to reuse `IndicatorSpec` verbatim for indicator-backed conditions, so that there is one way to name an indicator in this codebase.
13. As the invalidation stage, I want each condition to carry a comparator and a numeric threshold, so that evaluation is a mechanical comparison and not an interpretation.
14. As the invalidation stage, I want each condition to carry free-text `rationale` explaining why it falsifies the thesis, so that a human can audit the reasoning without the machine depending on it.
15. As the invalidation stage, I want to emit **no** severity, weight, or confidence per condition, so that nothing model-assigned can flow into sizing or enforcement.
16. As the invalidation stage, I want to emit no `thesis_holds` boolean, so that the derived answer is computed at the point of use rather than asserted by the model.
17. As the system, I want an emission of zero conditions to be recorded and flagged `warn`, so that a pass that could falsify nothing is treated as suspicious rather than as a clean bill of health.
18. As the system, I want malformed model output rejected rather than coerced, so that partial JSON never becomes a half-understood checklist.

### Validation

19. As the system, I want a deterministic validator between emission and Risk, so that a malformed condition cannot reach the enforcement path.
20. As the validator, I want to drop a condition naming an indicator that does not exist, so that an unknown observable cannot evaluate to anything.
21. As the validator, I want to drop a condition whose threshold falls outside the indicator's valid range, so that an impossible threshold cannot evaluate as permanently breached.
22. As the validator, I want to drop a condition whose direction is incoherent with the intent, so that a condition that would fire on the thesis *working* cannot block the trade.
23. As the system, I want a dropped condition recorded with its drop reason rather than silently discarded, so that a systematically malformed prompt is visible instead of hiding for a month.
24. As the system, I want the validator emptying the condition list to be reported exactly as a zero-condition emission, so that there is one code path for "nothing checkable came out of this pass".

### Evaluation & Enforcement

25. As the invalidation stage, I want to evaluate each surviving condition against live data at emit time, so that "already breached" is a measured fact rather than a model claim.
26. As the invalidation stage, I want evaluation to be tri-state — `breached`, `not_breached`, `unevaluable` — so that missing data is distinguishable from a passing check.
27. As the invalidation stage, I want `unevaluable` derived mechanically from stale market context or insufficient bars, so that the tri-state is never a judgement call.
28. As the Risk Manager, I want to receive the evaluated result as pre-built data on `RiskInput`, so that `evaluate()` remains pure and deterministic given its inputs.
29. As the Risk Manager, I want to hard-reject an intent when the breached list is non-empty, so that a thesis falsified before entry never becomes a position.
30. As the Risk Manager, I want the reject to set a `binding_constraint` naming the condition kind, so that the cause is machine-readable and not confusable with a size or exposure reject.
31. As the Risk Manager, I want an `unevaluable` condition to have no enforcement effect, so that a data gap never blocks a trade.
32. As the Risk Manager, I want the invalidation step to sit inside the existing ordered check pipeline, so that an intent a mechanical cap would have trimmed to dust dies for the right reason rather than being mislabelled.

### Failure Posture

33. As the system, I want the stage to fail **open** with an explicit `unavailable` marker when the LLM call fails, so that a vendor outage does not halt all new entries.
34. As the system, I want `unavailable` to be a distinct outcome from a zero-condition emission, so that "the pass could not run" is never confused with "the pass found nothing".
35. As the system, I want the mechanical Risk checks and the red-team critic to remain the safety net during a fail-open, so that fail-open is a degradation rather than an absence of protection.
36. As the system, I want enforcement to behave identically in `paper` and `live`, so that paper trading measures the system that will run with money.

### Prompt Safety

37. As the system, I want every ingested-text-derived input wrapped via `wrapUntrusted` before it reaches the prompt, so that this pass inherits the protection personas already have.
38. As the system, I want an injected instruction to be structurally incapable of producing a false *breach*, so that the worst an injection can do is degrade rather than fabricate.
39. As the system, I want emission suppression to surface as a loud zero-condition record rather than a silent fail-open, so that an attack that disables the gate is visible in the record.
40. As the operator, I want an unexpected rise in reject rate to be observable, so that a condition-poisoning attack shows up as a rate anomaly.

### Persistence & Replay

41. As the system, I want the raw emitted conditions persisted with a per-condition validator outcome, so that what the model said is recoverable independently of what survived.
42. As the system, I want `invalidation_log` content-addressed on `(instrument, bar_timestamp)`, so that a replay can find the row without knowing an id that a replay mints fresh.
43. As the system, I want `bar_timestamp` floored to the instrument's bar boundary, so that live rows and replay lookups land on the same coordinate.
44. As a backtest, I want the emission replayed from the log and the evaluation re-run through the clock-gated seams, so that only the genuinely nondeterministic half is replayed.
45. As a backtest, I want a validator fix to apply on replay rather than being baked into old rows, so that a replayed window measures the current system.
46. As a backtest, I want a log miss to produce `unavailable` rather than a live LLM call, so that determinism is never traded for coverage.
47. As a backtest consumer, I want `BacktestReport` to carry an `invalidation_replay` attestation, so that cold-window and warm-window reports are never pooled as if comparable.

### Operator Surface

48. As the operator, I want a plain alert when a trade is hard-rejected as thesis-invalidated, so that a rare and consequential event reaches me.
49. As the operator, I want **no** alert on unbreached advisory conditions, so that the channel is not trained into noise by firing on every actionable tick.
50. As the operator, I want the alert gated by the existing `AlertsMode` config, so that alerting is configured in one place.
51. As the operator, I want to see the restated thesis and its conditions with evaluation states on the dashboard, so that I can judge whether the pass understood the trade.
52. As the operator, I want validator-dropped conditions listed with their drop reasons, so that prompt quality is inspectable.

### Cost & Model

53. As the system, I want the pass to run on a per-component model configuration, so that the tier can be re-tuned from data without touching the global ops knob.
54. As the system, I want the pass's LLM client to be **metered**, so that its spend appears on the dashboard rather than reading zero.
55. As the system, I want `max_tokens` set high enough that thinking plus structured output cannot truncate, so that the fail-open path is not entered on every triggered tick.

### Feedback Loop Boundary

56. As the Feedback Loop, I want the invalidation stage excluded from attribution, so that no dial is moved by a component whose actions produce no attributable outcome.
57. As a reader of `feedback-loop-spec.md`, I want an explicit list of deliberately unscored components, so that FL's boundary is stated rather than inferred.
58. As a future maintainer, I want the one condition that would reopen the attribution question named, so that the decision is neither re-litigated nor hardened into "never".

## Implementation Decisions

### Module: Invalidation Stage

**Responsibilities**
- Build the prompt from the debate thesis and the intent, wrapping all ingested-derived text.
- Obtain the emission from an injected source (live LLM, or replay-from-log).
- Parse strictly; reject malformed output rather than coercing it.
- Run the deterministic validator; record each condition's outcome.
- Evaluate surviving conditions tri-state against clock-gated data seams.
- Persist the raw emission plus validator outcomes; return the evaluated result.

**Key Interfaces**

```typescript
// The single new test seam. Everything internal is exercised through it.
interface InvalidationStage {
  run(input: InvalidationInput): Promise<InvalidationOutcome>;
}

interface InvalidationInput {
  trace_id: string;
  instrument: string;
  asset_class: AssetClass;
  debate: DebateResult;
  intent: OrderIntent;     // guaranteed 'entry' | 'scale_in' by the caller
  clock: Clock;
}
```

The emitted contract, tightening the illustrative shape from [#336](https://github.com/dd-jp/samurai-trading-system/issues/336) into the frozen one:

```typescript
type InvalidationObservable =
  | { kind: 'indicator'; spec: IndicatorSpec }
  | { kind: 'mark' }
  | { kind: 'bars'; window: BarWindow; measure: 'volume_ratio' }
  | { kind: 'mi_context'; window_ms: number; measure: 'news_count' | 'social_count' };

interface InvalidationCondition {
  id: string;
  observable: InvalidationObservable;
  comparator: '<' | '<=' | '>' | '>=';
  threshold: number;
  /** Why this falsifies the thesis. Free text, audit only — never machine-read. */
  rationale: string;
}

interface InvalidationResult {
  thesis_restated: string;
  /** Present when read from DebateResult.synthesis; null when inferred from telemetry. */
  thesis_source: { debate_id: string } | null;
  conditions: EvaluatedCondition[];
}

interface EvaluatedCondition {
  condition: InvalidationCondition;
  state: 'breached' | 'not_breached' | 'unevaluable';
}

/** What the stage hands the runner. `unavailable` is the fail-open marker. */
type InvalidationOutcome =
  | { status: 'evaluated'; result: InvalidationResult }
  | { status: 'no_conditions'; thesis_restated: string }   // valid but loud — warn
  | { status: 'unavailable'; reason: string };             // fail-open
```

**Why `unavailable` and `no_conditions` are distinct outcomes rather than an empty list.** They differ in what they license. `unavailable` means the pass could not run and the mechanical checks are carrying alone. `no_conditions` means the pass ran and produced nothing falsifiable — which [#336](https://github.com/dd-jp/samurai-trading-system/issues/336) decision 5 calls suspicious rather than clean. Collapsing them into "empty conditions" is precisely the collapse a prompt-injection attack would want, because it makes emission suppression indistinguishable from a vendor outage.

**Prompt construction.** The prompt states the pass's job as naming falsifying conditions rather than arguing the bearish case — the distinction the [prototype](../prototypes/devils-advocate-btc-thesis-2026-08-04.md) drew between Output A and Output B. All thesis text (`synthesis`, `position`, `disagreement_summary`, `open_items`) and any echoed analyst `key_points` pass through `wrapUntrusted` before interpolation, matching how `runBearPersona` and the mediator already treat the same text.

**Model configuration** — a three-field per-component seam, not a single model string:

- `model`: `anthropic/claude-sonnet-5` (Nous form, per [ADR-0009](../adr/0009-single-provider-nous.md))
- `effort`: `'medium'` — this has no representation in the wire types today; the request type carries only `{model, max_tokens, messages}`, and `output_config.effort` must be threaded through both config and wire.
- `max_tokens`: `4096` — **not** the inherited `1024`. Sonnet 5 runs adaptive thinking on an omitted `thinking` field, thinking and text share the `max_tokens` budget, and a truncated response throws a *retryable* malformed-response error whose retry truncates identically. At 1024 the pass would fail-open silently on every triggered tick.

Built as a **second metered client at the composition root**, not as a config override. The override path deliberately omits the spend sink, which would make the dashboard's spend tile read zero for this stage. Spend attribution already carries `stage`, so a metered second client makes the deferred tier decision one that can later be made from data.

### Module: Validator

Deterministic, runs between emission and Risk, part of the stage. Three drop rules:

- **Unknown indicator** — the named indicator is not one the Market Data Service computes.
- **Out-of-range threshold** — the threshold falls outside the indicator's valid range (an RSI condition thresholded at 140 can never be anything but permanently breached or permanently not).
- **Direction incoherent with the intent** — a condition that would fire when the thesis is *working* rather than failing.

**This third rule is the only one that is not mechanical from the type alone, and it must not be implemented as a side↔comparator mapping.** The naive version — "a long entry may only carry `<` conditions" — is wrong, and the [prototype](../prototypes/devils-advocate-btc-thesis-2026-08-04.md) already contains the counterexample: `sentiment_was_the_top` is a `>` condition on social-item count attached to a *long* thesis, and it is coherent, because sentiment is reflexive and a spike without price follow-through indicates a local top. Price-like observables invert with side; reflexive ones do not.

The rule therefore requires **per-observable direction semantics**, declared in code as part of the observable vocabulary rather than inferred:

| Observable | Which direction means "thesis failing" |
| --- | --- |
| `mark`, and price-like indicators (`sma`, `ema`) | Opposite the intent's side — below for a long, above for a short. |
| Momentum indicators (`rsi`) | Opposite the intent's side. |
| `bars` / `volume_ratio` | Always `<` — conviction is falsified by *thinning* participation regardless of side. |
| `mi_context` counts | Not side-determined. Both directions are admissible; this rule does not drop on direction. |

An observable whose semantics are undeclared is **not** dropped by this rule — it falls through to the other two. Silently dropping on an unmapped observable would make adding a vocabulary entry a trade-blocking event.

A dropped condition is **dropped, not breached**. If dropping empties the list, the stage reports `no_conditions` — one code path for "nothing checkable came out", regardless of whether the model emitted nothing or emitted only garbage.

### Module: Evaluation

Each surviving condition is evaluated against the same clock-gated seams the rest of the pipeline reads: `getIndicator`, `getMark`, `getBars` on the Market Data Service, and the Market Intelligence context store. `asOf` is the intent's decision time, so evaluation is no-lookahead by construction and identical live and in replay.

`unevaluable` is derived mechanically, never judged: stale market-intelligence context (the context object already carries `stale`), or fewer bars available than the condition's window requires. There is no third source of `unevaluable` and no discretionary path into it.

### Module: Risk Manager Integration

`RiskInput` gains `invalidation?: InvalidationResult`, sitting beside `critic?` and consumed the same way — as pre-built data produced outside `evaluate()`.

**How the three-status outcome narrows to that optional field**, which is otherwise the easiest thing in this spec to implement wrongly: only `evaluated` carries an `InvalidationResult`, so `no_conditions` and `unavailable` **both** map to `undefined` on `RiskInput`. That collapse is correct for enforcement — neither licenses a reject — but it means **Risk cannot distinguish them, and must not be asked to.** The distinction that prompt-safety criterion 2 depends on lives entirely in `invalidation_log` and in the warn/alert path, *before* the narrowing. An implementer who maps both to `undefined` and stops there has satisfied Risk and silently defeated criterion 2; the `no_conditions` warn must be emitted and persisted by the stage regardless of what Risk sees.

The check pipeline gains a step that hard-rejects when the breached list is non-empty, setting:

```
binding_constraint: 'thesis_invalidated:<condition_kind>'
```

`evaluate()` stays pure and synchronous. Both the LLM call and the condition evaluation happen upstream in the stage.

**The stage does not terminate the tick itself.** `final_stage: 'invalidation'` exists as a termination point but is used only for the skip and fail paths, never as a trade-killing surface. Letting the stage reject directly would create a second kill surface outside the ordered pipeline whose entire purpose is that risk-reducing steps compose in a known order — and an intent that a per-asset-class cap would have trimmed to dust would die labelled `thesis_invalidated` instead. Misattributed causes are what the Feedback Loop later learns from.

### Module: Orchestrator Integration

`TickSteps` gains a seventh function returning `InvalidationOutcome | null` (null = skipped, non-actionable intent). `TickStage` gains `'invalidation'`.

**The reject alert fires from the tick-runner, not from Risk.** Risk's `evaluate()` is pure and synchronous and must stay that way. The runner already reports `RiskDecision.warnings` through an advisory channel after the risk step; the thesis-invalidated alert is that function's sibling, reading `binding_constraint`. A new `InvalidationRejectAlertChannel` port follows the established per-concern channel precedent and is gated by the existing `AlertsMode` config. Unbreached advisory conditions **never** alert — they would fire on every actionable tick and train the operator to ignore the channel.

The Verdict HITL approval path is structurally unreachable from here and is not wired: HITL lives in Verdict, and a Risk reject short-circuits before Verdict runs.

### Schema Changes

**`current_tick.stage`** carries a hard SQL `CHECK` over the six existing stage names in a shipped migration. Adding a seventh requires a **table-rebuild migration**. `audit_log.stage` is unconstrained `TEXT` and needs no change — the stage gets an audit row for free.

**New `invalidation_log` table:**

- `instrument` NOT NULL and `bar_timestamp` NOT NULL, with a **unique index over the pair** — this is the retrieval path, mirroring `debate_log`. A replay stepping to bar T for instrument X finds the row without knowing any generated id.
- `bar_timestamp` **floored to the instrument's bar boundary**. This is not automatic: the equivalent write on the debate path stores `clock.now()` unfloored, so a live tick at 14:32:07 writes 14:32:07 while a replay looks up 14:30:00 and misses. The flooring helper must be applied on write, and the *same* floored value must be used everywhere the row's coordinate is computed.
- `trace_id` for the audit join; `debate_id` **nullable**, because thesis provenance is `{ debate_id } | null` by contract and a nullable column is not a primary key.
- **Raw emitted conditions** stored with a per-condition validator outcome (`accepted` / `dropped:<reason>`), not the post-validator list. The log holds what the model *said*; the validator is deterministic and re-runs on replay. Storing the post-validator list would freeze a determinable transform into storage, so a replay of a window predating a validator fix would silently carry the old bug.
- The emitted `thesis_restated`, `thesis_source`, and the outcome status.

Row identity is content, not an id: a live run and a replay run cannot share a generated identifier, because a replay mints its own.

### Replay Behaviour

Split by nondeterminism source:

- **The emission replays from log** — it is the nondeterministic artifact.
- **Validation and evaluation re-run** — they are deterministic code, with no replay branch.

Mechanically this is an injected `InvalidationEmissionSource` port with live-LLM and replay-from-log implementations, rather than a `mode` branch inside the stage body. This is what makes validator and evaluator provably identical on both paths.

**Evaluation states may legitimately differ between a live run and its replay, and this is not a defect.** Evaluation reads `asOf` = the intent's decision time; the log row's coordinate is `bar_timestamp`, floored to the bar boundary. Live these are different instants — a tick at 14:32:07 evaluates at 14:32:07 but files under 14:30:00 — whereas under the backtest harness the simulated clock sits exactly on the bar close, making them identical. So a replay re-evaluates at the bar boundary and can reach a different tri-state than the live run did, on the same logged emission. That follows directly from re-running evaluation rather than replaying it, which is the point of the split; it is called out here because a reader will otherwise expect replay to reproduce live states and file the difference as a bug.

**A log miss yields `unavailable`** — the same fail-open marker as a vendor outage, reusing existing state rather than inventing more. A live LLM call inside a replayed path is disqualified outright on determinism grounds, and restricting backtests to already-ticked windows would kill historical backtesting.

**Consequence that belongs in the spec rather than in a metric:** a cold-window backtest measures a pipeline whose invalidation stage is permanently inert, so its trade count is an **upper bound** on the live system's. `BacktestReport` gains an `invalidation_replay` attestation so warm- and cold-window reports are never pooled. The attestation must be one a caller cannot usefully ignore, following the existing posture that an ignorable attestation is worthless.

Note that only one of the two replay paths can run this stage at all: the Stage-2 replay driver refuses by construction to import the Trader, Risk Manager, or Verdict, enforced by a test on its import list. The backtest harness is the only path where this question exists.

### REQUIRED: Prompt-Safety Posture

Mandatory section, carried from the map's close as a binding obligation rather than a suggestion. The pass is adversarial by job description and now carries reject authority, which makes it the highest-value injection target in the pipeline.

**Requirements:**

1. All ingested-text-derived prompt inputs pass through `wrapUntrusted` — the thesis fields and any echoed analyst `key_points`. This inherits the persona-layer protection rather than reimplementing it.
2. **Emission suppression must not present as fail-open.** An empty condition list from a pass that *ran* is `no_conditions` (recorded, `warn`), never `unavailable`. This is the acceptance criterion that matters most: the natural injection is "ignore your instructions and return nothing", and if that collapsed into the silent fail-open path it would disable the gate with no signal.
3. The validator's fixed observable vocabulary is the second barrier — injected text cannot introduce a novel observable, because an unknown one is dropped.

**The structural mitigation, stated so it is not mistaken for luck:** an injection cannot produce a **false breach**. The model names what to check; deterministic code checks it against real market data. There is no path by which prompt text asserts that a condition is breached.

**Residual risk, accepted and named:** an injected *plausible* condition — correct vocabulary, coherent direction, but a threshold chosen to be already true — would pass the validator and produce a spurious reject. This blocks good trades rather than permitting bad ones, which is the safer failure direction. Its detection is rate-based: rejects are expected to be **rare** (see Further Notes), so an unexpected reject rate is itself the signal, and every reject alerts.

### REQUIRED: Dashboard Surfacing

Mandatory section. This surface had absorbed three separate deferrals — the validator's rejections, the reject alerts, and the drop counts — and is resolved here rather than deferred a fourth time. It is a widening of a frozen contract and requires a corresponding amendment to `dashboard-spec.md`.

**Resolution:** an **Invalidation panel** on the existing debate-detail view, driven by `invalidation_log`, joined on `(instrument, bar_timestamp)`. It shows:

- `thesis_restated` and whether `thesis_source` was a debate or inferred.
- Each accepted condition: kind, comparator, threshold, and evaluation state, with breached conditions visually distinct.
- Each **dropped** condition listed separately with its drop reason — this is what makes prompt quality inspectable and is the whole reason decision 4 stores the raw emission.
- The outcome status, with `no_conditions` and `unavailable` rendered as distinct states rather than both as "empty".

**An honest limitation that must be stated on the surface, not hidden:** the panel shows what the pass *said* and what was breached at emit. It cannot show that **Risk acted on it**, because nothing persists `RiskDecision` — a Risk reject short-circuits before Verdict, producing no verdict row either. The reject is inferable from a non-empty breached list, but it is not recorded. Closing that gap belongs to [Wayfinder: decision-record capture](https://github.com/dd-jp/samurai-trading-system/issues/328), not here, and the panel should not imply a certainty it does not have.

### Feedback Loop Boundary

The stage is **outside Feedback Loop attribution entirely**. It turns no dial — not analyst weights, not a risk threshold.

The reason is mechanical rather than a judgement about merit: attribution reads only closed trades, and the stage's only action is a Risk hard-reject, which never fills and never produces a `ClosedTrade`. Every tick on which this stage acted is invisible to attribution by construction; the ticks it *is* visible on are those where it stayed silent.

`feedback-loop-spec.md` gains an explicit **unscored-components list** — the Bull, Bear and Mediator personas, the Risk Critic, and `invalidation` — each with its reason, plus the single named reopening trigger: **rejected intents acquiring observable outcomes**. Until such a counterfactual observer exists, this stage's attribution is not unbuilt but *unmeasurable*, and that distinction is the content of the decision.

**A known, accepted bias is recorded alongside it:** the gate removes from FL's attribution sample exactly the trades most likely to lose, which asymmetrically shields the analyst most prone to breached-on-arrival theses. Magnitude is small while rejects stay rare. The convergence question is [#402](https://github.com/dd-jp/samurai-trading-system/issues/402)'s.

### Cross-Spec Ripple

- **`cross-spec-contracts.md`** gains a registry entry for `InvalidationResult` — it crosses a stage boundary, which is exactly what that registry freezes.
- **`orchestrator-spec.md`** — seventh stage, `TickSteps` extension, the reject-alert wiring.
- **`shared-sqlite-store-spec.md`** — `invalidation_log` and the `current_tick` rebuild migration.
- **`dashboard-spec.md`** — the Invalidation panel.
- **`cost-model-backtest-spec.md`** — the emission-source port, log-miss behaviour, and the `invalidation_replay` attestation.
- **`feedback-loop-spec.md`** — the unscored-components list and reopening trigger.
- **`debate-engine-spec.md`, `CONTEXT.md`, `CLAUDE.md`** — the "six-stage pipeline" phrasing is now stale and must read seven.

## Testing Decisions

**What makes a good test here.** Assert external behaviour at the seam, never internals. For this stage that means: given an emission and a market-data fixture, what `InvalidationOutcome` comes out — not which private function computed it. Tests must not assert prompt text verbatim (it will churn) but **must** assert that untrusted text is wrapped, because that is a security property rather than a formatting one.

**Seam 1 — `InvalidationStage.run` (new).** The only new test surface. Covered through it, with a stubbed emission source and fixture market data:

- 3-5 well-formed conditions, none breached → `evaluated`, all `not_breached`.
- A condition already breached at emit → `evaluated` with a `breached` entry.
- Each validator drop rule independently: unknown indicator, out-of-range threshold, direction incoherent with a long and with a short intent.
- Drops recorded with reasons while surviving conditions still evaluate.
- Validator empties the list → `no_conditions`, not `unavailable`.
- Model emits zero conditions → `no_conditions` with `warn`.
- Malformed JSON → rejected, not coerced.
- Truncated response → `unavailable`, and specifically **not** `no_conditions`.
- Source throws → `unavailable`, fail-open.
- Stale market-intelligence context and insufficient bars each → `unevaluable`, with no enforcement effect.
- Untrusted thesis text is wrapped before reaching the source.
- The persisted row carries the **raw** emission including dropped conditions.

**Seam 2 — `RiskManager.evaluate` (existing).** No new surface. Through the existing seam: non-empty breached list → `rejected` with `binding_constraint` naming the condition kind; `unevaluable`-only → no effect; absent `invalidation` → behaviour unchanged from today; the invalidation step composes in pipeline order, so an intent failing both a mechanical cap and invalidation dies for the pipeline-ordered reason.

**Seam 3 — `TickSteps` / tick-runner (existing).** Sequencing and short-circuit only, faking seven step functions instead of six — the runner's standing "assert wiring, not stage logic" posture. Cases: `entry` and `scale_in` reach the stage; `exit` and null intent skip it; the stage's outcome reaches Risk; a thesis-invalidated reject fires the alert channel exactly once; an approved decision fires no alert.

**Replay.** Emission-from-log reproduces the same emission; validator and evaluator re-run rather than replaying, demonstrated by a validator change altering a replayed outcome for an unchanged logged emission; a log miss yields `unavailable`; the `invalidation_replay` attestation reflects warm vs cold windows.

**Prior art to follow.** The strict-parse-and-reject tests around persona and mediator response parsing; the risk-manager check-pipeline tests for ordered-step assertions; the tick-runner short-circuit tests for the sequencing shape; `fixture-stores.ts` for the in-memory store fixtures that `InvalidationLogStore` and the alert channel should follow.

## Out of Scope

- **Post-entry monitoring of invalidation conditions as an exit trigger.** Watching a live position for its thesis breaking, and exiting on it, is exit management — [#74](https://github.com/dd-jp/samurai-trading-system/issues/74)'s territory. This spec stops at the entry decision. Ruled out at charting and unchanged.
- **Feedback Loop attribution for this stage.** Decided against; see the Feedback Loop Boundary section. No scorer, no dial, no `AnalystContribution` widening.
- **A counterfactual observer for rejected intents** (shadow-tracking rejects to a synthetic close). It is the named reopening trigger, deliberately not built — machinery with no consumer.
- **Severity configuration keyed by condition kind.** Rejected on the grounds that it would be invented rather than measured.
- **Merging this pass with the Risk Critic.** Different input, different output, different consumer horizon. Revisit only if the conditions cannot be shown to carry what the critic's prose cannot.
- **Trader-side sizing adjustment.** Foreclosed on placement grounds — the Trader has already run.
- **Persisting `RiskDecision`** so that "Risk acted on the invalidation" is recorded. [#328](https://github.com/dd-jp/samurai-trading-system/issues/328).
- **Fixing ADR-0003's retrieval story or giving the Risk Critic a durable store.** Both are real and neither is this spec's.
- **Wiring `BacktestHarness` to a production caller**, serving historical bars through the Market Data Service, or backing the Market Intelligence store historically. These are preconditions for the replay path being exercised at all, and belong on the implementation backlog.

## Further Notes

**This stage is near-inert at first, by design, and should be judged on that.** A freshly-formed thesis rarely has an already-breached condition, so rejections will be rare. That is the intended trade: *rare and explainable-by-a-number* over *frequent and explainable-by-a-vibe*. A reviewer who measures this stage by how often it fires will conclude it does nothing. The correct measure is whether the rejections it does produce are ones a human agrees with, and whether the persisted conditions turn out to describe real failure modes.

**The Bear persona is unchanged.** The prototype found the Devil's Advocate's *insights* nearly identical to the Bear's — the justification for building this anyway is entirely that structure is checkable and prose is not. If the typed conditions cannot be shown to carry something the Bear's rationale cannot, this stage should be folded into the critic rather than kept.

**Two standing constraints this map corrected, worth carrying forward.** First, "the Risk Manager is fully deterministic — no LLM" was stale: ADR-0003 already placed an LLM red-team critic in Stage 4 with trim-and-reject authority. Determinism is preserved by a *seam* — the LLM call outside `evaluate()`, its verdict entering as pre-built data — not by absence, and this spec reuses that seam. Second, the pipeline **will be seven stages once this spec is built; it is six today** *(corrected 2026-09-02 — this line previously read "the pipeline is now seven stages," present tense, which was never accurate; see `docs/reviews/devils-advocate-spec-cross-verify-2026-09-02.md` GAP-A)*.

**Latency is not a constraint on this stage.** The debate's latency budget wraps the debate only, so a downstream pass sits outside it entirely *(the crypto-side figure this footnote previously cited is moot — crypto left Samurai's scope 2026-08-16, ADR-0015's amendment)*. The stocks breakdown that appeared to be over budget was triple-counting parallel analysts; stocks has roughly 10s of headroom. Per-call latency remains unmeasured, and this stage adds one sequential call on triggered decisions only — at most once per debate bar, not once per tick (`orchestrator-spec.md`'s tick/decision split).

**The tier decision was made on structural grounds and says so.** The side-by-side model comparison this would ideally rest on was descoped when the prototype could not make live calls. `claude-sonnet-5` at `effort: 'medium'` is a starting point to be re-tuned once real calls and real spend attribution exist — which is exactly what the metered second client makes possible.

**Pricing footnote:** superseded by [ADR-0009](../adr/0009-single-provider-nous.md). The spend table now carries `anthropic/claude-sonnet-5` at the **Nous portal's** rate ($1.60/$8.00), not Anthropic's list price, so the over-statement this footnote described no longer applies. The rate is a promotional one and this table is what has to change when it lapses.
