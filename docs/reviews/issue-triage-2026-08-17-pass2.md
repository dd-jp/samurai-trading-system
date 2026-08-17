# Issue triage, pass 2 — 2026-08-17

A second pass on the same day as [`issue-triage-2026-08-17.md`](issue-triage-2026-08-17.md), asked for as *"triage open issues for staleness and contradictions against the spec in main."* It does not repeat that run. It adds the two axes that run could not or did not cover, and it corrects one claim it made.

**Coverage, stated per axis rather than as one number.**

| Axis | Coverage | Why |
| --- | --- | --- |
| Code — is the defect in the tree? | **6 newly verified** ([#821](https://github.com/dd-jp/samurai-trading-system/issues/821)–[#826](https://github.com/dd-jp/samurai-trading-system/issues/826)); **40 inherited unchanged** | `HEAD` is `12aa739` — *the prior report's own commit*. Only `76b5f4a` and `12aa739` (both docs-only) landed after its verification window. Re-running the code axis on the other 40 would return byte-identical verdicts against a byte-identical tree, so it was not re-run |
| Spec — does the body contradict `docs/specs/` and the ADRs? | **all 46 screened, 21 read** | The prior run judged issues against *code*; spec contradictions surfaced only incidentally there ([#751](https://github.com/dd-jp/samurai-trading-system/issues/751)'s title, [#720](https://github.com/dd-jp/samurai-trading-system/issues/720)'s hard-filter row). All 46 bodies were screened against seven known scope reversals — crypto, the intraday horizon, tranche/ladder, ADR-0016's expectancy sign, `src/` paths, the capital split, and docs 10/12. **21 matched and were read; the 25 that matched nothing were not read line by line**, so a contradiction outside those seven patterns would not have been caught |

**Correction to the prior report.** It states: *"No issue was opened between those two listings, so the current open set is fully covered."* Six issues were opened after its verification SHA `92bc113` — #821 at 19:49Z and #822–#826 in a 47-second burst at 19:53–19:54Z, against a report committed at 20:57Z. The claim was false by the time it was written. Its own subject was artifacts that assert a fact and go stale silently; this is one.

**Nothing was closed, commented on, relabelled, or edited by this run.** Recommendations only.

---

## 1. The headline: six specs still carry crypto as a live requirement, against a rule the spec corpus itself states

The instruction was to triage issues *against the spec*. Doing that surfaced the opposite of what was expected — the spec side is the weaker artifact.

**The rule already exists, and it is not vague.** `cross-spec-contracts.md:347`, finding CV-25, states it as the operative one: *"**no spec, gate, measurement or ticket may assume a crypto path exists.**"* It also names why the code is not the problem — *"`AssetClass`, `AlwaysOpenCalendar`, `sessionCalendars`, crypto config keys and `SMOKE_TEST_UNIVERSE`'s BTC-USD entry all remain. ADR-0014's amendment deliberately does **not** decide their removal"* — the same posture `scheduler.ts:10` takes: *"`AssetClass` keeps its `'crypto'` member and `UniverseInstrument` still accepts crypto rows."*

That distinction is what makes a raw count of `crypto` mentions worthless. Every mention falls into one of three buckets and **only the first violates CV-25**:

| Bucket | Status | Where |
| --- | --- | --- |
| **(a) a live requirement, story or decision** | **violates CV-25** | six specs, below |
| **(b) a type or schema retaining the `'crypto'` member** | correct, matches the code by design | `shared-sqlite-store-spec.md`'s seven `CHECK(asset_class IN ('crypto','stocks'))` constraints; the `asset_class` unions in `execution-spec.md:171,213`, `dashboard-spec.md:299`, `cost-model-backtest-spec.md:115` |
| **(c) a record of a past measurement or a preserved input** | correct, preserved by rule | `stage2-validation-execution-spec.md`'s Stage 2 run; `cost-model-backtest-spec.md`'s fee/latency parameters, which ADR-0015's amendment explicitly keeps as *"an input the future crypto system inherits, not withdrawn as wrong"* |

**The six in bucket (a):**

| Spec | The live crypto requirement |
| --- | --- |
| `debate-engine-spec.md` | `:268` — *"**Crypto**: 30s hard cap, **1-round cap** (`MAX_ROUNDS_BY_ASSET_CLASS.crypto = 1`)"*, with `:281` carrying a full cost-coupling argument built on *"crypto is ~80% of ticks (24/7)"*. Crypto is 0% of ticks since `5ff65d5` |
| `market-data-service-spec.md` | `:157` — *"**Crypto:** ccxt WebSocket (Kraken first; Coinbase Advanced swappable by config) maintains the latest mark … 24/7"*; story 12 at `:53` requires that source hidden behind `DataSource` |
| `market-intelligence-spec.md` | `:103` asset-class cadence and retention; story 19 at `:144` — *"latency budgets (5s crypto, 30s stocks)"* |
| `execution-spec.md` | `:122` — *"four implementations — Alpaca …, **ccxt** (Kraken/Coinbase crypto), IBKR …"* |
| `transport-layer-spec.md` | stories 6, 21 and 26 — crypto path-root routing (`/v1beta3/crypto/us/…`), `BTC-USD` → `X:BTCUSD` translation, and a `VolatilityReading` of `{crypto, stocks}` with tests specced for each (`:198`, `:202`) |
| `verdict-spec.md` | story 5 at `:41` and the rationale at `:131` — per-asset-class signal age *"because the classes genuinely differ: crypto prints continuously"*; `:237` still lists *"batched approvals for rapid-fire crypto signals"* |

Two more are marginal and named for completeness rather than counted: `dashboard-spec.md:165` requires an *"asset-class glyph distinguishing crypto from stocks"*, and `devils-advocate-spec.md:386` cites the *"crypto-15s / stocks-60s"* budget — one line, and stale twice over, since #581 replaced 15s with 30s/1-round.

**Amended correctly, for contrast:** `analysts-spec.md`, `orchestrator-spec.md`, `risk-manager-spec.md`, `trader-spec.md`, `universe-selector-spec.md` (clauses struck in place, `:63,93,300`), and `cross-spec-contracts.md` itself via CV-25.

`market-intelligence-spec.md` took a substantive amendment **today** ([#782](https://github.com/dd-jp/samurai-trading-system/issues/782)'s debate-bar floor, at `:139`) and its crypto lines were not touched in the same pass. This is not a backlog nobody has opened — it is a rule nobody has enforced. CV-25 says *"enforced at review"*, and six specs are the evidence that review does not reach them.

**The consequence for triage is direct: "verify the issue against the spec" returns the wrong answer for crypto-mentioning issues in these six areas.** Those issues are *spec-consistent and ADR-inconsistent* — [#683](https://github.com/dd-jp/samurai-trading-system/issues/683) (§4.2) is the clean example, faithful to `debate-engine-spec.md:268` and about a desk that no longer runs. Anyone resolving the conflict in the spec's favour re-introduces scope David dropped.

**Nothing tracks it.** CV-25 states the rule but names no ticket, and the five amended specs were swept under other work. **Recommend one ticket: apply ADR-0015's amendment to the six, striking rather than deleting**, per the convention `universe-selector-spec.md:63,93,300` already set — and explicitly leaving buckets (b) and (c) alone, since CV-25's own text says the code question stays open.

---

## 2. The #818 cluster: five open issues describe code that is not in main

[#822](https://github.com/dd-jp/samurai-trading-system/issues/822), [#823](https://github.com/dd-jp/samurai-trading-system/issues/823), [#824](https://github.com/dd-jp/samurai-trading-system/issues/824), [#825](https://github.com/dd-jp/samurai-trading-system/issues/825) and [#826](https://github.com/dd-jp/samurai-trading-system/issues/826) cite `resolveFallbackPacing`, `buildFailoverDataSource` and `FailoverDataSource`. **None of those symbols exists in `main`.** They live only on `origin/issue-562-live-ohlcv-failover` — PR **[#818](https://github.com/dd-jp/samurai-trading-system/pull/818)**, which implements [#562](https://github.com/dd-jp/samurai-trading-system/issues/562) and is **still a draft**.

This is a new verdict class the prior report had no occasion to use:

> **`BRANCH-ONLY`** — the defect is real, verified, and located in an unmerged branch. It cannot be verified against `main`, and it evaporates or moves if the PR is revised before merge.

Verified on the branch, one by one:

| # | Verdict | Evidence |
| --- | --- | --- |
| [#822](https://github.com/dd-jp/samurai-trading-system/issues/822) | `BRANCH-ONLY` — confirmed | `data-failover.ts:119` `resolveFallbackPacing(logger, env = process.env)`, called at `:235` as `resolveFallbackPacing(deps.logger)` — the default binds `process.env` inside the wiring, not a `ProductionConfig` field |
| [#825](https://github.com/dd-jp/samurai-trading-system/issues/825) | `BRANCH-ONLY` — confirmed, **same line as #822** | `:235` runs unconditionally; `pacing` is consumed only inside the lazy default fetcher at `:237-243`, which an injected `equitiesFallbackBarFetcher` skips entirely |
| [#823](https://github.com/dd-jp/samurai-trading-system/issues/823) | `BRANCH-ONLY` — confirmed | all six `buildFailoverDataSource` cases in `data-failover.test.ts` (`:101,127,144,170,200,231`) pass `equitiesFallbackBarFetcher`. The `PolygonBarsClient` default branch is executed by no test |
| [#824](https://github.com/dd-jp/samurai-trading-system/issues/824) | `BRANCH-ONLY` — confirmed | `FailoverDataSource.fetchBars` (`failover-data-source.ts:101`) wraps `withOhlcvFailover` and nothing else. No breaker, no open-circuit state, no fallback-first path after N failures |
| [#826](https://github.com/dd-jp/samurai-trading-system/issues/826) | `BRANCH-ONLY` — confirmed as behaviour, but **filed as a bug against a documented decision** | `failover-data-source.ts:118` — *"Primary only — see the module doc: **a mark must not come from a delayed fallback feed**"*; `:126-131` for quotes — *"No fallback here either: **no fallback vendor quotes bid/ask**"* |

**Three things follow that no single ticket says:**

1. **#822 and #825 are one edit**, not two — move the pacing resolution inside the lazy branch and source it from config. Filed 25 seconds apart off the same review, they read as independent.
2. **#826 is a decision-reversal ticket, not a defect ticket.** Its observation is correct — an Alpaca outage still stops the tick at the mark read — but the code states a reason for that, so the ticket has to beat the reason, not report the behaviour. And the obvious fallback cannot serve it: **Polygon does not quote the LSE**, which is [#734](https://github.com/dd-jp/samurai-trading-system/issues/734)'s hole, unaffected by this PR.
3. **[#791](https://github.com/dd-jp/samurai-trading-system/issues/791) is half-overtaken by #818, in a way that will get its live half built twice.** The branch adds `dataFailoverAlerts` to `AlertChannelSlots` (`alert-transport.ts:226`) — that is #791's AC1 on the live path. But #791's own evidence quotes `backfill-market-data.ts:307`, and on the branch that alerter is **still `console.error`** (`:313-318`), documented as deliberate. AC2 (quarantining `source: 'polygon'` rows) is untouched. **Re-scope #791 after #818 merges to: the backfill path plus the quarantine.**

Also worth recording against #562 itself: two of its acceptance criteria — *"Alpaca vs Coinbase crypto stamping and volume conventions are compared and recorded"* and adding Bitstamp as a third crypto writer — are **dead scope** under ADR-0015, are not implemented by #818, and would leave #562 permanently unable to be checked off as written.

---

## 3. CI cannot run at all, which caps everything the prior report called "startable"

PR #818's three checks — `checks`, `e2e`, `review-harness` — all fail in **2 seconds with an empty `steps` array** (run `32063380272`, and the four runs before it, 19:29–19:59Z). No job body executes, so this is not a code failure.

**Stated at the certainty it was verified.** This matches the `actions-billing-blocks-all-ci` signature exactly — seconds-long duration, zero steps, every job in every run — but the check-run annotation that would say so in words was **not** recovered: `gh api …/check-runs/95489583374` returns `output: null`, and `gh run view --json jobs` returns the same empty `steps`. The inference is strong and the alternative explanations (a workflow-syntax error, a missing runner label) would normally leave an annotation. Confirm it at <https://github.com/organizations/dd-jp/settings/billing> before spending time on the workflow files.

The prior report's "what is startable today" list is still correct about the *work*. It is wrong about the *throughput*: nothing can be merged behind green CI while billing is blocked. Anything landed now is landed on local `yarn test` alone. **This is a prerequisite to the whole backlog and has no issue.**

---

## 4. Issue bodies that contradict the spec or a landed decision

Five findings. All are body-level, none is visible from the title.

### 4.1 [#751](https://github.com/dd-jp/samurai-trading-system/issues/751) — the body prescribes the framing the spec explicitly rejected

The body instructs: *"Reverse the always-present-crypto clause explicitly, and **record it as suspended rather than deleted** … Amend the test to assert the **suspension**, with the unpark gate named."*

`universe-selector-spec.md:291` names and refuses exactly that: *"~~crypto is always present~~ — **this assertion is deleted, not inverted**. **An earlier draft of this change would have amended it to assert a *suspension*; that framing is superseded** by ADR-0014's amendment, under which there is no crypto pair to assert anything about."*

The prior report caught this in the **title**. The body is the part that misleads: an implementer following it writes a suspension test the spec forbids, plus an "unpark gate" for an unpark that is not coming. The spec's replacement assertion is stated and should be the ticket's: *the active list has exactly two sources — watchlist and held — and a provider emitting anything else fails.*

### 4.2 [#683](https://github.com/dd-jp/samurai-trading-system/issues/683) — the worked example runs on a desk that no longer exists

The body's arithmetic rests on: *"the desk size is not hypothetical: crypto debates run 2 analysts, equity 3 … **the two-analyst crypto desk is the one that clears outright**."*

Crypto was suspended from the production tick loop by [#738](https://github.com/dd-jp/samurai-trading-system/issues/738) (`5ff65d5`). The defect itself is still live — the prior report traced `conviction-score.ts:152` → `debate-adapter.ts:262` → `decide.ts:392` at the composition root — but **the case that made it vivid is dead**, and the ticket does not show the equity three-analyst arithmetic. Since this is one of the seven awaiting David's decision, it needs to be re-derived at the desk that actually runs before the decision is asked for; a decision taken on the two-analyst number is a decision about nothing.

Note the ticket is faithful to `debate-engine-spec.md:268`, which still declares that desk. That is §1's point in miniature.

### 4.3 [#238](https://github.com/dd-jp/samurai-trading-system/issues/238) — the soak's definition of done is unsatisfiable

*"Orchestrator runs unattended for 14 consecutive days against real Alpaca paper **+ a crypto venue**"*, and *"widening … to the full ADR-0001 default universe (SPY/QQQ/AAPL/TSLA/BTC-USD/ETH-USD) is an **explicit part of starting this run**."*

`scheduler.ts:4` — *"**2026-08-17 (#738) — crypto is out of Samurai's scope**"*. The prior report flagged #238 as still specifying the pre-pivot product; the sharper statement is that **its acceptance criteria can never be met**, so the 14-day soak — the last gate before live — currently has no achievable done-bar. This is the highest-consequence stale body in the set.

### 4.4 [#562](https://github.com/dd-jp/samurai-trading-system/issues/562), [#655](https://github.com/dd-jp/samurai-trading-system/issues/655), [#664](https://github.com/dd-jp/samurai-trading-system/issues/664) — dead crypto branches inside live tickets

Each is a genuinely live ticket carrying a dead limb: #562's crypto reconciliation ACs (§2 above); #655's catalyst table rows for halvings, token unlocks and ETF decisions, plus its *"crypto has neither"* branch; #664's replay requirement *"no boundary at all for crypto"*. None invalidates its ticket. All three shrink once §1's sweep runs, which is the cheapest way to fix them — the specs they mirror are the source.

### 4.5 [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) — verified, and its root cause is §1

*"`market-data-service-spec.md` specs three `DataSource` implementations — ccxt/Kraken, IBKR, and Alpaca. **None of them serves the LSE.**"* Confirmed verbatim at `:53`, `:157-159`. The ticket is exactly right, and the reason the spec offers no LSE source is that it has not been re-read since the venue became a Trading 212 ISA on LSE-listed ETPs.

---

## 5. The briefing files name a rejected exit rule again

`CLAUDE.md:99` — *"The primary control is the recorded thesis's falsifier arm 2 (same name, **same ladder**, same stop …)"*.
`CONTEXT.md:59` — *"the same name selection, **the same profit ladder**, the same stop"*.

ADR-0018 `:102`, as amended today by [#814](https://github.com/dd-jp/samurai-trading-system/issues/814): *"**There is no tranche ladder on the trading path, and there is no deferred one.**"* The live rule is one frozen bracket per subclass.

`CONTEXT.md` contradicts itself on this — `:53` already records the ladder as *"measured and **rejected** (#708)"*, four lines above `:59` still requiring the control arm to replicate it.

Blast radius is why this is its own section rather than a table row. [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) — which owns *which spec computes the falsifier control arm*, and is one of the seven questions awaiting David — quotes the `CLAUDE.md` line verbatim as its corrected requirement. [#793](https://github.com/dd-jp/samurai-trading-system/issues/793) leans on *"same ladder, same stop"* to argue exit-mix comparability. [#753](https://github.com/dd-jp/samurai-trading-system/issues/753) already corrected itself on 2026-08-17 — *"'profit ladder' named a rule that no longer exists"* — so the tickets are ahead of the briefing files, not behind them.

**One word, three places: `ladder` → `bracket`.** These are the two files every session reads first, and this is the same class as the `briefing-files-go-stale` fix landed at `ad48ff9` — re-opened by a decision that landed one commit later.

---

## 6. Doc 52, which postdates every verdict in the prior report

[`52-exit-geometry-and-subclass-odds.md`](../research/52-exit-geometry-and-subclass-odds.md) landed at `76b5f4a`, after the prior run's verification window. Checked against the issues that assert bracket, ATR or subclass facts — #757, #750, #756, #798, #800:

- **No contradiction found.** Doc 52 selects nothing and re-prices the declared rule.
- It does **further downgrade [#757](https://github.com/dd-jp/samurai-trading-system/issues/757)'s stakes**, in the same direction the prior report already moved them. §7.2: frozen versus width-matched ATR differs by a median ~0.15 pp against ~1.2 pp standard errors, 5 of 7 names inside the noise — *"Read the 5/7 as a coin, not as a direction."* #757 is a **real correctness defect on the money path** (both ATR specs sit on the warm-up floor) and should still be fixed; what it is not is an expectancy lever.
- It **independently supports [#813](https://github.com/dd-jp/samurai-trading-system/issues/813) as the top priority**, from a direction the prior report did not use. §8: *"Where the differences actually live is **the instrument, not the geometry**"* — MSTR at 7.16 pp against PLTR at 1.29 pp. A 7-underlying pool is where the variance is, and widening it is the only lever measured to matter.

---

## 7. Recommendations, in dependency order

1. **Check the Actions billing state, and unblock it if that is the cause.** Nothing merges behind green CI until this clears (§3) — a one-minute check that gates every other item here. No issue exists.
2. **Sweep ADR-0015's amendment through the six specs that still carry crypto as a live requirement** (§1), leaving the type unions and the preserved measurements alone. One ticket, striking not deleting. It also fixes #562's, #655's and #664's dead limbs at the source, and it is the reason #683's ticket reads as correct while being about a dead desk.
3. **Re-scope [#238](https://github.com/dd-jp/samurai-trading-system/issues/238)** so the soak has an achievable done-bar (§4.3). It is the last gate before live and currently cannot be passed.
4. **`ladder` → `bracket` in `CLAUDE.md:99` and `CONTEXT.md:59`** (§5), before #636 is decided on the stale wording.
5. **Merge [#822](https://github.com/dd-jp/samurai-trading-system/issues/822) into [#825](https://github.com/dd-jp/samurai-trading-system/issues/825)** as one edit, and hold all five #818 follow-ups until that PR merges (§2) — they are branch-only and will move if it is revised.
6. **Re-scope [#791](https://github.com/dd-jp/samurai-trading-system/issues/791) to the backfill alerter plus the polygon-row quarantine** once #818 lands, or its live half gets built twice (§2).
7. **Fix [#751](https://github.com/dd-jp/samurai-trading-system/issues/751)'s body** to the spec's own replacement assertion (§4.1), and **restate [#683](https://github.com/dd-jp/samurai-trading-system/issues/683)'s arithmetic at three analysts** before asking David to decide it (§4.2).

The prior report's startable list is otherwise unchanged, with [#813](https://github.com/dd-jp/samurai-trading-system/issues/813) still first — now with doc 52 behind it as well as the quintile argument.

---

## 8. Method, and what this run does not claim

Single-session, no subagents. Every verdict here carries a `file:line` or a verbatim quote. §1's sweep ran mechanically over all 17 specs and **every one of the 17 was then read**, hit by hit, to sort each mention into requirement / type / record — because a raw count of 12 specs "mentioning crypto" is the number a keyword scan gives, and it is wrong: half those mentions are the `asset_class` union the code deliberately keeps. The six named are the ones carrying a **requirement**. The two marginal ones are named rather than counted, so a reader can disagree with the boundary without re-running the sweep.

Three caveats:

1. **The 40 inherited code verdicts were not re-derived.** They rest on the prior report against a tree identical to this one. If that report was wrong about an issue, this one is wrong the same way.
2. **The #818 branch was read at its current tip.** A draft PR is a moving target; §2's five verdicts have a shorter shelf life than anything else here, which is the point of the `BRANCH-ONLY` label.
3. **Nothing was mutated.** No issue was closed, edited, relabelled or commented on, and no spec was swept — §1's recommendation is a ticket to open, not work done.
