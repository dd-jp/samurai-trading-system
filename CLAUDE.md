# CLAUDE.md — Project Briefing

Read this on every session start.

## Project Identity

- **Codename:** Samurai (v2 since 2026-09-19).
- **Goal:** `CONTEXT.md`'s **North Star** — read it first. An autonomous, self-improving trading system that makes a steady net profit over each year and never loses more than £1,500 net in a calendar year.
- **Owner:** David (Deepak). David is the final decision-maker; on any ambiguous call, ask him and treat the answer as final. Merges are his, except that since 2026-09-25 a session may merge its own PR under the merge-authority ruling in doc 66.
- **Authority chain:** `docs/research/66-v2-grill-decisions.md` (rulings Q1–Q19, G1–G18; wins over everything else) → `docs/adr/0001-samurai-v2.md` (the one ADR, with every open item listed) → `docs/research/67-v2-plan-and-handoff.md` (ordered work, Steps 0–6, definition of done, loose-ends register) → `docs/research/68-fable-handoff.md` (session prompts and the session eval). Map issue: [#1706](https://github.com/dd-jp/samurai-trading-system/issues/1706). `docs/v1-postmortem.md` holds the six v1 pitfalls that bind v2; `docs/v2-vision.md` is the vision (its daily target is superseded by Q1).
- **Sleeve:** debate only (Sonnet 5 + DeepSeek + GPT debaters, Opus 5 judge, daily swing, vs the no-LLM control arm 2, forward paper only); target universe commodities, indices, ETFs and equities. Momentum was dropped 2026-09-25 after both sub-books failed the kill line (doc 70, doc 66 Session B (n)); its 70% share is unassigned (open). No intraday sleeve.
- **Venues and universe:** Saxo Capital Markets UK GIA over OpenAPI for LSE 1× ETFs/ETCs; Alpaca live account (GBP wired once, trade USD) for US large caps (+ US ETFs if UK access is confirmed; bounded long-only small caps in the debate sleeve only). No 3× ETPs, no UK single stocks, no CFDs, no crypto.
- **Loss budget:** £1,500 net trading loss per calendar year from start capital, both venues, GBP, marked to market, FX excluded; −£500 half size, −£1,000 quarter size, −£1,500 halt for the year; daily cap 1.0% of start capital blocks entries; never loosened mid-year.
- **Gate:** DSR ≥ 0.95, PBO ≤ 0.10, 40% Sharpe haircut, 8–12 weeks of paper inside the 90% band with costs within ±25%, 4 fault-free weeks; debate sleeve instead ≥ 100 closed paper trades and a one-sided 95% test vs arm 2. Capital ≤ £1,500 / (backtest max DD × 1.5). Demotion on 4 weeks outside the 95% band or drawdown > 1.5× backtest max.
- **Autonomy:** fully autonomous. Auto to paper. Anything reaching live passes the gate, then a Telegram approval request goes to David: "no" blocks, no reply in 24 hours approves; request, answer/timeout and summary recorded to a GitHub issue. A session prompt's STOP is a different thing and waits for David's actual answer.
- **Host and stack:** always-on MacBook + external dead-man's switch + Saxo token-refresh/wake job; broker-resting stops on every position. TypeScript (Node 24+, per `package.json` engines) for everything that trades; backtest, paper and live run the same code. Optional offline Python research sidecar via parquet/ONNX/strategy-spec files with a TS parity test (G3). No LangGraph/CrewAI/LangSmith.
- **Repo layout:** `client/` (Vite+React UI) + `server/` (Node: `apps/`, `pipeline/`, `providers/`, `shared/`, `tools/`) + `contracts/` (the wire model both import and neither owns). No root `src/`. Neither runtime imports the other; both import `contracts/`.
- **Status:** the code in the tree is the frozen **v1** runtime (six-stage debate pipeline, ~7,200 tests across 350 files, `npm run smoke` green). The v2 composition root is doc 67 Step 3; v1 is torn down in Step 5 after v2 runs end to end. The v1 paper soak is stopped in Step 3 (Q10); its database is archived at `~/samurai-archive/v1-final/samurai-paper.sqlite`. v1's 21 ADRs and 20 specs are at tag `v1-final`, not in the tree.

## Code Comments

David has 15 years of professional experience — code does not need narration. This tightens the global comment rule (`~/.claude/CLAUDE.md`) for this repo specifically: bias toward zero comments, not "fewer."

- Never write a comment that explains what a file, function, or block does. The code already says that; a comment repeating it is noise to re-read on every future pass.
- Comment only when skipping it would lose information the code cannot express on its own: a non-obvious invariant a future edit could silently break, a workaround tied to a specific external bug or constraint, a cited source for a magic number, or a decision that looks wrong without the reason behind it.
- If removing a comment loses nothing a future editor needs, delete it — including comments already in the codebase, not just ones about to be added.
- Precedent: 2026-09-17, David stripped 62 lines of narration comments from `.github/workflows/ci.yml` (commit `effde735`) that had accumulated across prior sessions — every step had a "why this exists" paragraph, most of them restating what the step name already said.

## Lint Tooling Rule

All existing oxlint, biome, crap and fallow rules stay intact and bind v2 from its first commit (doc 66 Tooling row, Q18a). "crap" is the CRAP score gate (complexity × coverage), ticket [#1649](https://github.com/dd-jp/samurai-trading-system/issues/1649) (G15): threshold **7** as a ratchet (doc 66, 2026-09-25): `npm run crap` runs full coverage, then `server/tools/crap-gate.ts` fails on any `server/` or `contracts/` function the branch adds or touches (diff against the merge-base with `origin/main`, uncommitted and untracked files included) with CRAP above 7, on any such complexity finding it cannot attribute to a covered function, and on a run that scores nothing. `server/apps/v2/` and `contracts/` are gated in full (`--strict`). Every other function the diff does not touch is reported against 7, and still fails above #1776's repo-wide 15. fallow, not knip, for dead code. Never loosen a rule to get a PR green; fix the code or record the finding.

## Definition of Done (every step, doc 67 §5)

A step's PR ships its own unit tests, e2e tests where it touches a runtime path, passes oxlint + biome + fallow + the CRAP gate, and runs mutation testing on any risk, sizing or loss-budget code it adds. There is no separate testing phase; Step 4b is the cross-cutting pre-paper checklist on top of this, not a substitute. Local green is the bar while GitHub Actions billing is off — say so in the PR. Before reporting done or opening a PR, run the session eval in `docs/research/68-fable-handoff.md`. Fable-mode discipline throughout: read the spec fully, plan by risk, verify before reporting done, re-read the diff as a hostile reviewer before committing.

## Docs Convention

| File | Purpose |
| ------ | --------- |
| `CONTEXT.md` (repo root) | North Star first, then the v2 glossary: terms, relationships, invariants. No implementation detail. |
| `docs/adr/` | One ADR, `0001-samurai-v2.md`. Amend it when David rules; do not add ADRs unless a decision is hard to reverse, surprising without context and a real trade-off. Never scanned by the citation checker. |
| `docs/specs/` | v2 specs only, written in the step that needs them: `debate-sleeve-spec.md`, `loss-budget-spec.md`, and the Step 3c UI spec (G13). `debate-sleeve-spec.md` landed with Step 3; the rest are written in their own steps. |
| `docs/research/` | `NN-slug.md`, numbered, banded by track; navigation starts at `docs/research/README.md`. v2 docs are 61 onward; 69 = facts (Session R), 70 = momentum backtest (Session B), 71 = debate audit (Session C). Archive is `docs/research/archive/`, never deleted. |
| `docs/reviews/` | Audit reports, dated; start at `docs/reviews/README.md`. Immutable record. |
| `docs/wayfinder/` | Historical only. Maps are GitHub issues. |
| `docs/techstack.md`, `docs/coding-standards.md`, `docs/cgt-disposal-matching.md` | Living registers: stack, standards, CGT share matching. |

When in doubt, grep existing docs before writing new ones. Backticked paths in tracked `.md`/`.ts`/`.tsx` files must resolve (`npm run check:citations`); mark a deliberate dead path `<!-- cite-exempt: foreign|historical|planned|untracked — why -->` on the same line.

## Process (Q18 — lighter than v1)

1. One wayfinder map issue, [Samurai v2 #1706](https://github.com/dd-jp/samurai-trading-system/issues/1706), carries the rulings as closed decisions; each unruled item has a child ticket. New decisions are grilled one question at a time with David, recorded as a comment on the ticket, in doc 66 and in the ADR.
2. Tickets per build step (doc 67 §5), each with its kill line. Claim by assignment; never `Closes #n` / `closed #n` in a PR body or commit — use `Refs #n`.
3. Specs only for the debate sleeve, the loss-budget machinery and the UI, written in the step that builds them.
4. Every step: `what => verify / kill line`. Stop at any kill line or ambiguity and ask David; never decide what is his (the ADR's open list says what that is).
5. Local gates green (lint, typecheck, test, smoke, fallow, citations) before the PR. Merge only under doc 66's merge-authority ruling: a general-purpose subagent review using `code-review-graph`, its comments fixed, and local green on the full tests, mutation testing, the CRAP gate, fallow and the doc 68 session eval. A docs-only PR merges after the review, its comments fixed, citations and the session eval. Otherwise open the PR and leave the merge to David.
6. Chat replies to David in caveman-ultra style; normal prose in docs and commits. Never commit secrets (`data/saxo-tokens/` <!-- cite-exempt: untracked — gitignored local file -->, `.env*`).

## Key Constraints

- Every mandatory protective action is venue-resting or watchdog-backed, never tick-dependent (postmortem §3).
- Every windowed data read carries a tested coverage invariant (postmortem §2).
- Persistent state (SQLite); crash-restart must not lose open positions; reconcile against the broker every run.
- Idempotent order IDs, partial-fill handling, rate-limit resilient.
- API keys: trade-only, **withdrawals disabled**, IP-restricted where offered; no account data or key leaves in any LLM request.
- Per-disposal GBP tax log with the FX rate used and share matching; both accounts are taxable (Saxo GIA, Alpaca); W-8BEN.
- Every decision, fill and LLM call journalled; any past day replays to the same decisions.
- Paper profit is not evidence of edge; paper gates on fidelity to the backtest. Every comparison is risk-adjusted against the sleeve's matched benchmark, never return-only.
- LLM spend cap ~$30/month across providers; a breach stops LLM calls, never exits.
- Model versions pinned; a swap is a new trial.

## Rate Limit Rule — HARD STOP

If Claude Code returns a rate-limit / usage-exceeded error:

- **DO NOT** attempt to write implementation code yourself
- **DO NOT** fall back to writing code in Hermes session
- Stop and report to user: "Claude rate limited, waiting for reset"
- Resume when user says go, OR follow cron-retry cadence if configured

This rule is NON-NEGOTIABLE. Never fill the gap with your own code.

**`autoContinueAtUsageLimit` is on** (`~/.claude/settings.json`, set 2026-09-05). A live session now waits out the reset and continues the same task by itself, so "resume when user says go" is satisfied automatically for the in-flight case — the session picks up its own context, it does not hand work to another model, and the two DO-NOTs above still bind. Auto-continue holds only while the CLI keeps running: if Claude Code exits, relaunches, or the session moves to the cloud or Claude Desktop, resumption is manual again (`claude --resume`, or a scheduled wakeup).

## When in doubt

1. Read `CONTEXT.md` (North Star, then the glossary)
2. Read doc 66 for the ruling, then the ADR for whether it is still open
3. Grep the codebase for prior art; remember the tree is v1 code until Step 3 lands
4. If genuinely ambiguous and blocking — stop with a clear reason and ask David, never guess

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
