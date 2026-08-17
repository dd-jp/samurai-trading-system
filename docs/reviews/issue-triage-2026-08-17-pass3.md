# Issue triage, pass 3 — duplicates and overlap — 2026-08-17

A third pass on the same day, asked for as *"triage open issues for duplicates."* It runs one axis neither [`issue-triage-2026-08-17.md`](issue-triage-2026-08-17.md) (code) nor [`issue-triage-2026-08-17-pass2.md`](issue-triage-2026-08-17-pass2.md) (spec) ran: **which open issues are the same work, and which merely collide.** Relations those two already asserted are credited to them and not re-filed as new; this report adds what they did not state.

**Verified at `765b65b`.** Main advanced three commits past pass 2's `12aa739`, and one of them changes a verdict that report made — see §0.

**Coverage.** All 46 open issues listed; **all 46 bodies read**, each truncated at 1,400 characters. That is the whole body for 31 of them and the opening section for 15. A duplicate asserted only in the tail of a long body — #238, #514, #631, #636, #664, #683, #707, #750, #751, #773, #791, #793, #797, #813, #828 are the truncated ones — would not have been caught. Pairs were then verified against the tree, not against each other's prose.

**Nothing was closed, commented on, relabelled or edited by this run.** Recommendations only, matching both prior passes.

---

## 0. Correction to pass 2: PR #818 merged, so `BRANCH-ONLY` no longer holds

Pass 2's §2 rests on *"**None of those symbols exists in `main`.** They live only on `origin/issue-562-live-ohlcv-failover` — PR #818, which is **still a draft**."*

**PR #818 merged at `b4a8a27`**, two commits before pass 2's own report commit landed. Re-verified at `765b65b`:

| Symbol | pass 2 (branch) | now (`main`) |
| --- | --- | --- |
| `resolveFallbackPacing(logger, env = process.env)` | `data-failover.ts:119` | `data-failover.ts:119` — identical |
| the unconditional call | `:235` | `:235` — identical |
| the `equitiesFallbackBarFetcher ??` default | `:237-243` | `:238` — identical |
| backfill's `console.error` alerter | `:313-318`, unchanged by the PR | `backfill-market-data.ts:314` — still `console.error` |

So **#822, #823, #824, #825 and #826 are now ordinary `RELEVANT` issues against `main`**, not branch-only, and pass 2's advice to *"hold all five until that PR merges"* is discharged — they are startable today. Its §2.3 recommendation to **re-scope [#791](https://github.com/dd-jp/samurai-trading-system/issues/791) to the backfill alerter plus the polygon-row quarantine** was conditioned on *"once #818 lands"*; that condition is met, and the `console.error` at `:314` confirms the backfill half was indeed left behind.

This is pass 2's own subject — an artifact asserting a fact and going stale — landing on pass 2 within the hour. It is not a criticism of that report; it is the argument for the SHA-stamping rule pass 1 proposed, applied to reports as well as to issue bodies.

---

## 1. The categories, and why the distinction is the whole point

"Duplicate" is four different relations with four different actions. Sorted deliberately, because collapsing them destroys information — this repo's dominant failure mode is *one defect class recurring across N sites*, and calling those N sites "duplicates" would erase exactly the pattern that makes them worth tracking.

| Category | Count | Action |
| --- | --- | --- |
| **A. True duplicate** — same defect, same site | **0** | — |
| **B. Dissolves-on-resolution** — one issue's answer may remove the other entirely | 1 pair | Sequence, do not merge |
| **C. Competing scope** — two open issues answer the same question differently | **0** (2 claimed, both falsified on verification — §3) | — |
| **D. Overlapping fix surface** — same lines, different defects; will conflict if worked in parallel | 4 clusters | Batch into one PR, or order them |
| **E. Subsumption / merge candidate** — one's scope is contained in another's | 3 pairs | Fold and close one |
| **F. Same class, separate sites** | 4 groups | Cross-link, keep both open |
| **G. Duplicated effort** — different tickets, same work done twice | 1 | Scope one out |

**No two open issues are true duplicates.** That is worth stating plainly: 46 issues, no redundant pair. The titles in this backlog are unusually specific and the filing discipline is working. What the backlog *does* have is **thirteen** pairs that will waste work if they are picked up independently, and the rest of this report is those.

