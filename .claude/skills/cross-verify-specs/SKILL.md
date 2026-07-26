---
name: cross-verify-specs
description: Cross-verify all specs in a specs folder (default docs/specs/) against each other and individually, before /to-tickets. Use whenever the user asks to "cross-verify specs", "check specs for contradictions", "review the specs folder", "audit the specs", asks whether the specs are consistent/ready for tickets, or invokes the cross-spec verification step named in CLAUDE.md Standing Pipeline Rule 7 — even if they just say "verify the specs" or "are the specs done" without naming this skill. Checks for contradicting requirements between specs, security issues (secrets, injection, authz gaps, unsafe defaults), missing good-practice/design-pattern moves (and overengineering), and speed/performance/maintainability/complexity/simplicity improvements. Produces a structured, hostile-reviewer report — not a rubber stamp.
---

# Cross-Verify Specs

Formalizes the manual "cross-spec verification" step in this repo's pipeline: **wayfinder map → spec → cross-spec verification (this skill) → `/to-tickets`**. Nothing produced here should read as a rubber stamp — specs that pass this pass become GitHub tickets and then code; a contradiction or security gap missed here becomes a load-bearing bug two stages later.

This repo already has one hand-run example of the convention this skill formalizes: `docs/specs/cross-spec-contracts.md`. Read it before your first run — it shows the severity ranking (HIGH/MEDIUM/LOW), the "GAP-<letter>: problem → Fix" phrasing, the "Confirmed clean" section, and the propagation log. Match that voice and structure; don't invent a new report format.

## When invoked

Argument: a folder path, default `docs/specs/`. If the user names a different folder, use it.

## Why this is delegated to subagents

Specs in this project run long and there are a dozen-plus of them. Reading all of them into your own context to compare pairwise burns the context budget you need for the actual cross-referencing judgment call. Instead:

1. One subagent **per spec** does the close reading and extraction.
2. You (not a subagent) do the cross-referencing — the point where contradictions actually surface — because it requires holding all the extracts in view at once and making judgment calls a subagent can't make blind to the others.

Don't skip step 1's delegation "to save time" on a small folder — even 3-4 specs benefit from parallel dispatch, and the discipline of separating extraction from cross-referencing is what keeps the cross-referencing pass honest (it's reasoning over structured facts, not re-skimming prose).

## Step 1 — Enumerate specs

List every file in the target folder. Exclude any existing cross-verification registry (e.g. `cross-spec-contracts.md`) from the "specs to review" set, but read it if present — it's the frozen source of truth for shared types, and this run should treat contradictions with it as HIGH severity (a spec drifting from a frozen registry is worse than two specs disagreeing with each other, since one side is already supposed to be authoritative).

## Step 2 — Per-spec extraction (parallel subagents)

Spawn one `general-purpose` agent per spec **in parallel** (single message, multiple Agent calls), each with `run_in_background: false` — Step 3 needs every extract in hand before it can cross-reference, so don't let any of these run in the background where the result would land in a separate, unordered turn. Give each agent the full file path (not a summary) and this brief:

- Read the spec fully.
- Extract every type/interface/contract it **defines** (owns) and every one it **consumes** (assumes from another stage) — field names, types, units, ownership claims, exact as written. This is the raw material the cross-referencing pass needs; approximate names cause false contradictions or missed real ones.
- Security review of this spec alone: secrets/API-key handling, injection surfaces (anything built from external input — market data, config, user input), authn/authz boundaries, unsafe defaults (fail-open vs fail-closed, permissive parsing, missing input validation at trust boundaries).
- Design-practice review: is there an abstraction this spec should honor but doesn't (e.g. this project's `BrokerAdapter`-style seams), tight coupling to a concrete implementation where an interface is implied elsewhere, missing idempotency on operations that clearly need it (retries, restarts), missing error-boundary/failure-mode handling for a stage that can partially fail. Flag missing patterns with a concrete recommended change — not "consider using a pattern here."
- Performance/complexity review: anything that reads as needless complexity for the problem size (overengineering — flag this as freely as underengineering), anything that will be slow at the stated scale/frequency, anything that will be hard to maintain because it's doing too much or naming things ambiguously.
- Return structured findings (see `references/extraction-format.md` for the exact shape to ask each subagent to return) rather than prose — the cross-referencing pass in step 3 needs to diff these mechanically.

