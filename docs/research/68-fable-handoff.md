# Samurai v2 — handoff to Fable (2026-09-19)

Paste-ready prompts for Fable (`claude-fable-5-1`), one session per prompt, each with its effort
level. Authority for every session: `docs/research/66-v2-grill-decisions.md` (David's rulings)
and `docs/research/67-v2-plan-and-handoff.md` (plan; §5a is the loose-ends register with stable
IDs G1–G15 and R1–R16, each naming the one step it blocks). All on `main`.

**Before anything:** David fixes GitHub Actions billing — CI refuses to start any job until then,
so no PR can show CI green.

## Order

```
W (tickets)
 ├─ G (grill: Step-0 rulings first — G2, G3, G6, G8, G9, G14, G15; then G10)
 ├─ R (research, all R items)                       ← parallel with G
 └─ C (debate audit — nothing blocks it)            ← parallel with G
X (cross-verification) — after the Step-0 rulings are recorded
A (Step 0 doc rewrite) → T (board triage)
B (Step 1 backtest) — after G9, G10, R12–R15
D (Step 3) + U (Step 3c UI) — after A, B verdict, C verdict and Step-3 blockers
E (Step 4 protection) → Q (Step 4b assurance) → P (paper soak reviews) → live sign-off
F (Step 5 teardown) — after D runs end to end
L (research loop) — after G11
```

Every session: reply to David in caveman-ultra style, normal prose in docs and commits; open PRs,
never merge (merges are David's); never write "Closes #n" or "closed #n"; stop at any kill line
or ambiguity and ask David. Each step's PR meets doc 67 §5's definition of done (own tests, e2e
where runtime paths change, oxlint + biome + fallow + CRAP gate, mutation testing on risk code).

Doc numbers pre-assigned to avoid parallel collisions: **69 = Session R, 70 = Session B,
71 = Session C.** Anything else takes the next free number on `origin/main`.

---

## Session W — wayfinder map + tickets · effort **high** · run first

```
You are working on Samurai (GitHub repo dd-jp/samurai-trading-system, project board #1).
Read docs/research/66-v2-grill-decisions.md, docs/research/67-v2-plan-and-handoff.md (§5 and
§5a) and docs/research/68-fable-handoff.md.

Create the v2 wayfinder map as GitHub issues. First check for an existing open "Samurai v2" map
(avoid duplicates).
1. Map issue "Samurai v2", label `wayfinder-map`. Body: the North Star (CONTEXT.md), "Decisions
   so far" = doc 66's Q1–Q19 one line each, "Frontier" = the child tickets.
2. Child tickets — exactly one per row of doc 67 §5a, using its ID in the title
   ("G4 — Debate universe", "R12 — UK tax on funds"):
   - G1–G15 → label `wayfinder:grilling`. Body: question, options, the recommendation from the
     §5a table, and "Blocks: <step>".
   - R1–R3, R5–R16 → label `wayfinder:research`. Body: the exact questions, sources to use
     (primary: HMRC manuals, broker docs/terms, vendor/provider terms, academic papers for R5),
     done = each question marked verified / refuted / unknown with a URL, and "Blocks: <step>".
   - `wayfinder:task` tickets: "X — cross-verification of docs 65–68 + CONTEXT.md"; one per
     build step in doc 67 §5 (Step 0, 1, 2, 3, 3c, 4, 4b, 5, 6) with its verify/kill line;
     "L — research loop".
3. Link every child to the map as a sub-issue:
   gh api repos/dd-jp/samurai-trading-system/issues/<map>/sub_issues -X POST -F sub_issue_id=<child DATABASE id>
4. Wire blocking edges from doc 67 §5a "Summary of what blocks what" with the dependencies API
   (the body takes the blocker's numeric DATABASE id, not its issue number):
   id=$(gh api repos/dd-jp/samurai-trading-system/issues/<blocker> --jq .id)
   gh api repos/dd-jp/samurai-trading-system/issues/<blocked>/dependencies/blocked_by -X POST -F issue_id=$id
   Also: X is blocked by G2, G3, G6, G8, G9, G14, G15; Step 0 is blocked by X; Steps follow doc 67.
5. Add every issue to project #1 (`gh project item-add 1 --owner dd-jp --url <issue url>`), set
   Status = Todo. When listing the board always pass --limit 1000.
6. Verify: every §5a ID has exactly one ticket; re-read each blocked issue's blocked_by list.

Report the map URL and a table (ID → issue number → blocks). Do not start working any ticket.
```

## Session G — grill David on the rulings · effort **high**

Run repeatedly until every G ticket is closed; Step-0 rulings first.

```
You are working on Samurai. Read docs/research/66-v2-grill-decisions.md and
docs/research/67-v2-plan-and-handoff.md §5a. List the open `wayfinder:grilling` tickets on the
"Samurai v2" map.

Grill David ONE question at a time, in this order: G2, G3, G6, G8, G9, G14, G15, then G10, then
the rest in ID order. For each: state the question in two lines, the options, and the §5a
recommendation marked "(Recommended)". Wait for his answer; treat it as final.

After each answer: comment the ruling on the ticket; append a one-line pointer to the map's
"Decisions so far"; append the ruling to doc 66 (new row, same ID) and, where it overrides an
earlier ruling, mark that clause superseded (e.g. G8 supersedes Q11's "never deleted"); close the
ticket. Commit the doc 66 edits on one branch and open one PR at the end of the session.
```

## Session R — facts research · effort **high**

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md §5a table "R —
research". List the open `wayfinder:research` tickets on the "Samurai v2" map and claim each by
assignment before working it.

Answer every question in R1–R3 and R5–R16 from primary sources: HMRC manuals (R1, R12), broker
docs and terms (R2, R11, R13, R16), data-vendor terms (R7, R14), LLM provider terms and
OpenRouter docs (R10), exchange/venue docs (R9, R15), academic papers free of look-ahead (R5).
Record findings with URLs and access dates in docs/research/69-v2-facts.md. Mark each question
verified / refuted / unknown. Where the answer needs a decision (R1 may need an accountant; R2
may force whole-share-only US positions) say so plainly and propose the decision.

Comment each ticket's findings and close it when every question is marked. No code. One PR.
```

## Session C — Step 2: debate audit · effort **xhigh**

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md (Step 2 and §3) and
docs/research/66-v2-grill-decisions.md (Q4, Q8, Q9, Q16).

Offline, no LLM calls: replay debate_log from the paper DB read-only via the literal URI
sqlite3 "file:/Users/ddjp/Documents/projects/samurai-trading-system/data/samurai-paper.sqlite?mode=ro".
Find why bullish conviction caps at 0.473 against the 0.55 floor (`conviction_floor` in
server/pipeline/trader/types.ts). Data: 267 debates, 209 neutral, 42 bearish (mean 0.67), 16
bullish. History: #625 (ceiling 0.5478, rounds moved conviction by zero), #683 (mediator
tie-break). Trace the conviction formula and show, with replayed numbers, whether the cap is a
formula defect or genuine.

Also: explain doc 65's scoreboard defects (control-arm oversizing; arm_comparison_samples
−18.8% vs closed_trades +£799 disagree in sign) and propose arm 2's entry rule for a daily swing
horizon. State the caveat that v1 debates ran on hourly bars over a different book, so a
"long setups are weak" verdict may not transfer to daily swing.

Write docs/research/71-debate-audit.md. If a defect: fix it with tests on a new branch,
re-replay, show bullish can clear the floor. If not a defect: report and STOP — David decides
short-only vs veto-only. One PR.
```

## Session X — cross-verification · effort **high**

Run after the Step-0 rulings (G2, G3, G6, G8, G9, G14, G15) are recorded in doc 66.

```
You are an adversarial reviewer of Samurai's v2 plan. Read docs/research/65 through 68,
CONTEXT.md (North Star) and docs/samurai-postmortem.md. Find: contradictions between docs;
rulings stated differently in two places; numbers that disagree (PBO bar, loss budget, capital
formula, band, paper window); anything still implying intraday or a daily % target; claims
about code that the repo does not support (check each cited path/symbol); session prompts in
doc 68 a model with no chat history could misread. Run
`npx tsx server/tools/check-path-citations.ts` (must report 0 violations).

Fix doc-only issues in one PR. List anything needing David's ruling and STOP. Close the
X ticket when there are zero contradictions and 0 violations.
```

## Session A — Step 0: doc rewrite · effort **high**

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md (Step 0, §5a, §6),
docs/research/66-v2-grill-decisions.md (including rulings G2, G3, G6, G8, G9, G14, G15),
docs/research/65-next-steps-plan.md, docs/samurai-postmortem.md, docs/samurai-vision-v2.md.

Do Step 0 of doc 67 exactly, on a new branch off fresh origin/main, as ONE PR: tag v1-final;
archive the paper DB with sqlite3 .backup to the G14 location; delete docs/specs/* and
docs/adr/* per G8; write docs/adr/0001-samurai-v2.md from doc 66 (record every still-open §5a
item as "open — ticket #n"); rewrite CONTEXT.md (keep its "North Star" section verbatim as the
first section, dropping only its "until the v2 rewrite" sentence, and updating any figure a
G ruling changed); rewrite CLAUDE.md (Project Identity opens with a pointer to the North Star;
keep verbatim the Code Comments, Rate Limit HARD STOP and graphify sections; add the lint rule
and the definition of done); handle spec-schema-drift.test.ts per G14; fix or cite-exempt every
backticked docs/adr|specs citation (Step 0 item 7 lists them); renames per item 8; graphify
update. Do NOT edit applied SQL migrations or the path-citations test fixtures.

Verify: `npx tsx server/tools/check-path-citations.ts` = 0 violations; lint + typecheck + test +
`npm run smoke` green locally.
```

## Session T — GitHub board triage · effort **high**

Run after Session A merges. Snapshot 2026-09-19: 819 items, 50 open (Todo 43, In Progress 3,
In Review 4).

```
You are working on Samurai. Read docs/research/66-v2-grill-decisions.md,
docs/research/67-v2-plan-and-handoff.md and the Session T section of
docs/research/68-fable-handoff.md.

Triage every open item on project #1 (Todo, In Progress, In Review) against v2. List with
`gh project item-list 1 --owner dd-jp --limit 1000 --format json`. Read each issue's BODY and
comments, not just the title. For each pick one:
  close-obsolete — v1-only (intraday/flatten, 3x ETPs, D5 £350/£250, T212, v1 soak/arms);
                   comment the doc 66 ruling that obsoletes it, then close.
  fold           — still needed; comment the v2 step (doc 67 Step N) it belongs to; retitle if
                   its v1 framing is wrong.
  keep           — tooling/quality David wants (lint, CRAP, fallow, telemetry).
  defer          — touches code the Step 5 teardown may delete.
  park           — MI/sentiment inputs not in v2 yet; label parked.
Before closing ANY issue: grep server/ client/ contracts/ for "#<n>" and its URL — code cites
some issues as live gates. If cited, do not close. Run `npm run check:live-gates` before and
after. In Progress / In Review items with an open PR: report, don't close.

First produce the full classification table and STOP for David's approval; apply only after.
```

Starting buckets (from titles; verify each against its body):

| Bucket | Issues |
|---|---|
| close-obsolete | #1119, #1149, #1412, #1413, #1498, #1554, #1603, #1604, #1657 |
| fold/defer — code-cited, do NOT close | #238, #751, #895 (LSE mark source; the Saxo simulated adapter needs bid/ask), #900, #1054 — #895/#900 are in `LIVE_MONEY_GATES` and a test asserts they stay open |
| fold | #756 → Step 2; #750, #1515 → Step 1; #1400, #1302, #1215, #1426, #1581, #1438, #1444 → Steps 3/4; #1521 → tax log; #1516 → Step 4b drift monitor; #1387 → R9 |
| keep | #1648, #1649 (CRAP gate, G15), #1677, #1082, #1427, #1675 |
| defer | #1652, #1654, #1656, #1658, #1659, #1660, #1661, #1662, #1663, #1665 |
| park | #688, #689, #1042, #1085, #928, #1685, #1686 |

## Session B — Step 1: momentum backtest · effort **xhigh**

Run after G9, G10 and R12–R15 are resolved.

```
You are working on Samurai. Read docs/research/67-v2-plan-and-handoff.md (Step 1, §5a),
docs/research/66-v2-grill-decisions.md (Q2, Q7, Q8, Q14, Q15, Q19, G9, G10),
docs/research/69-v2-facts.md (R12–R15), doc 64 (replication prior) and doc 11 (earlier trend
measurement).

FIRST propose, in docs/research/70-momentum-backtest.md, and STOP for David's approval:
strategy family (time-series trend vs cross-sectional); the exact ETF list (not
lse-etp-pool.ts — that is the 3x pool) filtered by R12 reporting-fund status and R13 access;
the point-in-time S&P 500 dataset (URL); the delisted-name haircut; LSE survivorship handling;
DSR on excess vs absolute returns; execution timing from R15; the full parameter grid; and
confirmation the strategy is written as the module live code will import.

After approval: build it in TypeScript, reuse server/tools/backtest/overfitting.ts (DSR, PBO);
use the G9 PBO bar (server/tools/backtest/stage2-verdict.ts hard-codes 0.05 — change it only
if G9 says so). Count every trial from #1. Run each configuration with and without the resting
stop (R4). Include the loss-budget rules per G10. Costs: Saxo 0.08%/side no minimum; Alpaca
spread-only (measure it). Walk-forward, 10y+ where data allows. Benchmark: risk-matched
buy-and-hold of the same universe.
Kill line: fails unless it beats the benchmark after a 40% Sharpe haircut with DSR >= 0.95 and
PBO <= the G9 bar. Report pass/fail with numbers and the max drawdown. No LLM calls, no paid
data. One PR.
```

## Session D — Step 3: v2 composition root · effort **high**

```
Read docs/research/67-v2-plan-and-handoff.md Step 3 and §5a, doc 66, docs 69–71. Build Step 3
exactly: slim v2 root; reuse broker adapters, providers, stores, debate core behind a real module
interface; Saxo simulated paper adapter at the live tariff; Alpaca paper; Anthropic + OpenRouter
clients with pinned versions; separate paper book per sleeve; wire only sleeves that survived B
and C; stop the v1 paper soak. Verify with a dry run that submits no orders. One PR per area.
```

## Session U — Step 3c: UI · effort **high**

```
Read docs/research/67-v2-plan-and-handoff.md Step 3c and ruling G13 in doc 66. Write the v2 UI
spec, STOP for David's approval, then build the screens alongside Session D. Component tests per
screen; e2e for halt and sign-off. Keep the dashboard's existing lint/test rules.
```

## Session E — Step 4: protection · effort **high**

```
Read docs/research/67-v2-plan-and-handoff.md Step 4, rulings Q6, Q13, G6, G12 in doc 66, and
docs/research/69-v2-facts.md (R2, R16). Build broker-resting stops, the loss-budget machinery,
the daily cap, dead-man's switch, Saxo token refresh, per-disposal GBP tax log (share matching
per R12), and the LLM trace. Verify with fault injection (kill the process mid-position → stop
still rests at the broker; budget breach → entries halt).
```

## Session Q — Step 4b: assurance · effort **high**

```
Read docs/research/67-v2-plan-and-handoff.md Step 4b. Build every row as an automated test or a
recorded drill with its pass condition. One PR per area. Paper trading may not start until every
row passes; report the checklist with evidence per row.
```

## Session F — Step 5: v1 teardown · effort **high**

```
Read docs/research/67-v2-plan-and-handoff.md Step 5 and doc 66 Q11. Run fallow + graphify
reachability from the v2 root, produce the deletion list and STOP for David's review. Then
delete in per-area waves (one PR each), rename surviving v1-named modules, and do the client
pass so the UI reads no deleted server field. Run `npm run check:live-gates` before deleting
anything that references an issue.
```

## Session P — Step 6: paper soak review · effort **high** · weekly

```
Read docs/research/67-v2-plan-and-handoff.md Step 6 and the Q7/Q19/G-rulings in doc 66. Review
the week's paper data: band position, realised vs modelled cost, order-level fidelity, the
plumbing-fault ledger, loss budget. Report to David. When the go-live conditions are met,
produce the one-page sign-off summary (change, haircut backtest, paper fidelity, worst case vs
£1,500) and STOP.
```

## Session L — research loop · effort **xhigh**

Only after G11 (research-loop design) is ruled and a trade journal exists.

## David's own to-dos (Fable cannot do these)

- Fix GitHub Actions billing (now).
- Answer the G rulings when Session G asks.
- Open the live Alpaca account, apply for margin (debate-sleeve shorts), W-8BEN, one GBP→USD transfer — before live.
- Accountant input if R1 says so.