*Originally fifteen. A verification pass over the full bodies falsified both Category C pairs (§3) — in each case the filer had declared the disposition in the part of the body this report's 1,400-character read cut off. Everything else was re-verified and stands; the record is §11.*

---

## 2. Category B — the one pair where a resolution may dissolve the other

### [#800](https://github.com/dd-jp/samurai-trading-system/issues/800) may close [#798](https://github.com/dd-jp/samurai-trading-system/issues/798) outright, and the reverse order re-sizes a fraction that was never the live one

Both tickets know about each other — #800's body already says *"both are D5 amendments and are cheaper to decide together"*, and pass 1 lists them as one row in the awaiting-David table. **Neither states the direction, and the direction is what matters.**

#800 is the question of what `portfolio.equity` denominates. Two readings, differing by exactly 2×:

- **Trader** (`decide.ts`): position lands on `0.35 × portfolio.equity`.
- **D5 gate** (`risk-manager/index.ts`, `perSubclassDeploymentCap`): allows `0.5 × 0.35 × portfolio.equity`, via `EQUITY_LEG_FRACTION_OF_CAPITAL = 0.5`.

#798 is the question of whether the declared brackets' drawdown envelope is tolerable. ADR-0018's #729 verification note states the arithmetic precisely:

> Re-measured at the declared brackets: … the single-stock envelope moves 26.2% → **41.8%** at 25% … **Holding the tolerance at the declared brackets needs f ≈ 0.332 (index) and f ≈ 0.142 (single-stock).**

Put the two together:

| Resolution of #800 | effective single-stock `f` | vs the `f ≈ 0.142` the tolerance needs |
| --- | --- | --- |
| Trader's reading wins — drop the `0.5` from the cap | **0.25** | 1.76× over — #798 is live, ~41.8% against a ~20–25% band |
| D5 gate's reading wins — scale the Trader by `0.5` too | **0.125** | **already inside it** — #798's overshoot does not exist |
| `EQUITY_LEG_FRACTION_OF_CAPITAL` itself is re-set to `1.0` | **0.25** | 1.76× over — #798 is live again *even under the D5 gate's reading* |

The index leg is the same story with more room: `0.5 × 0.35 = 0.175` against the `f ≈ 0.332` the tolerance needs, and `0.35` unscaled.

**The third row is not hypothetical.** #800's acceptance criterion 4 reads: *"The `EQUITY_LEG_FRACTION_OF_CAPITAL` question is resolved against ADR-0015 given crypto's removal from scope, rather than left as a constant nobody owns"* — and its body says crypto's departure "reopens what the equity leg should be a fraction of." CLAUDE.md is explicit that the equity leg's share of capital is **open and must not be settled by inference**. The `0.5` encodes a two-leg book that no longer exists; the natural post-crypto reading is that the equity leg takes the whole book, which restores `f = 0.25` regardless of which stage's denominator wins.

**So the safe statement is not "one answer dissolves #798" — it is that #798's envelope is a function of #800's resolution, and the published 41.8% assumes an unscaled 25% that no stage may end up using.** Deciding #798 first — re-sizing 25% down toward 14%, re-opening the frozen stop, or accepting a 41.8% envelope — would be deciding against a deployment fraction two of #800's three outcomes do not produce. Under the middle row a subsequent #800 resolution would halve any #798 result again to ~7%; under the third row #798 survives untouched.

**Recommend: #800 is answered first, and #798 is re-derived at the resolved denominator rather than at 25%.** Both are David's calls and both are ADR-0018 amendments, so this is a sequencing note inside one decision session, not a blocker. It does not weaken #800 — that issue is a genuine 2× contradiction between two stages and must be resolved regardless of which way it goes.

*Caveats stated. (a) The envelope is a max-drawdown of a fixed-fraction compounded equity curve, so it is monotone in `f` but not exactly linear. The `f ≈ 0.142` and `f ≈ 0.332` break-evens are ADR-0018's own published numbers, and 0.125 sits below 0.142 with margin — but the ~22% figure implied for `f = 0.125` is an interpolation, not a re-run of `18-drawdown-envelope.py`. (b) The middle row holds only while `EQUITY_LEG_FRACTION_OF_CAPITAL` stays at `0.5`, which #800 AC4 puts in play. Re-run the generator at the resolved fraction before closing #798 either way.*

