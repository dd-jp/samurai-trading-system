# Devil's Advocate — Skeptic Self-Review Enhancement Specification — **DECLINED**

**Status:** **Declined 2026-08-17** — not built, and not pending  
**Owner:** David (Deepak)  
**Date:** 2026-08-16, declined 2026-08-17  
**Wayfinder map:** [#718](https://github.com/dd-jp/samurai-trading-system/issues/718), **closed as not planned** on David's ruling  
**Supersedes:** Nothing  
**Research basis:** `docs/research/README.md` doc 16 (open finding), Quant Vault "play the skeptic" prompt, AI Vault "Silent AI Agent Failure Checklist" pattern

## Why this was declined

Stated here in the body rather than as a banner, so a later reader does not find an unbuilt spec and assume it is pending work. **Everything below this section is the declined proposal, preserved as the record of what was considered — it is not a plan.**

Four grounds, three of them decisions taken after this spec was written:

1. **It adds a third LLM-driven stage, against the direction the record now takes.** The 2026-08-16 intraday re-specification pass moved the LLM commitment off the per-analyst layer and confined it to the debate: a nondeterministic, unauditable, per-call-billed model should not compute what a rule computes. [#642](https://github.com/dd-jp/samurai-trading-system/issues/642) and [#513](https://github.com/dd-jp/samurai-trading-system/issues/513) apply the same reasoning to the Risk Manager's LLM critic, with the recorded direction being that the *"no LLM"* claims are the true ones.
2. **It widens the surface [#683](https://github.com/dd-jp/samurai-trading-system/issues/683) exists to bound.** With the model off the analyst layer, the mediator is the only place a nondeterministic judgment enters the pipeline. A second one means the mandated falsifier control (arm 2 — same names, exit rule and stop, entry by indicator alone, no LLM) bypasses two model-driven stages rather than one, making any lift the live arm shows harder to attribute. That control is now the primary benchmark per CLAUDE.md, [ADR-0014](../adr/0014-intraday-flat-by-close-horizon.md) amendment 2 and [ADR-0017](../adr/0017-validation-gates-paper-operational-thesis-expectancy.md).
3. **Its target failure modes are already measured, quantitatively and reproducibly.** Overfitting, data snooping and trial inflation are what PBO/DSR and MinBTL compute. `docs/research/13-stage2-proxy-verdict.md` is the standing demonstration — a terminal KILL, with 12/24 configurations surviving on Sharpe and **not** surviving selection accounting. An advisory model flag reading "this looks overfit" adds nothing to a computed PBO of 0.85, and risks being taken as a second opinion when it is a weaker one.
4. **Advisory-only flags on an unbuilt stage are this repo's dominant defect shape.** `invalidation` is specced and not built — the runtime chain is six stages, Trader → Risk. Flags nothing acts on, emitted by a stage nothing calls, is a mechanism that looks like a methodology guard and guards nothing.

**What survives, and where it went.** The enumeration below — overfitting, look-ahead bias, data snooping, regime shift, crowding, structural break, cost illusion — is a fair account of how a strategy this size dies, and it is kept. It belongs as a **checklist applied when writing a `docs/research/NN-*.md`**, not as a runtime stage: it costs nothing, it is auditable, and it lands where these failures actually occur — in study design, not in a live tick. The existing research convention (pass bar declared before the result, declared trial count, declared OOS split) is the same instinct; this list extends it.

**What would reopen this.** Not "the invalidation stage got built." The prior question is **what does a flag change?** Advisory-only means nothing acts on it, and a flag nobody acts on is documentation with a per-call bill. If the answer is that it should *block*, that is a different proposal that collides head-on with ground 1 — it would have to overturn the determinism ruling, not sidestep it.

---

## Problem Statement (continued from `devils-advocate-spec.md`) — *declined proposal, retained as record*

The existing Devil's Advocate stage asks **"what would falsify this thesis?"** and emits machine-checkable conditions against live data. That layer is sound and the spec is complete.

What it does **not** do is ask **"how might this thesis be wrong in ways that aren't yet checkable?"** — overfitting, look-ahead bias, data snooping, survivorship, methodology flaws, structural changes in the instrument or market regime. These are not predicates on a price feed. They are self-skepticism questions that only a model can pose, and the current stage has no slot for them.

The consequence: a thesis can pass all invalidation conditions (every checkable predicate is `not_breached`) and still be a fabricated pattern that would collapse the moment the regime shifts — because nothing in the pipeline asks the thesis to defend its own methodology.

This spec adds a **Skeptic Self-Review** step inside the existing `invalidation` stage, between the condition emission and the evaluation step. It preserves every existing contract, every tri-state evaluation, and every Risk Manager handoff. It adds one new output field: `skeptic_flags[]`.

---

## Solution

A **single additional LLM call** inside the `invalidation` stage, executed after conditions are emitted but before they are evaluated. The call takes the debate synthesis, the intent, and the emitted conditions as input, and asks the model to act as a hostile reviewer — specifically looking for the failure modes listed below.

The output is a list of typed `SkepticFlag` objects, each with a `category`, a `rationale`, and a `severity` (advisory only — never feeds into Risk's hard-reject logic). Flags are persisted, surfaced in the debate log, and included in the post-trade review. They do **not** block trades; they are diagnostic signals for the Feedback Loop and for human review.

**Key constraint:** the skeptic call cannot block the tick. If it fails or times out, the stage proceeds with an empty `skeptic_flags[]` and a `warn`-level log entry. The existing invalidation logic is the only trade-killer.

---

## Failure Modes the Skeptic Must Search For

These are the categories the prompt must instruct the model to check. They are drawn from the Quant Vault's "play the skeptic" prompt and the AI Vault's failure-checklist pattern, filtered against what is actually observable inside Samurai's pipeline at invalidation time.

| Category | What to look for | Observable from |
|---|---|---|
| `overfitting` | Strategy parameters chosen to fit historical noise; too many configuration degrees of freedom relative to the number of observed trades | Debate synthesis, analyst weight history, backtest config |
| `lookahead_bias` | Indicators or conditions that would have used data not available at the decision time | Indicator computation provenance, replay store |
| `data_snooping` | The thesis was formed after the fact or tuned on the same data used to evaluate it | Feedback Loop weight history, stage 2/3 validation status |
| `regime_shift` | The market structure that produced the edge has changed (volatility regime, instrument listing change, venue rule change) | WorldMonitor CII, recent marketChanges velocity, instrument metadata |
| `crowding` | The edge is widely known and arbitraged away | social sentiment velocity, convergence signal count |
| `structural_break` | A one-off event (earnings, regulatory action, exchange halt) creates a temporary pattern that looks like an edge | DeepResearch news velocity, WorldMonitor intel items |
| `methodology` | The debate's reasoning contains a logical flaw, unsupported causal claim, or category error | Debate synthesis, analyst rationale texts |
| `cost_illusion` | The edge survives backtest but would be erased by realistic fees, slippage, or spread | ADR-0018 thresholds, venue fee schedule, measured spread data |

Categories are a closed enum. The model may only emit flags from this list; the validator drops any flag with an unrecognized category. This prevents the LLM from inventing failure types and keeps the output machine-parseable.

---

## User Stories

### Skeptic Call

1. As the `invalidation` stage, I want to invoke a skeptic self-review LLM call after emitting conditions and before evaluating them, so that methodology-level warnings reach the log without blocking the tick.
2. As the system, I want the skeptic call to time out at the stage's existing latency budget, so that a slow model response cannot stall the pipeline.
3. As the system, I want a failed or timed-out skeptic call to produce an empty `skeptic_flags[]` with a `warn` log entry, so that the tick proceeds normally.
4. As the skeptic call, I want to receive the debate synthesis, the OrderIntent, and the emitted invalidation conditions as my input, so that my review is grounded in the actual thesis under evaluation.

### Output & Persistence

5. As the `invalidation` stage, I want to emit `skeptic_flags[]` as a new field on `InvalidationResult`, so that downstream stages and post-trade review can see the flags.
6. As the `InvalidationResult` contract, I want `skeptic_flags[]` to be advisory-only — present in logs and review, absent from Risk's hard-reject decision, so that methodology warnings never block a trade that passed all mechanical checks.
7. As the Feedback Loop, I want to read `skeptic_flags` during post-trade review, so that recurring flag patterns can adjust analyst weights or trigger a strategy re-evaluation.
8. As the human operator, I want to see skeptic flags in the debate log and dashboard, so that I can audit whether the system is aware of its own potential failure modes.

### Validation

9. As the validator, I want to drop any `SkepticFlag` whose `category` is not in the closed enum above, so that invented failure types cannot reach the log.
10. As the validator, I want to accept any `severity` value the model emits (the model judges plausibility), but log it for later calibration against actual trade outcomes.

---

## Data Structures

```typescript
// New: appended to InvalidationResult
interface SkepticFlag {
  category: SkepticCategory;
  rationale: string;          // one-paragraph explanation of why this category applies
  severity: 'low' | 'medium' | 'high';  // advisory only, never feeds Risk
}

const SKEPTIC_CATEGORIES = [
  'overfitting',
  'lookahead_bias',
  'data_snooping',
  'regime_shift',
  'crowding',
  'structural_break',
  'methodology',
  'cost_illusion',
] as const;

type SkepticCategory = typeof SKEPTIC_CATEGORIES[number];

// Amended: InvalidationResult now carries skeptic_flags
interface InvalidationResult {
  trace_id: string;
  thesis_restated: string;
  conditions: InvalidationCondition[];
  evaluated: EvaluatedCondition[];
  skeptic_flags: SkepticFlag[];   // NEW — advisory, advisory-only
  // ... rest unchanged
}
```

---

## Prompt Contract

The skeptic prompt is a single call to the same LLM role used by the Debate Engine's mediator persona. It receives:

```
Role: You are a hostile reviewer. Your job is to find how this trading thesis might be wrong
       in ways that are NOT already covered by the mechanical checks below.

Mechanical checks (all passed — none breached):
  {each evaluated condition, one line}

Debate synthesis:
  position: {position}
  confidence: {confidence}
  disagreement_summary: {disagreement_summary}
  open_items: {open_items}

Order intent:
  instrument: {instrument}
  side: {side}
  size: {size}
  entry: {entry}

Your task:
  For each of these categories, assess whether it applies:
    overfitting, lookahead_bias, data_snooping, regime_shift,
    crowding, structural_break, methodology, cost_illusion

  Emit only categories that genuinely apply. If none apply, emit an empty list.
  For each flag: one-paragraph rationale, and a severity judgment
  (low/medium/high) based on how damaging this flaw would be if real.

  Output JSON: { "flags": [ { "category": "...", "rationale": "...", "severity": "..." } ] }
```

**Constraints on the prompt:**
- Must include the closed-category list verbatim — the validator depends on it
- Must NOT include Risk or enforcement language — this is diagnostic, not decision-making
- Must NOT duplicate conditions already covered by mechanical checks — if the thesis fails on price-below-SMA, the mechanical check catches it; the skeptic looks for things that *aren't* checkable mechanically
- Output format is JSON only; malformed output → empty flags + warn log, same as condition emission failure

---

## Implementation Decisions

### Where the Call Fits in the Tick

```
trader → [invalidation stage]
          1. Emit conditions (existing)
          2. Evaluate conditions against live data (existing)
          3. ★ NEW: Skeptic self-review LLM call
          4. Append skeptic_flags to InvalidationResult
          5. Hand to Risk (existing)
```

Steps 3 happens **after** step 2 so the skeptic sees which conditions passed, but **before** Risk receives the result. This ordering means:
- Risk's hard-reject logic is unchanged — only `evaluated.breached` matters
- Skeptic flags are always advisory regardless of when they fire
- A skeptic call timeout does not risk a trade that would have been rejected by conditions

### Latency

The skeptic call runs inside the stage's existing latency budget (same as condition emission). If it consumes time that would push the stage over budget, it is the first thing truncated — the stage proceeds with `skeptic_flags: []`.

**Estimated cost:** one additional LLM call per actionable intent. At ADR-0008's measured $0.001/call, this adds negligible cost per trade. The bigger cost is latency: the skeptic call must not push the stage past its budget.

**"The stage's existing latency budget" is a forward reference, not a measured number, and this spec must not be read as if it were** *(stated 2026-08-17)*. The `invalidation` stage is specced and **not built** — it has no runtime, so it has no measured throughput and no observed budget consumption. That makes this design a second LLM call on a path whose first call has never been timed end to end. Three consequences the implementation ticket must carry rather than discover:

1. **The budget is a precondition of the build, not of this spec.** Invalidation must land with an explicit numeric budget derived the way ADR-0009 derived the debate's — measured tail, not median, over the real prompt — before the skeptic call is enabled. Shipping both at once would make one unmeasured number cover two calls.
2. **First-truncated is only a safeguard if truncation is observable.** The stage proceeding with `skeptic_flags: []` is indistinguishable at every consumer from a skeptic that ran and found nothing. The truncation must be recorded as its own status in `invalidation_log`, or a permanently-truncated skeptic reads as a permanently-clean one. This is the same blind spot cross-spec §8 names for the `unavailable` status, arriving one layer in.
3. **Sequential, not concurrent, is the assumption.** The skeptic runs after condition evaluation by design (see the ordering above), so its latency adds rather than overlaps. Any budget arithmetic must sum the two calls.

### Replay

The skeptic call is **non-deterministic** (LLM output varies across runs for the same input). Per ADR-0003 §2 and the existing Invalidation replay convention:
- The **emitted `skeptic_flags[]` replay from log** — stored at emission time, read during backtest
- The call itself is **never re-run** during replay
- Backtest mode opens the same log the live path writes, so backtest and live see identical flags for the same intent

This matches the existing pattern for condition emission (see `devils-advocate-spec.md` §"Replay splits by nondeterminism source").

### Persistence

`skeptic_flags` are stored as part of the `InvalidationResult` row in the shared SQLite store (same row as conditions). No new table needed. The Feedback Loop reads them during post-trade review.

### Prompt Injection

The skeptic prompt receives the debate synthesis and conditions as untrusted data. The same tagged-untrusted-block convention used in the Debate Engine's `personas.ts` applies here: ingested text is wrapped in `<untrusted_analyst_data>` with an explicit preamble, and the output-format instruction sits outside the block.

---

## Open Questions

1. **Should recurring `cost_illusion` flags escalate to a hard check?** If the skeptic flags cost_illusion on three consecutive trades, should that trigger a re-evaluation of ADR-0018's threshold arithmetic rather than remain advisory? This spec leaves it advisory; a follow-up ticket can gate escalation on observed frequency.

2. **Should skeptic flags feed into the conviction score?** The current conviction formula does not include them. Adding them would change the Debate Engine contract; this spec does not propose that change.

3. **Calibration of severity against outcomes.** The skeptic's severity is uncalibrated. Over 6–12 months, the Feedback Loop can correlate `severity: high` flags with actual trade outcomes to tune the model's self-assessment. No calibration exists today.

---

## Implementation Notes

- No change to any downstream contract (Risk, Trader, Verdict)
- No new database table or schema change
- The skeptic prompt uses the same model/role as the Debate Engine mediator (ADR-0009 Nous role)
- The `SkepticCategory` enum is a closed list — the validator rejects any category outside it
- A zero-flag emission is `[]`, not `null` — matches the existing convention for empty item lists

---

## Files Touched

| File | Change |
|---|---|
| `server/pipeline/invalidation/invalidation-stage.ts` | Add skeptic call step between condition evaluation and result assembly |
| `server/pipeline/invalidation/skeptic-prompt.ts` | New — prompt construction, JSON parsing, category validation |
| `contracts/invalidation.ts` | Add `SkepticFlag`, `SkepticCategory` to `InvalidationResult` |
| `server/providers/shared-sqlite-store-spec.md` | No change — `skeptic_flags` stored in existing `invalidations` table |
| `docs/specs/devils-advocate-spec.md` | Amendment note pointing to this spec |
