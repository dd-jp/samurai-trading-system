# Samurai v2 — handoff to Fable (2026-09-19)

Paste-ready prompts for Fable (`claude-fable-5-1`), one session per step. Run Session A first;
Sessions B and C can run in parallel after it (or before it — they are £0 research and touch no
docs Step 0 rewrites). Sessions D+ come later and are listed for completeness.

**Before starting:** fix GitHub Actions billing — CI currently refuses to start any job ("recent
account payments have failed or your spending limit needs to be increased"), so no step's
"CI green" check can pass until it's fixed.

Authority for every session: `docs/research/66-v2-grill-decisions.md` (rulings Q1–Q19) and
`docs/research/67-v2-plan-and-handoff.md` (plan, traps). Both on `main`.

---

## Session A — Step 0: doc rewrite · effort **high**

```
You are working on Samurai (repo: samurai-trading-system). Read, in order:
docs/research/67-v2-plan-and-handoff.md, docs/research/66-v2-grill-decisions.md,
docs/research/65-next-steps-plan.md, then docs/samurai-postmortem.md and
docs/samurai-vision-v2.md from the MAIN checkout (they are untracked there).

Do Step 0 of doc 67 exactly, on a new branch off fresh origin/main, as ONE PR:
tag v1-final; archive the paper DB; delete all docs/specs/* and docs/adr/*; write
docs/adr/0001-samurai-v2.md from doc 66; rewrite CONTEXT.md and CLAUDE.md (keep verbatim the
Code Comments, Rate Limit HARD STOP and graphify sections; add the lint rule: oxlint, biome,
crap, fallow rules intact); fix every reference to deleted docs; rename files for readability
per Step 0 item 8; graphify update.

Traps (doc 67 §6 and Step 0 item 7): do NOT edit applied SQL migrations; do NOT "fix" the
path-citations test fixtures; spec-schema-drift.test.ts reads the store spec you are deleting.

STOP and ask David before: committing his untracked docs (61-64, postmortem, vision); choosing
the paper-DB archive location; deciding what replaces spec-schema-drift.test.ts. Do not merge —
open the PR and report. Verify locally: lint + typecheck + test + npm run smoke green.
Reply to David in caveman-ultra style; normal prose in docs and commits.
```

## Session B — Step 1: momentum backtest · effort **xhigh**

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md (Step 1) and
docs/research/66-v2-grill-decisions.md (Q2, Q7, Q8, Q14, Q15, Q19). Also doc 64 (replication
prior) and doc 11 (earlier trend measurement) for context.

Build and run the momentum-sleeve backtest in TypeScript, reusing
server/tools/backtest/overfitting.ts for DSR/PBO. Long/flat only. Universe: LSE 1x ETFs/ETCs
(Yahoo .L + Stooq) and US large caps with point-in-time S&P 500 membership (Q15), plus an
explicit haircut for missing delisted names. Costs: Saxo 0.08%/side no minimum; Alpaca
spread-only (measure it). 10y+ daily, walk-forward.

Pre-declare the parameter grid in a committed file BEFORE running anything; count every trial
from #1. Benchmark: risk-matched buy-and-hold of the same universe.
Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and
PBO <= 0.10. Report pass/fail with the numbers; do not tune after seeing results without
counting the trial. Report the backtest max drawdown (feeds capital = 1500 / (DD x 1.5)).

No LLM calls, no paid data. Work on a new branch; open a PR, do not merge.
STOP and ask David if a ruling in doc 66 is ambiguous. Caveman-ultra replies to David.
```

## Session C — Step 2: D1 debate audit · effort **xhigh**

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md (Step 2 and §3) and
docs/research/66-v2-grill-decisions.md (Q4, Q8, Q9, Q16).

Offline, no LLM calls: replay debate_log from the paper DB, read-only, via the literal URI
sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro".
Find why bullish conviction caps at 0.473 against the 0.55 entry floor (267 debates: 209
neutral, 42 bearish mean 0.67, 16 bullish). History: #625 (ceiling 0.5478, rounds moved
conviction by zero), #683 (mediator tie-break). Trace the conviction formula in the debate
core and show, with the replayed numbers, whether the cap is a formula defect or genuine.

If a defect: fix it on a new branch with tests, re-replay, show bullish can clear the floor;
open a PR, do not merge. If not a defect: report the evidence and STOP — David decides
short-only vs veto-only for the debate sleeve. Caveman-ultra replies to David.
```

## Later sessions (not ready yet)

| Session | Step | Effort | Blocked on |
|---|---|---|---|
| D | 3 — v2 composition root, Saxo simulated paper adapter, Alpaca paper, surviving sleeves only | high | A merged; B/C verdicts |
| E | 4 — resting stops, loss budget, daily cap, dead-man's switch, token refresh, tax log, LLM trace | high | D |
| F | 5 — v1 teardown via fallow + graphify, renames | high | D running end-to-end |
| — | 6 — 8–12 week paper soak, then sign-off | — | real time + David |

Each later session starts: *"Read docs/research/67-v2-plan-and-handoff.md and 66; do Step N;
stop at any kill line or open question and ask David."*

## David's own to-dos (Fable cannot do these)

- Fix GitHub Actions billing.
- Rule on the Python research sidecar (doc 66 "Still open").
- Open the live Alpaca account, apply for margin (debate-sleeve shorts), W-8BEN, one GBP→USD transfer.
- Decide on committing docs 61–64, the postmortem and vision-v2.