---

## 3. Category C — WITHDRAWN. Both candidate pairs were falsified on verification

**This section originally asserted two competing-scope pairs. A verification pass over the full bodies falsified both.** Both were artifacts of this report's own 1,400-character truncation: in each case the disposition I said was missing is written in the part of the body that was cut. The category count in §1 is therefore **0, not 2**, and recommendations 5 and 8 are withdrawn. The mechanism is worth recording — a triage that reads the head of a body will systematically find "undeclared" the things a careful filer declared at the end.

### 3.1 WITHDRAWN — [#753](https://github.com/dd-jp/samurai-trading-system/issues/753) does *not* answer [#636](https://github.com/dd-jp/samurai-trading-system/issues/636), and says so explicitly

The claim was that #753's body prescribes the answer to #636's open half. It does not, and the error was mine in reading what #636's open half *is*.

- **#636's open half is spec ownership**, not design: *"Which spec owns computing the falsifier control arm's metrics and the risk-adjusted outside benchmarks, and where is the comparison emitted?"* It is a `cost-model-backtest-spec.md` vs `feedback-loop-spec.md` question, evidenced by `benchmark` appearing **0 times** in both.
- **#753 disclaims that question in terms:** *"This ticket makes the mandate real by **building** the control. It does **not** decide which spec owns declaring it — that is #636's question and David's to answer."*
- The passage I quoted (the axis vote thresholded, debate bypassed) answers *how the control is produced* — which #636 already treats as settled: *"The producer is nearly free… the open work is **ownership, wiring and emission**, not a new metric."*

So the two tickets are cleanly separated parent/child, not competing scope. **No action. #636 stays a live decision on David's frontier and cannot be discharged by pointing at #753.**

### 3.2 WITHDRAWN — [#707](https://github.com/dd-jp/samurai-trading-system/issues/707) already declares its disposition against [#750](https://github.com/dd-jp/samurai-trading-system/issues/750), in advance, for all three outcomes

The claim was that #707 could return positive and collide with #750's single-axis, zero-trials design with no rule for combining them. #707's "Outcomes, declared before the result" section pre-empts exactly this, and its reasoning is the same one I raised:

> **PARTIAL** … Admissible then as a **hard eligibility gate on the pool** … and **never** as a second ranked axis, and never as an entry rule.
> *"This restriction is load-bearing. C2 went to a single axis specifically so the screener contributes **zero trials** to the PBO accounting. A second ranked axis reintroduces a relative weight, weights are fitted parameters, and the zero-trial property is quietly gone."*

**FAIL** is likewise declared (*"build nothing. C2's single ranked axis stands alone"*), and a 2026-08-17 banner already reconciles the ticket with #750's replaced axis, including that a PARTIAL *"must say how the two gates compose rather than assume an empty slot."*

**Residual, stated narrowly and not as a collision:** the **PASS** branch routes to *"a 5-minute confirmation at the frozen bracket"* and is the one outcome that does not restate the never-a-second-ranked-axis bar. The bar is load-bearing by #707's own argument and applies a fortiori to PASS, so this is at most a one-line tidy, not the undeclared disposition §3.2 originally claimed. Filed here rather than as a recommendation.

---

## 4. Category D — same lines, different defects

These will conflict if two agents pick them up in parallel. Given the `parallel-pr-sweep-hazards` and `concurrent-ticket-duplication` history, this is the most operationally useful section here.

### 4.1 The #818 follow-up cluster — five issues, one file, now all in `main`

`server/apps/orchestrator/production/data-failover.ts` and the failover path it wires:

| # | Site | Defect |
| --- | --- | --- |
| [#822](https://github.com/dd-jp/samurai-trading-system/issues/822) | `:119`, `:235` | pacing sourced from `process.env`, not `ProductionConfig` |
| [#825](https://github.com/dd-jp/samurai-trading-system/issues/825) | `:235` | the same call runs when its result is unused |
| [#823](https://github.com/dd-jp/samurai-trading-system/issues/823) | `:238` default branch | the `PolygonBarsClient` branch is exercised by no test |
| [#824](https://github.com/dd-jp/samurai-trading-system/issues/824) | `failover-data-source.ts` | no circuit breaker under a sustained stall |
| [#828](https://github.com/dd-jp/samurai-trading-system/issues/828) | `venue-pacing.ts:269`, `normalizing-data-source.ts:39` | widen-and-retry amplifies fallback requests 4× against a 13s bucket |

**Pass 2 called #822 and #825 "one edit". Verified: they are one *line*, but the two tickets prescribe fixes that do not compose.**

- #822: *"resolved as `config.fallbackPacing ?? resolveFallbackPacing(logger)` at the composition root"* — keeps the call eager, moves its source.
- #825: *"resolve the pacing inside the default branch only … or gate the call on `deps.equitiesFallbackBarFetcher === undefined`"* — keeps the source, makes the call conditional.

Implementing #822 as written leaves #825's symptom fully intact: with a `??` default and no config field supplied, `resolveFallbackPacing` still runs on every boot and still warns about a malformed `SAMURAI_PACING_POLYGON_*` the run will never consult. **They are one edit only if written as one edit** — a config field *and* a conditional resolution — which is what a merged ticket should say and what neither says today. This sharpens pass 2's recommendation 5 rather than repeating it: merging them is not a bookkeeping tidy, it is the only way the second one gets fixed.

**#823 is the test for the branch #825 makes conditional.** Landing #825 first changes the construction site #823's test has to reach. Order: #822+#825 as one PR, then #823.

### 4.2 [#824](https://github.com/dd-jp/samurai-trading-system/issues/824) and [#828](https://github.com/dd-jp/samurai-trading-system/issues/828) — #828 is #824's second half, measured

**#828 appears in neither prior report** — it was opened at 20:07Z, after pass 2's verification window, and this is its first triage. That also means it is the one issue in this cluster with no code verdict from any pass; the symbols it cites are confirmed present (`venue-pacing.ts:269`, `normalizing-data-source.ts:39,403`) but its failure scenario is not independently re-derived here.

#824 states its own scope as two halves: *"an open-circuit state … **plus a re-derived Polygon pacing budget for the steady-state case. Both halves are needed: the breaker alone still leaves the bucket undersized.**"*

#828's entire subject is that second half, with the multiplier #824 does not have: *"Before #818 a failed-over bar read cost 1 Polygon request. Now it costs up to 4."* Both cite the same self-flagging comment in `venue-pacing.ts` about the margin needing re-derivation if the fallback goes steady-state, and both would edit `DEFAULT_POLYGON_PACING`.

**Recommend: fold #828 into #824 as its measured second half, or explicitly narrow #824 to the breaker alone and let #828 own the budget.** Either is fine; what does not work is both open with #824 claiming a half it has not measured and #828 measuring a half it does not own. Worked independently they produce two competing edits to one constant.

### 4.3 [#826](https://github.com/dd-jp/samurai-trading-system/issues/826) and [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) — one of #826's three options is entirely #734's job

#826 decides what the live system does when the mark source is unavailable, and offers three: hold, flatten, or *"acquire a second mark source that is good enough to price a position (Trading 212 / IBKR on the live equity leg, which is a different venue question again — see #641/#640 and the 'no LSE mark source' gap)."*

That third option **is** #734, whole. #734 is not "a second mark source for the LSE leg" — it is that there is *no first one*, so the leg cannot be marked at all today. Pass 2 approached this from the Polygon side (*"Polygon does not quote the LSE, which is #734's hole"*); the ticket-level statement is stronger: **#826's option 3 cannot be chosen without doing #734, and once #734 is done the LSE leg's mark question is answered by whatever #734 picks.**

**Recommend: scope #826 to the Alpaca-served leg** — hold versus flatten when the primary mark stalls — and cite #734 as owning the LSE side rather than listing it as an option. Otherwise the two tickets each hold a piece of "how does the live book get a price" and neither holds all of it.

### 4.4 [#683](https://github.com/dd-jp/samurai-trading-system/issues/683) and [#756](https://github.com/dd-jp/samurai-trading-system/issues/756) — same gate, same constant, opposite kinds of fix

Both are about `conviction_floor = 0.55`, and both land on `decide.ts`:

- **#683**: the comparison is `<`, so an exact tie at the floor is not skipped — it trades. Verified at `decide.ts:392`: `if (debate.confidence < config.conviction_floor) return skip('below_conviction_floor')`. (The body cites `:168`; pass 1 already located it at `:392`.)
- **#756**: the floor's *value* was fitted against the pre-#722 inflated RSI series and needs re-deriving against the converged one.

Neither ticket mentions the other. They are genuinely different defects — a boundary-inclusivity bug and a calibration bug — but they are the same constant read at the same line, and #756's re-derivation is the natural moment to also decide whether the comparison is `<` or `<=`. Worked apart, #683's fix is a one-character change that #756's PR will touch anyway.

**One thing neither ticket says:** `conviction_floor` is read twice. `decide.ts:509` — `convictionMultiplier(debate.confidence, config.conviction_floor)` — makes it a **sizing input**, not only a gate. So #756's re-derivation moves position size as well as the trade/skip boundary, which widens its blast radius beyond what its body claims and puts it adjacent to the D5 sizing questions in §2.

**Recommend: cross-link, and state the sizing consumer in #756.**

### 4.5 [#664](https://github.com/dd-jp/samurai-trading-system/issues/664) and [#289](https://github.com/dd-jp/samurai-trading-system/issues/289)'s H11 limb — both rewrite `replay-driver.ts`

#664 parameterises the replay timeframe end to end, naming `server/tools/backtest/replay-driver.ts:497` among four files. #289's H11 rewrites ATR computation inside the same file (its path `cost-model-backtest/replay-driver.ts` predates the `server/tools/backtest/` split — same file, confirmed present).

Low-stakes, and pass 1 already notes #289 should be scheduled after the soak while #664 blocks any intraday Stage 2 verdict. **Recommend: no merge; just do not run them concurrently**, and note in #289 that H11's window arithmetic changes shape once the timeframe is a parameter — a rolling ATR written against a hard-coded `'1d'` assumption is work that #664 partially invalidates.

---

## 5. Category E — merge candidates

### 5.1 [#514](https://github.com/dd-jp/samurai-trading-system/issues/514) into [#238](https://github.com/dd-jp/samurai-trading-system/issues/238)

#514's own corrected body concedes its framing is dead — *"Not code. The binding constraints are all outside the tree"* — and pass 1 refused a bare close for one reason only: *"its ordered post-soak tail is tracked nowhere else, so a bare close loses six pointers."*

#238 is the soak that tail is ordered around, and pass 2 established #238 needs a body rewrite anyway (§4.3: its acceptance criteria *"can never be met"*). **Both need an edit, and the same edit serves both.** Move #514's ordered tail into #238 as the post-soak sequence, and #514 closes with nothing lost — one artifact holding the soak's precondition, its done-bar and its tail, instead of two that each hold a third of it and one of which announces its own obsolescence in its first paragraph.

This is a recommendation neither prior pass made; pass 1 explicitly left the disposition open.

### 5.2 [#828](https://github.com/dd-jp/samurai-trading-system/issues/828) into [#824](https://github.com/dd-jp/samurai-trading-system/issues/824) — see §4.2.

### 5.3 [#822](https://github.com/dd-jp/samurai-trading-system/issues/822) into [#825](https://github.com/dd-jp/samurai-trading-system/issues/825) — pass 2's recommendation 5, with §4.1's correction that the merged ticket must carry *both* fix shapes.

---

## 6. Category F — same defect class, separate sites, keep both

These read as duplicates from the title and are not. Cross-linking them is worth more than merging them, because the pattern is the finding.

| Group | Issues | The shared class |
| --- | --- | --- |
| **Built, tested, uncalled / unenforced** | [#797](https://github.com/dd-jp/samurai-trading-system/issues/797) (`computeRvol` has no caller), [#790](https://github.com/dd-jp/samurai-trading-system/issues/790) (optional telemetry sink; participation has no registry kind), [#807](https://github.com/dd-jp/samurai-trading-system/issues/807) (`assertValidPool`'s docstring promises a check it does not run) | The `no-caller-defect-pattern`, in three flavours: no caller, an optional seam at the composition site, and a claim of enforcement with no enforcement. Pass 1's method section already grouped #797/#790; #807 is the same shape and is not grouped with them anywhere |
| **Indicator warm-up floor** | [#757](https://github.com/dd-jp/samurai-trading-system/issues/757) (both ATR specs), [#756](https://github.com/dd-jp/samurai-trading-system/issues/756) (the threshold fitted against the pre-fix RSI) | #757 is #722's sibling defect; #756 is #722's downstream consequence. Not the same work, and #757 does **not** invalidate #756 — it reprices stops and the volatility halt, not analyst confidence |
| **Published figures from untested research scripts** | [#685](https://github.com/dd-jp/samurai-trading-system/issues/685) (earnings reaction-day labelling), [#637](https://github.com/dd-jp/samurai-trading-system/issues/637) (MinBTL `E[SR]`, with a second uncoupled copy in `docs/research/18-entry-time-brackets.py`) | Both are a `docs/research/*.py` defect whose output is quoted as a decision input, with nothing that would have caught it. Both require a recompute-and-restate pass over published numbers, and that pass could be one job |
| **Wake-on-data, no trigger** | [#688](https://github.com/dd-jp/samurai-trading-system/issues/688) (calibrate `f(\|toneDelta\|)` once `mi_archive_raw` holds history), [#689](https://github.com/dd-jp/samurai-trading-system/issues/689) (revisit live-mode MI replay once the LSE leg has history) | Both filed off kimi-3-review on #681; both gated on accumulated history with no stated threshold or check date, so neither can be found at the moment it becomes actionable. Pass 1 flagged #688's `ready-for-agent` label as wrong; #689 has the same shape and no such flag |

**Recommend for the fourth group: give both an explicit revisit condition** — a row count or a date — for the same reason pass 1 put an expiry on #809. A ticket whose trigger is "enough history" and whose threshold is unstated is indistinguishable from a ticket nobody will reopen.

---

## 7. Category G — the same work scheduled twice

### [#773](https://github.com/dd-jp/samurai-trading-system/issues/773) overlaps the #818 follow-up cluster on PR #560

#773 is a second-model review of four unreviewed PRs, one of which is **#560 — *"live money — OHLCV failover and a new fallback vendor writing to `bars`"***.

That is the same subsystem that PR #818 has now extended and that #791, #822, #823, #824, #825, #826 and #828 have already been filed against, several of them off exactly this kind of review. **A fresh second-model pass over #560 will re-derive findings that are already open as seven tickets**, and its reviewer has no way to know that.

**Recommend: list the seven open failover findings in #773's body** so the reviewer scopes #560 to what is *not* already captured. #773's value is in the three PRs with no such coverage — #532, #546 (re-arming protective legs on a partial flatten) and #566 (the capital-capped live profile) — and #546 in particular has nothing filed against it by any pass.

---

## 8. Relations already asserted, credited not re-filed

Checked against both prior reports so nothing here is restated as new, and so no pair is called a duplicate that an earlier pass explicitly called something else:

| Relation | Where it was stated | Status here |
| --- | --- | --- |
| #822 + #825 are one edit | pass 2 §2.1 | Confirmed, **and sharpened** — the two prescribed fixes do not compose (§4.1) |
| #813 unblocks #707, #750, #751 | pass 1 §"What is startable" | Dependency, not duplication. Unchanged |
| #813 and #800 are "the same event" (wiring the pool arms the 2×) | pass 1 | Unchanged; note it makes #813 a precondition of §2's sequencing, not a competitor |
| #797's real gate is #751, not the closed #749 | pass 1 | Unchanged |
| #807 is **not** blocked by #751 | pass 1 | Explicitly **not** contradicted — §6 groups #807 with #790/#797 by *class*, which is not a dependency |
| #791 half-overtaken by #818; re-scope to backfill + quarantine | pass 2 §2.3 | Condition now met (§0) — the re-scope is due today |
| #719 → #720 parent/child; #631 → #636/#655/#665/#666 | both | By design. Not duplication |
| #666 gates #750 | #666's own banner | Dependency, unchanged |
| #813 blocks #707; #636/#753 parent-child | pass 1 / #753's own body | Confirmed by §11; my §3 attempts to promote either to *competing scope* were falsified |
| #798 and #800 "cheaper to decide together" | #800's own body | **Direction added** (§2): #800 first, because #798's envelope is a function of #800's answer — and one of the three outcomes removes #798 entirely |

---

## 9. Recommendations, in the order they save the most work

1. **Re-scope [#791](https://github.com/dd-jp/samurai-trading-system/issues/791) now** — #818 has merged and `backfill-market-data.ts:314` is still `console.error`, so pass 2's condition is met (§0).
2. **Merge [#822](https://github.com/dd-jp/samurai-trading-system/issues/822) and [#825](https://github.com/dd-jp/samurai-trading-system/issues/825) into one ticket carrying both fix shapes** — a `ProductionConfig` field *and* a conditional resolution — then do [#823](https://github.com/dd-jp/samurai-trading-system/issues/823) against the resulting branch (§4.1).
3. **Decide [#800](https://github.com/dd-jp/samurai-trading-system/issues/800) before [#798](https://github.com/dd-jp/samurai-trading-system/issues/798)**, and re-run `18-drawdown-envelope.py` at the resolved fraction — #798's envelope is a function of #800's answer, and one of the three outcomes removes #798 entirely (§2). #800 AC4 also reopens `EQUITY_LEG_FRACTION_OF_CAPITAL` itself, so do not assume the `0.5` survives.
4. **Fold [#828](https://github.com/dd-jp/samurai-trading-system/issues/828) into [#824](https://github.com/dd-jp/samurai-trading-system/issues/824)'s second half**, or narrow #824 to the breaker (§4.2). #828 is also this backlog's only untriaged issue.
5. ~~**Put [#636](https://github.com/dd-jp/samurai-trading-system/issues/636) to David as "does #753's design answer this?"**~~ — **WITHDRAWN on verification (§3.1).** #753 explicitly disclaims deciding which spec owns the control; #636 is a live decision and stays on the frontier.
6. **Fold [#514](https://github.com/dd-jp/samurai-trading-system/issues/514)'s ordered tail into [#238](https://github.com/dd-jp/samurai-trading-system/issues/238)** and close #514 — #238 needs a body rewrite anyway (§5.1).
7. **Scope [#826](https://github.com/dd-jp/samurai-trading-system/issues/826) to the Alpaca leg**, ceding the LSE mark source to [#734](https://github.com/dd-jp/samurai-trading-system/issues/734) (§4.3).
8. ~~**Declare in [#707](https://github.com/dd-jp/samurai-trading-system/issues/707) what a positive result does to [#750](https://github.com/dd-jp/samurai-trading-system/issues/750)**~~ — **WITHDRAWN on verification (§3.2).** #707 declares all three outcomes in advance, including the never-a-second-ranked-axis bar. At most a one-line tidy on the PASS branch.
9. **Cross-link [#683](https://github.com/dd-jp/samurai-trading-system/issues/683)/[#756](https://github.com/dd-jp/samurai-trading-system/issues/756)**, and record in #756 that `conviction_floor` is a sizing input at `decide.ts:509`, not only a gate (§4.4).
10. **List the seven open failover findings in [#773](https://github.com/dd-jp/samurai-trading-system/issues/773)** so its reviewer does not re-derive them (§7).

---

## 10. Method, and what this run does not claim

Single-session, no subagents. Every code claim carries a `file:line` verified at `765b65b`; every issue claim is a verbatim quote from the body. The four categories in §1 were fixed before the pairs were sorted, so that a pair could not be promoted to "duplicate" by the convenience of the label.

Four caveats:

1. **Bodies were read to 1,400 characters.** Fifteen were truncated, listed in the coverage note. A relation asserted only in a long body's tail was not seen.
2. **Only the duplicate axis was run.** Code verdicts are inherited from pass 1 and pass 2 except where §0 corrects them; no issue's underlying defect was re-verified beyond the specific lines each pairing turns on.
3. **§2's `f = 0.125` envelope figure is interpolated**, not re-run, and it assumes `EQUITY_LEG_FRACTION_OF_CAPITAL` stays `0.5` — which #800 AC4 explicitly reopens. The `f ≈ 0.142` break-even it is compared against is ADR-0018's own published number. Re-run the generator before closing #798 on it.
4. **Nothing was mutated.** No issue closed, edited, relabelled or commented on. All ten recommendations are unexecuted.

*Caveat 1 is no longer hypothetical: the verification pass in §11 read the full bodies and the truncation cost this report two of its fifteen findings.*

---

## 11. Verification pass — every flagged pair re-checked against the full body and the tree

Run after the report was first written, on the question *"do these claims survive being checked?"* Full issue bodies (no truncation) via `gh issue view`, plus the cited code.

**2 of 15 findings falsified, both in §3. 13 stand.**

| Claim | Method | Verdict |
| --- | --- | --- |
| 46 open issues | `gh issue list --state open` | **Confirmed** — 46 |
| §0 PR #818 merged at `b4a8a27` | `gh pr view 818` | **Confirmed** — `MERGED`, `b4a8a2778c9f…`, 2026-08-17T20:08:04Z |
| §0 backfill alerter still `console.error` | `backfill-market-data.ts:314` | **Confirmed** |
| §2 Trader deploys `0.35` / `0.25` unscaled | `subclass-bracket.ts:100`, `:104` | **Confirmed** — `D5_INDEX_ETP_DEPLOYMENT_FRACTION = 0.35` |
| §2 D5 gate scales by `0.5` | `paper-profile.ts:377`, `:426`; `risk-manager/index.ts:449` | **Confirmed** — and `subclass-deployment-cap.test.ts:43` asserts `0.5 × LIVE_CAPITAL = 750`, i.e. the constant encodes a **£1,500 two-leg book**, which is precisely what crypto's removal reopens |
| §2 #800 AC4 reopens the constant | full body | **Confirmed** verbatim |
| §3.1 #753 answers #636 | full bodies | **FALSIFIED** — #753: *"It does **not** decide which spec owns declaring it"*; #636's open half is spec ownership, not design |
| §3.2 #707 has no declared disposition | full body | **FALSIFIED** — all three outcomes declared in advance; PARTIAL bars a second ranked axis on the zero-trials argument |
| §4.1 #822/#825 fixes do not compose | both fix-shape paragraphs, verbatim | **Confirmed** — #822 is `config.fallbackPacing ?? resolveFallbackPacing(logger)`; with no config field supplied the call still runs and still warns, which is #825's whole symptom |
| §4.2 #824 claims a second half it has not measured | full bodies | **Confirmed** — #824: *"plus a re-derived Polygon pacing budget… Both halves are needed"*; #828 measures 1 → 4 requests and would edit the same `DEFAULT_POLYGON_PACING`. **Amendment: #828 already lists #824 under Related**, so the cross-link half of the recommendation is done; the scope overlap is not |
| §4.2 #828 opened after pass 2 | `gh issue view 828 --json createdAt` | **Confirmed** — 20:07:24Z, 40s before #818 merged |
| §4.3 #826's option 3 is #734's job | full body | **Confirmed** verbatim, and #826 does not cite #734 anywhere |
| §4.4 #683 cites the wrong line | full body vs `decide.ts:392` | **Confirmed** — body says `decide.ts:168` |
| §4.4 `conviction_floor` is also a sizing input | `decide.ts:509` | **Confirmed** |
| §4.5 both touch `replay-driver.ts` | file present, 546 lines | **Confirmed** — `:497` in range |
| §5.1 #514 concedes its framing | full body | **Confirmed** — *"Not code. The binding constraints are all outside the tree"*, with an explicit *"Deliberately post-soak"* tail |
| §6 `computeRvol` has no caller | grep, non-test | **Confirmed** — defined and re-exported, never called |
| §6 `assertValidPool` promises a check it does not run | `lse-etp-pool.ts:539-555` | **Confirmed** — docstring promises the identity fields are *"non-empty **and distinct**"*; the body checks non-empty only, no distinctness test |
| §7 #773 covers PR #560 plus three others | full body | **Confirmed** — #532, #546, #560, #566, with #546 *"re-arming protective legs on a partial flatten"* |

**What the two falsifications have in common** is the finding worth keeping: both were declared in a body's tail, and both were called undeclared by a pass that read the head. The categories that survived verification intact are the ones anchored in **code** (§4.1, §4.4, §6) or in a **cross-artifact contradiction** (§0, §2) rather than in the absence of a statement. Absence-of-statement findings from a truncated read are the unreliable class, and this report produced exactly two of them and got both wrong.