## Step 3 — Cross-referencing (you, not a subagent)

Once all extraction agents return, do the comparison yourself:

- **Contradiction matrix.** For every type/contract that appears as "defined" in one extract and "consumed" in another (or "defined" in two), diff the field names, types, and semantics. A mismatch is a contradiction whether or not either spec's author noticed — that's the entire point of this pass. Note the exact two spec names + line-level detail, not "specs disagree somewhere."
- **Ownership conflicts.** Two specs both claiming to define/write the same type or own the same responsibility.
- **Silent assumptions.** A spec consuming a contract that no other spec defines at all (an orphaned dependency) — this is how `DebateLog` went unspecced in this repo's own history until a verification pass caught it.
- **Security issues that only show up cross-spec** — e.g. one spec assumes another performs an auth check that the other spec never actually performs.
- **Constraint compliance.** Check each spec's actual behavior against this project's decided constraints, not just against each other — `CONTEXT.md`, `docs/adr/`, and the binding research principles in `docs/research/00-summary.md`/`01-full-report-with-sources.md`/`02-staged-deployment-plan.md` (expectancy floor, √-law transaction costs, PBO/DSR/walk-forward/MinBTL, point-in-time/no-lookahead/survivorship-free, fractional-Kelly sizing, circuit breakers). A spec that's internally consistent but quietly softens or contradicts a decided constraint (e.g. exposing a fixed kill-line as tunable config) is a real defect the pairwise contradiction matrix alone won't catch — treat it as HIGH, same tier as contradicting the frozen registry.
- **Aggregate the per-spec findings** (security, design-practice, performance/complexity) from step 2, deduplicating overlapping ones, and rank everything by severity using this project's existing convention:
  - **HIGH** — MVP-blocking, load-bearing, or contradicts the frozen registry.
  - **MEDIUM** — real but not blocking; will bite later or in an edge case.
  - **LOW** — polish, naming, minor duplication.
  - **Confirmed clean** — call out what you checked and found consistent, so the report isn't only complaints. This also proves the pass was thorough rather than skipped.

Before writing anything up, apply this project's fable-mode discipline: re-read the two or three most severe findings against the actual spec text (not your extraction agent's summary) as a hostile reviewer would — could you be wrong because the extraction paraphrased something the spec actually said precisely? Verify before asserting a contradiction exists.

## Step 4 — Report

Use the structure in `references/report-template.md`. Write it to the target folder as a new dated file, e.g. `docs/specs/cross-verify-<date>.md` — this is the default even when a registry file like `cross-spec-contracts.md` already exists. That file is explicitly marked **Frozen**; propagating a finding into it is a separate, deliberate edit the user makes afterward (or asks for explicitly), not something this pass does as a side effect of reporting. Every finding needs a concrete fix recommendation, not just a description of the problem — "GAP-X: two Fill shapes disagree" is useless without "Fix: rename Y's field to Z, owner is the spec that already has consumers."

Do not soften findings to make the report look better. A short "Confirmed clean" list next to a few sharp HIGH findings is a more useful and more credible report than a long list of trivial nitpicks padded to look thorough, or an all-clear that missed something a hostile reviewer would have caught.

## After the report

This skill's job ends at the report. Point the user at it and stop — don't auto-edit specs to fix findings unless asked. Per CLAUDE.md Rule 7, specs feed `/to-tickets` next; fixes to the specs themselves are the user's call on scope/sequencing, not something to apply silently mid-verification.
