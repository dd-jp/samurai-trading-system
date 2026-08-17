# Issue triage against the code — 2026-08-17

Every open issue re-judged on one question the earlier runs deliberately did not answer: **is the defect still there in the tree today?** [`issue-triage-2026-08-16.md`](issue-triage-2026-08-16.md) states its own limit plainly — *"verdicts rest on ticket bodies plus targeted code checks, not a full re-read of every cited file."* This run reads the file. Every `IMPLEMENTED` and `PREMISE-FALSE` verdict below carries a `file:line` or a verbatim quote; a verdict without one was downgraded to `RELEVANT / unverified` rather than guessed.

**Coverage.** 42 issues — the 41 open at `92bc113`, plus [#814](https://github.com/dd-jp/samurai-trading-system/issues/814), which was open when this run started at `31e20be` and closed mid-run. No issue was opened between those two listings, so the current open set is fully covered. 18 of the 42 post-date the 2026-08-16 file and had never been triaged. Prior findings are referenced, not re-filed.

**Nothing was closed by this run.** The verdicts are recommendations; the triggers are David's.

## The headline

**41 of 42 issues describe a defect that is still in the tree.** One shipped. That is not a healthy number — it means the backlog is real work, not accumulated staleness, and the earlier runs' re-scopes were correctly conservative.

But **four issue bodies are false in a way that would mislead whoever picks them up**, and every one of them was written by an earlier pass of this same project. That is the recurring cost, and it is worth stating as a rule rather than as four corrections.

| Verdict | Count | Issues |
| --- | --- | --- |
| `RELEVANT` — defect verified present | 37 | all others |
| `PREMISE-FALSE` — body misstates the defect | 4 | [#504](https://github.com/dd-jp/samurai-trading-system/issues/504), [#514](https://github.com/dd-jp/samurai-trading-system/issues/514), [#645](https://github.com/dd-jp/samurai-trading-system/issues/645), [#809](https://github.com/dd-jp/samurai-trading-system/issues/809) |
| `IMPLEMENTED` | 1 | [#814](https://github.com/dd-jp/samurai-trading-system/issues/814) |
| `SUPERSEDED` | 0 | — |

By what verification even means — the split matters, because "verify against code" is not a coherent instruction for half of them:

| Bucket | Count | What a verdict rests on |
| --- | --- | --- |
| code | 19 | grep the named symbol, read the line |
| human-gated | 15 | can only be *still blocked* or *superseded* — never "already implemented" |
| research | 5 | does the research premise still hold |
| doc | 3 | read the doc, quote it |

**15 of 42 cannot be worked by an agent at all.** Seven of those need a decision from David; the rest need an account action, a credential, or elapsed wall-clock time. That is a third of the backlog, and it is the actual constraint on the live ramp — not code readiness. This confirms the 2026-08-16 run's judgement on [#665](https://github.com/dd-jp/samurai-trading-system/issues/665)/[#666](https://github.com/dd-jp/samurai-trading-system/issues/666) and widens it.

---

## The four false premises

Not "stale" — **false**. Each would send an implementer at the wrong thing.

### [#504](https://github.com/dd-jp/samurai-trading-system/issues/504) — the justification is false, the work is real

The body's load-bearing claim is that *"the `news` bucket … still has no writer."* It has one: `mi-ingest-agent.ts:78` writes `type: 'news'`, constructed in the production composition root at `production.ts:962` and `:1245`. The Polymarket work itself is genuinely unbuilt — `grep -rni polymarket server/` returns zero — so **keep the ticket and replace the body.** The real justification is the LSE-ETP coverage hole `market-intelligence-spec.md:69` measured: *"Alpaca News returns 0 items for 3USL/3LDE/SGLN and 5 each for AAPL/SPY/BTCUSD."* Scope item 5's crypto batch is dead per ADR-0015's amendment.

This one matters because the false claim is *more* alarming than the truth. An implementer reading "no writer" builds a writer that already exists — this repo's dominant bug class, arrived at through the front door.

### [#514](https://github.com/dd-jp/samurai-trading-system/issues/514) — three rows of its inherited-decisions table are false

| The body says | The tree says |
| --- | --- |
| *"Universe? Already widened to `DEFAULT_UNIVERSE` (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) … #238's first acceptance criterion is **already met**"* | `scheduler.ts:36-41` — SPY/QQQ/AAPL/TSLA only. No crypto. AC1 is **void**, not met |
| *"15-minute uniform REST tick … 296 passes/day ≈ \$42"* | `paper-profile.ts:1703` — `tickIntervalMs: 2 * 60_000` |
| *"#289 … H8 limb (batch `getMarks`) has separately already landed"* | `portfolio-view.ts:172` — `await marketData.getMark(instrument, asOf)`, per instrument. No `getMarks` on `MarketDataService` at all |

Its framing is also dead: *"live-capable code is the critical path"* is false when the binding constraints are [#665](https://github.com/dd-jp/samurai-trading-system/issues/665) (a questionnaire), [#666](https://github.com/dd-jp/samurai-trading-system/issues/666) (a measurement needing that credential), [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) (no LSE mark source) and [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) (a decision). **Rewrite or close — but its ordered post-soak tail is tracked nowhere else**, so a bare close loses six pointers.

### [#645](https://github.com/dd-jp/samurai-trading-system/issues/645) — the count in the title is wrong and the residual is a different job

Title: *"~180 dead `src/` path citations across 44 docs."* Measured today: **~100 backticked `src/…` hits — 95 by one pass, 111 counting every backticked occurrence under `docs/` — and every live one is legitimate.** The count is roughly half the title's, and the two measurements are recorded rather than reconciled because the exact number is not what the verdict turns on: the *population* changed, not just its size. `cost-model-backtest-spec.md:217,348` cite *pybroker's* `src/eval.py` — another repo. `dashboard-spec.md:438,457` are historical statements about a removed `src/cli/`. The rest sit in `docs/adr/`, `docs/wayfinder/`, `docs/research/archive/` and `docs/reviews/`, all preserved by rule — the 2026-08-16 run already established that rewriting an ADR would falsify the record.

And the remaining work is misdescribed. The issue says *extend the link checker*. **There is no link checker.** No `*link*` file exists; `package.json` scripts are dev/build/test; CI runs lint/typecheck/build/test plus a Python fixture-provenance step; `.github/scripts/` holds only the AI-review lib. The residual is *build a backticked-path checker* — a different, larger ticket than the one filed.

### [#809](https://github.com/dd-jp/samurai-trading-system/issues/809) — unactionable as filed, but it points at a real gap

The body concedes it: *"There is nothing actionable without the test name."* AC2 has no period attached, so there is no closing condition either — it can never be satisfied or refuted. But the *reason* the name was lost is verified and fixable: `vitest.config.ts:22` declares `include`, `environment`, `globals`, `globalSetup`, `coverage` — **and no `reporters`**, so no run leaves a durable per-test record. **Rescope to the reporter change plus an expiry date on the flake record.**

---

## The rule these four share

An issue body is a **measurement with a timestamp**, and this project keeps reading them as standing descriptions. All four were written by earlier passes of this same triage-and-spec process, and each was true when written. The memory entry `wayfinder-bodies-go-stale` already names this. What this run adds is the sharper form:

> **A body that asserts a code fact goes stale silently, and its staleness is invisible from the title.** Not one of these four is detectable without opening the file it cites. The titles of #504 and #514 read fine.

The cheapest available fix is not more triage — it is to stop putting code facts in bodies without a commit SHA beside them. A claim written as *"`news` has no writer (verified at `77fa3ed`)"* is self-invalidating; the same claim without the SHA is indistinguishable from a claim about today.

---

## Corrections to live tickets found on the way

These are true issues whose *scope lines* are wrong. Cheaper to fix now than to have an implementer discover them.

| # | The correction |
| --- | --- |
| [#797](https://github.com/dd-jp/samurai-trading-system/issues/797) | Its stated gate #749 is **closed** (`38982bd` landed the pool as data only). The real gate is [#751](https://github.com/dd-jp/samurai-trading-system/issues/751) |
| [#807](https://github.com/dd-jp/samurai-trading-system/issues/807) | *"Blocked by: sequence into #751"* is wrong — the fix is one comparison plus one test and depends on nothing #751 does. It is startable now |
| [#751](https://github.com/dd-jp/samurai-trading-system/issues/751) | *"crypto clause suspended"* in the title is superseded. `universe-selector-spec.md:291`: *"~~crypto is always present~~ — **this assertion is deleted, not inverted**"* |
| [#685](https://github.com/dd-jp/samurai-trading-system/issues/685) | Names the wrong file. `18-fetch-earnings.py` classifies nothing — its own header says *"The study does NOT use this."* The look-ahead is `18-threshold-study.py:85` |
| [#720](https://github.com/dd-jp/samurai-trading-system/issues/720) | Its hard-filter table has a **"no US single stocks"** row, contradicted by the checked-in pool: 5 of 7 distinct `screening_instrument` values are US single stocks (`lse-etp-pool.ts:59`) |
| [#756](https://github.com/dd-jp/samurai-trading-system/issues/756) | Its −18% basis (0.240 → 0.197) was measured on the pre-#789 analyst; `technical-analyst.ts:307` now caps at `LOW_CONVICTION_CAP = 0.4` |
| [#637](https://github.com/dd-jp/samurai-trading-system/issues/637) | Citation path `src/cost-model-backtest/overfitting.ts` predates the split. The live copy is `server/tools/backtest/overfitting.ts:50` — and there is a **second, uncoupled copy** at `docs/research/18-entry-time-brackets.py:61,313` |
| [#238](https://github.com/dd-jp/samurai-trading-system/issues/238) | Still specifies the pre-pivot crypto product, and conflates ADR-0017 Gate 1 with a graduation claim |
| [#289](https://github.com/dd-jp/samurai-trading-system/issues/289) | Six items, three fates: four fully open (H8, H11, M10, M7/M9), one partly landed (M12's binary search, `trade-derivation.ts:111`), one dead (H10 — ccxt serves crypto) |

**Label defects that break the agent flow**, worth fixing in one pass: [#791](https://github.com/dd-jp/samurai-trading-system/issues/791) is labelled `documentation` but is code, and carries no `size:`/`model:` label, so no implementation sweep will pick it up. [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) is labelled `implementation` but is a source *decision*. [#665](https://github.com/dd-jp/samurai-trading-system/issues/665) carries `model:sonnet` on work no agent can do. [#688](https://github.com/dd-jp/samurai-trading-system/issues/688) carries `ready-for-agent` but is gated on elapsed collection time.

---

## What is startable today

Nothing here needs David, a credential, or elapsed time. Ordered by what unblocks the most.

1. **[#813](https://github.com/dd-jp/samurai-trading-system/issues/813) — expand the LSE ETP pool to ≥25 screening instruments.** The pool is **11 rows, 7 distinct underlyings** (`lse-etp-pool.ts`, pinned at `lse-etp-pool.test.ts:151`). The declared quintile ranking is undefined at N=7 — top-1 versus bottom-1. `universe-selector-spec.md:229`: *"If the pool lands under ~25 rows, ship without the ranking and trade the whole pool."* This one file blocks [#707](https://github.com/dd-jp/samurai-trading-system/issues/707), [#750](https://github.com/dd-jp/samurai-trading-system/issues/750) and [#751](https://github.com/dd-jp/samurai-trading-system/issues/751), and it is the only route that does not re-register a trial-count-1 study.
2. **[#807](https://github.com/dd-jp/samurai-trading-system/issues/807)** — one comparison, one test. `lse-etp-pool.ts:542` promises *"both instrument-identity fields are non-empty and distinct"*; `:547-551` checks emptiness only.
3. **[#757](https://github.com/dd-jp/samurai-trading-system/issues/757)** — both ATR specs still sit on the warm-up floor (`production/defaults.ts:80-87`, `decide.ts:74`) while RSI already uses `recommendedWarmupFor` (`technical-analyst.ts:178`). Unblocked since #739 landed. **Prior framing overstated the impact**: the live consumers are the setup vector and realized-R labelling, not the volatility halt, whose baseline `paper-profile.ts` documents as *"deliberately high enough to be **inert**."*
4. **[#773](https://github.com/dd-jp/samurai-trading-system/issues/773)** — PRs #532/#546/#560/#566 all merged 2026-08-07 and `docs/reviews/` contains no report covering them. The gap #567 left is still fully open.
5. **[#811](https://github.com/dd-jp/samurai-trading-system/issues/811)**, **[#793](https://github.com/dd-jp/samurai-trading-system/issues/793)**, **[#791](https://github.com/dd-jp/samurai-trading-system/issues/791)**, **[#637](https://github.com/dd-jp/samurai-trading-system/issues/637)**'s surfacing half — each verified unbuilt, each self-contained.

---

## The seven issues awaiting David, and why they are the real frontier

Restated as questions, because that is the form they need to be answered in:

| # | The question |
| --- | --- |
| [#800](https://github.com/dd-jp/samurai-trading-system/issues/800) / [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) | How much capital does the equity leg take, and does the ~41.8% single-stock envelope get re-sized, accepted, or does the stop re-open? |
| [#683](https://github.com/dd-jp/samurai-trading-system/issues/683) | Should a mediator-manufactured tie be allowed to authorise a trade? |
| [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) | Which spec owns computing and emitting the falsifier control arm? |
| [#513](https://github.com/dd-jp/samurai-trading-system/issues/513) | Risk Critic step 7: build the producer, or delete the step? |
| [#655](https://github.com/dd-jp/samurai-trading-system/issues/655) | Does catalyst gating reopen, and if not, where does ADR-0016's 0.312%/trade bar live? |
| [#589](https://github.com/dd-jp/samurai-trading-system/issues/589) | Dashboard topology and auth |

Three findings on these worth more than the row:

- **#800 is verified at 2×, and both halves are latent rather than firing.** `paper-profile.ts:426` scales by `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5`; `subclass-bracket.ts:100`'s `D5_INDEX_ETP_DEPLOYMENT_FRACTION = 0.35` is unscaled. It does not bite *yet* only because `resolveSubclassBracket` returns `null` and `d5EnvelopeFor` returns `undefined` off the same empty `subclass_of` — and `lse-etp-pool.ts` **is imported by nothing but its own test.** Wiring the pool is what arms this. That makes #813 and #800 the same event, which nothing currently records.
- **#683 passes the composition-root check** — the check this repo's dominant bug class demands. `conviction-score.ts:152` `values.push(directionValue(debateVerdict))` reaches production at `debate-adapter.ts:262`, and the value it produces is the exact `debate.confidence` the Trader gates on at `decide.ts:392`. This is live, not theoretical.
- **#513's deciding question is now unencumbered.** #642 resolved the spec contradiction the other way, so nothing else has to move first. `risk-manager/index.ts:267` branches on `critic === undefined`; `direct-bind.ts:685-689` says it outright — *"has NO PRODUCER anywhere in the tree"* — and only a `dist/risk-manager/critic-store.d.ts` exists with no `.ts` behind it.

**[#631](https://github.com/dd-jp/samurai-trading-system/issues/631) correctly stays open.** Its own question is answered ("neither", ADR-0014) but Standing Pipeline Rule 1 closes a map on a clear frontier, and four children are open — #636, #655, #665, #666 — three of which need David personally.

---

## Method, and what this run does not claim

Seven parallel agents, one per subject area, each required to return a fixed schema and a citation. Verdicts without a `file:line` or verbatim quote were downgraded rather than accepted. The three issues shaped like this repo's dominant bug class — [#797](https://github.com/dd-jp/samurai-trading-system/issues/797), [#790](https://github.com/dd-jp/samurai-trading-system/issues/790), [#753](https://github.com/dd-jp/samurai-trading-system/issues/753) — were checked at the composition root, not at the definition site. No code-bucket issue returned `IMPLEMENTED`, so the "exists and is tested but nothing calls it" correction never had occasion to fire — it discriminates only against an `IMPLEMENTED` verdict. The reachability check ran affirmatively on [#683](https://github.com/dd-jp/samurai-trading-system/issues/683), where the chain `conviction-score.ts:152` → `debate-adapter.ts:262` → `decide.ts:392` was traced to confirm the hole is live rather than dead code.

Three caveats, stated rather than buried:

1. **`origin/main` advanced mid-run**, from `31e20be` to `92bc113` (PR #817, 19:15Z). Only `docs/adr/0018-*.md` changed, so no code verdict is affected — but one agent's note that ADR-0018 *"still declares the tranche ladder"* was true of the stale local tree and is **false of `92bc113`**, which now reads *"WITHDRAWN 2026-08-17."* That is this document's own instance of the staleness it is about.
2. Verdicts rest on the cited lines and their immediate context, not on a full read of every file. The claim is *"this specific defect is present at `92bc113`"* — not *"this file is otherwise correct."*
3. **Nothing was closed, relabelled, or commented on.** Whether #504 and #645 get retitled or closed, and whether #514 is rewritten or retired, are calls this run deliberately leaves open.
